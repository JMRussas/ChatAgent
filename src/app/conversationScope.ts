import { z } from "zod";
const label = z.string().min(1).max(300);
/** Explicitly selected scope plus a bounded evidence snapshot, never the full directory. */
export const conversationScopeSchema = z.object({
  path: z.array(label).min(1).max(5),
  entity: z.object({ provider: label, id: label, name: label }).strict(),
  reference: z.object({ resultId:z.string().uuid(), sourceUrl:z.string().url(), observedAt:z.string().datetime(),
    expiresAt:z.string().datetime(), revision:label,
    fields:z.record(z.string().max(100),z.string().max(1000))
  }).strict().nullable()
}).strict();
export type ConversationScope = z.infer<typeof conversationScopeSchema>;
export function scopeForModel(scope: ConversationScope | undefined, now = Date.now()) {
  if (!scope) return undefined;
  const result = structuredClone(scope);
  const referenceStatus = result.reference ? Date.parse(result.reference.expiresAt) <= now ? "expired" : "attached" : "not_attached";
  if (referenceStatus === "expired") result.reference = null;
  return {...result, referenceStatus};
}
