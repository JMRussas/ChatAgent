import { z } from "zod";
export const deadLetterRetentionSchema = z
  .object({
    maxRecords: z.number().int().min(1).max(10000).default(100),
    maxBytes: z.number().int().min(1).max(268435456).default(16777216)
  })
  .strict();
export type DeadLetterRetention = z.infer<typeof deadLetterRetentionSchema>;
/** Read once per store; records are never expired or evicted to satisfy these limits. */
export function loadDeadLetterRetention(env: NodeJS.ProcessEnv = process.env): DeadLetterRetention {
  const read = (name: string) => (env[name] === undefined ? undefined : Number(env[name]));
  return deadLetterRetentionSchema.parse({
    maxRecords: read("DEAD_LETTER_MAX_RECORDS"),
    maxBytes: read("DEAD_LETTER_MAX_BYTES")
  });
}
