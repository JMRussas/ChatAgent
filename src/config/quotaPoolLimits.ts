import { z } from "zod";
export const quotaPoolLimitsSchema = z
  .object({ maxPools: z.number().int().min(1).max(10000).default(100) })
  .strict();
export type QuotaPoolLimits = z.infer<typeof quotaPoolLimitsSchema>;
/** Read once per ledger; consumed pool totals are never expired or evicted to satisfy this limit. */
export function loadQuotaPoolLimits(env: NodeJS.ProcessEnv = process.env): QuotaPoolLimits {
  const read = (name: string) => (env[name] === undefined ? undefined : Number(env[name]));
  return quotaPoolLimitsSchema.parse({ maxPools: read("ADMISSION_MAX_QUOTA_POOLS") });
}
