import { z } from "zod";

export const conversationRetentionSchema = z
  .object({
    maxIdentities: z.number().int().min(1).max(100000).default(1000),
    maxHistories: z.number().int().min(1).max(10000).default(100),
    idleTtlMs: z.number().int().min(1).max(2592000000).default(86400000),
    maxEvents: z.number().int().min(1).max(100000).default(10000),
    maxBytes: z.number().int().min(1).max(268435456).default(8388608)
  })
  .strict()
  .refine((v) => v.maxHistories <= v.maxIdentities, "History limit must fit identity limit");
export type ConversationRetention = z.infer<typeof conversationRetentionSchema>;
export function loadConversationRetention(
  env: NodeJS.ProcessEnv = process.env
): ConversationRetention {
  const read = (name: string) => (env[name] === undefined ? undefined : Number(env[name]));
  return conversationRetentionSchema.parse({
    maxIdentities: read("CONVERSATION_MAX_IDENTITIES"),
    maxHistories: read("CONVERSATION_MAX_HISTORIES"),
    idleTtlMs: read("CONVERSATION_IDLE_TTL_MS"),
    maxEvents: read("CONVERSATION_MAX_EVENTS"),
    maxBytes: read("CONVERSATION_MAX_BYTES")
  });
}
