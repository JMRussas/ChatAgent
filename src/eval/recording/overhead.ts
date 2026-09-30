import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ChatTimelineEvent } from "../../domain/types";
import { InMemoryConversationTimelineStore } from "../../app/timelineStore";
import { canonical, digest, type RunArtifact } from "./contract";
import { EvaluationRecorder, writeArtifact, type ArtifactWriter } from "./recorder";
import { startHttpOverhead } from "./httpOverhead";
import { validateArtifact } from "./storage";

export interface OverheadOptions { root: string; pairs: number; warmupPairs: number; turns: number; capture: "metadata" | "answers"; execution?: "timeline" | "http" }
export function overheadWorkload(turns: number) {
  const dataset = { version: "recorder-overhead-v1", prompts: Array.from({ length: turns }, (_, i) => ({ id: `p${i}`, text: `Synthetic prompt ${i}` })) };
  const events: Array<{ conversation: string; event: ChatTimelineEvent }> = [];
  for (let i = 0; i < turns; i++) {
    const conversation = `c${i}`, messageId = `m${i}`, deep = i % 2 === 1;
    const append = (event: Omit<ChatTimelineEvent, "messageId" | "createdAtIso">) => events.push({ conversation,
      event: { ...event, messageId, createdAtIso: "2026-09-30T00:00:00.000Z" } });
    append({ type: "user", text: dataset.prompts[i].text, routeDecision: deep ? "deep" : "direct" });
    for (const phase of deep ? ["fast", "deep"] as const : ["fast"] as const) {
      const model = { provider: "mock", model: "overhead-fixture", bindingId: `fixture-${phase}` };
      if (phase === "deep") {
        const attemptId = `${messageId}-${phase}-retry`;
        append({ type: "activity", phase, attemptId, model, activity: "running", text: "" });
        append({ type: "terminal", phase, attemptId, model, text: "", finishReason: "error", retrying: true, errorCode: "PROVIDER_UNAVAILABLE" });
      }
      const attemptId = `${messageId}-${phase}`;
      append({ type: "activity", phase, attemptId, model, activity: "running", text: "" });
      const chunk = "Synthetic answer text. ".repeat(8);
      for (let part = 0; part < 4; part++) append({ type: "delta", phase, attemptId, model, text: chunk });
      append({ type: phase === "fast" ? "provisional" : "refined", phase, attemptId, model, text: chunk.repeat(4), answerKind: "substantive" });
      append({ type: "terminal", phase, attemptId, model, text: chunk.repeat(4), finishReason: "stop" });
    }
  }
  return { dataset, events };
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted[sorted.length - 1] };
}
export async function measureRecorderOverhead(options: OverheadOptions, code: RunArtifact["manifest"]["code"], writer: ArtifactWriter = writeArtifact) {
  for (const [value, min, max] of [[options.pairs, 2, 100], [options.warmupPairs, 1, 10], [options.turns, 2, 100]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("EVAL_OVERHEAD_INVALID_OPTIONS");
  }
  if (!["metadata", "answers"].includes(options.capture) || !code.revision || !code.sourceDigest || code.dirty === null) throw new Error("EVAL_OVERHEAD_MISSING_IDENTITY");
  const workload = overheadWorkload(options.turns);
  const execution = options.execution ?? "timeline";
  if (!["timeline", "http"].includes(execution)) throw new Error("EVAL_OVERHEAD_INVALID_OPTIONS");
  if (execution === "http") workload.dataset = { version: "recorder-http-overhead-v1", prompts: workload.dataset.prompts.map((p, i) => ({ ...p,
    text: i % 2 ? `Compare and design code for a complex distributed system case ${i} with detailed tradeoffs and cite sources` : `Explain event loops for application case ${i}` })) };
  const configuration = { method: execution === "http" ? "mock-http-runtime-v1" : "timeline-replay-v1",
    ...(execution === "http" ? { workerIntervalMs: 5, pollIntervalMs: 5, deadlineMs: 5000 } : {}), capture: options.capture, turns: options.turns,
    maxBytes: 67108864, maxEvents: 10000, retentionMs: 3600000 };
  const run = async (enabled: boolean) => {
    // Directory creation/deletion and verification are excluded equally from both conditions.
    const root = await mkdtemp(join(options.root, "recorder-overhead-"));
    let recorder: EvaluationRecorder | undefined;
    let http: Awaited<ReturnType<typeof startHttpOverhead>> | undefined;
    let writes = 0, writtenBytes = 0;
    try {
      const start = performance.now();
      if (enabled) {
        recorder = new EvaluationRecorder({ root, capture: options.capture, maxBytes: configuration.maxBytes,
          maxEvents: configuration.maxEvents, retentionMs: configuration.retentionMs, repetition: 1, condition: "warm" },
        workload.dataset, configuration, code, async (path, data) => { writes++; writtenBytes += Buffer.byteLength(data); await writer(path, data); });
        await recorder.flush();
      }
      const timeline = new InMemoryConversationTimelineStore(recorder?.record);
      if (execution === "http") http = await startHttpOverhead(timeline, workload.dataset, async () => { await recorder?.finish(); });
      const setupMs = performance.now() - start;
      const feedStart = performance.now();
      const httpResult = http ? await http.run() : undefined;
      if (!http) for (const { conversation, event } of workload.events) await timeline.appendEvent(conversation, event);
      const feedMs = performance.now() - feedStart;
      const flushStart = performance.now();
      if (http) await http.close();
      else await recorder?.finish();
      const flushMs = performance.now() - flushStart;
      const totalMs = performance.now() - start;
      let recorderCpuMs = 0, artifactBytes = 0;
      if (recorder) {
        const serialized = await readFile(recorder.path, "utf8");
        const artifact = validateArtifact(JSON.parse(serialized));
        if (artifact.manifest.status !== "complete" || artifact.manifest.droppedEvents || artifact.trace.length !== (httpResult?.eventCount ?? workload.events.length)) throw new Error("EVAL_OVERHEAD_INVALID_RECORDING");
        recorderCpuMs = artifact.summary.recorderCpuMs; artifactBytes = Buffer.byteLength(serialized);
      }
      const output = [];
      if (!http) for (let i = 0; i < options.turns; i++) output.push((await timeline.getEvents(`c${i}`)).map(({ eventId: _, ...event }) => event));
      return { setupMs, feedMs, flushMs, totalMs, recorderCpuMs, writes, writtenBytes, artifactBytes, outputDigest: digest(canonical(httpResult?.output ?? output)),
        eventCount: httpResult?.eventCount ?? workload.events.length, observations: httpResult?.observations ?? null };
    } finally {
      await http?.close().catch(() => undefined);
      await recorder?.finish().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
  type Sample = Awaited<ReturnType<typeof run>>;
  const pairs: Array<{ order: "off-on" | "on-off"; off: Sample; on: Sample; deltaMs: { setup: number; feed: number; flush: number; total: number } }> = [];
  for (let index = -options.warmupPairs; index < options.pairs; index++) {
    const onFirst = Math.abs(index) % 2 === 1;
    const first = await run(onFirst), second = await run(!onFirst);
    const on = onFirst ? first : second, off = onFirst ? second : first;
    if (on.outputDigest !== off.outputDigest) throw new Error("EVAL_OVERHEAD_BEHAVIOR_MISMATCH");
    if (index >= 0) pairs.push({ order: onFirst ? "on-off" : "off-on", on, off,
      deltaMs: { setup: on.setupMs - off.setupMs, feed: on.feedMs - off.feedMs, flush: on.flushMs - off.flushMs, total: on.totalMs - off.totalMs } });
  }
  return { schemaVersion: "chatagent-recorder-overhead-v1", generatedAtIso: new Date().toISOString(), mode: "synthetic",
    scope: execution === "http" ? "loopback HTTP, production orchestration/context/retries/automatic worker and shutdown; mock providers; excludes discovery, catalog dispatch, live inference and directory cleanup"
      : "in-process timeline replay with real recorder writes; excludes inference, HTTP, startup discovery and directory cleanup",
    environment: { node: process.version, platform: process.platform, architecture: process.arch }, code,
    configuration, configurationDigest: digest(canonical(configuration)), workloadDigest: digest(canonical(execution === "http" ? workload.dataset : workload)),
    eventCount: pairs[0].on.eventCount, warmupPairs: options.warmupPairs, pairs,
    summary: { setupDeltaMs: distribution(pairs.map(p => p.deltaMs.setup)), feedDeltaMs: distribution(pairs.map(p => p.deltaMs.feed)),
      flushDeltaMs: distribution(pairs.map(p => p.deltaMs.flush)), totalDeltaMs: distribution(pairs.map(p => p.deltaMs.total)) },
    quality: null, usage: null, costUsd: null, liveOverheadMs: null };
}
