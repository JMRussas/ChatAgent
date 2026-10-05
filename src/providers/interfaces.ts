import { z } from "zod";
import { loadDeadLetterRetention } from "../config/deadLetterRetention";
import { GenerationError } from "../domain/generation";
import type { GenerationControl, GenerationMetadata, GenerationResult } from "../domain/generation";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";

export interface FastModelProvider {
  thinkingOptions?(control?: GenerationControl): Promise<("on" | "off")[]>;
  withThinking?(value: "on" | "off", control?: GenerationControl): Promise<FastModelProvider>;
  metadata?: GenerationMetadata;
  createProvisionalReply(
    input: {
      message: UserMessage;
      correctedText: string;
      routeDecision: "direct" | "deep" | "clarify";
      // Optional so direct/legacy callers (existing adapter unit tests) keep
      // using each adapter's current-prompt-only fallback; every orchestrated
      // call carries one (spec 01).
      context?: ConversationContext;
    },
    control?: GenerationControl
  ): Promise<GenerationResult>;
}

export interface DeepModelProvider {
  metadata?: GenerationMetadata;
  resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult>;
}

export interface TaskQueue {
  enqueue(task: DeepTask): Promise<void>;
  dequeue(): Promise<DeepTask | undefined>;
  /** Optional inspection used by identity retirement; absent means it cannot tell. */
  hasConversation?(conversationId: string): boolean;
  /** Removes queued entries only; without removal, cancellation retains resources until dequeue.
   * Dequeued work retains its lifecycle until physical settlement. */
  removeMessage?(conversationId: string, messageId: string): DeepTask[];
}

export class InMemoryTaskQueue implements TaskQueue {
  private tasks: DeepTask[] = [];

  readonly capacity: number;
  readonly maxBytes: number;
  private bytes = 0;
  private readonly sizes = new WeakMap<DeepTask, number>();
  constructor(
    capacity = process.env.DEEP_QUEUE_MAX_TASKS === undefined
      ? loadDeadLetterRetention().maxRecords
      : Number(process.env.DEEP_QUEUE_MAX_TASKS),
    maxBytes = process.env.DEEP_QUEUE_MAX_BYTES === undefined
      ? loadDeadLetterRetention().maxBytes
      : Number(process.env.DEEP_QUEUE_MAX_BYTES)
  ) {
    this.capacity = z.number().int().min(1).max(10000).parse(capacity);
    this.maxBytes = z.number().int().min(1).max(268435456).parse(maxBytes);
  }
  async enqueue(task: DeepTask): Promise<void> {
    const snapshot = structuredClone(task);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (this.tasks.length >= this.capacity || this.bytes + bytes > this.maxBytes)
      throw new GenerationError("DEEP_QUEUE_CAPACITY", false);
    this.tasks.push(snapshot);
    this.sizes.set(snapshot, bytes);
    this.bytes += bytes;
  }

  async dequeue(): Promise<DeepTask | undefined> {
    const task = this.tasks.shift();
    if (task) this.bytes -= this.sizes.get(task)!;
    return task;
  }

  retentionStats() {
    return {
      queued: this.tasks.length,
      bytes: this.bytes,
      capacity: this.capacity,
      maxBytes: this.maxBytes
    };
  }
  size(): number {
    return this.tasks.length;
  }

  removeMessage(conversationId: string, messageId: string): DeepTask[] {
    const removed = this.tasks.filter(
      (task) =>
        task.conversationId === conversationId && (task.messageId ?? task.taskId) === messageId
    );
    const entries = new Set(removed);
    this.tasks = this.tasks.filter((task) => !entries.has(task));
    for (const task of removed) this.bytes -= this.sizes.get(task)!;
    return removed;
  }
  hasConversation(conversationId: string): boolean {
    return this.tasks.some((task) => task.conversationId === conversationId);
  }
}

/** The current chat input is text-only. Reject action/input payloads explicitly
 * rather than silently stripping them and implying the action was performed. */
export function rejectUnsupportedInputs(input: unknown): void {
  if (
    input &&
    typeof input === "object" &&
    ["images", "attachments", "tools", "actions"].some((key) => key in input)
  )
    throw new GenerationError("CAPABILITY_UNSUPPORTED", false);
}
