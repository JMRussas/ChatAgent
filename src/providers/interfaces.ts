import { GenerationError } from "../domain/generation";
import type { GenerationControl, GenerationMetadata, GenerationResult } from "../domain/generation";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";

export interface FastModelProvider {
  thinkingOptions?(control?: GenerationControl): Promise<("on" | "off")[]>;
  withThinking?(value: "on" | "off", control?: GenerationControl): Promise<FastModelProvider>;
  metadata?: GenerationMetadata;
  createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
    // Optional so direct/legacy callers (existing adapter unit tests) keep
    // using each adapter's current-prompt-only fallback; every orchestrated
    // call carries one (spec 01).
    context?: ConversationContext;
  }, control?: GenerationControl): Promise<GenerationResult>;
}

export interface DeepModelProvider {
  metadata?: GenerationMetadata;
  resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult>;
}

export interface TaskQueue {
  enqueue(task: DeepTask): Promise<void>;
  dequeue(): Promise<DeepTask | undefined>;
}

export class InMemoryTaskQueue implements TaskQueue {
  private readonly tasks: DeepTask[] = [];

  async enqueue(task: DeepTask): Promise<void> {
    this.tasks.push(task);
  }

  async dequeue(): Promise<DeepTask | undefined> {
    return this.tasks.shift();
  }

  size(): number {
    return this.tasks.length;
  }
}

/** The current chat input is text-only. Reject action/input payloads explicitly
 * rather than silently stripping them and implying the action was performed. */
export function rejectUnsupportedInputs(input: unknown): void {
  if (input && typeof input === "object" && ["images", "attachments", "tools", "actions"].some(key => key in input))
    throw new GenerationError("CAPABILITY_UNSUPPORTED", false);
}
