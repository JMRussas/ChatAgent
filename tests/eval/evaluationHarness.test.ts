import { describe, expect, it } from "vitest";
import { summarizeRecords } from "../../src/eval/metrics";

describe("evaluation harness", () => {
  it("calculates summary metrics used in success criteria", () => {
    const summary = summarizeRecords([
      { promptId: "1", routeDecision: "direct", responseLatencyMs: 600, usedCitation: false, evaluatorScore: 4 },
      {
        promptId: "2",
        routeDecision: "deep",
        responseLatencyMs: 820,
        usedCitation: true,
        evaluatorScore: 5,
        retryCount: 1,
        deadLettered: false
      },
      { promptId: "3", routeDecision: "clarify", responseLatencyMs: 550, usedCitation: false, evaluatorScore: 4 }
    ]);

    expect(summary.avgLatency).toBeLessThan(1000);
    expect(summary.avgScore).toBeGreaterThanOrEqual(4);
    expect(summary.citationRateAll).toBeGreaterThan(0);
    expect(summary.deepCitationRate).toBe(1);
    expect(summary.avgRetriesDeep).toBe(1);
    expect(summary.deadLetterRateDeep).toBe(0);
  });
});
