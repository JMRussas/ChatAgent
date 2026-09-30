/** Explicit capacity-consuming golden acceptance; never part of offline release checks. */
import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { startServer } from "../server";
import { runLiveReport } from "../bench/liveReport";
import { goldenSuiteSchema } from "./golden";
import { evaluateLiveGoldens } from "./liveGolden";
import { readArtifact } from "./recording/storage";

const root = resolve(process.argv[2] ?? `reports/evaluations/live-golden-${Date.now()}`);
await mkdir(dirname(root), { recursive: true });
await mkdir(root, { recursive: false });
const suite = goldenSuiteSchema.parse(JSON.parse(await readFile("data/golden-prompts.json", "utf8")));
const dataset = { version: "live-golden-v1", prompts: suite.map(t => ({ id: t.id, text: t.prompt })) };
const datasetPath = join(root, "dataset.json");
await writeFile(datasetPath, JSON.stringify(dataset, null, 2));
// Process-scoped evaluation settings; do not rewrite the user's .env or account policy.
Object.assign(process.env, { EVAL_RECORDING: "true", EVAL_CAPTURE: "answers", EVAL_DATASET_PATH: datasetPath,
  EVAL_OUTPUT_ROOT: root, EVAL_CONDITION: "unknown", CONTEXT_SUMMARY_MODE: "off", DEEP_WORKER_AUTO_RUN: "true",
  TELEMETRY_STORE_PATH: join(root, "telemetry.json"), DOC_TASK_PYTHON: "", OLLAMA_FAST_THINK: "default", OLLAMA_DEEP_THINK: "default" });
if (process.env.MODEL_ROUTING_MODE !== "catalog") throw new Error("LIVE_ACCEPTANCE_REQUIRES_CATALOG");
const runtime = await startServer(0), baseUrl = `http://127.0.0.1:${runtime.address.port}`;
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  let readiness: unknown;
  while (Date.now() < deadline) {
    const view = await (await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) })).json();
    readiness = view;
    if (view.models?.some((m: { id: string; availability: string }) => m.id === "claude-hekate-default" && m.availability === "ready")) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await writeFile(join(root, "readiness.json"), JSON.stringify(readiness, null, 2));
  if (!ready) throw new Error("LIVE_ACCEPTANCE_PROVIDER_NOT_READY");
  const report = await runLiveReport(dataset.prompts, { baseUrl, deadlineMs: 120000 });
  await writeFile(join(root, "observations.json"), JSON.stringify(report, null, 2));
  await runtime.shutdown();
  if (!report.recorderRunId) throw new Error("LIVE_ACCEPTANCE_RECORDER_UNAVAILABLE");
  const artifact = await readArtifact(join(root, report.recorderRunId, "run.json"));
  const results = evaluateLiveGoldens(suite, report.records, artifact);
  await writeFile(join(root, "structural.json"), JSON.stringify({ schemaVersion: "live-golden-structural-v1", runId: report.recorderRunId,
    results, quality: "unrated", usage: null, costUsd: null }, null, 2));
  console.log(JSON.stringify({ root, runId: report.recorderRunId, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
} finally { await runtime.shutdown(); }
