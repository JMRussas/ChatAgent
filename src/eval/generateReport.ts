import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildEvalReport, renderEvalReportMarkdown } from "./report";
import type { EvalRecord } from "./metrics";

async function main() {
  const inputPath = process.env.EVAL_INPUT_PATH ?? "data/eval-records.json";
  const outputPath = process.env.EVAL_OUTPUT_PATH ?? "reports/prototype-eval.md";

  const raw = await readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as EvalRecord[];

  const report = buildEvalReport(records, {
    maxAvgLatencyMs: Number(process.env.EVAL_MAX_AVG_LATENCY_MS ?? "1000"),
    minAvgScore: Number(process.env.EVAL_MIN_AVG_SCORE ?? "4"),
    minCitationRate: Number(process.env.EVAL_MIN_CITATION_RATE ?? "0.9"),
    maxDeadLetterRateDeep: Number(process.env.EVAL_MAX_DEAD_LETTER_RATE_DEEP ?? "0.1"),
    maxAvgRetriesDeep: Number(process.env.EVAL_MAX_AVG_RETRIES_DEEP ?? "1")
  });

  const markdown = renderEvalReportMarkdown(report);

  await mkdir("reports", { recursive: true });
  await writeFile(outputPath, markdown, "utf8");

  console.log(`Evaluation report written to ${outputPath}`);
  console.log(`Overall result: ${report.passed ? "PASS" : "FAIL"}`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
