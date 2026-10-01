import { it, expect } from "vitest";
import fixtures from "../../data/evals/retrieval-answer.v1.json";
import { ToolResultStore } from "../../src/app/toolResult";
import {
  retrievalAnswerPolicySchema,
  beginWorkflow,
  reserveWorkflowCall,
  prepareAnswerEvidence,
  validateGroundedAnswer
} from "../../src/app/retrievalAnswerContract";
const now = Date.parse("2026-09-30T00:00:00Z"),
  signal = () => new AbortController().signal;
const policy = retrievalAnswerPolicySchema.parse({ version: "retrieval-answer-v1" });
function setup() {
  const store = new ToolResultStore(() => now);
  const result = store.put("u", "c", {
    version: "tool-result-v1",
    context: {
      status: "ready",
      summary: "games",
      scope: "synthetic games",
      coverage: "partial",
      limitations: ["Latest game not confirmed"],
      expiresAt: new Date(now + 1000).toISOString()
    },
    payload: { kind: "table", title: "Games", columns: fixtures.columns, rows: fixtures.rows },
    evidence: {
      sourceUrl: "https://example.invalid/games",
      observedAt: new Date(now).toISOString(),
      revision: "fixture-v1"
    }
  });
  const selection = [{ resultId: result.context.resultId, rows: [0] }];
  const packet = prepareAnswerEvidence(store, selection, "u", "c", policy, now, signal());
  return { store, result, selection, packet };
}
it("only includes selected evidence and retains source coverage and limitations", () => {
  const { packet } = setup();
  expect(JSON.stringify(packet)).not.toContain("UNSELECTED_TEAM");
  expect(packet.references[0].sourceCoverage).toBe("partial");
  expect(packet.limitations).toContain("Latest game not confirmed");
});
it.each(fixtures.cases)(
  "checks citation structure without claiming semantic grading: $id",
  (fixture) => {
    const { packet, result } = setup();
    const output = {
      status: "answer",
      scope: "selected_rows",
      claims: [
        {
          text: fixture.claim,
          citations: [
            {
              resultId: result.context.resultId,
              row: fixture.row,
              column: fixture.column,
              quote: fixture.quote
            }
          ]
        }
      ],
      limitations: []
    };
    if (fixture.citationExpected === "fail")
      expect(() =>
        validateGroundedAnswer(output, packet, now, signal(), beginWorkflow(policy, now))
      ).toThrow("ANSWER_CITATION_INVALID");
    else {
      const checked = validateGroundedAnswer(
        output,
        packet,
        now,
        signal(),
        beginWorkflow(policy, now)
      );
      expect(checked.semanticGrounding).toBe("ungraded");
      expect(checked.evidenceLimitations).toContain("Latest game not confirmed");
    }
  }
);
it("blocks foreign, empty, oversized and expired evidence before answer generation", () => {
  const { store, selection } = setup();
  expect(() =>
    prepareAnswerEvidence(store, selection, "other", "c", policy, now, signal())
  ).toThrow();
  expect(() =>
    prepareAnswerEvidence(store, selection, "u", "other", policy, now, signal())
  ).toThrow();
  expect(() => prepareAnswerEvidence(store, [], "u", "c", policy, now, signal())).toThrow(
    "ANSWER_EVIDENCE_REQUIRED"
  );
  expect(() =>
    prepareAnswerEvidence(
      store,
      selection,
      "u",
      "c",
      { ...policy, maxEvidenceBytes: 1 },
      now,
      signal()
    )
  ).toThrow("ANSWER_EVIDENCE_LIMIT");
  expect(() =>
    prepareAnswerEvidence(store, selection, "u", "c", policy, now + 1000, signal())
  ).toThrow("ANSWER_EVIDENCE_EXPIRED");
});
it("supports insufficient evidence and rechecks cancellation/expiry before publication", () => {
  const { packet } = setup(),
    answer = {
      status: "insufficient_evidence",
      reason: "A score cannot establish a play-by-play recap."
    };
  expect(
    validateGroundedAnswer(answer, packet, now, signal(), beginWorkflow(policy, now))
  ).toMatchObject({
    answer: { status: "insufficient_evidence" },
    citationChecks: "not_applicable",
    semanticGrounding: "ungraded"
  });
  expect(() =>
    validateGroundedAnswer(answer, packet, now + 1000, signal(), beginWorkflow(policy, now))
  ).toThrow("ANSWER_EVIDENCE_EXPIRED");
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    validateGroundedAnswer(answer, packet, now, controller.signal, beginWorkflow(policy, now))
  ).toThrow();
});
it("counts attempts across stages and stops at the shared deadline or cancellation", () => {
  let budget = beginWorkflow(policy, now);
  budget = reserveWorkflowCall(policy, budget, "model", now, signal());
  budget = reserveWorkflowCall(policy, budget, "tool", now, signal());
  budget = reserveWorkflowCall(policy, budget, "model", now, signal());
  expect(() => reserveWorkflowCall(policy, budget, "model", now, signal())).toThrow(
    "WORKFLOW_CALL_LIMIT"
  );
  for (let i = 0; i < 2; i++) budget = reserveWorkflowCall(policy, budget, "tool", now, signal());
  expect(() => reserveWorkflowCall(policy, budget, "tool", now, signal())).toThrow(
    "WORKFLOW_CALL_LIMIT"
  );
  expect(() =>
    reserveWorkflowCall(
      policy,
      beginWorkflow(policy, now),
      "model",
      now + policy.deadlineMs,
      signal()
    )
  ).toThrow("WORKFLOW_DEADLINE");
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    reserveWorkflowCall(policy, beginWorkflow(policy, now), "model", now, controller.signal)
  ).toThrow();
});

it("rejects unavailable source evidence even when a payload exists", () => {
  const { store, result } = setup();
  const unavailable = store.put("u", "c", {
    ...result,
    context: { ...result.context, status: "unavailable", coverage: "unavailable" }
  });
  expect(() =>
    prepareAnswerEvidence(
      store,
      [{ resultId: unavailable.context.resultId, rows: [0] }],
      "u",
      "c",
      policy,
      now,
      signal()
    )
  ).toThrow("ANSWER_EVIDENCE_UNAVAILABLE");
});

it.each(["answer", "insufficient_evidence"])(
  "rejects late %s output even while evidence is valid",
  (status) => {
    const { packet, result } = setup();
    const budget = beginWorkflow({ ...policy, deadlineMs: 10 }, now);
    const output =
      status === "answer"
        ? {
            status,
            scope: "selected_rows",
            claims: [
              {
                text: "Harbor Comets scored 101.",
                citations: [{ resultId: result.context.resultId, row: 0, column: 3, quote: "101" }]
              }
            ],
            limitations: []
          }
        : { status, reason: "Not enough evidence." };
    expect(() => validateGroundedAnswer(output, packet, now + 9, signal(), budget)).not.toThrow();
    expect(() => validateGroundedAnswer(output, packet, now + 10, signal(), budget)).toThrow(
      "WORKFLOW_DEADLINE"
    );
  }
);
