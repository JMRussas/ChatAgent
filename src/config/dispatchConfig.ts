import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  billingComponentSchema,
  executionScopeSchema,
  resourceFactsSchema
} from "../models/connections";

const evidence = z
  .object({
    source: z.string().min(1),
    kind: z.enum(["configured", "observed"]),
    checkedAtIso: z.string().datetime(),
    expiresAtIso: z.string().datetime()
  })
  .strict();
export const bindingResourcesSchema = z
  .object({
    facts: resourceFactsSchema,
    evidence,
    // A declared complete upper bound, in USD, covering all incremental billing
    // components (tokens/cache/requests/time). Fixed fees are deliberately separate.
    incremental: z
      .object({
        maxInvocationUsd: z.number().finite().nonnegative(),
        currency: z.literal("USD"),
        evidence
      })
      .strict()
      .optional(),
    quotaAdmission: z.literal("adapter-preflight").optional(),
    fixedCostNote: z.string().optional(),
    quota: z
      .object({
        poolId: z.string().min(1),
        unit: z.enum(["requests", "tokens"]),
        remaining: z.number().finite().nonnegative(),
        evidence
      })
      .strict()
      .optional(),
    compute: z
      .object({ poolId: z.string().min(1), concurrency: z.number().int().positive() })
      .strict()
      .optional()
  })
  .strict();
export type BindingResources = z.infer<typeof bindingResourcesSchema>;
export const dispatchPolicySchema = z
  .object({
    environment: z.string().min(1).default("default"),
    allowedExecutionScopes: z.array(executionScopeSchema).min(1).default(["local-device"]),
    allowedBillingComponents: z.array(billingComponentSchema).min(1).default(["owned-compute"]),
    // Process-lifetime aggregate ceiling; null is explicit permission to omit it.
    maxIncrementalUsd: z.number().finite().nonnegative().nullable().default(0),
    unknownCostAction: z.enum(["deny", "allow-unpriced"]).default("deny"),
    quotaExhaustionAction: z.enum(["fail", "wait"]).default("fail"),
    waitTimeoutMs: z.number().int().min(1).max(120000).default(5000),
    fallbackBindingIds: z
      .object({ fast: z.array(z.string()).default([]), deep: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    // Keys are catalog entry IDs; resources are per binding, not URL heuristics.
    bindings: z.record(bindingResourcesSchema).default({})
  })
  .strict();
export type DispatchPolicy = z.infer<typeof dispatchPolicySchema>;
export async function loadDispatchConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = z.enum(["fixed", "catalog"]).parse(env.MODEL_ROUTING_MODE ?? "fixed");
  const policy = dispatchPolicySchema.parse(
    env.MODEL_DISPATCH_CONFIG_PATH
      ? JSON.parse(await readFile(env.MODEL_DISPATCH_CONFIG_PATH, "utf8"))
      : {}
  );
  return { mode, policy };
}
