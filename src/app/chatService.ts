import { loadConversationRetention } from "../config/conversationRetention";
import { assertConcurrentTurnLimit, loadTurnAdmissionConfig } from "../config/turnAdmission";
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
import { assertReadBudget, type ConversationTimelineStore } from "./timelineStore";
import type { TaskQueue } from "../providers/interfaces";
import { z } from "zod";
import { ownerBelongsToPrincipal } from "../auth/authenticator";

export const conversationIdentitySnapshotSchema = z
  .object({
    version: z.literal(1),
    owners: z.array(z.tuple([z.string().min(1).max(4096), z.string().min(1).max(4096)])),
    scopes: z.array(z.tuple([z.string().min(1).max(4096), conversationScopeSchema]))
  })
  .strict();
export type ConversationIdentitySnapshot = z.infer<typeof conversationIdentitySnapshotSchema>;

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

/** A store outside `ChatService` that keeps state bound to a conversation identity. */
export interface ConversationRetirementParticipant {
  /** Codes that refuse retirement. Evaluated before anything is forgotten; may ask an
   * external owner. A participant that cannot answer must return a code, not `[]`. */
  blockers?(conversationId: string, ownerUserId: string | undefined): string[] | Promise<string[]>;
  /** Drops the participant's state for the conversation. Synchronous and idempotent. */
  forget(conversationId: string): void;
}
export type ConversationRetirement =
  { status: "retired" } | { status: "not_found" } | { status: "blocked"; blockers: string[] };

export interface ChatServiceOptions {
  /** Concurrent turns admitted at once; defaults to `CHAT_MAX_CONCURRENT_TURNS`. */
  maxConcurrentTurns?: number;
}

export class ChatService {
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Turns past admission and not yet settled; counted before anything is claimed. */
  private activeTurns = 0;
  readonly maxConcurrentTurns: number;
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
    // The orchestrator owns these even when this service was given no queue.
    this.orchestrator.cancelPreparations?.();
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
    if (scope) this.persistenceHook?.();
    return this.getSelectedContext(conversationId, userId);
  }
  private readonly scopes = new Map<string, ConversationScope>();
  openScopedConversation(userId: string, value: unknown) {
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    const scope = conversationScopeSchema.parse(value),
      conversationId = randomUUID();
    this.claimConversation(conversationId, userId);
    this.scopes.set(conversationId, structuredClone(scope));
    this.persistenceHook?.();
    return { conversationId, context: scopeForModel(scope) };
  }
  getSelectedContext(conversationId: string, userId: string) {
    this.claimConversation(conversationId, userId, false);
    this.timelineStore.assertConversationAvailable?.(conversationId);
    return scopeForModel(this.scopes.get(conversationId));
  }
  private readonly ownerUserIdByConversationId = new Map<string, string>();
  private persistenceHook?: () => void;
  setPersistenceHook(hook: (() => void) | undefined) {
    this.persistenceHook = hook;
  }
  exportSnapshot(): ConversationIdentitySnapshot {
    return {
      version: 1,
      owners: [...this.ownerUserIdByConversationId],
      scopes: structuredClone([...this.scopes])
    };
  }
  /** Restore ownership/context before accepting requests; provider execution is not restored. */
  restoreSnapshot(value: unknown) {
    const snapshot = conversationIdentitySnapshotSchema.parse(value);
    const owners = new Map(snapshot.owners);
    const scopes = new Map(snapshot.scopes);
    if (
      this.activeTurns ||
      this.inFlight.size ||
      this.orchestrator.detachedTurns?.() ||
      owners.size !== snapshot.owners.length ||
      scopes.size !== snapshot.scopes.length ||
      owners.size > this.maxConversationIdentities ||
      [...scopes.keys()].some((id) => !owners.has(id))
    )
      throw new Error("CONVERSATION_IDENTITY_SNAPSHOT_INVALID");
    this.ownerUserIdByConversationId.clear();
    this.scopes.clear();
    for (const [id, owner] of owners) this.ownerUserIdByConversationId.set(id, owner);
    for (const [id, scope] of scopes) this.scopes.set(id, structuredClone(scope));
  }

  constructor(
    private readonly orchestrator: Pick<ChatOrchestrator, "handleUserMessage" | "cancel"> & {
      whenIdle?: () => Promise<void>;
      /** Turns whose response has returned while their inline work still runs. */
      detachedTurns?: () => number;
      runControlOptions?: () => unknown;
      thinkingOptions?: (bindingId?: string) => Promise<unknown>;
      /** Shutdown: ends turns that are still preparing and have no attempts yet. */
      cancelPreparations?: () => void;
    },
    private readonly worker: DeepWorker,
    private readonly timelineStore: ConversationTimelineStore,
    private readonly queue?: TaskQueue,
    private readonly deadLetterStore?: DeadLetterStore,
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator,
    options: ChatServiceOptions = {}
  ) {
    this.maxConcurrentTurns =
      options.maxConcurrentTurns === undefined
        ? loadTurnAdmissionConfig().maxConcurrentTurns
        : assertConcurrentTurnLimit(options.maxConcurrentTurns);
    timelineStore.onConversationExpired?.((id) => {
      if (this.scopes.delete(id)) this.persistenceHook?.();
    });
  }
  private readonly fallbackIdentityLimit = loadConversationRetention().maxIdentities;
  get maxConversationIdentities() {
    return this.timelineStore.maxConversationIdentities ?? this.fallbackIdentityLimit;
  }
  hasConversationIdentity(conversationId: string) {
    return this.ownerUserIdByConversationId.has(conversationId);
  }
  /** The owner a conversation was claimed by, or undefined if it was never claimed. */
  conversationOwner(conversationId: string) {
    return this.ownerUserIdByConversationId.get(conversationId);
  }
  /** Only authenticated principal-owned histories appear in the workspace directory. */
  listConversations(principalId: string) {
    return (this.timelineStore.conversationSummaries?.() ?? [])
      .filter((row) => ownerBelongsToPrincipal(this.conversationOwner(row.id), principalId))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
  }
  conversationRetentionStats() {
    return { owners: this.ownerUserIdByConversationId.size, scopes: this.scopes.size };
  }
  private occupiedTurns() {
    return this.activeTurns + (this.orchestrator.detachedTurns?.() ?? 0);
  }
  retentionStats() {
    return {
      ...this.conversationRetentionStats(),
      inFlight: this.inFlight.size,
      activeTurns: this.activeTurns,
      detachedTurns: this.orchestrator.detachedTurns?.() ?? 0,
      maxConcurrentTurns: this.maxConcurrentTurns
    };
  }
  private readonly retirementParticipants: ConversationRetirementParticipant[] = [];
  addRetirementParticipant(participant: ConversationRetirementParticipant) {
    this.retirementParticipants.push(participant);
  }
  /** Holds history and ownership while an asynchronous external request can publish data. */
  retainConversationWork(conversationId: string) {
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    return this.timelineStore.retainConversation?.(conversationId) ?? (() => undefined);
  }
  conversationVersion(conversationId: string) {
    return this.timelineStore.conversationVersion?.(conversationId);
  }
  /** Operator view of identity usage. Expired identities are the only retirement candidates. */
  conversationRetention(limit = 200) {
    const expired = this.timelineStore.expiredConversations?.() ?? [];
    return {
      maxIdentities: this.maxConversationIdentities,
      owners: this.ownerUserIdByConversationId.size,
      scopes: this.scopes.size,
      expiredCount: expired.length,
      expired: expired.slice(0, limit),
      truncated: expired.length > limit,
      retirementSupported: !!(
        this.timelineStore.retireConversation && this.timelineStore.conversationVersion
      )
    };
  }
  /**
   * Explicit operator release of one expired identity. Expiry already removed the
   * history; this removes the tombstone, owner and every dependent index together,
   * so the ID becomes unknown: a later request with it starts an unrelated
   * conversation that any user may claim, with no deduplication against the old
   * message IDs. It refuses while anything could still act on or replay into the
   * conversation, and never discards a dead letter on the operator's behalf.
   */
  async retireConversation(conversationId: string): Promise<ConversationRetirement> {
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    const store = this.timelineStore;
    const state = () => store.conversationState?.(conversationId);
    const owner = this.ownerUserIdByConversationId.get(conversationId);
    if (!store.conversationState || !store.retireConversation || !store.conversationVersion)
      return owner === undefined
        ? { status: "not_found" }
        : { status: "blocked", blockers: ["RETIREMENT_UNSUPPORTED"] };
    if (state() === undefined) return { status: "not_found" };
    if (state() === "live") return { status: "blocked", blockers: ["HISTORY_LIVE"] };
    const version = store.conversationVersion(conversationId);
    // Blocker answers belong to this incarnation, even if a competing retirement
    // releases and reuses the ID while an external participant is awaited.
    const external = (
      await Promise.all(
        this.retirementParticipants.map(async (participant) => {
          try {
            return (await participant.blockers?.(conversationId, owner)) ?? [];
          } catch {
            return ["PARTICIPANT_UNAVAILABLE"];
          }
        })
      )
    ).flat();
    // No await below: the remaining checks and every deletion are one synchronous step.
    if (this.stopping) throw new GenerationError("SHUTTING_DOWN", false);
    if (state() !== "expired" || store.conversationVersion(conversationId) !== version)
      return { status: "not_found" };
    const blockers = [...external];
    if (this.queue) {
      if (generationLifecycle(this.queue).conversationActive(conversationId))
        blockers.push("ACTIVE_TURNS");
      if (!this.queue.hasConversation) blockers.push("QUEUE_UNINSPECTABLE");
      else if (this.queue.hasConversation(conversationId)) blockers.push("QUEUED_TASKS");
    }
    if (this.deadLetterStore) {
      if (!this.deadLetterStore.conversationReferences) blockers.push("DEAD_LETTERS_UNINSPECTABLE");
      else if (this.deadLetterStore.conversationReferences(conversationId))
        blockers.push("DEAD_LETTERS");
    }
    if (blockers.length) return { status: "blocked", blockers: [...new Set(blockers)] };
    // Dependents first: ownership must outlive the data it guards if one of them throws.
    for (const participant of this.retirementParticipants) participant.forget(conversationId);
    if (this.queue) generationLifecycle(this.queue).forgetConversation(conversationId);
    this.scopes.delete(conversationId);
    if (!store.retireConversation(conversationId))
      return { status: "blocked", blockers: ["RETIREMENT_REFUSED"] };
    this.ownerUserIdByConversationId.delete(conversationId);
    this.persistenceHook?.();
    return { status: "retired" };
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
    // Admission is decided synchronously, before ownership, history or a message ID
    // is claimed, so a refused turn leaves nothing behind and is safe to retry.
    // A turn is still occupied after its response returns while inline retrieval
    // runs; in the microtask between the two counts it is counted twice, which
    // can only refuse one extra submission, never admit one too many.
    if (this.occupiedTurns() >= this.maxConcurrentTurns)
      throw new GenerationError(
        "TURN_CAPACITY",
        true,
        `The server is already running ${this.maxConcurrentTurns} turns. Retry after one finishes.`
      );
    this.activeTurns += 1;
    try {
      return await this.admitMessage(message);
    } finally {
      this.activeTurns -= 1;
    }
  }

  private async admitMessage(message: UserMessage): Promise<OrchestratorResponse> {
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
        this.persistenceHook?.();
      }
    } else if (existingOwner !== userId) {
      throw new ConversationOwnershipConflictError(conversationId);
    }
    if (claim) this.timelineStore.assertConversationAvailable?.(conversationId);
  }

  async cancelMessage(conversationId: string, messageId: string) {
    const result = await this.orchestrator.cancel(conversationId, messageId);
    const removed = this.queue?.removeMessage?.(conversationId, messageId) ?? [];
    await Promise.all(removed.map((task) => this.worker.discardQueued(task)));
    return result;
  }

  async runDeepWorkerOnce(): Promise<DeepResult | undefined> {
    if (this.stopping) return undefined;
    return this.track(() => this.worker.runSingle());
  }

  async getTimeline(conversationId: string): Promise<ChatTimelineEvent[]> {
    return this.timelineStore.getEvents(conversationId);
  }

  /**
   * Events after a sequence, optionally within a serialized-byte budget (the first
   * event is always included). Stores without getEventsAfter pay the full read and
   * cannot apply the budget.
   */
  async getTimelineAfter(
    conversationId: string,
    afterSequence: number,
    maxBytes?: number
  ): Promise<ChatTimelineEvent[]> {
    assertReadBudget(maxBytes);
    if (this.timelineStore.getEventsAfter)
      return this.timelineStore.getEventsAfter(conversationId, afterSequence, maxBytes);
    return (await this.timelineStore.getEvents(conversationId)).filter(
      (event) => (event.sequence ?? 0) > afterSequence
    );
  }

  /**
   * The timeline's revision (its last sequence) without copying any events, or
   * undefined when the store keeps none. Never falls back to a full read. Checked like
   * getTimeline: expired history throws CONVERSATION_EXPIRED.
   */
  timelineRevision(conversationId: string): number | undefined {
    return this.timelineStore.lastSequence?.(conversationId);
  }

  /** The last timeline sequence; stores without lastSequence pay a full read. */
  async lastTimelineSequence(conversationId: string): Promise<number> {
    if (this.timelineStore.lastSequence) return this.timelineStore.lastSequence(conversationId);
    return (await this.timelineStore.getEvents(conversationId)).at(-1)?.sequence ?? 0;
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
      if (!attempt.active) {
        releaseDispatch?.();
        lifecycle.releaseTask(removed.task.taskId);
        this.deadLetterStore.release?.(taskId);
        return false;
      }
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
