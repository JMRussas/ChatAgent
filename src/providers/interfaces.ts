import type { DeepResult, DeepTask, UserMessage } from "../domain/types";

export interface FastModelProvider {
  createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }): Promise<string>;
}

export interface DeepModelProvider {
  resolveDeepTask(input: DeepTask): Promise<DeepResult>;
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
