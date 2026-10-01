import type { ChatTimelineEvent } from "../domain/types";
import type { AnswerEvidencePacket } from "./retrievalAnswerContract";
import { evidenceCitationId } from "./evidenceCitations";
export function reviewEvidenceMapping(
  target: ChatTimelineEvent,
  packet: AnswerEvidencePacket,
  maxBytes: number
) {
  const refs = target.answerReferences;
  const allowed = refs?.citations.length
    ? refs.sources.map((s) => s.resultId)
    : (target.payloadResults?.map((p) => p.context.resultId) ?? []);
  if (allowed.length && packet.references.some((r) => !allowed.includes(r.resultId)))
    throw Error("REVIEW_EVIDENCE_MISMATCH");
  if (
    refs?.citations.length &&
    packet.references.some((r) =>
      r.selectedRows.some(
        (row) =>
          !refs.citations.some(
            (c) =>
              c.row === row &&
              refs.sources.find((s) => s.id === c.sourceId)?.resultId === r.resultId
          )
      )
    )
  )
    throw Error("REVIEW_EVIDENCE_MISMATCH");
  const mapping = (refs?.citations ?? []).flatMap((c) => {
    const source = refs!.sources.find((s) => s.id === c.sourceId),
      ref = packet.references.find((r) => r.resultId === source?.resultId);
    if (!ref || !ref.selectedRows.includes(c.row)) return [];
    const column =
      c.columnIndex ??
      (target.groundedAnswer?.answer.status === "answer"
        ? target.groundedAnswer.answer.claims
            .flatMap((v) => v.citations)
            .find(
              (v) =>
                v.resultId === ref.resultId &&
                v.row === c.row &&
                v.quote === c.value &&
                ref.columns[v.column] === c.column
            )?.column
        : undefined);
    if (typeof column !== "number" || ref.rows[ref.selectedRows.indexOf(c.row)][column] !== c.value)
      throw Error("REVIEW_EVIDENCE_MISMATCH");
    return [{ marker: c.id, citationId: evidenceCitationId(ref.resultId, c.row, column) }];
  });
  const result = {
    scope: "selected_evidence_only",
    markers: mapping,
    unreviewedMarkers: (refs?.citations ?? [])
      .filter((c) => !mapping.some((m) => m.marker === c.id))
      .map((c) => c.id)
  };
  if (Buffer.byteLength(JSON.stringify({ packet, mapping: result })) > maxBytes)
    throw Error("REVIEW_EVIDENCE_LIMIT");
  return result;
}
