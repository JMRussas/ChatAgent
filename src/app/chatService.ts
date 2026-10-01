import { loadConversationRetention } from "../config/conversationRetention";
import { randomUUID } from "node:crypto";
import {
  conversationScopeSchema,
  scopeForModel,
  type ConversationScope
} from "./conversationScope";
import { GenerationError } from "../domain/generation";
import { generationLifecycle } from "./generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "./orchestrator";
import type {
  ChatTimelineEvent,
  DeepResult,
  OrchestratorResponse,
  UserMessage
} from "../domain/types";
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
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  get isShuttingDown() {
    return this.stopping;
  }
  stopAccepting() {
    this.stopping = true;
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work);
    this.inFlight.add(pending);
    void pending.finally(() => this.inFlight.delete(pending)).catch(() => undefined);
    return pending;
  }
  async whenIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    await this.orchestrator.whenIdle?.();
    if (this.queue) await generationLifecycle(this.queue).flushClosingWrites();
  }
  async cancelRemaining(): Promise<void> {
    if (!this.queue) return;
    const lifecycle = generationLifecycle(this.queue);
    lifecycle.closeAdmissions();
    await Promise.all(
      lifecycle
        .registeredTurns()
        .map((turn) => this.orchestrator.cancel(turn.conversationId, turn.messageId))
    );
  }
  async discardPending(): Promise<void> {
    if (this.queue) {
      let task;
      const errors: unknown[] = [];
      while ((task = await this.queue.dequeue())) {
        try {
          await this.worker.discardQueued(task);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Queued task cleanup failed");
    }
  }
  resolveReferences?: (
    selections: unknown,
    userId: string,
    conversationId: string
  ) => import("./referenceSelection").AttachedReference[];
  detachTeamReference(conversationId: string, userId: string) {
    this.claimConversation(conversationId, userId, false);
    const scope = this.scopes.get(conversationId);
    if (scope) scope.reference = null;
    return this.getSelectedContext(conversationId, userId);
  }
  private readonly scopes = new Map<string, ConversationScope>();
  openScopedConversation(userId: string, value: unknown) {
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    const scope = conversationScopeSchema.parse(value),
      conversationId = randomUUID();
    this.claimConversation(conversationId, userId);
    this.scopes.set(conversationId, structuredClone(scope));
    return { conversationId, context: scopeForModel(scope) };
  }
  getSelectedContext(conversationId: string, userId: string) {
    this.claimConversation(conversationId, userId, false);
    this.timelineStore.assertConversationAvailable?.(conversationId);
    return scopeForModel(this.scopes.get(conversationId));
  }
  private readonly ownerUserIdByConversationId = new Map<string, string>();

  constructor(
    private readonly orchestrator: Pick<ChatOrchestrator, "handleUserMessage" | "cancel"> & {
      whenIdle?: () => Promise<void>;
      runControlOptions?: () => unknown;
      thinkingOptions?: (bindingId?: string) => Promise<unknown>;
    },
    private readonly worker: DeepWorker,
    private readonly timelineStore: ConversationTimelineStore,
    private readonly queue?: TaskQueue,
    private readonly deadLetterStore?: DeadLetterStore,
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator
  ) {
    timelineStore.onConversationExpired?.((id) => this.scopes.delete(id));
  }
  private readonly fallbackIdentityLimit = loadConversationRetention().maxIdentities;
  get maxConversationIdentities() {
    return this.timelineStore.maxConversationIdentities ?? this.fallbackIdentityLimit;
  }
  hasConversationIdentity(conversationId: string) {
    return this.ownerUserIdByConversationId.has(conversationId);
  }
  conversationRetentionStats() {
    return { owners: this.ownerUserIdByConversationId.size, scopes: this.scopes.size };
  }

  runControlOptions() {
    return this.orchestrator.runControlOptions?.() ?? { models: [] };
  }
  thinkingOptions(bindingId?: string) {
    return (
      this.orchestrator.thinkingOptions?.(bindingId) ?? Promise.resolve({ options: ["configured"] })
    );
  }
  async submitMessage(message: UserMessage): Promise<OrchestratorResponse> {
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    if (message.runControls && !this.orchestrator.runControlOptions)
      throw new GenerationError(
        message.runControls.roleId ? "ROLE_EXECUTION_UNSUPPORTED" : "RUN_CONTROLS_UNSUPPORTED",
        false
      );
    this.claimConversation(message.conversationId, message.userId);
    const releaseHistory = this.timelineStore.retainConversation?.(message.conversationId);
    try {
      const selectedContext = this.getSelectedContext(message.conversationId, message.userId);
      let attachedReferences: import("./referenceSelection").AttachedReference[] = [];
      if (message.referenceSelections?.length) {
        if (!this.resolveReferences) throw new GenerationError("REFERENCES_UNAVAILABLE", false);
        try {
          attachedReferences = this.resolveReferences(
            message.referenceSelections,
            message.userId,
            message.conversationId
          );
        } catch {
          throw new GenerationError(
            "REFERENCE_SELECTION_UNAVAILABLE",
            false,
            "Selected references are expired, unavailable or too large. Refresh or detach them."
          );
        }
      }
      return await this.track(() =>
        this.orchestrator.handleUserMessage({ ...message, selectedContext, attachedReferences })
      );
    } finally {
      releaseHistory?.();
    }
  }

  claimConversation(conversationId: string, userId: string, claim = true): void {
    const existingOwner = this.ownerUserIdByConversationId.get(conversationId);
    if (existingOwner === undefined) {
      if (claim) {
        if (this.ownerUserIdByConversationId.size >= this.maxConversationIdentities)
          throw new GenerationError("CONVERSATION_CAPACITY", false);
        const release = this.timelineStore.retainConversation?.(conversationId);
        this.ownerUserIdByConversationId.set(conversationId, userId);
        release?.();
      }
    } else if (existingOwner !== userId) {
      throw new ConversationOwnershipConflictError(conversationId);
    }
    if (claim) this.timelineStore.assertConversationAvailable?.(conversationId);
  }

  cancelMessage(conversationId: string, messageId: string) {
    return this.orchestrator.cancel(conversationId, messageId);
  }

  async runDeepWorkerOnce(): Promise<DeepResult | undefined> {
    if (this.stopping) return undefined;
    return this.track(() => this.worker.runSingle());
  }

  async getTimeline(conversationId: string): Promise<ChatTimelineEvent[]> {
    return this.timelineStore.getEvents(conversationId);
  }

  async listDeadLetters(): Promise<DeadLetterRecord[]> {
    if (!this.deadLetterStore) return [];
    return this.deadLetterStore.list();
  }

  deadLetterCapacity() {
    return this.deadLetterStore?.retentionStats?.();
  }

  /** Explicit operator removal; the only way besides replay that a record leaves the store. */
  async discardDeadLetter(taskId: string): Promise<boolean> {
    return (await this.deadLetterStore?.remove(taskId)) !== undefined;
  }

  replayDeadLetter(taskId: string): Promise<boolean> {
    if (this.stopping) return Promise.reject(new GenerationError("SHUTTING_DOWN", false));
    return this.track(() => this.replay(taskId));
  }
  private async replay(taskId: string): Promise<boolean> {
    if (!this.queue || !this.deadLetterStore) return false;

    // A claimed record keeps its slot while replayed, so restoring it cannot hit capacity.
    const removed = await (this.deadLetterStore.claim
      ? this.deadLetterStore.claim(taskId)
      : this.deadLetterStore.remove(taskId));
    if (!removed) return false;

    const lifecycle = generationLifecycle(this.queue);
    const messageId = removed.task.messageId ?? removed.task.taskId;
    if (lifecycle.get(removed.task.conversationId, messageId, "deep")?.status === "cancelled") {
      this.deadLetterStore.release?.(taskId);
      return false;
    }
    let releaseDispatch: (() => void) | undefined;
    let replayAttempt: import("./generationLifecycle").GenerationAttempt | undefined;
    try {
      if (
        ["fast", "deep"].some(
          (phase) =>
            lifecycle.get(removed.task.conversationId, messageId, phase as "fast" | "deep")?.active
        )
      )
        throw new GenerationError("REPLAY_CONFLICT", false);
      releaseDispatch = this.worker.prepareReplay(removed.task);
      const attempt = (replayAttempt = lifecycle.create(
        removed.task.conversationId,
        messageId,
        "deep",
        this.timelineStore,
        removed.task.taskId
      ));
      attempt.dispatchId = removed.task.dispatchId;
      await attempt.queued();
      await this.queue.enqueue(removed.task);
    } catch (error) {
      releaseDispatch?.();
      try {
        if (replayAttempt?.active) await replayAttempt.finish("error", undefined, "REPLAY_FAILED");
      } finally {
        if (replayAttempt) lifecycle.releaseTask(removed.task.taskId);
        await this.deadLetterStore.add(removed);
      }
      throw error;
    }
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

    const directP95 =
      estimates.length === 0 ? current : estimates.reduce((max, e) => Math.max(max, e.p95), 0);

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
