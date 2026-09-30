import { ToolResultStore } from "../../src/app/toolResult";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { startEvaluationRecording } from "../../src/eval/recording/startup";
import { EvaluationRecorder, type ArtifactWriter } from "../../src/eval/recording/recorder";
import { digest, canonical, recordingConfig, redact, type RecorderConfig } from "../../src/eval/recording/contract";
import { scoreRecording } from "../../src/eval/recording/annotations";
import { readArtifact, pruneExpired } from "../../src/eval/recording/storage";
import { runtime, entry, message } from "../helpers/dispatchFixtures";
import type { FastModelProvider } from "../../src/providers/interfaces";
import { GenerationError } from "../../src/domain/generation";

const directories: string[] = [];
const dataset = { version: "fixture-v1", prompts: [{ id: "hello", text: "hello" }] };
const code = { revision: "a".repeat(40), dirty: false, sourceDigest: "b".repeat(64) };
const recorders: EvaluationRecorder[] = [];
afterEach(async () => {
  await Promise.allSettled(recorders.splice(0).map(r => r.finish()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});
async function setup(overrides: Partial<RecorderConfig> = {}, writer?: ArtifactWriter) {
  const root = await mkdtemp(join(tmpdir(), "chatagent-evaluation-")); directories.push(root);
  const config: RecorderConfig = { root, capture: "metadata", maxBytes: 100000, maxEvents: 100, retentionMs: 60000, repetition: 1, condition: "cold", ...overrides };
  const recorder = new EvaluationRecorder(config, dataset, { strategy: "fast-deep", apiKey: "secret-config", private: "Bearer SECRET-TOKEN" }, code, writer);
  recorders.push(recorder); return recorder;
}
function turn(recorder: EvaluationRecorder, text = "answer") {
  const base = { messageId: "m", createdAtIso: new Date().toISOString(), phase: "fast" as const, attemptId: "a", model: { provider: "mock", model: "fixture" } };
  recorder.record("c", { ...base, type: "user", text: "hello", routeDecision: "direct" });
  recorder.record("c", { ...base, type: "activity", activity: "running", text: "private activity text" });
  recorder.record("c", { ...base, type: "provisional", text, answerKind: "substantive" });
  recorder.record("c", { ...base, type: "terminal", text, finishReason: "stop" });
}
const annotations = (text = "answer") => ({ version: 2, rubricVersion: "rubric-v1", judge: { kind: "human", id: "reviewer", configurationDigest: digest("human-v1") },
  ratings: [{ promptId: "hello", responseHash: digest(text), correctness: "pass", relevance: "pass", unsupportedClaims: "no", groundedness: "pass", taskCompletion: "pass" }] });

describe("evaluation recording", () => {
  it("records payload hashes separately and retains content only in answers mode", async () => {
    for (const capture of ["metadata", "answers"] as const) {
      const recorder = await setup({capture});
      const result = new ToolResultStore().put("u","c", {version:"tool-result-v1",context:{status:"ready",summary:"Ready",scope:"test",coverage:"complete",limitations:[],expiresAt:new Date(Date.now()+60000).toISOString()},payload:{kind:"table",title:"Directory",columns:["Name"],rows:[["PAYLOAD_CANARY"]]},evidence:{sourceUrl:"https://example.invalid",observedAt:new Date().toISOString(),revision:"v"}});
      recorder.record("c",{type:"refined",messageId:"m",text:"Ready",createdAtIso:new Date().toISOString(),payloadResults:[result]});
      await recorder.finish();
      const run = await readArtifact(recorder.path);
      expect(run.trace[0].payloads?.[0].contentHash).toBe(digest(JSON.stringify(result)));
      const serialized = await readFile(recorder.path,"utf8");
      if (capture === "metadata") expect(serialized).not.toContain("PAYLOAD_CANARY");
      else expect(run.trace[0].payloads?.[0].text).toContain("PAYLOAD_CANARY");
      expect(run.trace[0].answer?.text ?? "").not.toContain("PAYLOAD_CANARY");
    }
  });
  it("defaults off and rejects invalid capture/size configuration", () => {
    expect(redact('password="a secret with spaces"')).toBe("password=[REDACTED]");
    expect(recordingConfig({})).toBeUndefined();
    expect(recordingConfig({ EVAL_RECORDING: "true" })?.capture).toBe("metadata");
    for (const config of [{ EVAL_RECORDING: "yes" }, { EVAL_RECORDING: "true", EVAL_CAPTURE: "reasoning" }, { EVAL_RECORDING: "true", EVAL_MAX_BYTES: "0" }])
      expect(() => recordingConfig(config)).toThrow();
  });
  it("EVAL-04: persists metadata without prompts, answers, raw errors or secret-bearing fields", async () => {
    const recorder = await setup(); turn(recorder, "Bearer ANSWER-SECRET"); await recorder.finish();
    const serialized = await readFile(recorder.path, "utf8");
    for (const secret of ["ANSWER-SECRET", "secret-config", "SECRET-TOKEN", "private activity text"])
      expect(serialized).not.toContain(secret);
    const run = await readArtifact(recorder.path);
    expect(run.trace[2].answer).toMatchObject({ scoredHash: digest("Bearer ANSWER-SECRET"), artifactHash: null });
    expect(run.summary).toMatchObject({ mode: "synthetic", usage: null, costUsd: null, quality: "unrated", recorderOverheadMs: null });
    expect(scoreRecording(run, annotations("Bearer ANSWER-SECRET")).passed).toBe(false);
  });
  it("EVAL-03: requires the exact retained answer, complete rubric, and matching response hash", async () => {
    const recorder = await setup({ capture: "answers" }); turn(recorder); await recorder.finish();
    const run = await readArtifact(recorder.path);
    expect(scoreRecording(run, annotations()).passed).toBe(true);
    expect(scoreRecording(run, annotations("changed answer")).passed).toBe(false);
    expect(scoreRecording(run, { ...annotations(), ratings: [] }).passed).toBe(false);
    const changed = structuredClone(run); changed.trace[2].answer!.text = "tampered";
    expect(() => scoreRecording(changed, annotations())).toThrow("EVAL_ARTIFACT_INTEGRITY");
    expect(() => scoreRecording(run, annotations(), Date.parse(run.manifest.expiresAtIso))).toThrow("EVAL_ARTIFACT_EXPIRED");
    expect(scoreRecording(run, { ...annotations(), ratings: [{ ...annotations().ratings[0], correctness: "unrated" }] }).passed).toBe(false);
  });
  it("EVAL-04: transformed answer artifacts cannot masquerade as the scored answer", async () => {
    const recorder = await setup({ capture: "answers" }); turn(recorder, "password=secret123"); await recorder.finish();
    const run = await readArtifact(recorder.path);
    expect(run.trace[2].answer).toMatchObject({ transformed: true, text: "password=[REDACTED]" });
    expect(scoreRecording(run, annotations("password=secret123")).passed).toBe(false);
  });
  it.each([{ maxEvents: 2 }, { maxBytes: 4096 }])("EVAL-04/05: bounded capture reports dropped events and incomplete evidence (%j)", async limits => {
    const recorder = await setup({ ...limits, capture: "answers" }); turn(recorder, "x".repeat(5000));
    await expect(recorder.finish()).rejects.toThrow("EVAL_RECORDING_INCOMPLETE");
    const run = await readArtifact(recorder.path);
    expect(run.manifest.droppedEvents).toBeGreaterThan(0);
    expect(Buffer.byteLength(await readFile(recorder.path, "utf8"))).toBeLessThanOrEqual(recorder.config.maxBytes);
  });
  it("EVAL-05: unfinished calls remain incomplete and failures are explicit without escaping record()", async () => {
    const recorder = await setup();
    recorder.record("c", { type: "user", messageId: "m", text: "hello", createdAtIso: "ignored", routeDecision: "deep" });
    await expect(recorder.finish()).rejects.toThrow("EVAL_RECORDING_INCOMPLETE");
    const failing = await setup({}, async () => { throw new Error("secret disk details"); });
    turn(failing); await expect(failing.finish()).rejects.toThrow("EVAL_WRITE_FAILED");
    expect(failing.status()).toMatchObject({ status: "failed", failureCode: "EVAL_WRITE_FAILED" });
  });
  it("EVAL-04: pruning removes only expired owned recordings", async () => {
    const recorder = await setup(); turn(recorder); await recorder.finish();
    const run = await readArtifact(recorder.path);
    const unrelated = join(recorder.config.root, "keep.txt"); await writeFile(unrelated, "keep");
    expect(await pruneExpired(recorder.config.root, Date.parse(run.manifest.expiresAtIso))).toBe(1);
    await expect(readFile(recorder.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });
  it("EVAL-04/05: expiry removes active answer capture and shutdown failure invalidates evidence", async () => {
    vi.useFakeTimers();
    const recorder = await setup({ capture: "answers", retentionMs: 1000 });
    turn(recorder); await recorder.flush();
    await vi.advanceTimersByTimeAsync(1000); await recorder.flush();
    expect(recorder.status().status).toBe("failed");
    await expect(readFile(recorder.path)).rejects.toMatchObject({ code: "ENOENT" });
    const timedOut = await setup(); turn(timedOut);
    timedOut.invalidate("EVAL_RUNTIME_SHUTDOWN_TIMEOUT");
    await expect(timedOut.finish()).rejects.toThrow("EVAL_RUNTIME_SHUTDOWN_TIMEOUT");
    expect((await readArtifact(timedOut.path)).manifest.status).toBe("failed");
  });
  it("EVAL-05: the grading command exits nonzero for missing ratings", async () => {
    const recorder = await setup({ capture: "answers" }); turn(recorder); await recorder.finish();
    const path = join(recorder.config.root, "annotations.json");
    await writeFile(path, JSON.stringify({ ...annotations(), ratings: [] }));
    await expect(promisify(execFile)(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/eval/recording/cli.ts"), "grade", recorder.path, path])).rejects.toMatchObject({ code: 1 });
  });
  it("EVAL-05: an unwritable output root returns failed recording without blocking startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatagent-eval-failure-")); directories.push(root);
    const datasetPath = join(root, "dataset.json"), file = join(root, "not-a-directory");
    await writeFile(datasetPath, JSON.stringify(dataset)); await writeFile(file, "occupied");
    const recorder = (await startEvaluationRecording({}, { EVAL_RECORDING: "true", EVAL_DATASET_PATH: datasetPath, EVAL_OUTPUT_ROOT: file }))!;
    recorders.push(recorder);
    expect(recorder.status().status).toBe("failed");
    await expect(recorder.finish()).rejects.toThrow();
  });
  it("EVAL-05: finish waits for the final writer and prevents queued terminal flushes after closure", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = vi.fn(async () => { await gate; });
    const recorder = await setup({}, writer); turn(recorder);
    const finishing = recorder.finish();
    expect(recorder.finish()).toBe(finishing);
    let finished = false; void finishing.then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    release(); await finishing; await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);
  });
  it("EVAL-02: overlapping turns retain separate call parents through cancellation", async () => {
    const recorder = await setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const provider: FastModelProvider = { createProvisionalReply: async (input, control) => {
      if (++calls === 2) entered();
      if (input.message.messageId === "second") {
        await new Promise<void>(resolve => control!.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new GenerationError("CANCELLED", false);
      }
      await gate; return { text: "answer", finishReason: "stop" };
    } };
    const r = runtime([entry("a")], { a: { fast: provider } }, recorder.record);
    const first = r.service.submitMessage(message("hello", "first"));
    const second = r.service.submitMessage(message("hello", "second"));
    await started; await r.service.cancelMessage("c", "second"); release();
    await Promise.all([first, second]); await recorder.finish(); await r.manager.shutdown();
    const run = await readArtifact(recorder.path);
    const terminals = run.trace.filter(e => e.type === "terminal");
    expect(new Set(terminals.map(e => e.callId)).size).toBe(2);
    expect(new Set(terminals.map(e => e.parentCallId)).size).toBe(2);
    expect(terminals.map(e => e.finishReason).sort()).toEqual(["cancelled", "stop"]);
    expect(run.trace.every(e => e.usage === null && e.costUsd === null)).toBe(true);
  });
  it("EVAL-01/05: deferred provider requests, selections, retries and answers match with recording off/on, even with write failures", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const results = [];
    for (const enabled of [false, true]) {
      const recorder = enabled ? await setup({}, async () => { throw new Error("disk full"); }) : undefined;
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      let count = 0;
      const provider = { createProvisionalReply: vi.fn(async (_input: Parameters<FastModelProvider["createProvisionalReply"]>[0]) => {
        if (++count === 1) { entered(); await gate; throw new GenerationError("PROVIDER_UNAVAILABLE", true); }
        return { text: "answer", finishReason: "stop" as const };
      }) };
      const r = runtime([entry("a")], { a: { fast: provider } }, recorder?.record);
      const pending = r.service.submitMessage(message("hello")); await started; release(); await pending;
      const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([k]) => !["snapshotId", "attemptId", "eventId", "signal", "onDelta", "onQueued"].includes(k)).map(([k, v]) => [k, clean(v)])) : value;
      results.push(clean({ requests: provider.createProvisionalReply.mock.calls.map(call => call[0]), events: await r.timeline.getEvents("c") }));
      await recorder?.finish().catch(() => undefined); await r.manager.shutdown();
    }
    expect(results[1]).toEqual(results[0]);
  });
});

it("separates an honest limitation from task completion", async () => {
  const recorder = await setup({ capture: "answers" });
  const text = "I cannot fetch current figures because no retrieval tool is available.";
  turn(recorder, text); await recorder.finish();
  const review = annotations(text); review.ratings[0].taskCompletion = "fail";
  const grade = scoreRecording(await readArtifact(recorder.path), review);
  expect(grade).toMatchObject({ runtimePassed: true, passed: false, results: [{
    runtimeOutcome: "stop", correctness: "pass", relevance: "pass", groundedness: "pass", taskCompletion: "fail", outcome: "fail"
  }] });
});
it("does not upgrade legacy reviews into task-completion evidence", async () => {
  const recorder = await setup({ capture: "answers" }); turn(recorder); await recorder.finish();
  const { groundedness, taskCompletion, ...legacyRating } = annotations().ratings[0];
  const grade = scoreRecording(await readArtifact(recorder.path), { ...annotations(), version: 1, ratings: [legacyRating] });
  expect(grade).toMatchObject({ annotationVersion: 1, runtimePassed: true, passed: false,
    results: [{ groundedness: "unavailable", taskCompletion: "unavailable", outcome: "unavailable" }] });
});
it("requires groundedness even when an answer completes the requested format", async () => {
  const recorder = await setup({ capture: "answers" }); turn(recorder); await recorder.finish();
  const review = annotations(); review.ratings[0].groundedness = "fail"; review.ratings[0].unsupportedClaims = "yes";
  expect(scoreRecording(await readArtifact(recorder.path), review)).toMatchObject({ passed: false,
    results: [{ groundedness: "fail", taskCompletion: "pass", outcome: "fail" }] });
});
it("keeps absent quality ratings unavailable and rejects missing v2 dimensions", async () => {
  const recorder = await setup({ capture: "answers" }); turn(recorder); await recorder.finish();
  const run = await readArtifact(recorder.path), review = annotations();
  review.ratings[0].taskCompletion = "unrated";
  expect(scoreRecording(run, review)).toMatchObject({ passed: false, results: [{ taskCompletion: "unavailable", outcome: "unavailable" }] });
  const { taskCompletion, ...incomplete } = review.ratings[0];
  expect(() => scoreRecording(run, { ...review, ratings: [incomplete] })).toThrow();
});
