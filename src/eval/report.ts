import type { EvalRecord, EvalSummary } from "./metrics";
import { summarizeRecords } from "./metrics";

export interface EvalThresholds {
  maxAvgLatencyMs: number;
  minAvgScore: number;
  minCitationRate: number;
  maxDeadLetterRateDeep: number;
  maxAvgRetriesDeep: number;
}

export interface EvalGateResult {
  gate: string;
  passed: boolean;
  actual: number;
  expected: number;
}

export interface EvalReport {
  summary: EvalSummary;
  gates: EvalGateResult[];
  passed: boolean;
}

export function buildEvalReport(records: EvalRecord[], thresholds: EvalThresholds): EvalReport {
  const summary = summarizeRecords(records);

  const gates: EvalGateResult[] = [
    {
      gate: "avg_latency",
      passed: summary.avgLatency <= thresholds.maxAvgLatencyMs,
      actual: summary.avgLatency,
      expected: thresholds.maxAvgLatencyMs
    },
    {
      gate: "avg_score",
      passed: summary.avgScore >= thresholds.minAvgScore,
      actual: summary.avgScore,
      expected: thresholds.minAvgScore
    },
    {
      gate: "deep_citation_rate",
      passed: summary.deepCitationRate >= thresholds.minCitationRate,
      actual: summary.deepCitationRate,
      expected: thresholds.minCitationRate
    },
    {
      gate: "dead_letter_rate_deep",
      passed: summary.deadLetterRateDeep <= thresholds.maxDeadLetterRateDeep,
      actual: summary.deadLetterRateDeep,
      expected: thresholds.maxDeadLetterRateDeep
    },
    {
      gate: "avg_retries_deep",
      passed: summary.avgRetriesDeep <= thresholds.maxAvgRetriesDeep,
      actual: summary.avgRetriesDeep,
      expected: thresholds.maxAvgRetriesDeep
    }
  ];

  return {
    summary,
    gates,
    passed: gates.every((g) => g.passed)
  };
}

export function renderEvalReportMarkdown(report: EvalReport): string {
  const gateLines = report.gates
    .map((g) => {
      const status = g.passed ? "PASS" : "FAIL";
      return `- ${g.gate}: ${status} (actual=${g.actual.toFixed(3)}, expected=${g.expected.toFixed(3)})`;
    })
    .join("\n");

  return [
    "# Prototype Evaluation Report",
    "",
    `Overall: ${report.passed ? "PASS" : "FAIL"}`,
    "",
    "## Summary",
    `- avgLatencyMs: ${report.summary.avgLatency.toFixed(2)}`,
    `- avgScore: ${report.summary.avgScore.toFixed(2)}`,
    `- citationRateAll: ${report.summary.citationRateAll.toFixed(3)}`,
    `- deepCitationRate: ${report.summary.deepCitationRate.toFixed(3)}`,
    `- deepRouteRate: ${report.summary.deepRouteRate.toFixed(3)}`,
    `- avgRetriesDeep: ${report.summary.avgRetriesDeep.toFixed(3)}`,
    `- deadLetterRateDeep: ${report.summary.deadLetterRateDeep.toFixed(3)}`,
    "",
    "## Gates",
    gateLines,
    ""
  ].join("\n");
}
