import { randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";
import { GenerationError, type GenerationControl, type GenerationMetadata } from "../domain/generation";
import { MAX_ANSWER_BYTES } from "../providers/streaming";
import type { TaskQueue } from "../providers/interfaces";
import type { ConversationTimelineStore } from "./timelineStore";

type Phase = "fast" | "deep";
type Status = "queued" | "running" | "stop" | "length" | "cancelled" | "error";
export class DuplicateMessageError extends Error { readonly code = "DUPLICATE_MESSAGE_ID"; }
export class GenerationAttempt {
  readonly attemptId = randomUUID();
  readonly controller = new AbortController();
  status: Status = "queued";
  text = "";
  private bytes = 0;
  private pending = "";
  private lastFlush = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private writeError?: unknown;
  private completion?: Promise<void>;
  model?: GenerationMetadata;
  dispatchId?: string;
  constructor(readonly conversationId: string, readonly messageId: string, readonly phase: Phase,
    private timeline: ConversationTimelineStore, readonly taskId?: string) {}
  get active() { return this.status === "queued" || this.status === "running"; }
  private append(event: Omit<ChatTimelineEvent, "messageId" | "createdAtIso">) {
    const full = { ...event, messageId: this.messageId, phase: this.phase, attemptId: this.attemptId,
      taskId: this.taskId, model: this.model, createdAtIso: new Date().toISOString() };
    this.writes = this.writes.then(() => this.timeline.appendEvent(this.conversationId, full));
    // Retain failure for awaiting callers without an unhandled timer rejection.
    void this.writes.catch(error => { this.writeError = error; });
    return this.writes;
  }
  async queued(retrying = false) {
    if (!this.active) return;
    await this.append({ type: "activity", activity: retrying ? "retrying" : "queued", ...(this.phase === "deep" ? { routeDecision: "deep" as const } : {}),
      text: retrying ? `Retrying the ${this.phase} provider` : `Waiting for the ${this.phase} provider` });
  }
  async start(timeline: ConversationTimelineStore, model?: GenerationMetadata) {
    if (!this.active) return;
    this.timeline = timeline;
    this.model = model;
    this.status = "running";
    await this.append({ type: "activity", activity: "running",
      text: this.phase === "deep" ? "Working on a deeper answer" : "Working on a reply" });
  }
  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return this.writes;
    const text = this.pending; this.pending = ""; this.lastFlush = Date.now();
    return this.append({ type: "delta", text });
  }
  readonly control: GenerationControl = {
    signal: this.controller.signal,
    attemptId: this.attemptId,
    onDelta: async text => {
      if (!this.active) return;
      if (this.writeError) throw this.writeError;
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > MAX_ANSWER_BYTES) throw new GenerationError("ANSWER_TOO_LARGE", false);
      this.text += text; this.pending += text;
      const wait = Math.max(0, 50 - (Date.now() - this.lastFlush));
      if (!wait) await this.flush();
      else if (!this.timer) this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, wait);
    }
  };
  finish(reason: Exclude<Status, "queued" | "running">, answer?: Partial<ChatTimelineEvent>, errorCode?: string, retrying = false): Promise<void> {
    if (this.completion) return this.completion;
    if (!this.active) return this.writes;
    // Claim terminal state synchronously, before any await. Cancellation and completion cannot both win.
    this.status = reason;
    if (reason === "cancelled") this.controller.abort(new GenerationError("CANCELLED", false));
    this.completion = (async () => {
      await this.flush();
      if (answer) await this.append({ type: this.phase === "fast" ? "provisional" : "refined", text: this.text, ...answer });
      await this.append({ type: "terminal", text: this.text, finishReason: reason, errorCode, retrying });
    })();
    return this.completion;
  }
}

export class GenerationLifecycle {
  private claimed = new Set<string>();
  private turns = new Map<string, Map<Phase, GenerationAttempt>>();
  private key(conversationId: string, messageId: string) { return JSON.stringify([conversationId, messageId]); }
  claim(conversationId: string, messageId: string) {
    const key = this.key(conversationId, messageId);
    if (this.claimed.has(key)) throw new DuplicateMessageError("This messageId is already registered in this conversation.");
    this.claimed.add(key);
  }
  release(conversationId: string, messageId: string) { this.claimed.delete(this.key(conversationId, messageId)); }
  get(conversationId: string, messageId: string, phase: Phase) { return this.turns.get(this.key(conversationId, messageId))?.get(phase); }
  create(conversationId: string, messageId: string, phase: Phase, timeline: ConversationTimelineStore, taskId?: string) {
    const key = this.key(conversationId, messageId);
    const phases = this.turns.get(key) ?? new Map<Phase, GenerationAttempt>();
    const attempt = new GenerationAttempt(conversationId, messageId, phase, timeline, taskId);
    phases.set(phase, attempt); this.turns.set(key, phases);
    return attempt;
  }
  async cancel(conversationId: string, messageId: string) {
    const phases = this.turns.get(this.key(conversationId, messageId));
    if (!phases) return undefined;
    await Promise.all([...phases.values()].filter(a => a.active).map(a => a.finish("cancelled")));
    return { messageId, phases: Object.fromEntries([...phases].map(([phase, attempt]) => [phase, attempt.status])) };
  }
}
const lifecycles = new WeakMap<TaskQueue, GenerationLifecycle>();
/** One queue is one runtime. Direct construction and ChatService share the same registry. */
export function generationLifecycle(queue: TaskQueue) {
  let registry = lifecycles.get(queue);
  if (!registry) { registry = new GenerationLifecycle(); lifecycles.set(queue, registry); }
  return registry;
}
