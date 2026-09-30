/** Explicit capacity-consuming golden acceptance; never part of offline release checks. */
import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { startServer } from "../server";
import { runLiveReport } from "../bench/liveReport";
import { goldenSuiteSchema } from "./golden";
import { evaluateLiveGoldens } from "./liveGolden";
import { scenarioDataset } from "./scenarios";
import { linkScenarioRecording } from "./recording/linkLive";
import { digest } from "./recording/contract";
import { readArtifact } from "./recording/storage";

const root = resolve(process.argv[2] ?? `reports/evaluations/live-golden-${Date.now()}`);
await mkdir(dirname(root), { recursive: true });
await mkdir(root, { recursive: false });
const scenarios = process.argv[3] === "--scenarios"
  ? scenarioDataset(JSON.parse(await readFile(process.argv[4] ?? "data/grounding-followup-scenarios.json", "utf8"))) : undefined;
if (process.argv[3] && !scenarios) throw new Error("UNKNOWN_ACCEPTANCE_MODE");
const suite = goldenSuiteSchema.parse(JSON.parse(await readFile("data/golden-prompts.json", "utf8")));
const dataset = scenarios?.dataset ?? { version: "live-golden-v1", prompts: suite.map(t => ({ id: t.id, text: t.prompt })) };
if (scenarios) await writeFile(join(root, "scenario-plan.json"), JSON.stringify(scenarios.suite, null, 2));
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
  const report = await runLiveReport(dataset.prompts, { baseUrl, deadlineMs: 120000, conversationGroups: scenarios?.conversationGroups });
  await writeFile(join(root, "observations.json"), JSON.stringify(report, null, 2));
  await runtime.shutdown();
  if (!report.recorderRunId) throw new Error("LIVE_ACCEPTANCE_RECORDER_UNAVAILABLE");
  const artifact = await readArtifact(join(root, report.recorderRunId, "run.json"));
  if (scenarios) await writeFile(join(root, "coverage.json"), JSON.stringify({
    requested: dataset.prompts.length, executed: report.records.length,
    recorded: artifact.trace.filter(e => e.type === "user").length,
    cases: dataset.prompts.map((p, i) => ({ promptId: p.id, outcome: report.records[i]?.outcome ?? "unrun",
      errorCode: report.records[i]?.errorCode ?? null }))
  }, null, 2));
  const results = scenarios ? (() => {
    // Link exact evidence and grouping without supplying invented quality ratings.
    const linked = linkScenarioRecording(report, artifact, scenarios.suite, {
      version: 2, rubricVersion: "unrated", judge: { kind: "code", id: "structural-only", configurationDigest: digest("scenario-structure-v1") }, ratings: []
    });
    return linked.grading.results.map(r => ({ promptId: r.promptId, passed: r.runtimeOutcome === "stop", runtimeOutcome: r.runtimeOutcome }));
  })() : evaluateLiveGoldens(suite, report.records, artifact);
  await writeFile(join(root, "structural.json"), JSON.stringify({ schemaVersion: scenarios ? "scenario-runtime-v1" : "live-golden-structural-v1", runId: report.recorderRunId,
    results, quality: "unrated", usage: null, costUsd: null }, null, 2));
  console.log(JSON.stringify({ root, runId: report.recorderRunId, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
} finally { await runtime.shutdown(); }
