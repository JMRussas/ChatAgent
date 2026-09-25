import type { BenchmarkSummary } from "./benchmarkCore";

export interface BenchmarkSummaryFile {
  generatedAtIso: string;
  mode: string;
  runContext?: {
    simulationSeed?: string;
    promptsDigestSha256?: string;
    profilesDigestSha256?: string;
  };
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
  compatibilityIssues: string[];
  passed: boolean;
}

function buildCompatibilityIssues(baseline: BenchmarkSummaryFile, candidate: BenchmarkSummaryFile): string[] {
  const issues: string[] = [];

  if (baseline.mode !== candidate.mode) {
    issues.push(`mode mismatch: baseline=${baseline.mode}, candidate=${candidate.mode}`);
  }

  const baseContext = baseline.runContext;
  const candContext = candidate.runContext;

  const baselineProfiles = new Set(baseline.summaries.map((s) => s.profile.name));
  const candidateProfiles = new Set(candidate.summaries.map((s) => s.profile.name));
  const missingInCandidate = [...baselineProfiles].filter((name) => !candidateProfiles.has(name));
  const extraInCandidate = [...candidateProfiles].filter((name) => !baselineProfiles.has(name));

  if (missingInCandidate.length > 0 || extraInCandidate.length > 0) {
    issues.push(
      `profile set mismatch: missing_in_candidate=[${missingInCandidate.join(",") || "none"}], extra_in_candidate=[${extraInCandidate.join(",") || "none"}]`
    );
  }

  if (!baseContext?.promptsDigestSha256 || !candContext?.promptsDigestSha256) {
    issues.push("missing prompt digest in runContext");
  }

  if (!baseContext?.profilesDigestSha256 || !candContext?.profilesDigestSha256) {
    issues.push("missing profile digest in runContext");
  }

  if (baseContext?.promptsDigestSha256 && candContext?.promptsDigestSha256) {
    if (baseContext.promptsDigestSha256 !== candContext.promptsDigestSha256) {
      issues.push("prompt set digest mismatch");
    }
  }

  if (baseContext?.profilesDigestSha256 && candContext?.profilesDigestSha256) {
    if (baseContext.profilesDigestSha256 !== candContext.profilesDigestSha256) {
      issues.push("profile set digest mismatch");
    }
  }

  if (baseline.mode === "simulate") {
    if (!baseContext?.simulationSeed || !candContext?.simulationSeed) {
      issues.push("missing simulation seed in runContext for simulate mode");
    }

    if (baseContext?.simulationSeed && candContext?.simulationSeed) {
      if (baseContext.simulationSeed !== candContext.simulationSeed) {
        issues.push(
          `simulation seed mismatch: baseline=${baseContext.simulationSeed}, candidate=${candContext.simulationSeed}`
        );
      }
    }
  }

  return issues;
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
    compatibilityIssues: [],
    passed: gates.every((g) => g.passed)
  };
}

export function compareBenchmarkFiles(
  baseline: BenchmarkSummaryFile,
  candidate: BenchmarkSummaryFile,
  thresholds: CompareThresholds
): CompareReport {
  const deltas = computeDeltas(baseline, candidate);
  const baseReport = evaluateDeltas(deltas, thresholds);
  const compatibilityIssues = buildCompatibilityIssues(baseline, candidate);

  if (deltas.length === 0) {
    compatibilityIssues.push("no overlapping profile names to compare");
  }

  return {
    ...baseReport,
    compatibilityIssues,
    passed: baseReport.passed && compatibilityIssues.length === 0
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
    ...(report.compatibilityIssues.length > 0
      ? ["", "## Compatibility", ...report.compatibilityIssues.map((issue) => `- FAIL: ${issue}`)]
      : []),
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
