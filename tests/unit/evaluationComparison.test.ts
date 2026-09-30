import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { EvaluationRecorder } from "../../src/eval/recording/recorder";
import { canonical, digest, type RunArtifact } from "../../src/eval/recording/contract";
import { compareRecordings, configurationDifferences, executionDigest } from "../../src/eval/recording/comparison";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const dataset = { version: "test-v1", prompts: [{ id: "p", text: "Question" }] };
const ratings = () => ({ version: 1, rubricVersion: "v1", judge: { kind: "human", id: "reviewer", configurationDigest: digest("judge") },
  ratings: [{ promptId: "p", responseHash: digest("Answer"), correctness: "pass", relevance: "pass", unsupportedClaims: "no" }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chatagent-comparison-")); roots.push(root);
  const recorder = new EvaluationRecorder({ root, capture: "answers", maxBytes: 100000, maxEvents: 100, retentionMs: 60000, repetition: 1, condition: "cold" },
    dataset, { routing: { strategy: "single", budget: 100 } }, { revision: "a".repeat(40), dirty: false, sourceDigest: digest("source") });
  const base = { messageId: "m", createdAtIso: new Date().toISOString(), phase: "fast" as const, attemptId: "a", model: { provider: "mock", model: "fixture" } };
  recorder.record("c", { ...base, type: "user", text: "Question", routeDecision: "direct" });
  recorder.record("c", { ...base, type: "provisional", text: "Answer", answerKind: "substantive" });
  recorder.record("c", { ...base, type: "terminal", text: "Answer", finishReason: "stop" });
  await recorder.finish();
  const a: RunArtifact = JSON.parse(await readFile(recorder.path, "utf8"));
  const b = structuredClone(a); b.manifest.runId = "00000000-0000-4000-8000-000000000002";
  return { a, b };
}
function configuration(run: RunArtifact, value: unknown) { run.manifest.configuration = value; run.manifest.configurationDigest = digest(canonical(value)); }
const compare = (a: RunArtifact, b: RunArtifact, experiment?: unknown) => compareRecordings(a, b, dataset, ratings(), ratings(), experiment);
function experiment(a: RunArtifact, b: RunArtifact) {
  return { version: 1, id: "strategy-v1", createdAtIso: new Date(Date.parse(a.manifest.startedAtIso) - 1000).toISOString(),
    datasetDigest: a.manifest.dataset.digest,
    baseline: { configurationDigest: a.manifest.configurationDigest, executionDigest: executionDigest(a) },
    candidate: { configurationDigest: b.manifest.configurationDigest, executionDigest: executionDigest(b) },
    allowedConfigurationDifferences: [["routing", "strategy"]] };
}
it("compares compatible exact-answer grades and preserves distinct run identities", async () => {
  const { a, b } = await fixture();
  const result = compare(a, b);
  expect(result).toMatchObject({ available: true, candidateQualityPassed: true, passRateDelta: 0, costDeltaUsd: null });
  expect(result.runs[0].runId).not.toBe(result.runs[1].runId);
});
it("allows exactly declared config changes with pinned condition identities", async () => {
  const { a, b } = await fixture(); configuration(b, { routing: { strategy: "dual", budget: 100 } });
  expect(compare(a, b).available).toBe(false);
  const manifest = experiment(a, b);
  expect(compare(a, b, manifest)).toMatchObject({ available: true, candidateQualityPassed: true });
  expect(compare(a, b, manifest).runs[0].configurationDigest).not.toBe(compare(a, b, manifest).runs[1].configurationDigest);
  configuration(b, { routing: { strategy: "dual", budget: 200 } });
  expect(compare(a, b, experiment(a, b)).issues).toContain("undeclared or unused configuration differences");
});
it("rejects late declarations, stale digests, and ancestor exemptions", async () => {
  const { a, b } = await fixture(); configuration(b, { routing: { strategy: "dual", budget: 100 } });
  const manifest = experiment(a, b);
  expect(compare(a, b, { ...manifest, createdAtIso: new Date(Date.parse(a.manifest.startedAtIso) + 1).toISOString() }).available).toBe(false);
  expect(compare(a, b, { ...manifest, candidate: manifest.baseline }).available).toBe(false);
  expect(compare(a, b, { ...manifest, allowedConfigurationDifferences: [["routing"]] }).available).toBe(false);
});
it.each(["condition", "code", "mode", "dataset", "prompt", "execution"])("rejects incompatible %s evidence", async kind => {
  const { a, b } = await fixture();
  if (kind === "condition") b.manifest.condition = "unknown";
  if (kind === "code") b.manifest.code.sourceDigest = digest("different");
  if (kind === "mode") b.summary.mode = "live";
  if (kind === "dataset") b.manifest.dataset.version = "other";
  if (kind === "prompt") b.trace[0].textHash = digest("different prompt");
  if (kind === "execution") b.trace.forEach(e => { if (e.model) e.model.model = "other"; });
  expect(compare(a, b).available).toBe(false);
});
it("requires complete matching rubric evidence and distinguishes quality failure from incompatibility", async () => {
  const { a, b } = await fixture();
  const missing = ratings(); missing.ratings = [];
  expect(compareRecordings(a, b, dataset, ratings(), missing).passRateDelta).toBeNull();
  const other = ratings(); other.judge.configurationDigest = digest("other");
  expect(compareRecordings(a, b, dataset, ratings(), other).issues).toContain("quality method mismatch");
  const failed = ratings(); failed.ratings[0].correctness = "fail";
  expect(compareRecordings(a, b, dataset, ratings(), failed)).toMatchObject({ available: true, candidateQualityPassed: false, passRateDelta: -1 });
});
it("does not accept partial datasets or hash-only answers", async () => {
  const { a, b } = await fixture();
  const extended = { ...dataset, prompts: [...dataset.prompts, { id: "q", text: "Missing question" }] };
  for (const run of [a, b]) run.manifest.dataset.digest = digest(canonical(extended));
  expect(compareRecordings(a, b, extended, ratings(), ratings()).available).toBe(false);
  b.trace[1].answer!.text = undefined; b.trace[1].answer!.artifactHash = null;
  expect(compareRecordings(a, b, extended, ratings(), ratings()).candidateQualityPassed).toBe(false);
});
it("treats arrays atomically and missing keys differently from null", () => {
  expect(configurationDifferences({ a: [1], b: null }, { a: [2] })).toEqual([["a"], ["b"]]);
});

it("comparison CLI succeeds with complete grades and fails with missing ratings", async () => {
  const { a, b } = await fixture();
  const root = roots[roots.length - 1];
  const values = [a, b, dataset, ratings(), ratings()];
  const paths = values.map((_, i) => join(root, `${i}.json`));
  await Promise.all(values.map((value, i) => writeFile(paths[i], JSON.stringify(value))));
  const command = ["node_modules/tsx/dist/cli.mjs", "src/eval/recording/cli.ts", "compare", ...paths];
  const result = await promisify(execFile)(process.execPath, command);
  expect(JSON.parse(result.stdout)).toMatchObject({ available: true, candidateQualityPassed: true });
  await writeFile(paths[4], JSON.stringify({ ...ratings(), ratings: [] }));
  await expect(promisify(execFile)(process.execPath, command)).rejects.toMatchObject({ code: 1 });
});

function resequence(run: RunArtifact) {
  run.trace.forEach((e, i) => { e.sequence = i + 1; });
  run.summary.eventCount = run.trace.length;
}
function deepTurn(run: RunArtifact) {
  const fastTerminal = structuredClone(run.trace[2]);
  run.trace[0].route = "deep"; run.trace[0].model = null; run.trace[0].phase = null; run.trace[0].callId = null;
  for (const e of run.trace.slice(1)) {
    e.phase = "deep"; e.callId = digest("deep-call");
    if (e.type === "provisional") e.type = "refined";
  }
  run.trace.splice(1, 0, fastTerminal); resequence(run);
}
it.each(["fast", "deep"] as const)("rejects missing %s call identity even when the other phase has metadata", async phase => {
  const { a, b } = await fixture();
  for (const run of [a, b]) {
    deepTurn(run);
    run.trace.filter(e => e.phase === phase).forEach(e => { e.model = null; });
  }
  expect(compare(a, b)).toMatchObject({ available: false, candidateQualityPassed: false });
  expect(compare(a, b).issues).toContain("candidate: missing or inconsistent call execution identity");
});
it.each(["answer", "terminal", "conflicting", "empty"])("rejects %s model identity gaps within the scored call", async kind => {
  const { a, b } = await fixture();
  if (kind === "answer") b.trace[1].model = null;
  if (kind === "terminal") b.trace[2].model = null;
  if (kind === "conflicting") b.trace[2].model!.model = "different-model";
  if (kind === "empty") for (const e of b.trace) if (e.model) e.model.model = "";
  expect(compare(a, b).candidateQualityPassed).toBe(false);
});
it("distinguishes which fallback model failed and which produced the graded answer", async () => {
  const { a, b } = await fixture();
  for (const [i, run] of [a, b].entries()) {
    run.trace[0].model = null; run.trace[0].callId = null; run.trace[0].phase = null;
    const failed = structuredClone(run.trace[2]);
    failed.callId = digest("failed-call"); failed.retrying = true; failed.finishReason = "error";
    failed.model!.model = i === 0 ? "model-A" : "model-B";
    for (const e of run.trace.slice(1)) e.model!.model = i === 0 ? "model-B" : "model-A";
    run.trace.splice(1, 0, failed); resequence(run);
  }
  expect(executionDigest(a)).not.toBe(executionDigest(b));
  expect(compare(a, b).issues).toContain("execution identity mismatch: experiment required");
  const manifest = { ...experiment(a, b), allowedConfigurationDifferences: [] };
  expect(compare(a, b, manifest).available).toBe(true);
});
it("ignores run-local IDs and fast/deep interleaving while preserving phase execution", async () => {
  const { a, b } = await fixture();
  deepTurn(a); deepTurn(b);
  const fastTerminal = b.trace.splice(1, 1)[0]; b.trace.push(fastTerminal);
  for (const event of b.trace) if (event.callId) event.callId = digest(`other:${event.callId}`);
  resequence(b);
  expect(executionDigest(a)).toBe(executionDigest(b));
  expect(compare(a, b).available).toBe(true);
});
it("preserves repeated same-model retry attempts in the digest", async () => {
  const { a, b } = await fixture();
  const failed = structuredClone(b.trace[2]); failed.callId = digest("retry-call"); failed.retrying = true; failed.finishReason = "error";
  b.trace.splice(1, 0, failed); resequence(b);
  expect(executionDigest(a)).not.toBe(executionDigest(b));
  expect(compare(a, b).available).toBe(false);
});
