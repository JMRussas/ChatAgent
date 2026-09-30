import { readFile } from "node:fs/promises";
import { z } from "zod";
import { providerKindSchema, type RuntimeProviderConfig } from "./providerConfig";
import { bindingKey, type ApiKind, type Connection } from "../models/connections";
import { computeReadiness, isChatAdapterImplemented, type ModelObservation, type Readiness } from "../models/inventory";

const taskSchema = z.enum(["conversation", "coding", "reasoning", "summarization", "extraction"]);
const supportSchema = z.enum(["supported", "unsupported", "unknown"]);

export const modelEntrySchema = z.object({
  id: z.string().min(1),
  provider: z.union([providerKindSchema, z.literal("cli")]),
  model: z.string().min(1),
  enabled: z.boolean(),
  roles: z.array(z.enum(["fast", "deep"])).min(1),
  // Operator routing preferences, not claims of measured quality.
  tasks: z.array(taskSchema),
  routingPriority: z.number().int().optional(),
  capabilities: z.object({
    thinking: supportSchema,
    tools: supportSchema,
    vision: supportSchema,
    structuredOutput: supportSchema
  }).strict(),
  limits: z.object({
    contextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional()
  }).strict(),
  deployment: z.enum(["local", "remote", "unknown"]),
  cli: z.object({
    adapterId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    accountProfile: z.string().min(1),
    authentication: z.enum(["subscription-login", "api-credentials", "unknown"]),
    nonInteractive: supportSchema,
    streaming: supportSchema,
    outputFormat: z.enum(["json", "jsonl", "text", "unknown"]),
    executionMode: z.enum(["answer-only", "agent", "unknown"]),
    automationSupport: supportSchema
  }).strict().optional(),
  billing: z.object({
    kind: z.enum(["subscription", "usage", "local-compute", "unknown"]),
    planLabel: z.string().optional(),
    quotaPoolId: z.string().optional(),
    exhaustionPolicy: z.enum(["wait", "fail", "approved-fallback"]),
    usageBillingFallbackAllowed: z.boolean()
  }).strict().optional(),
  pricing: z.object({
    inputUsdPerMillionTokens: z.number().finite().nonnegative(),
    outputUsdPerMillionTokens: z.number().finite().nonnegative(),
    checkedAtIso: z.string().datetime(),
    source: z.string().min(1)
  }).strict().optional(),
  evaluations: z.array(z.object({
    task: taskSchema,
    sampleCount: z.number().int().positive(),
    successRate: z.number().min(0).max(1),
    firstUsefulResponseP95Ms: z.number().finite().nonnegative(),
    finalResponseP95Ms: z.number().finite().nonnegative(),
    evaluatedAtIso: z.string().datetime(),
    environment: z.string().min(1),
    report: z.string().min(1)
  }).strict()).optional(),
  notes: z.string().optional()
}).strict().refine((entry) => !entry.limits.contextTokens || !entry.limits.maxOutputTokens
  || entry.limits.maxOutputTokens <= entry.limits.contextTokens, "Output limit cannot exceed context limit")
  .refine((entry) => (entry.provider === "cli") === (entry.cli !== undefined), "CLI metadata is required only for CLI entries")
  .refine((entry) => entry.cli?.authentication !== "subscription-login" || entry.billing?.kind === "subscription",
    "Subscription login requires subscription billing metadata");

export const modelCatalogSchema = z.object({
  version: z.literal(1),
  models: z.array(modelEntrySchema)
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  const deployments = new Set<string>();
  catalog.models.forEach((entry, index) => {
    const deployment = JSON.stringify([entry.provider, entry.model, entry.cli?.adapterId, entry.cli?.accountProfile]);
    if (ids.has(entry.id) || deployments.has(deployment)) {
      context.addIssue({ code: "custom", path: ["models", index], message: "Duplicate model ID or provider/model binding" });
    }
    ids.add(entry.id);
    deployments.add(deployment);
  });
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export async function loadModelCatalog(path = "data/model-catalog.json"): Promise<ModelCatalog> {
  return modelCatalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/**
 * v1 -> v2 in-memory migration (spec 03): v1 catalog entries only name a
 * `provider`, not a `connectionId`/`apiKind`. Derive both deterministically so
 * every entry has a stable binding key, without ever rewriting the catalog file.
 */
export function apiKindForEntry(entry: Pick<ModelEntry, "provider">): ApiKind {
  if (entry.provider === "mock") return "mock";
  if (entry.provider === "ollama") return "ollama-chat";
  if (entry.provider === "azure") return "azure-openai-chat";
  if (entry.provider === "bedrock") return "bedrock-converse";
  return "cli";
}

export function connectionIdForEntry(entry: Pick<ModelEntry, "provider" | "cli">): string {
  if (entry.provider === "cli" && entry.cli) return `cli-${entry.cli.adapterId}-${entry.cli.accountProfile}`;
  return `default-${entry.provider}`;
}

export interface CatalogInventoryView {
  implementedBindingIds?: readonly string[];
  connections?: readonly Connection[];
  observations?: readonly ModelObservation[];
}

export function describeModelCatalog(catalog: ModelCatalog, config: RuntimeProviderConfig, inventory: CatalogInventoryView = {}) {
  const observationsByBindingId = new Map((inventory.observations ?? []).map((o) => [o.bindingId, o] as const));
  const connectionsById = new Map((inventory.connections ?? []).map((c) => [c.connectionId, c] as const));
  const nowIso = new Date().toISOString();
  const curatedBindingIds = new Set<string>();

  const models = catalog.models.map((entry) => {
    const apiKind = apiKindForEntry(entry);
    const connectionId = connectionIdForEntry(entry);
    const bindingId = bindingKey(connectionId, apiKind, entry.model, entry.cli?.accountProfile);
    curatedBindingIds.add(bindingId);
    const observation = observationsByBindingId.get(bindingId);
    const connection = connectionsById.get(connectionId);
    const adapterImplemented = isChatAdapterImplemented(apiKind) || !!inventory.implementedBindingIds?.includes(bindingId);

    const availability: Readiness = computeReadiness({ enabled: entry.enabled, adapterImplemented, observation, nowIso });

    return {
      ...entry,
      connectionId,
      bindingId,
      apiKind,
      selectedRoles: (["fast", "deep"] as const).filter((role) =>
        config[role].provider === entry.provider && config[role].model === entry.model),
      availability,
      adapterStatus: adapterImplemented ? "implemented" as const : "not-implemented" as const,
      // Declared, not observed (RES-01/03/04) -- resourceFacts/quota/compute come
      // only from connection configuration, never inferred from provider/model names.
      ...(connection ? { resourceFacts: connection.resourceFacts, quota: connection.quota, compute: connection.compute } : {}),
      ...(observation ? {
        observation: {
          installed: observation.installed, access: observation.access, health: observation.health,
          observedAtIso: observation.observedAtIso,
          ...(observation.effectiveContextTokens !== undefined ? { effectiveContextTokens: observation.effectiveContextTokens } : {}),
          ...(observation.effectiveOutputTokens !== undefined ? { effectiveOutputTokens: observation.effectiveOutputTokens } : {}),
          ...(observation.lastErrorCode !== undefined ? { lastErrorCode: observation.lastErrorCode } : {})
        }
      } : {})
    };
  });

  // Discovered-but-uncurated: real observations with no matching catalog entry.
  // Listed separately and never enabled -- discovery never curates automatically.
  const discovered = (inventory.observations ?? [])
    .filter((o) => !curatedBindingIds.has(o.bindingId))
    .map((o) => ({ connectionId: o.connectionId, model: o.model, revision: o.revision, enabled: false as const }));

  return {
    version: catalog.version,
    routingMode: "fixed-fast-deep" as const,
    models,
    discovered,
    unlistedSelections: (["fast", "deep"] as const).filter((role) => !catalog.models.some((entry) =>
      entry.provider === config[role].provider && entry.model === config[role].model))
      .map((role) => ({ role, provider: config[role].provider, model: config[role].model }))
  };
}

/** Eligibility preview only. Health checks and measured ranking must precede dispatch. */
export function findModelCandidates(catalog: ModelCatalog, request: {
  task: z.infer<typeof taskSchema>;
  role: "fast" | "deep";
  requiredCapabilities?: Array<keyof ModelEntry["capabilities"]>;
  inputTokens?: number;
  outputTokens?: number;
}): ModelEntry[] {
  for (const count of [request.inputTokens, request.outputTokens]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      throw new Error("Token requirements must be nonnegative integers");
    }
  }
  return catalog.models.filter((entry) => {
    // Cataloging a subscription does not make its CLI executable by this app.
    if (entry.provider === "cli") return false;
    if (!entry.enabled || !entry.roles.includes(request.role) || !entry.tasks.includes(request.task)) return false;
    if (request.requiredCapabilities?.some((capability) => entry.capabilities[capability] !== "supported")) return false;
    if (request.outputTokens !== undefined &&
      (entry.limits.maxOutputTokens === undefined || request.outputTokens > entry.limits.maxOutputTokens)) return false;
    if (request.inputTokens !== undefined &&
      (entry.limits.contextTokens === undefined || request.inputTokens + (request.outputTokens ?? 0) > entry.limits.contextTokens)) return false;
    return true;
  });
}
