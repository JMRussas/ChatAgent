import { describe, expect, it } from "vitest";
import {
  buildGoldenReport,
  goldenSuiteSchema,
  renderGoldenReportMarkdown
} from "../../src/eval/golden";

describe("golden evaluation", () => {
  it("validates golden prompt suite schema", () => {
    const suite = goldenSuiteSchema.parse([
      {
        id: "direct",
        prompt: "What is 2+2?",
        expectedRoute: "direct",
        expectedPhase: "fast-only"
      },
      {
        id: "deep",
        prompt: "Find latest market data and cite sources.",
        expectedRoute: "deep",
        expectedPhase: "deep-required"
      }
    ]);

    expect(suite.length).toBe(2);
  });

  it("renders markdown summary with pass/fail totals", () => {
    const report = buildGoldenReport("http://localhost:3100", [
      {
        id: "c1",
        prompt: "What is 2+2?",
        expectedRoute: "direct",
        actualRoute: "direct",
        expectedPhase: "fast-only",
        fastReply: "2+2 is 4.",
        fastLatencyMs: 120,
        passed: true,
        failures: []
      },
      {
        id: "c2",
        prompt: "Do it",
        expectedRoute: "clarify",
        actualRoute: "direct",
        expectedPhase: "fast-only",
        fastReply: "Done.",
        fastLatencyMs: 140,
        passed: false,
        failures: ["Route mismatch"]
      }
    ]);

    const markdown = renderGoldenReportMarkdown(report);

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(markdown).toContain("Overall: FAIL");
    expect(markdown).toContain("Pass rate: 50.0% (1/2)");
  });
});
