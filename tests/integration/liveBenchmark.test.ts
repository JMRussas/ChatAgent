import { expect, it } from "vitest";
import { createChatServer } from "../../src/server";
import { createRuntimeHandle } from "../../src/app/runtimeHandle";
import { entry, runtime } from "../helpers/dispatchFixtures";
import { GenerationError } from "../../src/domain/generation";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";

it("retains provider failure and retry evidence through the real HTTP error response", async () => {
  const r = runtime([entry("a")], { a: { fast: { createProvisionalReply: async () => {
    throw new GenerationError("PROVIDER_UNAVAILABLE", true);
  } } } });
  const server = createChatServer(r.service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const handle = createRuntimeHandle(server, r.service, { config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => {}, stopInternal: () => r.manager.shutdown(), persist: async () => {} });
  try {
    const [record] = await runLiveBenchmark([{ id: "hello", text: "Hello" }], {
      baseUrl: `http://127.0.0.1:${handle.address.port}`, pollIntervalMs: 5, deadlineMs: 3000
    });
    expect(record).toMatchObject({ outcome: "error", httpStatus: 502, errorCode: "PROVIDER_UNAVAILABLE",
      routeDecision: "clarify", retryCount: 2, cancellation: "not-requested" });
    expect(record.attempts).toHaveLength(3);
    expect(record.attempts.every(a => a.bindingId !== null && a.finishReason === "error")).toBe(true);
    expect(record.finalObservedMs).not.toBeNull();
  } finally { await handle.shutdown(); }
});

it("links a bracketed HTTP benchmark to its completed recorder and exact-answer grades", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { EvaluationRecorder } = await import("../../src/eval/recording/recorder");
  const { digest } = await import("../../src/eval/recording/contract");
  const { runLiveReport } = await import("../../src/bench/liveReport");
  const { linkLiveRecording } = await import("../../src/eval/recording/linkLive");
  const root = await mkdtemp(join(tmpdir(), "chatagent-http-link-"));
  const dataset = { version: "http-link-v1", prompts: [{ id: "direct", text: "Explain event loops" }, { id: "deep", text: "Compare and design code for a complex distributed system" }] };
  const recorder = new EvaluationRecorder({ root, capture: "answers", maxBytes: 1000000, maxEvents: 1000, retentionMs: 60000, repetition: 1, condition: "cold" },
    dataset, { test: "http-link" }, { revision: "a".repeat(40), sourceDigest: digest("source"), dirty: false });
  const r = runtime([entry("a")], {}, recorder.record);
  const server = createChatServer(r.service, { evaluationStatus: () => ({ enabled: true, ...recorder.status() }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const timer = setInterval(() => { void r.service.runDeepWorkerOnce(); }, 5);
  const handle = createRuntimeHandle(server, r.service, { config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => clearInterval(timer), stopInternal: () => r.manager.shutdown(), persist: () => recorder.finish() });
  try {
    const report = await runLiveReport(dataset.prompts, { baseUrl: `http://127.0.0.1:${handle.address.port}`, pollIntervalMs: 5, deadlineMs: 3000 });
    expect(report.recorderRunId).toBe(recorder.runId);
    await handle.shutdown();
    const artifact = JSON.parse(await readFile(recorder.path, "utf8"));
    const annotations = { version: 1, rubricVersion: "test", judge: { kind: "code", id: "fixture", configurationDigest: digest("fixture") },
      ratings: dataset.prompts.map(p => ({ promptId: p.id, responseHash: digest("a"), correctness: "pass", relevance: "pass", unsupportedClaims: "no" })) };
    const linked = linkLiveRecording(report, artifact, dataset, annotations);
    expect(linked).toMatchObject({ linked: true, qualityPassed: true, mode: "synthetic" });
    expect(linked.observations).toHaveLength(2);
  } finally { await handle.shutdown(); await rm(root, { recursive: true, force: true }); }
});
