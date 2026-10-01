import { z } from "zod";
import type { ToolResultStore, ToolResult } from "./toolResult";
export const referenceSelectionsSchema = z
  .array(
    z
      .object({
        resultId: z.string().uuid(),
        rows: z
          .array(z.number().int().min(0).max(999))
          .min(1)
          .max(20)
          .refine((v) => new Set(v).size === v.length)
      })
      .strict()
  )
  .max(3)
  .refine((v) => new Set(v.map((r) => r.resultId)).size === v.length);
export type ReferenceSelection = z.infer<typeof referenceSelectionsSchema>;
export interface AttachedReference {
  resultId: string;
  title: string;
  columns: string[];
  rows: string[][];
  selectedRows: number[];
  scope: string;
  limitations: string[];
  evidence: ToolResult["evidence"];
  expiresAt: string;
  coverage: "selected_rows";
}
export function selectReferences(
  store: ToolResultStore,
  input: unknown,
  userId: string,
  conversationId: string
): AttachedReference[] {
  const selections = referenceSelectionsSchema.parse(input);
  const result = selections.map((selection) => {
    const value = store.get(selection.resultId, userId, conversationId);
    if (!value.payload || selection.rows.some((i) => !value.payload!.rows[i]))
      throw Error("REFERENCE_ROW_UNAVAILABLE");
    return {
      resultId: selection.resultId,
      title: value.payload.title,
      columns: value.payload.columns,
      rows: selection.rows.map((i) => value.payload!.rows[i]),
      selectedRows: selection.rows,
      scope: value.context.scope,
      limitations: value.context.limitations,
      evidence: value.evidence,
      expiresAt: value.context.expiresAt,
      coverage: "selected_rows" as const
    };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 16000) throw Error("REFERENCE_CONTEXT_LIMIT");
  return structuredClone(result);
}
