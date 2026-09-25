import type { BenchmarkSummary } from "./benchmarkCore";

export interface BenchmarkSummaryFile {
  generatedAtIso: string;
  mode: string;
  summaries: BenchmarkSummary[];
}

export interface BenchmarkDelta {
  profileName: string;
  firstResponseP95DeltaMs: number;
  finalLatencyP95DeltaMs: number;
  avgQualityDelta: number;
  avgRetriesDeepDelta: number;
  deadLetterRateDeepDelta: number;
}

export interface CompareThresholds {
  maxFirstResponseP95RegressionMs: number;
  maxFinalLatencyP95RegressionMs: number;
  maxDeadLetterRateRegression: number;
  minQualityDelta: number;
}

export interface GateResult {
  profileName: string;
  gate: string;
  passed: boolean;
  actual: number;
  expected: number;
}

export interface CompareReport {
  deltas: BenchmarkDelta[];
  gates: GateResult[];
  passed: boolean;
}

function toMap(summaries: BenchmarkSummary[]): Map<string, BenchmarkSummary> {
  return new Map(summaries.map((s) => [s.profile.name, s]));
}

export function computeDeltas(baseline: BenchmarkSummaryFile, candidate: BenchmarkSummaryFile): BenchmarkDelta[] {
  const baseByProfile = toMap(baseline.summaries);
  const candidateByProfile = toMap(candidate.summaries);

  const profileNames = [...candidateByProfile.keys()].filter((name) => baseByProfile.has(name));

  return profileNames.map((name) => {
    const base = baseByProfile.get(name)!;
    const cand = candidateByProfile.get(name)!;

    return {
      profileName: name,
      firstResponseP95DeltaMs: cand.firstResponseP95 - base.firstResponseP95,
      finalLatencyP95DeltaMs: cand.finalLatencyP95 - base.finalLatencyP95,
      avgQualityDelta: cand.avgQuality - base.avgQuality,
      avgRetriesDeepDelta: cand.avgRetriesDeep - base.avgRetriesDeep,
      deadLetterRateDeepDelta: cand.deadLetterRateDeep - base.deadLetterRateDeep
    };
  });
}

export function evaluateDeltas(deltas: BenchmarkDelta[], thresholds: CompareThresholds): CompareReport {
  const gates: GateResult[] = [];

  for (const d of deltas) {
    gates.push({
      profileName: d.profileName,
      gate: "first_response_p95_regression_ms",
      passed: d.firstResponseP95DeltaMs <= thresholds.maxFirstResponseP95RegressionMs,
      actual: d.firstResponseP95DeltaMs,
      expected: thresholds.maxFirstResponseP95RegressionMs
    });

    gates.push({
      profileName: d.profileName,
      gate: "final_latency_p95_regression_ms",
      passed: d.finalLatencyP95DeltaMs <= thresholds.maxFinalLatencyP95RegressionMs,
      actual: d.finalLatencyP95DeltaMs,
      expected: thresholds.maxFinalLatencyP95RegressionMs
    });

    gates.push({
      profileName: d.profileName,
      gate: "dead_letter_rate_regression",
      passed: d.deadLetterRateDeepDelta <= thresholds.maxDeadLetterRateRegression,
      actual: d.deadLetterRateDeepDelta,
      expected: thresholds.maxDeadLetterRateRegression
    });

    gates.push({
      profileName: d.profileName,
      gate: "quality_delta",
      passed: d.avgQualityDelta >= thresholds.minQualityDelta,
      actual: d.avgQualityDelta,
      expected: thresholds.minQualityDelta
    });
  }

  return {
    deltas,
    gates,
    passed: gates.every((g) => g.passed)
  };
}

export function renderCompareMarkdown(report: CompareReport): string {
  const deltaRows = report.deltas.map((d) => {
    return `| ${d.profileName} | ${d.firstResponseP95DeltaMs.toFixed(0)} | ${d.finalLatencyP95DeltaMs.toFixed(0)} | ${d.avgQualityDelta.toFixed(3)} | ${d.avgRetriesDeepDelta.toFixed(3)} | ${d.deadLetterRateDeepDelta.toFixed(3)} |`;
  });

  const gateRows = report.gates.map((g) => {
    return `| ${g.profileName} | ${g.gate} | ${g.passed ? "PASS" : "FAIL"} | ${g.actual.toFixed(3)} | ${g.expected.toFixed(3)} |`;
  });

  return [
    "# Benchmark Comparison Report",
    "",
    `Overall: ${report.passed ? "PASS" : "FAIL"}`,
    "",
    "## Deltas (candidate - baseline)",
    "| Profile | First p95 delta (ms) | Final p95 delta (ms) | Quality delta | Avg retries delta | Dead-letter delta |",
    "|---|---:|---:|---:|---:|---:|",
    ...deltaRows,
    "",
    "## Gates",
    "| Profile | Gate | Status | Actual | Expected |",
    "|---|---|---|---:|---:|",
    ...gateRows,
    ""
  ].join("\n");
}
