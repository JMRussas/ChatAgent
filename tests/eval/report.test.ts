import { describe, expect, it } from "vitest";
import { buildEvalReport, renderEvalReportMarkdown } from "../../src/eval/report";

describe("evaluation report", () => {
  it("passes gates when thresholds are met", () => {
    const report = buildEvalReport(
      [
        {
          promptId: "1",
          routeDecision: "direct",
          responseLatencyMs: 700,
          usedCitation: true,
          evaluatorScore: 4
        },
        {
          promptId: "2",
          routeDecision: "deep",
          responseLatencyMs: 850,
          usedCitation: true,
          evaluatorScore: 5,
          retryCount: 1,
          deadLettered: false
        },
        {
          promptId: "3",
          routeDecision: "clarify",
          responseLatencyMs: 650,
          usedCitation: false,
          evaluatorScore: 4
        }
      ],
      {
        maxAvgLatencyMs: 1000,
        minAvgScore: 4,
        minCitationRate: 0.5,
        maxDeadLetterRateDeep: 0.1,
        maxAvgRetriesDeep: 1
      }
    );

    expect(report.passed).toBe(true);
    expect(report.gates.every((g) => g.passed)).toBe(true);
  });

  it("fails gates when thresholds are not met", () => {
    const report = buildEvalReport(
      [
        {
          promptId: "1",
          routeDecision: "direct",
          responseLatencyMs: 1400,
          usedCitation: false,
          evaluatorScore: 3,
          retryCount: 0,
          deadLettered: false
        },
        {
          promptId: "2",
          routeDecision: "deep",
          responseLatencyMs: 1300,
          usedCitation: false,
          evaluatorScore: 3,
          retryCount: 2,
          deadLettered: true
        }
      ],
      {
        maxAvgLatencyMs: 1000,
        minAvgScore: 4,
        minCitationRate: 0.5,
        maxDeadLetterRateDeep: 0.1,
        maxAvgRetriesDeep: 1
      }
    );

    expect(report.passed).toBe(false);
    expect(report.gates.some((g) => !g.passed)).toBe(true);
  });

  it("renders markdown report", () => {
    const report = buildEvalReport(
      [
        {
          promptId: "1",
          routeDecision: "deep",
          responseLatencyMs: 900,
          usedCitation: true,
          evaluatorScore: 5
        }
      ],
      {
        maxAvgLatencyMs: 1000,
        minAvgScore: 4,
        minCitationRate: 0.5,
        maxDeadLetterRateDeep: 0.1,
        maxAvgRetriesDeep: 1
      }
    );

    const markdown = renderEvalReportMarkdown(report);
    expect(markdown).toContain("# Prototype Evaluation Report");
    expect(markdown).toContain("Overall: PASS");
  });
});
