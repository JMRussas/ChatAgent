import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { measureRecorderOverhead } from "./overhead";
import { codeIdentity } from "./startup";
try {
  const output = resolve(process.argv[2] ?? `reports/recorder-overhead-${Date.now()}.json`);
  const capture = process.argv[3] ?? "metadata";
  if (capture !== "metadata" && capture !== "answers") throw new Error("Invalid capture");
  await mkdir(dirname(output), { recursive: true });
  const report = await measureRecorderOverhead({ root: dirname(output), pairs: 20, warmupPairs: 2, turns: 20, capture }, await codeIdentity());
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, mode: report.mode, pairs: report.pairs.length, summary: report.summary }, null, 2));
} catch { console.error("EVAL_OVERHEAD_FAILED"); process.exitCode = 1; }
