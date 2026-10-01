import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ChatTimelineEvent } from "../../domain/types";
import { canonical, digest, redact, redactConfiguration, type Dataset, type RecordedEvent, type RecorderConfig, type RunArtifact } from "./contract";

export type ArtifactWriter = (path: string, serialized: string) => Promise<void>;
export const writeArtifact: ArtifactWriter = async (path, serialized) => {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
};
export class EvaluationRecorder {
  readonly runId = randomUUID();
  readonly path: string;
  private artifact: RunArtifact;
  private bytes = 0;
  private readonly started: number;
  private closed = false;
  private scheduled = false;
  private writes: Promise<void> = Promise.resolve();
  private finishPromise?: Promise<void>;
  private retentionTimer: ReturnType<typeof setTimeout>;
  private promptIds = new Map<string, string>();
  private turns = new Map<string, string | null>();
  private openCalls = new Set<string>();
  private pendingPhases = new Set<string>();
  constructor(readonly config: RecorderConfig, dataset: Dataset, configuration: unknown, code: RunArtifact["manifest"]["code"],
    private writer: ArtifactWriter = writeArtifact, private clock: () => number = Date.now) {
    this.started = clock();
    this.path = join(config.root, this.runId, "run.json");
    for (const prompt of dataset.prompts) this.promptIds.set(digest(prompt.text), prompt.id);
    // Configuration is caller-allowlisted; redact again at the persistence boundary.
    const safeConfiguration = redactConfiguration(configuration);
    this.artifact = { schemaVersion: "chatagent-evaluation-v1", manifest: {
      runId: this.runId, status: "recording", startedAtIso: new Date(this.started).toISOString(), expiresAtIso: new Date(this.started + config.retentionMs).toISOString(), endedAtIso: null,
      dataset: { version: dataset.version, digest: digest(canonical(dataset)) }, configuration: safeConfiguration, configurationDigest: digest(canonical(safeConfiguration)), code,
      capture: config.capture, redaction: "allowlist-and-common-secrets-v1", maxBytes: config.maxBytes, maxEvents: config.maxEvents, repetition: config.repetition, condition: config.condition,
      supportedCalls: ["fast", "deep"], privateReasoningCaptured: false, droppedEvents: 0, failureCode: null }, trace: [],
      summary: { mode: "unknown", eventCount: 0, wallMs: 0, usage: null, costUsd: null, quality: "unrated", recorderCpuMs: 0, recorderOverheadMs: null } };
    this.bytes = Buffer.byteLength(JSON.stringify(this.artifact)) + 1024;
    if (this.bytes > config.maxBytes) this.fail("EVAL_MANIFEST_TOO_LARGE");
    this.retentionTimer = setTimeout(() => { void this.expire(); }, config.retentionMs);
    this.retentionTimer.unref();
  }
  private identity(kind: string, value: string) { return digest(`${this.runId}:${kind}:${value}`); }
  private fail(code: string) { this.artifact.manifest.status = "failed"; this.artifact.manifest.failureCode = code; }
  invalidate(code: "EVAL_RUNTIME_SHUTDOWN_TIMEOUT" | "EVAL_STARTUP_FAILED" | "EVAL_STORAGE_UNAVAILABLE") { this.fail(code); void this.finish().catch(() => undefined); }
  status() { return { runId: this.runId, status: this.artifact.manifest.status, failureCode: this.artifact.manifest.failureCode, droppedEvents: this.artifact.manifest.droppedEvents }; }
  record = (conversation: string, event: ChatTimelineEvent): void => {
    const begin = performance.now();
    try {
      if (this.closed || this.artifact.manifest.status === "failed") return;
      if (this.clock() >= Date.parse(this.artifact.manifest.expiresAtIso)) { this.fail("EVAL_RETENTION_EXPIRED"); return; }
      if (this.artifact.trace.length >= this.config.maxEvents || this.bytes >= this.config.maxBytes) { this.artifact.manifest.droppedEvents++; return; }
      const conversationId = this.identity("conversation", conversation), turnId = this.identity("turn", JSON.stringify([conversation, event.messageId ?? "unknown"]));
      const textHash = digest(event.text);
      const promptId = event.type === "user" ? this.promptIds.get(textHash) ?? null : this.turns.get(turnId) ?? null;
      const callId = event.attemptId ? this.identity("attempt", event.attemptId) : null;
      const answerEvent = event.type === "provisional" || event.type === "refined";
      const captured = answerEvent && this.config.capture === "answers" ? redact(event.text) : undefined;
      const safeLabel = (value: string | undefined) => value === undefined ? null : redact(value).slice(0, 512);
      const record: RecordedEvent = { sequence: this.artifact.trace.length + 1, timelineSequence: event.sequence ?? null,
        elapsedMs: Math.max(0, this.clock() - this.started), timestampIso: new Date(this.clock()).toISOString(),
        conversationId, turnId, taskId: event.taskId ? this.identity("task", event.taskId) : null, callId, parentCallId: turnId,
        type: event.type, phase: event.phase ?? null, activity: event.activity ?? null, finishReason: event.finishReason ?? null,
        retrying: event.retrying ?? false, route: event.routeDecision ?? null, promptId, textHash,
        errorCode: event.errorCode && /^[A-Z][A-Z0-9_]{0,79}$/.test(event.errorCode) ? event.errorCode : null,
        model: event.model ? { provider: safeLabel(event.model.provider)!, model: safeLabel(event.model.model)!, bindingId: safeLabel(event.model.bindingId),
          bindingRevision: safeLabel(event.model.selection?.revision), resolvedModel: null, modelRevision: null, reasoningEnabled: event.model.reasoningEnabled ?? null } : null,
        answerKind: event.answerKind ?? null,
        answer: answerEvent ? { scoredHash: textHash, artifactHash: captured === undefined ? null : digest(captured),
          transformed: captured !== undefined && captured !== event.text, ...(captured === undefined ? {} : { text: captured }) } : null,
        usage: null, costUsd: null,
        ...(event.attachedReferences?.length ? {attachedReferences:(()=>{
          const raw=JSON.stringify(event.attachedReferences),captured=this.config.capture === "answers" ? redact(raw) : undefined;
          return {contentHash:digest(raw),artifactHash:captured === undefined ? null : digest(captured),transformed:captured !== undefined && captured !== raw,count:event.attachedReferences.length,...(captured === undefined ? {} : {text:captured})};
        })()} : {}),
        ...(event.contextBudget ? {contextBudget:event.contextBudget} : {}),
        ...(event.groundedAnswer ? {groundedAnswer:(()=>{
          const raw=JSON.stringify(event.groundedAnswer),captured=this.config.capture === "answers" ? redact(raw) : undefined;
          return {contentHash:digest(raw),artifactHash:captured === undefined ? null : digest(captured),transformed:captured !== undefined && captured !== raw,...(captured === undefined ? {} : {text:captured})};
        })()} : {}),
        ...(event.roleExecution ? {roleExecution:(()=>{
          const raw=JSON.stringify(event.roleExecution),captured=this.config.capture === "answers" ? redact(raw) : undefined;
          return {contentHash:digest(raw),artifactHash:captured === undefined ? null : digest(captured),transformed:captured !== undefined && captured !== raw,...(captured === undefined ? {} : {text:captured})};
        })()} : {}),
        ...(event.runControls ? {runControls:{...event.runControls,
          ...(event.runControls.roleId ? {roleId:redact(event.runControls.roleId)} : {}),
          ...(event.runControls.toolIds ? {toolIds:event.runControls.toolIds.map(redact)} : {}),
          ...(event.runControls.bindingId ? {bindingId:redact(event.runControls.bindingId)} : {}),
          ...(event.runControls.targetMessageId ? {targetMessageId:this.identity("message",event.runControls.targetMessageId)} : {})}} : {}),
        ...(event.selectedContext ? {selectedContext:(() => {
          const raw = JSON.stringify(event.selectedContext), captured = this.config.capture === "answers" ? redact(raw) : undefined;
          return {contentHash:digest(raw), artifactHash:captured === undefined ? null : digest(captured),
            transformed:captured !== undefined && captured !== raw,referenceStatus:event.selectedContext.referenceStatus,
            ...(captured === undefined ? {} : {text:captured})};
        })()} : {}),
        ...(event.payloadResults?.length ? {payloads:event.payloadResults.map(result => {
          const raw = JSON.stringify(result), captured = this.config.capture === "answers" ? redact(raw) : undefined;
          return {resultId:this.identity("result",result.context.resultId),contentHash:digest(raw),
            artifactHash:captured === undefined ? null : digest(captured),transformed:captured !== undefined && captured !== raw,
            ...(captured === undefined ? {} : {text:captured})};
        })} : {}) };
      const size = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (this.bytes + size > this.config.maxBytes) { this.artifact.manifest.droppedEvents++; return; }
      this.bytes += size; this.artifact.trace.push(record);
      if (event.type === "user") {
        this.turns.set(turnId, promptId); this.pendingPhases.add(`${turnId}:fast`);
        if (event.routeDecision === "deep") this.pendingPhases.add(`${turnId}:deep`);
      }
      if (callId && event.type === "activity") this.openCalls.add(callId);
      if (callId && event.type === "terminal") this.openCalls.delete(callId);
      if (event.type === "terminal" && !event.retrying) this.pendingPhases.delete(`${turnId}:${event.phase}`);
      if (event.type === "terminal") this.scheduleFlush();
    } catch { this.fail("EVAL_CAPTURE_FAILED"); }
    finally { this.artifact.summary.recorderCpuMs += performance.now() - begin; }
  };
  private scheduleFlush() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closed) void this.flush(); });
  }
  private snapshot(): string {
    this.artifact.summary.eventCount = this.artifact.trace.length;
    this.artifact.summary.wallMs = Math.max(0, (this.artifact.manifest.endedAtIso ? Date.parse(this.artifact.manifest.endedAtIso) : this.clock()) - this.started);
    const providers = new Set(this.artifact.trace.flatMap(e => e.model ? [e.model.provider === "mock" ? "synthetic" : "live"] : []));
    this.artifact.summary.mode = providers.size > 1 ? "mixed" : providers.has("live") ? "live" : providers.has("synthetic") ? "synthetic" : "unknown";
    const result = JSON.stringify(this.artifact);
    if (Buffer.byteLength(result) > this.config.maxBytes) throw new Error("EVAL_SIZE_LIMIT");
    return result;
  }
  private async expire() {
    this.closed = true;
    this.fail("EVAL_RETENTION_EXPIRED");
    this.artifact.trace = []; this.turns.clear(); this.openCalls.clear();
    await this.writes;
    await rm(this.path, { force: true }).catch(() => this.fail("EVAL_RETENTION_DELETE_FAILED"));
  }
  flush(): Promise<void> {
    this.writes = this.writes.then(async () => {
      try {
        if (this.clock() >= Date.parse(this.artifact.manifest.expiresAtIso)) {
          this.fail("EVAL_RETENTION_EXPIRED"); await rm(this.path, { force: true }); return;
        }
        await mkdir(join(this.config.root, this.runId), { recursive: true, mode: 0o700 });
        await this.writer(this.path, this.snapshot());
      } catch { this.fail("EVAL_WRITE_FAILED"); }
    });
    return this.writes;
  }
  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.closed = true;
    clearTimeout(this.retentionTimer);
    if (this.artifact.manifest.status !== "failed") this.artifact.manifest.status = this.openCalls.size || this.pendingPhases.size || this.artifact.manifest.droppedEvents ? "incomplete" : "complete";
    this.artifact.manifest.endedAtIso = new Date(this.clock()).toISOString();
    this.finishPromise = this.flush().then(() => {
      if (this.artifact.manifest.status !== "complete") throw new Error(this.artifact.manifest.failureCode ?? "EVAL_RECORDING_INCOMPLETE");
    });
    return this.finishPromise;
  }
}
