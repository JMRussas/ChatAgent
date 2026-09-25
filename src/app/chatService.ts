import { ChatOrchestrator, DeepWorker } from "./orchestrator";
import type { ChatTimelineEvent, DeepResult, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeadLetterRecord, DeadLetterStore } from "./deadLetterStore";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import type { ConversationTimelineStore } from "./timelineStore";
import type { TaskQueue } from "../providers/interfaces";

export class ChatService {
  constructor(
    private readonly orchestrator: ChatOrchestrator,
    private readonly worker: DeepWorker,
    private readonly timelineStore: ConversationTimelineStore,
    private readonly queue?: TaskQueue,
    private readonly deadLetterStore?: DeadLetterStore,
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {}

  async submitMessage(message: UserMessage): Promise<OrchestratorResponse> {
    return this.orchestrator.handleUserMessage(message);
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

    await this.queue.enqueue(removed.task);
    return true;
  }

  getRoutingTelemetry() {
    if (!this.adaptiveRouting) {
      return {
        policy: { maxFastP95Ms: 1000 },
        estimates: []
      };
    }

    return {
      policy: this.adaptiveRouting.getPolicy(),
      estimates: this.adaptiveRouting.getLatencyEstimates()
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
}
