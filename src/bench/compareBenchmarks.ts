import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compareBenchmarkFiles, normalizeThresholds, renderCompareMarkdown, type BenchmarkSummaryFile } from "./compareCore";

async function readSummary(path: string): Promise<BenchmarkSummaryFile> {
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw);
  if (["chatagent-live-benchmark-v1", "chatagent-live-benchmark-v2", "chatagent-linked-benchmark-v1"].includes(value.schemaVersion)) {
    throw new Error("Live observation reports are not comparison eligible: configuration compatibility and quality evidence are required.");
  }
  return value as BenchmarkSummaryFile;
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

  const report = compareBenchmarkFiles(baseline, candidate, normalizeThresholds(readThresholds()));
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
