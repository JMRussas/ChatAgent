import { z } from "zod";
import type { RuntimeProviderConfig } from "../config/providerConfig";

// Initial supported transports (spec 03). Additional Foundry protocols remain
// explicitly unsupported until an adapter exists -- do not add a value here
// without a matching DiscoveryAdapter and a request-mapping adapter.
export const apiKindSchema = z.enum(["mock", "ollama-chat", "azure-openai-chat", "bedrock-converse", "cli"]);
export type ApiKind = z.infer<typeof apiKindSchema>;

// Where inference actually occurs -- a declared policy fact, never inferred
// from a URL, provider name, or model name (08-resource-policy.md).
export const executionScopeSchema = z.enum(["local-device", "self-hosted-remote", "managed-cloud", "hybrid", "unknown"]);
export type ExecutionScope = z.infer<typeof executionScopeSchema>;

export const billingComponentSchema = z.enum(["metered-usage", "subscription", "provisioned-capacity", "owned-compute", "unknown"]);
export type BillingComponent = z.infer<typeof billingComponentSchema>;

/** Declared, not observed. Combinations are allowed (e.g. subscription + owned-compute). */
export const resourceFactsSchema = z.object({
  executionScope: executionScopeSchema,
  // Region/processing scope may be known even when locality is not (or vice versa).
  processingRegion: z.string().min(1).optional(),
  billingComponents: z.array(billingComponentSchema).min(1)
}).strict();
export type ResourceFacts = z.infer<typeof resourceFactsSchema>;

export const UNKNOWN_RESOURCE_FACTS: ResourceFacts = { executionScope: "unknown", billingComponents: ["unknown"] };

const quotaFactsSchema = z.object({
  poolId: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  allowance: z.number().finite().nonnegative().optional(),
  used: z.number().finite().nonnegative().optional(),
  resetAtIso: z.string().datetime().optional(),
  // Freshness of the allowance/used numbers above; absent means never observed.
  observedAtIso: z.string().datetime().optional()
}).strict();
export type QuotaFacts = z.infer<typeof quotaFactsSchema>;

const computeFactsSchema = z.object({
  resourcePoolId: z.string().min(1).optional(),
  ownedOrRented: z.enum(["owned", "rented", "unknown"]),
  concurrencyLimit: z.number().int().positive().optional()
}).strict();
export type ComputeFacts = z.infer<typeof computeFactsSchema>;

export const UNKNOWN_COMPUTE_FACTS: ComputeFacts = Object.freeze({ ownedOrRented: "unknown" });

/**
 * A connection is one addressable way to reach a provider's models -- e.g. one
 * Ollama base URL, one Azure OpenAI resource, one AWS region for Bedrock. It
 * references credentials by name (an env var or SDK credential-chain profile),
 * never a value, so `connections.ts` output is always safe to expose publicly.
 */
export const connectionSchema = z.object({
  connectionId: z.string().min(1),
  apiKind: apiKindSchema,
  credentialRef: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  resourceFacts: resourceFactsSchema,
  quota: quotaFactsSchema,
  compute: computeFactsSchema
}).strict();
export type Connection = z.infer<typeof connectionSchema>;

function parseResourceFactsFromEnv(env: NodeJS.ProcessEnv, prefix: string): ResourceFacts {
  const scopeRaw = env[`${prefix}_EXECUTION_SCOPE`];
  const scope = scopeRaw ? executionScopeSchema.parse(scopeRaw) : "unknown";

  const billingRaw = env[`${prefix}_BILLING_COMPONENTS`];
  const billingComponents = billingRaw
    ? billingRaw.split(",").map((v) => billingComponentSchema.parse(v.trim()))
    : ["unknown" as const];

  const processingRegion = env[`${prefix}_PROCESSING_REGION`];

  return resourceFactsSchema.parse({ executionScope: scope, billingComponents, ...(processingRegion ? { processingRegion } : {}) });
}

/**
 * v1 -> v2 in-memory migration: synthesizes one `default-<provider>` connection
 * per configured provider from existing env settings. Never rewrites the
 * user's catalog file; this is applied only when describing the catalog.
 * Execution/billing facts stay "unknown" unless explicitly declared via the
 * new `<PROVIDER>_EXECUTION_SCOPE` / `<PROVIDER>_BILLING_COMPONENTS` env vars --
 * a base URL of "localhost" or a provider name is never treated as evidence.
 */
export function defaultConnectionsFromEnv(config: RuntimeProviderConfig, env: NodeJS.ProcessEnv = process.env, additionalProviders: RuntimeProviderConfig["fast"]["provider"][] = []): Connection[] {
  const connections: Connection[] = [];
  const providers = new Set([config.fast.provider, config.deep.provider, ...additionalProviders]);

  if (providers.has("mock")) {
    connections.push({
      connectionId: "default-mock", apiKind: "mock",
      resourceFacts: UNKNOWN_RESOURCE_FACTS, quota: {}, compute: UNKNOWN_COMPUTE_FACTS
    });
  }

  if (providers.has("ollama")) {
    connections.push({
      connectionId: "default-ollama", apiKind: "ollama-chat",
      baseUrl: config.ollama?.baseUrl ?? "http://localhost:11434",
      resourceFacts: parseResourceFactsFromEnv(env, "OLLAMA"), quota: {}, compute: UNKNOWN_COMPUTE_FACTS
    });
  }

  if (providers.has("azure") && config.azure) {
    connections.push({
      connectionId: "default-azure", apiKind: "azure-openai-chat",
      credentialRef: "AZURE_OPENAI_API_KEY", baseUrl: config.azure.endpoint,
      resourceFacts: parseResourceFactsFromEnv(env, "AZURE"), quota: {}, compute: UNKNOWN_COMPUTE_FACTS
    });
  }

  if (providers.has("bedrock") && config.bedrock) {
    connections.push({
      connectionId: "default-bedrock", apiKind: "bedrock-converse",
      credentialRef: "aws-sdk-default-credential-chain", region: config.bedrock.region,
      resourceFacts: parseResourceFactsFromEnv(env, "BEDROCK"), quota: {}, compute: UNKNOWN_COMPUTE_FACTS
    });
  }

  return connections;
}

/** Stable binding key: two entries with the same key are the same deployment. */
export function bindingKey(connectionId: string, apiKind: ApiKind, model: string, cliProfile?: string): string {
  return JSON.stringify([connectionId, apiKind, model, cliProfile ?? null]);
}
