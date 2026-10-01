import { z } from "zod";
import { selectReferences, type AttachedReference } from "./referenceSelection";
import type { ToolResultStore } from "./toolResult";

/** Opt-in contract only: no automatic second model call is enabled by this module. */
export const retrievalAnswerPolicySchema = z
  .object({
    version: z.literal("retrieval-answer-v1"),
    maxModelCalls: z.number().int().min(1).max(2).default(2),
    maxToolCalls: z.number().int().min(0).max(3).default(3),
    maxEvidenceBytes: z.number().int().min(1).max(16000).default(16000),
    deadlineMs: z.number().int().min(1).max(300000).default(60000)
  })
  .strict();
export type RetrievalAnswerPolicy = z.infer<typeof retrievalAnswerPolicySchema>;
/** Application-owned ledger, never populated from model output or request fields. */
export interface WorkflowBudget {
  modelCalls: number;
  toolCalls: number;
  deadlineAt: number;
}
export function beginWorkflow(policy: RetrievalAnswerPolicy, now: number): WorkflowBudget {
  const parsed = retrievalAnswerPolicySchema.parse(policy);
  return { modelCalls: 0, toolCalls: 0, deadlineAt: now + parsed.deadlineMs };
}
function assertWorkflowActive(budget: WorkflowBudget, now: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (now >= budget.deadlineAt) throw Error("WORKFLOW_DEADLINE");
}
/** Persist the returned ledger before starting work, including failed attempts. Shared provider admission still applies. */
export function reserveWorkflowCall(
  policy: RetrievalAnswerPolicy,
  budget: WorkflowBudget,
  kind: "model" | "tool",
  now: number,
  signal: AbortSignal
): WorkflowBudget {
  assertWorkflowActive(budget, now, signal);
  const next = {
    ...budget,
    [kind === "model" ? "modelCalls" : "toolCalls"]:
      budget[kind === "model" ? "modelCalls" : "toolCalls"] + 1
  };
  if (next.modelCalls > policy.maxModelCalls || next.toolCalls > policy.maxToolCalls)
    throw Error("WORKFLOW_CALL_LIMIT");
  return next;
}
/** Trusted packet prepared by the application, not accepted from model output. */
export interface AnswerEvidencePacket {
  version: "answer-evidence-v1";
  scope: "selected_rows";
  references: (AttachedReference & { sourceCoverage: "complete" | "partial" | "unavailable" })[];
  expiresAt: string;
  limitations: string[];
}
export function prepareAnswerEvidence(
  store: ToolResultStore,
  selections: unknown,
  userId: string,
  conversationId: string,
  policy: RetrievalAnswerPolicy,
  now: number,
  signal: AbortSignal
): AnswerEvidencePacket {
  signal.throwIfAborted();
  const checked = retrievalAnswerPolicySchema.parse(policy);
  const references = selectReferences(store, selections, userId, conversationId).map((r) => {
    const { context } = store.get(r.resultId, userId, conversationId);
    if (context.status !== "ready" || context.coverage === "unavailable")
      throw Error("ANSWER_EVIDENCE_UNAVAILABLE");
    return { ...r, sourceCoverage: context.coverage };
  });
  if (!references.length) throw Error("ANSWER_EVIDENCE_REQUIRED");
  const expires = Math.min(...references.map((r) => Date.parse(r.expiresAt)));
  if (now >= expires) throw Error("ANSWER_EVIDENCE_EXPIRED");
  const packet: AnswerEvidencePacket = {
    version: "answer-evidence-v1",
    scope: "selected_rows",
    references,
    expiresAt: new Date(expires).toISOString(),
    limitations: [
      "Only explicitly selected rows were supplied; unselected rows and search completeness are not established.",
      ...new Set(references.flatMap((r) => r.limitations))
    ]
  };
  if (Buffer.byteLength(JSON.stringify(packet)) > checked.maxEvidenceBytes)
    throw Error("ANSWER_EVIDENCE_LIMIT");
  return structuredClone(packet);
}
const citation = z
  .object({
    resultId: z.string().uuid(),
    row: z.number().int().min(0).max(999),
    column: z.number().int().min(0).max(19),
    quote: z.string().max(1000)
  })
  .strict();
export const groundedAnswerSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("answer"),
      scope: z.literal("selected_rows"),
      claims: z
        .array(
          z
            .object({
              text: z.string().trim().min(1).max(2000),
              citations: z.array(citation).min(1).max(10)
            })
            .strict()
        )
        .min(1)
        .max(20),
      limitations: z.array(z.string().min(1).max(1000)).max(30)
    })
    .strict(),
  z
    .object({
      status: z.literal("insufficient_evidence"),
      reason: z.string().trim().min(1).max(2000)
    })
    .strict()
]);
/** Citation identity and exact-value checks are not proof that prose follows from evidence. */
export function validateGroundedAnswer(
  output: unknown,
  packet: AnswerEvidencePacket,
  now: number,
  signal: AbortSignal,
  budget: WorkflowBudget
) {
  assertWorkflowActive(budget, now, signal);
  if (now >= Date.parse(packet.expiresAt)) throw Error("ANSWER_EVIDENCE_EXPIRED");
  const answer = groundedAnswerSchema.parse(output);
  if (answer.status === "answer")
    for (const claim of answer.claims)
      for (const cite of claim.citations) {
        const reference = packet.references.find((r) => r.resultId === cite.resultId);
        const index = reference?.selectedRows.indexOf(cite.row) ?? -1;
        if (
          !reference ||
          index < 0 ||
          cite.column >= reference.columns.length ||
          reference.rows[index][cite.column] !== cite.quote
        )
          throw Error("ANSWER_CITATION_INVALID");
      }
  // Carry server-owned limitations regardless of whether the model repeats them.
  return {
    answer,
    evidenceLimitations: [...packet.limitations],
    citationChecks: answer.status === "answer" ? ("passed" as const) : ("not_applicable" as const),
    semanticGrounding: "ungraded" as const
  };
}
