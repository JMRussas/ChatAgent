import { z } from "zod";

export const summaryConfigSchema = z.object({
  mode: z.enum(["off", "extractive", "model"]).default("extractive"),
  triggerRatio: z.coerce.number().gt(0).max(1).default(0.8),
  maxTokens: z.coerce.number().int().positive().max(1_000_000).default(1024),
  timeoutMs: z.coerce.number().int().positive().max(2_147_483_647).default(5000)
});
export type SummaryConfig = z.infer<typeof summaryConfigSchema>;
export function loadSummaryConfig(env: NodeJS.ProcessEnv = process.env): SummaryConfig {
  const result = summaryConfigSchema.safeParse({
    mode: env.CONTEXT_SUMMARY_MODE,
    triggerRatio: env.CONTEXT_SUMMARY_TRIGGER_RATIO,
    maxTokens: env.CONTEXT_SUMMARY_MAX_TOKENS,
    timeoutMs: env.CONTEXT_SUMMARY_TIMEOUT_MS
  });
  if (!result.success)
    throw new Error(`Invalid CONTEXT_SUMMARY configuration: ${result.error.message}`);
  return result.data;
}
