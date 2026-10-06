import { randomUUID } from "node:crypto";
import { z } from "zod";

export const tablePayloadSchema = z
  .object({
    kind: z.literal("table"),
    title: z.string().max(300),
    columns: z.array(z.string().max(100)).min(1).max(20),
    rows: z.array(z.array(z.string().max(1000)).max(20)).max(1000)
  })
  .strict()
  .refine((t) => t.rows.every((r) => r.length === t.columns.length), "Table width mismatch");
export const toolResultSchema = z
  .object({
    version: z.literal("tool-result-v1"),
    context: z
      .object({
        status: z.enum(["ready", "unavailable"]),
        summary: z.string().max(2000),
        resultId: z.string().uuid(),
        expiresAt: z.string().datetime(),
        scope: z.string().max(300),
        coverage: z.enum(["complete", "partial", "unavailable"]),
        limitations: z.array(z.string().max(300)).max(20)
      })
      .strict(),
    payload: tablePayloadSchema.nullable(),
    evidence: z
      .object({
        sourceUrl: z.string().url(),
        observedAt: z.string().datetime(),
        revision: z.string().max(200)
      })
      .strict()
  })
  .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
/** Process-local immutable records. Retrieval requires the same owner and conversation. */
export class ToolResultStore {
  private records = new Map<
    string,
    {
      userId: string;
      conversationId: string;
      result: ToolResult;
      bytes: number;
      /** Opaque component that issued the record; never exposed. */
      owner?: object;
    }
  >();
  constructor(
    private clock = Date.now,
    private capacity = 100,
    private maxBytes = process.env.TOOL_RESULT_MAX_BYTES === undefined
      ? 16777216
      : Number(process.env.TOOL_RESULT_MAX_BYTES)
  ) {
    z.number().int().min(1).max(10000).parse(capacity);
    z.number().int().min(1).max(268435456).parse(maxBytes);
  }
  private bytes = 0;
  private remove(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    this.bytes -= record.bytes;
    this.records.delete(id);
  }
  put(
    userId: string,
    conversationId: string,
    value: Omit<ToolResult, "context"> & { context: Omit<ToolResult["context"], "resultId"> },
    owner?: object
  ) {
    for (const [id, record] of this.records)
      if (Date.parse(record.result.context.expiresAt) <= this.clock()) this.remove(id);
    const result = toolResultSchema.parse({
      ...value,
      context: { ...value.context, resultId: randomUUID() }
    });
    if (Date.parse(result.context.expiresAt) <= this.clock()) throw Error("RESULT_EXPIRED");
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > this.maxBytes) throw Error("RESULT_TOO_LARGE");
    while (this.records.size >= this.capacity || this.bytes + bytes > this.maxBytes)
      this.remove(this.records.keys().next().value!);
    this.records.set(result.context.resultId, {
      userId,
      conversationId,
      result: structuredClone(result),
      bytes,
      ...(owner ? { owner } : {})
    });
    this.bytes += bytes;
    return result;
  }
  get(id: string, userId: string, conversationId: string) {
    const record = this.records.get(id);
    if (!record || record.userId !== userId || record.conversationId !== conversationId)
      throw Error("RESULT_NOT_FOUND");
    if (Date.parse(record.result.context.expiresAt) <= this.clock()) {
      this.remove(id);
      throw Error("RESULT_EXPIRED");
    }
    return structuredClone(record.result);
  }
  /** Identity retirement: drops every record bound to the conversation. */
  forgetConversation(conversationId: string) {
    const removed: string[] = [];
    for (const [id, record] of this.records)
      if (record.conversationId === conversationId) {
        this.remove(id);
        removed.push(id);
      }
    return removed;
  }
  /** Drops every record the given component issued; a scan of this bounded store. */
  forgetOwner(owner: object) {
    const removed: string[] = [];
    for (const [id, record] of this.records)
      if (record.owner === owner) {
        this.remove(id);
        removed.push(id);
      }
    return removed;
  }
  retentionStats() {
    return { records: this.records.size, bytes: this.bytes, maxBytes: this.maxBytes };
  }
  clear() {
    this.records.clear();
    this.bytes = 0;
  }
}
