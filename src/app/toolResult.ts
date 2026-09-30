import { randomUUID } from "node:crypto";
import { z } from "zod";

export const tablePayloadSchema = z.object({ kind: z.literal("table"), title: z.string().max(300),
  columns: z.array(z.string().max(100)).min(1).max(20),
  rows: z.array(z.array(z.string().max(1000)).max(20)).max(1000)
}).strict().refine(t => t.rows.every(r => r.length === t.columns.length), "Table width mismatch");
export const toolResultSchema = z.object({ version: z.literal("tool-result-v1"),
  context: z.object({ status: z.enum(["ready", "unavailable"]), summary: z.string().max(2000),
    resultId: z.string().uuid(), expiresAt: z.string().datetime(), scope: z.string().max(300),
    coverage: z.enum(["complete", "unavailable"]), limitations: z.array(z.string().max(300)).max(20)
  }).strict(),
  payload: tablePayloadSchema.nullable(),
  evidence: z.object({ sourceUrl: z.string().url(), observedAt: z.string().datetime(), revision: z.string().max(200) }).strict()
}).strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
/** Process-local immutable records. Retrieval requires the same owner and conversation. */
export class ToolResultStore {
  private records = new Map<string, { userId: string; conversationId: string; result: ToolResult }>();
  constructor(private clock = Date.now, private capacity = 100) {}
  put(userId: string, conversationId: string, value: Omit<ToolResult, "context"> & { context: Omit<ToolResult["context"], "resultId"> }) {
    for (const [id, record] of this.records) if (Date.parse(record.result.context.expiresAt) <= this.clock()) this.records.delete(id);
    const result = toolResultSchema.parse({ ...value, context: { ...value.context, resultId: randomUUID() } });
    if (Date.parse(result.context.expiresAt) <= this.clock()) throw Error("RESULT_EXPIRED");
    if (this.records.size >= this.capacity) this.records.delete(this.records.keys().next().value!);
    this.records.set(result.context.resultId, { userId, conversationId, result: structuredClone(result) });
    return result;
  }
  get(id: string, userId: string, conversationId: string) {
    const record = this.records.get(id);
    if (!record || record.userId !== userId || record.conversationId !== conversationId) throw Error("RESULT_NOT_FOUND");
    if (Date.parse(record.result.context.expiresAt) <= this.clock()) { this.records.delete(id); throw Error("RESULT_EXPIRED"); }
    return structuredClone(record.result);
  }
  clear() { this.records.clear(); }
}
