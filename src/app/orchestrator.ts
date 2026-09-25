import { analyzeFast } from "../domain/router";
import type { DeepResult, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider, TaskQueue } from "../providers/interfaces";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import { NoopDeadLetterStore, type DeadLetterStore } from "./deadLetterStore";
import { NoopConversationTimelineStore, type ConversationTimelineStore } from "./timelineStore";

function nowIso(): string {
  return new Date().toISOString();
}

function taskId(conversationId: string): string {
  return `task_${conversationId}_${Date.now()}`;
}

export class ChatOrchestrator {
  constructor(
    private readonly fastProvider: FastModelProvider,
    private readonly queue: TaskQueue,
    private readonly timelineStore: ConversationTimelineStore = new NoopConversationTimelineStore(),
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {}

  async handleUserMessage(message: UserMessage): Promise<OrchestratorResponse> {
    await this.timelineStore.appendEvent(message.conversationId, {
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

    const fastStart = Date.now();

    const provisionalReply = await this.fastProvider.createProvisionalReply({
      message,
      correctedText: adaptedAnalysis.correctedText,
      routeDecision: adaptedAnalysis.routeDecision
    });

    this.adaptiveRouting?.recordFastLatency(adaptedAnalysis.routeDecision, sizeBand, Date.now() - fastStart);

    await this.timelineStore.appendEvent(message.conversationId, {
      type: "provisional",
      text: provisionalReply,
      createdAtIso: nowIso()
    });

    if (adaptedAnalysis.routeDecision === "deep") {
      const deepTask = {
        taskId: taskId(message.conversationId),
        conversationId: message.conversationId,
        normalizedPrompt: adaptedAnalysis.correctedText,
        createdAtIso: nowIso(),
        sizeBand
      };

      await this.queue.enqueue(deepTask);

      return {
        fastResponse: {
          provisionalReply,
          analysis: adaptedAnalysis,
          processingStatus: "provisional"
        },
        deepTask
      };
    }

    return {
      fastResponse: {
        provisionalReply,
        analysis: adaptedAnalysis,
        processingStatus: "complete"
      }
    };
  }
}

export class DeepWorker {
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
    const task = await this.queue.dequeue();
    if (!task) return undefined;

    try {
      const result = await this.deepProvider.resolveDeepTask(task);

      this.attemptsByTaskId.delete(task.taskId);

      await this.timelineStore.appendEvent(task.conversationId, {
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
        await this.queue.enqueue(task);
        return undefined;
      }

      this.attemptsByTaskId.delete(task.taskId);

      await this.deadLetterStore.add({
        task,
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAtIso: nowIso()
      });

      return undefined;
    }
  }
}
