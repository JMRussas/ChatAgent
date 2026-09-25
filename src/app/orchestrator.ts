import { randomUUID } from "node:crypto";
import { analyzeFast } from "../domain/router";
import type { DeepResult, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider, TaskQueue } from "../providers/interfaces";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import { NoopDeadLetterStore, type DeadLetterStore } from "./deadLetterStore";
import { NoopConversationTimelineStore, type ConversationTimelineStore } from "./timelineStore";

function nowIso(): string {
  return new Date().toISOString();
}

export class ChatOrchestrator {
  constructor(
    private readonly fastProvider: FastModelProvider,
    private readonly queue: TaskQueue,
    private readonly timelineStore: ConversationTimelineStore = new NoopConversationTimelineStore(),
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {}

  async handleUserMessage(message: UserMessage): Promise<OrchestratorResponse> {
    const messageId = randomUUID();
    await this.timelineStore.appendEvent(message.conversationId, {
      messageId,
      type: "user",
      text: message.text,
      createdAtIso: message.timestampIso
    });

    const analysis = analyzeFast(message);
    const adaptiveDecision = this.adaptiveRouting?.decide(message, analysis);

    const routeDecision = adaptiveDecision?.routeDecision ?? analysis.routeDecision;
    const sizeBand = adaptiveDecision?.sizeBand ?? "medium";

    const adaptedAnalysis = {
      ...analysis,
      routeDecision,
      reasons: adaptiveDecision?.reasons ?? analysis.reasons
    };

    const deepTask = routeDecision === "deep" ? {
      taskId: randomUUID(),
      messageId,
      conversationId: message.conversationId,
      normalizedPrompt: adaptedAnalysis.correctedText,
      createdAtIso: nowIso(),
      sizeBand
    } : undefined;

    // Start deep work independently of the provisional model call.
    if (deepTask) {
      await this.timelineStore.appendEvent(message.conversationId, {
        type: "activity", messageId, routeDecision, activity: "queued",
        text: "Waiting for the deep provider", createdAtIso: nowIso()
      });
      await this.queue.enqueue(deepTask);
    }

    const fastStart = Date.now();

    const provisionalReply = await this.fastProvider.createProvisionalReply({
      message,
      correctedText: adaptedAnalysis.correctedText,
      routeDecision: adaptedAnalysis.routeDecision
    }).catch(async (error: unknown) => {
      if (!deepTask) {
        await this.timelineStore.appendEvent(message.conversationId, {
          type: "activity", messageId, routeDecision, activity: "failed",
          text: "The fast provider could not complete this reply. Please try again.", createdAtIso: nowIso()
        });
        throw error;
      }
      return "Your request is queued for deeper analysis.";
    });

    this.adaptiveRouting?.recordFastLatency(adaptedAnalysis.routeDecision, sizeBand, Date.now() - fastStart);

    await this.timelineStore.appendEvent(message.conversationId, {
      messageId,
      routeDecision,
      processingStatus: deepTask ? "provisional" : "complete",
      type: "provisional",
      text: provisionalReply,
      createdAtIso: nowIso()
    });

    if (deepTask) {
      return {
        messageId,
        fastResponse: {
          provisionalReply,
          analysis: adaptedAnalysis,
          processingStatus: "provisional"
        },
        deepTask
      };
    }

    return {
      messageId,
      fastResponse: {
        provisionalReply,
        analysis: adaptedAnalysis,
        processingStatus: "complete"
      }
    };
  }
}

export class DeepWorker {
  private running = false;
  private readonly attemptsByTaskId = new Map<string, number>();
  private readonly timelineStore: ConversationTimelineStore;
  private readonly maxRetries: number;
  private readonly deadLetterStore: DeadLetterStore;
  private readonly adaptiveRouting?: AdaptiveRoutingCoordinator;

  constructor(
    private readonly queue: TaskQueue,
    private readonly deepProvider: DeepModelProvider,
    timelineStore?: ConversationTimelineStore,
    maxRetries: number = 2,
    deadLetterStore?: DeadLetterStore,
    adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {
    this.timelineStore = timelineStore ?? new NoopConversationTimelineStore();
    this.maxRetries = maxRetries;
    this.deadLetterStore = deadLetterStore ?? new NoopDeadLetterStore();
    this.adaptiveRouting = adaptiveRouting;
  }

  async runSingle(): Promise<DeepResult | undefined> {
    // Both the timer and the manual endpoint share this concurrency limit.
    if (this.running) return undefined;
    this.running = true;
    try {
      return await this.processNext();
    } finally {
      this.running = false;
    }
  }

  private async processNext(): Promise<DeepResult | undefined> {
    const task = await this.queue.dequeue();
    if (!task) return undefined;

    try {
      await this.timelineStore.appendEvent(task.conversationId, {
        type: "activity", messageId: task.messageId, routeDecision: "deep", activity: "thinking",
        text: "Thinking with the deep provider", createdAtIso: nowIso()
      });
      const result = await this.deepProvider.resolveDeepTask(task);

      this.attemptsByTaskId.delete(task.taskId);

      await this.timelineStore.appendEvent(task.conversationId, {
        messageId: task.messageId,
        routeDecision: "deep",
        processingStatus: "complete",
        type: "refined",
        text: result.finalReply,
        createdAtIso: nowIso()
      });

      this.adaptiveRouting?.recordDeepLatency(task.sizeBand ?? "medium", result.totalLatencyMs);

      return result;
    } catch (error) {
      const attempts = (this.attemptsByTaskId.get(task.taskId) ?? 0) + 1;
      this.attemptsByTaskId.set(task.taskId, attempts);

      if (attempts <= this.maxRetries) {
        await this.timelineStore.appendEvent(task.conversationId, {
          type: "activity", messageId: task.messageId, routeDecision: "deep", activity: "retrying",
          text: `Deep provider retry ${attempts} of ${this.maxRetries} queued`, createdAtIso: nowIso()
        });
        await this.queue.enqueue(task);
        return undefined;
      }

      this.attemptsByTaskId.delete(task.taskId);

      await this.deadLetterStore.add({
        task,
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAtIso: nowIso()
      });

      await this.timelineStore.appendEvent(task.conversationId, {
        type: "activity", messageId: task.messageId, routeDecision: "deep", activity: "failed",
        text: "Deep analysis failed after retries. Any preliminary reply is not a completed deep answer.", createdAtIso: nowIso()
      });

      return undefined;
    }
  }
}
