import { ToolResultStore } from "../../src/app/toolResult";
import {
  prepareAnswerEvidence,
  retrievalAnswerPolicySchema,
  beginWorkflow,
  validateGroundedAnswer
} from "../../src/app/retrievalAnswerContract";
import { formatEvidenceAnswer } from "../../src/app/answerReferences";
export function deliveryFixture() {
  const now = Date.now(),
    store = new ToolResultStore(),
    policy = retrievalAnswerPolicySchema.parse({ version: "retrieval-answer-v1" });
  const result = store.put("u", "c", {
    version: "tool-result-v1",
    context: {
      status: "ready",
      summary: "Test",
      scope: "Test",
      coverage: "partial",
      limitations: [],
      expiresAt: new Date(now + 60000).toISOString()
    },
    payload: { kind: "table", title: "Scores", columns: ["Points"], rows: [["101"]] },
    evidence: {
      sourceUrl: "https://example.invalid/source",
      observedAt: new Date(now).toISOString(),
      revision: "test"
    }
  });
  const packet = prepareAnswerEvidence(
    store,
    [{ resultId: result.context.resultId, rows: [0] }],
    "u",
    "c",
    policy,
    now,
    new AbortController().signal
  );
  const checked = validateGroundedAnswer(
    {
      status: "answer",
      scope: "selected_rows",
      claims: [
        {
          text: "The score is 101. Literal label [77].",
          citations: [{ resultId: result.context.resultId, row: 0, column: 0, quote: "101" }]
        }
      ],
      limitations: []
    },
    packet,
    now,
    new AbortController().signal,
    beginWorkflow(policy, now)
  );
  const delivery = {
    version: "delivered-answer-v1" as const,
    ...formatEvidenceAnswer(checked, packet)
  };
  return { packet, checked, delivery };
}
