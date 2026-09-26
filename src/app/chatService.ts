import { generationLifecycle } from "./generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "./orchestrator";
import type { ChatTimelineEvent, DeepResult, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeadLetterRecord, DeadLetterStore } from "./deadLetterStore";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import type { ConversationTimelineStore } from "./timelineStore";
import type { TaskQueue } from "../providers/interfaces";

/**
 * Thrown when a conversationId's already-claimed owner (spec 01: "claim conversation
 * ownership on first submission using userId") differs from the submitting userId.
 * Not authentication — a prototype-scope guard against accidentally mixing two
 * users' turns into one conversation's shared context.
 */
export class ConversationOwnershipConflictError extends Error {
  readonly code = "CONVERSATION_OWNER_MISMATCH" as const;

  constructor(readonly conversationId: string) {
    super(`Conversation "${conversationId}" is already owned by a different user.`);
    this.name = "ConversationOwnershipConflictError";
  }
}

export class ChatService {
  private readonly ownerUserIdByConversationId = new Map<string, string>();

  constructor(
    private readonly orchestrator: ChatOrchestrator,
    private readonly worker: DeepWorker,
    private readonly timelineStore: ConversationTimelineStore,
    private readonly queue?: TaskQueue,
    private readonly deadLetterStore?: DeadLetterStore,
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {}

  async submitMessage(message: UserMessage): Promise<OrchestratorResponse> {
    const existingOwner = this.ownerUserIdByConversationId.get(message.conversationId);
    if (existingOwner === undefined) {
      this.ownerUserIdByConversationId.set(message.conversationId, message.userId);
    } else if (existingOwner !== message.userId) {
      throw new ConversationOwnershipConflictError(message.conversationId);
    }

    return this.orchestrator.handleUserMessage(message);
  }

  cancelMessage(conversationId: string, messageId: string) {
    return this.orchestrator.cancel(conversationId, messageId);
  }

  async runDeepWorkerOnce(): Promise<DeepResult | undefined> {
    return this.worker.runSingle();
  }

  async getTimeline(conversationId: string): Promise<ChatTimelineEvent[]> {
    return this.timelineStore.getEvents(conversationId);
  }

  async listDeadLetters(): Promise<DeadLetterRecord[]> {
    if (!this.deadLetterStore) return [];
    return this.deadLetterStore.list();
  }

  async replayDeadLetter(taskId: string): Promise<boolean> {
    if (!this.queue || !this.deadLetterStore) return false;

    const removed = await this.deadLetterStore.remove(taskId);
    if (!removed) return false;

    const lifecycle = generationLifecycle(this.queue);
    const messageId = removed.task.messageId ?? removed.task.taskId;
    if (lifecycle.get(removed.task.conversationId, messageId, "deep")?.status === "cancelled") return false;
    const attempt = lifecycle.create(removed.task.conversationId, messageId, "deep", this.timelineStore, removed.task.taskId);
    await attempt.queued();
    await this.queue.enqueue(removed.task);
    return true;
  }

  getRoutingTelemetry() {
    const queueLike = this.queue as unknown as { size?: () => number } | undefined;
    const queueDepth = typeof queueLike?.size === "function" ? queueLike.size() : undefined;

    if (!this.adaptiveRouting) {
      return {
        policy: { maxFastP95Ms: 1000 },
        estimates: [],
        queueDepth
      };
    }

    return {
      policy: this.adaptiveRouting.getPolicy(),
      estimates: this.adaptiveRouting.getLatencyEstimates(),
      queueDepth
    };
  }

  tuneRoutingPolicy(queueDepth: number): { maxFastP95Ms: number } {
    if (!this.adaptiveRouting) {
      return { maxFastP95Ms: 1000 };
    }

    const current = this.adaptiveRouting.getPolicy().maxFastP95Ms;
    const estimates = this.adaptiveRouting
      .getLatencyEstimates()
      .filter((e) => e.bucket.route === "direct" && e.bucket.sizeBand === "medium");

    const directP95 = estimates.length === 0 ? current : estimates.reduce((max, e) => Math.max(max, e.p95), 0);

    let next = current;
    if (queueDepth > 5 || directP95 > current * 1.2) {
      next = current - 100;
    } else if (queueDepth < 2 && directP95 < current * 0.8) {
      next = current + 50;
    }

    this.adaptiveRouting.setMaxFastP95Ms(next);
    return this.adaptiveRouting.getPolicy();
  }

  setRoutingPolicy(input: { maxFastP95Ms?: number }): { maxFastP95Ms: number } {
    if (!this.adaptiveRouting) {
      return { maxFastP95Ms: 1000 };
    }

    if (typeof input.maxFastP95Ms === "number" && Number.isFinite(input.maxFastP95Ms)) {
      this.adaptiveRouting.setMaxFastP95Ms(input.maxFastP95Ms);
    }

    return this.adaptiveRouting.getPolicy();
  }
}
