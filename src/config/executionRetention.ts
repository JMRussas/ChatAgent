import {z} from "zod";
export const executionRetentionSchema = z.object({
  maxCompleted: z.number().int().min(1).max(100000).default(100),
  completedTtlMs: z.number().int().min(1).max(86400000).default(300000),
  maxMetrics: z.number().int().min(1).max(100000).default(1000)
}).strict();
export type ExecutionRetention = z.infer<typeof executionRetentionSchema>;
/** Read once per runtime; completion limits never evict live consumers. */
export function loadExecutionRetention(env:NodeJS.ProcessEnv=process.env):ExecutionRetention {
  const read=(name:string)=>env[name]===undefined ? undefined:Number(env[name]);
  return executionRetentionSchema.parse({maxCompleted:read("EXECUTION_RETENTION_MAX_COMPLETED"),
    completedTtlMs:read("EXECUTION_RETENTION_TTL_MS"),maxMetrics:read("EXECUTION_RETENTION_MAX_METRICS")});
}
