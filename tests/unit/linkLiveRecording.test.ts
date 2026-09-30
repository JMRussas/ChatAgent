import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { EvaluationRecorder } from "../../src/eval/recording/recorder";
import { digest } from "../../src/eval/recording/contract";
import { linkLiveRecording } from "../../src/eval/recording/linkLive";
import { runLiveReport } from "../../src/bench/liveReport";
import type { LiveBenchmarkRecord } from "../../src/bench/liveBenchmark";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chatagent-link-")); roots.push(root);
  const dataset = { version: "link-v1", prompts: [{ id: "p", text: "Question" }] };
  const recorder = new EvaluationRecorder({ root, capture: "answers", maxBytes: 100000, maxEvents: 100, retentionMs: 60000, repetition: 1, condition: "cold" },
    dataset, { test: "link" }, { revision: "a".repeat(40), sourceDigest: digest("source"), dirty: false });
  const messageId = randomUUID(), attemptId = randomUUID(), conversationId = "bench-test";
  const base = { messageId, createdAtIso: new Date().toISOString(), phase: "fast" as const, attemptId, model: { provider: "mock", model: "fixture", bindingId: "fixture" } };
  recorder.record(conversationId, { type: "user", messageId, text: "Question", routeDecision: "direct", createdAtIso: base.createdAtIso });
  recorder.record(conversationId, { ...base, type: "provisional", text: "Answer", answerKind: "substantive" });
  recorder.record(conversationId, { ...base, type: "terminal", text: "Answer", finishReason: "stop" });
  await recorder.finish();
  const artifact = JSON.parse(await readFile(recorder.path, "utf8"));
  const record: LiveBenchmarkRecord = { promptId: "p", conversationId, messageId, evidenceMode: "synthetic", routeDecision: "direct",
    requestStartedAtIso: base.createdAtIso, responseReceivedMs: 2, firstAnswerObservedMs: 1, finalObservedMs: 3, elapsedMs: 4,
    firstUsefulAnswerMs: null, outcome: "stop", retryCount: 0, httpStatus: null, errorCode: null,
    attempts: [{ attemptId, phase: "fast", provider: "mock", model: "fixture", bindingId: "fixture", bindingRevision: null, finishReason: "stop", queueMs: null, providerMs: null }],
    responseHash: digest("Answer"), quality: null, usage: null, costUsd: null, cancellation: "not-requested" };
  const report = { schemaVersion: "chatagent-live-benchmark-v2", mode: "live", generatedAtIso: base.createdAtIso,
    recorderRunId: recorder.runId as string | null, promptsDigestSha256: digest(JSON.stringify(dataset.prompts)), requestedPromptCount: 1, executedPromptCount: 1,
    configurationDigest: null, qualityMethod: "unrated", comparisonEligible: false, records: [record] };
  const annotations = { version: 2, rubricVersion: "v1", judge: { kind: "human", id: "test", configurationDigest: digest("judge") },
    ratings: [{ promptId: "p", responseHash: digest("Answer"), correctness: "pass", relevance: "pass", unsupportedClaims: "no", groundedness: "pass", taskCompletion: "pass" }] };
  return { root, artifact, report, dataset, annotations };
}
it("links exact recorded answers and keeps HTTP and recorder timings separate", async () => {
  const f = await fixture();
  expect(linkLiveRecording(f.report, f.artifact, f.dataset, f.annotations)).toMatchObject({ linked: true, qualityPassed: true,
    configurationDigest: f.artifact.manifest.configurationDigest, mode: "synthetic", comparisonEligible: false,
    observations: [{ firstAnswerObservedMs: 1, finalObservedMs: 3, firstUsefulRecorderMs: null }] });
});
it.each(["run", "turn", "prompt", "attempt", "model", "retry", "answer", "outcome", "coverage", "mode"])("rejects mismatched %s evidence", async kind => {
  const f = await fixture(), r = f.report.records[0];
  if (kind === "run") f.report.recorderRunId = randomUUID();
  if (kind === "turn") r.conversationId = "other";
  if (kind === "prompt") f.dataset.prompts[0].text = "Changed";
  if (kind === "attempt") r.attempts[0].attemptId = randomUUID();
  if (kind === "model") r.attempts[0].model = "other";
  if (kind === "retry") r.retryCount = 2;
  if (kind === "answer") r.responseHash = digest("Changed");
  if (kind === "outcome") r.outcome = "error";
  if (kind === "coverage") f.report.executedPromptCount = 0;
  if (kind === "mode") r.evidenceMode = "live";
  expect(() => linkLiveRecording(f.report, f.artifact, f.dataset, f.annotations)).toThrow(/EVAL_LINK/);
});
it("missing ratings cannot turn linked evidence into a quality pass", async () => {
  const f = await fixture(); f.annotations.ratings = [];
  expect(linkLiveRecording(f.report, f.artifact, f.dataset, f.annotations)).toMatchObject({ linked: true, qualityPassed: false });
});
it("link CLI exits nonzero for a mismatched artifact", async () => {
  const f = await fixture(); f.report.recorderRunId = randomUUID();
  const values = [f.report, f.artifact, f.dataset, f.annotations], paths = values.map((_, i) => join(f.root, `${i}.json`));
  await Promise.all(values.map((value, i) => writeFile(paths[i], JSON.stringify(value))));
  await expect(promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/eval/recording/cli.ts", "link-live", ...paths])).rejects.toMatchObject({ code: 1 });
});
it.each(["same", "changed", "disabled"])("captures recorder identity only for a healthy bracket: %s", async condition => {
  const f = await fixture(); let statusCalls = 0, messageId = "";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/telemetry/evaluation")) return { ok: true, json: async () => ({ enabled: condition !== "disabled",
      runId: statusCalls++ === 0 || condition === "same" ? f.artifact.manifest.runId : randomUUID(), status: "recording", failureCode: null, droppedEvents: 0 }) };
    if (url.endsWith("/messages")) { messageId = JSON.parse(init!.body as string).messageId;
      return { ok: true, json: async () => ({ messageId, fastResponse: { analysis: { routeDecision: "direct" } } }) }; }
    return { ok: true, json: async () => ({ events: [{ messageId, phase: "fast", attemptId: randomUUID(), type: "terminal", finishReason: "stop", text: "" }] }) };
  }));
  const report = await runLiveReport(f.dataset.prompts, { baseUrl: "http://fixture", pollIntervalMs: 1 });
  expect(report.recorderRunId).toBe(condition === "same" ? f.artifact.manifest.runId : null);
});

it("retains runtime success while a linked task-completion grade fails", async () => {
  const f = await fixture(); f.annotations.ratings[0].taskCompletion = "fail";
  expect(linkLiveRecording(f.report, f.artifact, f.dataset, f.annotations)).toMatchObject({ linked: true, qualityPassed: false,
    grading: { runtimePassed: true, results: [{ taskCompletion: "fail", groundedness: "pass", outcome: "fail" }] } });
});
