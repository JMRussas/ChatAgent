import { loadExecutionRetention, type ExecutionRetention } from "../config/executionRetention";
import { randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";
import {
  GenerationError,
  type GenerationControl,
  type GenerationMetadata
} from "../domain/generation";
import { MAX_ANSWER_BYTES } from "../providers/streaming";
import type { TaskQueue } from "../providers/interfaces";
import type { ConversationTimelineStore } from "./timelineStore";

type Phase = "fast" | "deep";
type Status = "queued" | "running" | "stop" | "length" | "cancelled" | "error";
export class DuplicateMessageError extends Error {
  readonly code = "DUPLICATE_MESSAGE_ID";
}
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
  writesSettled = false;
  model?: GenerationMetadata;
  dispatchId?: string;
  constructor(
    readonly conversationId: string,
    readonly messageId: string,
    readonly phase: Phase,
    private timeline: ConversationTimelineStore,
    readonly taskId?: string,
    private onSettled: () => void = () => {}
  ) {}
  get active() {
    return this.status === "queued" || this.status === "running";
  }
  private append(event: Omit<ChatTimelineEvent, "messageId" | "createdAtIso">) {
    const full = {
      ...event,
      messageId: this.messageId,
      phase: this.phase,
      attemptId: this.attemptId,
      taskId: this.taskId,
      model: this.model,
      createdAtIso: new Date().toISOString()
    };
    this.writes = this.writes.then(() => this.timeline.appendEvent(this.conversationId, full));
    // Retain failure for awaiting callers without an unhandled timer rejection.
    void this.writes.catch((error) => {
      this.writeError = error;
    });
    return this.writes;
  }
  async queued(retrying = false) {
    if (!this.active) return;
    await this.append({
      type: "activity",
      activity: retrying ? "retrying" : "queued",
      ...(this.phase === "deep" ? { routeDecision: "deep" as const } : {}),
      text: retrying
        ? `Retrying the ${this.phase} provider`
        : `Waiting for the ${this.phase} provider`
    });
  }
  async start(timeline: ConversationTimelineStore, model?: GenerationMetadata) {
    if (!this.active) return;
    this.timeline = timeline;
    this.model = model;
    this.status = "running";
    await this.append({
      type: "activity",
      activity: "running",
      text: this.phase === "deep" ? "Working on a deeper answer" : "Working on a reply"
    });
  }
  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return this.writes;
    const text = this.pending;
    this.pending = "";
    this.lastFlush = Date.now();
    return this.append({ type: "delta", text });
  }
  readonly control: GenerationControl = {
    signal: this.controller.signal,
    attemptId: this.attemptId,
    onQueued: async (reason) => {
      if (this.active)
        await this.append({
          type: "activity",
          activity: "queued",
          text:
            reason === "quota"
              ? "Waiting for provider quota to reset"
              : "Waiting for provider capacity"
        });
    },
    onDelta: async (text) => {
      if (!this.active) return;
      if (this.writeError) throw this.writeError;
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > MAX_ANSWER_BYTES) throw new GenerationError("ANSWER_TOO_LARGE", false);
      this.text += text;
      this.pending += text;
      const wait = Math.max(0, 50 - (Date.now() - this.lastFlush));
      if (!wait) await this.flush();
      else if (!this.timer)
        this.timer = setTimeout(() => {
          void this.flush().catch(() => undefined);
        }, wait);
    }
  };
  finish(
    reason: Exclude<Status, "queued" | "running">,
    answer?: Partial<ChatTimelineEvent>,
    errorCode?: string,
    retrying = false
  ): Promise<void> {
    if (this.completion) return this.completion;
    if (!this.active) return this.writes;
    // Claim terminal state synchronously, before any await. Cancellation and completion cannot both win.
    this.status = reason;
    if (reason === "cancelled") this.controller.abort(new GenerationError("CANCELLED", false));
    this.completion = (async () => {
      await this.flush();
      if (answer)
        await this.append({
          type: this.phase === "fast" ? "provisional" : "refined",
          text: this.text,
          ...answer
        });
      await this.append({
        type: "terminal",
        text: this.text,
        finishReason: reason,
        errorCode,
        retrying
      });
    })().finally(() => {
      this.writesSettled = true;
      this.onSettled();
    });
    return this.completion;
  }
}

export class GenerationLifecycle {
  private readonly completed = new Map<string, number>();
  private readonly consumers = new Map<string, number>();
  private readonly tasks = new Map<string, () => void>();
  constructor(
    private readonly retention: ExecutionRetention = loadExecutionRetention(),
    private readonly clock = Date.now
  ) {}
  retentionStats() {
    this.prune();
    return {
      turns: this.turns.size,
      claimed: this.claimed.size,
      retained: this.completed.size,
      consumers: [...this.consumers.values()].reduce((a, b) => a + b, 0),
      tasks: this.tasks.size
    };
  }
  retain(conversationId: string, messageId: string) {
    const key = this.key(conversationId, messageId);
    this.completed.delete(key);
    this.consumers.set(key, (this.consumers.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.consumers.get(key)! - 1;
      if (remaining) this.consumers.set(key, remaining);
      else this.consumers.delete(key);
      this.settled(key);
    };
  }
  releaseTask(taskId: string) {
    const release = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    release?.();
  }
  private settled(key: string) {
    const phases = this.turns.get(key);
    if (
      this.consumers.has(key) ||
      !phases?.size ||
      [...phases.values()].some((a) => a.active || !a.writesSettled)
    )
      return;
    if (!this.completed.has(key)) this.completed.set(key, this.clock());
    this.prune();
  }
  private prune() {
    for (const [key, at] of this.completed) {
      if (
        this.clock() - at < this.retention.completedTtlMs &&
        this.completed.size <= this.retention.maxCompleted
      )
        continue;
      this.turns.delete(key);
      this.claimed.delete(key);
      this.completed.delete(key);
    }
  }
  private closing = false;
  private closingWrites = new Set<Promise<void>>();
  private closingError: unknown;
  closeAdmissions() {
    this.closing = true;
  }
  registeredTurns() {
    this.prune();
    return [...this.turns.values()].flatMap((phases) => {
      const first = [...phases.values()][0];
      return first ? [{ conversationId: first.conversationId, messageId: first.messageId }] : [];
    });
  }
  async flushClosingWrites() {
    await Promise.all(this.closingWrites);
    if (this.closingError) throw this.closingError;
  }
  private claimed = new Set<string>();
  private turns = new Map<string, Map<Phase, GenerationAttempt>>();
  private key(conversationId: string, messageId: string) {
    return JSON.stringify([conversationId, messageId]);
  }
  claim(conversationId: string, messageId: string) {
    this.prune();
    const key = this.key(conversationId, messageId);
    if (this.claimed.has(key))
      throw new DuplicateMessageError("This messageId is already registered in this conversation.");
    this.claimed.add(key);
  }
  /** Execution-cache expiry does not expire identities still present in history. */
  async claimMessage(
    conversationId: string,
    messageId: string,
    timeline: ConversationTimelineStore
  ) {
    this.claim(conversationId, messageId); // Serialize contenders before the history read.
    try {
      const events = await timeline.getEvents(conversationId);
      if (events.some((event) => event.type === "user" && event.messageId === messageId))
        throw new DuplicateMessageError(
          "This messageId already exists in this conversation's history."
        );
    } catch (error) {
      this.release(conversationId, messageId);
      throw error;
    }
  }
  release(conversationId: string, messageId: string) {
    this.claimed.delete(this.key(conversationId, messageId));
  }
  get(conversationId: string, messageId: string, phase: Phase) {
    this.prune();
    return this.turns.get(this.key(conversationId, messageId))?.get(phase);
  }
  create(
    conversationId: string,
    messageId: string,
    phase: Phase,
    timeline: ConversationTimelineStore,
    taskId?: string
  ) {
    const key = this.key(conversationId, messageId);
    this.completed.delete(key);
    this.claimed.add(key); // Explicit replay also owns the message identity.
    if (taskId && !this.tasks.has(taskId))
      this.tasks.set(taskId, this.retain(conversationId, messageId));
    const phases = this.turns.get(key) ?? new Map<Phase, GenerationAttempt>();
    const attempt = new GenerationAttempt(conversationId, messageId, phase, timeline, taskId, () =>
      this.settled(key)
    );
    phases.set(phase, attempt);
    this.turns.set(key, phases);
    if (this.closing) {
      const completion = attempt.finish("cancelled");
      this.closingWrites.add(completion);
      void completion
        .catch((error) => {
          this.closingError ??= error;
        })
        .finally(() => this.closingWrites.delete(completion));
    }
    return attempt;
  }
  async cancel(conversationId: string, messageId: string) {
    this.prune();
    const phases = this.turns.get(this.key(conversationId, messageId));
    if (!phases) return undefined;
    await Promise.all(
      [...phases.values()].filter((a) => a.active).map((a) => a.finish("cancelled"))
    );
    return {
      messageId,
      phases: Object.fromEntries([...phases].map(([phase, attempt]) => [phase, attempt.status]))
    };
  }
}
const lifecycles = new WeakMap<TaskQueue, GenerationLifecycle>();
/** One queue is one runtime. Direct construction and ChatService share the same registry. */
export function generationLifecycle(queue: TaskQueue) {
  let registry = lifecycles.get(queue);
  if (!registry) {
    registry = new GenerationLifecycle();
    lifecycles.set(queue, registry);
  }
  return registry;
}
