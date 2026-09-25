import { mkdir, readFile, writeFile } from "node:fs/promises";
import { computeDeltas, evaluateDeltas, renderCompareMarkdown, type BenchmarkSummaryFile } from "./compareCore";

async function readSummary(path: string): Promise<BenchmarkSummaryFile> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as BenchmarkSummaryFile;
}

function readThresholds() {
  return {
    maxFirstResponseP95RegressionMs: Number(process.env.BENCH_MAX_FIRST_P95_REGRESSION_MS ?? "150"),
    maxFinalLatencyP95RegressionMs: Number(process.env.BENCH_MAX_FINAL_P95_REGRESSION_MS ?? "300"),
    maxDeadLetterRateRegression: Number(process.env.BENCH_MAX_DEAD_LETTER_REGRESSION ?? "0.05"),
    minQualityDelta: Number(process.env.BENCH_MIN_QUALITY_DELTA ?? "-0.05")
  };
}

async function main() {
  const baselinePath = process.env.BENCH_BASELINE_PATH ?? "reports/benchmark-summary-baseline.json";
  const candidatePath = process.env.BENCH_CANDIDATE_PATH ?? "reports/benchmark-summary.json";
  const outputPath = process.env.BENCH_COMPARE_OUT ?? "reports/benchmark-compare.md";

  const [baseline, candidate] = await Promise.all([readSummary(baselinePath), readSummary(candidatePath)]);

  const deltas = computeDeltas(baseline, candidate);
  const report = evaluateDeltas(deltas, readThresholds());
  const markdown = renderCompareMarkdown(report);

  await mkdir("reports", { recursive: true });
  await writeFile(outputPath, markdown, "utf8");

  console.log(`Benchmark comparison report written to ${outputPath}`);
  console.log(`Overall result: ${report.passed ? "PASS" : "FAIL"}`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
