import { readFile } from "node:fs/promises";
import { z } from "zod";
import { providerKindSchema, type RuntimeProviderConfig } from "./providerConfig";

const taskSchema = z.enum(["conversation", "coding", "reasoning", "summarization", "extraction"]);
const supportSchema = z.enum(["supported", "unsupported", "unknown"]);

export const modelEntrySchema = z.object({
  id: z.string().min(1),
  provider: providerKindSchema,
  model: z.string().min(1),
  enabled: z.boolean(),
  roles: z.array(z.enum(["fast", "deep"])).min(1),
  // Operator routing preferences, not claims of measured quality.
  tasks: z.array(taskSchema),
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
  || entry.limits.maxOutputTokens <= entry.limits.contextTokens, "Output limit cannot exceed context limit");

export const modelCatalogSchema = z.object({
  version: z.literal(1),
  models: z.array(modelEntrySchema)
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  const deployments = new Set<string>();
  catalog.models.forEach((entry, index) => {
    const deployment = JSON.stringify([entry.provider, entry.model]);
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

export function describeModelCatalog(catalog: ModelCatalog, config: RuntimeProviderConfig) {
  return {
    version: catalog.version,
    routingMode: "fixed-fast-deep" as const,
    models: catalog.models.map((entry) => ({
      ...entry,
      selectedRoles: (["fast", "deep"] as const).filter((role) =>
        config[role].provider === entry.provider && config[role].model === entry.model),
      // Configuration is not evidence that a model is installed, healthy, or accessible.
      availability: "unchecked" as const
    })),
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
    if (!entry.enabled || !entry.roles.includes(request.role) || !entry.tasks.includes(request.task)) return false;
    if (request.requiredCapabilities?.some((capability) => entry.capabilities[capability] !== "supported")) return false;
    if (request.outputTokens !== undefined &&
      (entry.limits.maxOutputTokens === undefined || request.outputTokens > entry.limits.maxOutputTokens)) return false;
    if (request.inputTokens !== undefined &&
      (entry.limits.contextTokens === undefined || request.inputTokens + (request.outputTokens ?? 0) > entry.limits.contextTokens)) return false;
    return true;
  });
}
