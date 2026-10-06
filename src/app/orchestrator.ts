import { bindingKey, type ApiKind } from "../models/connections";
import { CatalogDispatch, type DispatchPlan } from "../routing/catalogDispatch";
import { generationLifecycle } from "./generationLifecycle";
import {
  GenerationError,
  normalizeGenerationError,
  type GenerationResult
} from "../domain/generation";
import { randomUUID } from "node:crypto";
import { analyzeFast } from "../domain/router";
import type { DeepResult, DeepTask, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider, TaskQueue } from "../providers/interfaces";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import { ContextBudgetError, cloneConversationContext } from "./contextBuilder";
import { ContextManager } from "./contextManager";
import { NoopDeadLetterStore, type DeadLetterStore } from "./deadLetterStore";
import type { TrustedRuntimeFacts } from "./systemInstructions";
import { NoopConversationTimelineStore, type ConversationTimelineStore } from "./timelineStore";

function fixedMetadata(metadata?: import("../domain/generation").GenerationMetadata) {
  const model = metadata ?? { provider: "unknown", model: "unknown" };
  const kinds: Record<string, ApiKind> = {
    mock: "mock",
    ollama: "ollama-chat",
    azure: "azure-openai-chat",
    bedrock: "bedrock-converse"
  };
  const bindingId =
    model.bindingId ??
    (kinds[model.provider]
      ? bindingKey(`default-${model.provider}`, kinds[model.provider], model.model)
      : `fixed:${model.provider}/${model.model}`);
  return {
    ...model,
    bindingId,
    selection: {
      bindingId,
      catalogVersion: 1,
      observationTimeIso: new Date().toISOString(),
      reasons: ["fixed-selection"],
      eligibleBindingIds: []
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// Matches contextConfig.ts's documented defaults; used only when no ContextManager
// is supplied (existing tests/direct construction), so the orchestrator still
// always attaches a context object as spec 01 requires.
const DEFAULT_CONTEXT_BUDGET = {
  windowTokens: 8192,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 2048
};

function defaultTrustedFacts(): TrustedRuntimeFacts {
  return {
    fastProvider: "mock",
    fastModel: "mock-v1",
    deepProvider: "mock",
    deepModel: "mock-v1",
    generatedAtIso: nowIso()
  };
}

export class ChatOrchestrator {
  private readonly contextManager: ContextManager;
  private readonly trustedFactsProvider: () => TrustedRuntimeFacts;
  /**
   * One controller per claimed turn, from before its history check until the turn
   * ends, so a cancel reaches it before any attempt exists (for example while it
   * waits for admission). Bounded by the turns in flight.
   */
  private readonly preparing = new Map<string, AbortController>();
  /** Set by shutdown: no turn registers a preparation, or starts one, afterwards. */
  private preparationsClosed = false;

  constructor(
    private readonly fastProvider: FastModelProvider,
    private readonly queue: TaskQueue,
    private readonly timelineStore: ConversationTimelineStore = new NoopConversationTimelineStore(),
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator,
    contextManager?: ContextManager,
    trustedFactsProvider?: () => TrustedRuntimeFacts,
    private readonly dispatch?: CatalogDispatch,
    private readonly deadLetterStore?: DeadLetterStore
  ) {
    this.contextManager =
      contextManager ?? new ContextManager(this.timelineStore, DEFAULT_CONTEXT_BUDGET);
    this.trustedFactsProvider = trustedFactsProvider ?? defaultTrustedFacts;
  }

  async handleUserMessage(message: UserMessage): Promise<OrchestratorResponse> {
    const releaseHistory = this.timelineStore.retainConversation?.(message.conversationId);
    try {
      return await this.handleRetainedMessage(message);
    } finally {
      releaseHistory?.();
    }
  }
  private async handleRetainedMessage(message: UserMessage): Promise<OrchestratorResponse> {
    const messageId = message.messageId ?? randomUUID();
    const lifecycle = generationLifecycle(this.queue);
    const key = JSON.stringify([message.conversationId, messageId]);
    // Admitted before shutdown but entered after it: nothing is claimed or written.
    if (this.preparationsClosed) throw new GenerationError("CANCELLED", false);
    // A turn already in flight under this key keeps its own controller; the claim
    // below then refuses this duplicate.
    const preparation = new AbortController();
    const owned = !this.preparing.has(key);
    if (owned) this.preparing.set(key, preparation);
    try {
      await lifecycle.claimMessage(message.conversationId, messageId, this.timelineStore);
    } catch (error) {
      if (owned) this.preparing.delete(key);
      throw error;
    }
    const release = lifecycle.retain(message.conversationId, messageId);
    try {
      return await this.handleClaimedMessage({ ...message, messageId }, preparation.signal);
    } catch (error) {
      const attempt = lifecycle.get(message.conversationId, messageId, "fast");
      if (attempt?.active)
        await attempt.finish("error", undefined, normalizeGenerationError(error).code);
      throw error;
    } finally {
      this.dispatch?.complete(
        this.dispatch.get(lifecycle.get(message.conversationId, messageId, "fast")?.dispatchId)
      );
      if (!lifecycle.get(message.conversationId, messageId, "fast"))
        lifecycle.release(message.conversationId, messageId);
      release();
      this.preparing.delete(key);
    }
  }
  private async handleClaimedMessage(
    message: UserMessage & { messageId: string },
    preparation: AbortSignal
  ): Promise<OrchestratorResponse> {
    const messageId = message.messageId,
      lifecycle = generationLifecycle(this.queue);
    const analysis = analyzeFast(message);
    const adaptiveDecision = this.adaptiveRouting?.decide(message, analysis);

    const routeDecision = adaptiveDecision?.routeDecision ?? analysis.routeDecision;
    const sizeBand = adaptiveDecision?.sizeBand ?? "medium";

    const adaptedAnalysis = {
      ...analysis,
      routeDecision,
      reasons: adaptiveDecision?.reasons ?? analysis.reasons
    };

    // Capture the shared snapshot before appending anything for this turn, so a
    // budget rejection leaves the timeline/queue untouched (spec 01: "before
    // appending events/enqueuing/calling providers").
    let plan: DispatchPlan | undefined;
    let deepTask: DeepTask | undefined;
    let deepQueued = false;
    try {
      const contextInput = {
        conversationId: message.conversationId,
        currentMessageId: messageId,
        currentUserText: message.text,
        trustedFacts: this.trustedFactsProvider(),
        routeDecision
      };
      // Cancelled before its user event exists, a turn leaves no history, attempt,
      // queue entry or provider call; its reservations are released below.
      const cancelledEarly = () => {
        if (preparation.aborted) throw new GenerationError("CANCELLED", false);
      };
      cancelledEarly();
      const contextResult = await (this.dispatch
        ? this.dispatch
            .prepare(this.contextManager, contextInput, undefined, preparation)
            .then((value) => {
              plan = value;
              return value.context;
            })
        : this.contextManager.prepare(contextInput));
      cancelledEarly();

      if (contextResult instanceof ContextBudgetError) {
        throw contextResult;
      }

      const context = contextResult;

      deepTask =
        routeDecision === "deep"
          ? {
              taskId: randomUUID(),
              messageId,
              conversationId: message.conversationId,
              normalizedPrompt: adaptedAnalysis.correctedText,
              createdAtIso: nowIso(),
              sizeBand,
              dispatchId: plan?.deep?.id,
              selection: plan?.deep ? structuredClone(plan.deep.candidate.selection) : undefined,
              context: cloneConversationContext(context)
            }
          : undefined;
      // Reserve failure room before the user event exists, so a full dead-letter
      // store rejects the turn without consuming its message ID.
      if (deepTask) this.deadLetterStore?.reserve?.(deepTask);

      await this.timelineStore
        .appendEvent(message.conversationId, {
          messageId,
          type: "user",
          selections: plan
            ? structuredClone({
                fast: plan.fast.candidate.selection,
                deep: plan.deep?.candidate.selection
              })
            : undefined,
          routeDecision,
          text: message.text,
          createdAtIso: message.timestampIso
        })
        .catch((error) => {
          this.dispatch?.release(plan?.fast);
          this.dispatch?.release(plan?.deep);
          throw error;
        });

      let fastAttempt = lifecycle.create(
        message.conversationId,
        messageId,
        "fast",
        this.timelineStore
      );
      fastAttempt.dispatchId = plan?.fast.id;
      const deepAttempt = deepTask
        ? lifecycle.create(
            message.conversationId,
            messageId,
            "deep",
            this.timelineStore,
            deepTask.taskId
          )
        : undefined;
      // The user event is recorded, so a cancel that arrived meanwhile is recorded
      // too: the attempts end cancelled before anything is queued or started.
      if (preparation.aborted) await lifecycle.cancel(message.conversationId, messageId);
      if (deepTask && deepAttempt) {
        deepAttempt.dispatchId = plan?.deep?.id;
        if (plan?.deep) deepAttempt.model = this.dispatch!.metadata(plan.deep);
        try {
          await deepAttempt.queued();
          if (deepAttempt.active) {
            await this.queue.enqueue(deepTask);
            deepQueued = true;
          } else lifecycle.releaseTask(deepTask.taskId);
        } catch (error) {
          this.dispatch?.release(plan?.fast);
          this.dispatch?.release(plan?.deep);
          try {
            await lifecycle.cancel(message.conversationId, messageId);
          } finally {
            lifecycle.releaseTask(deepTask.taskId);
          }
          throw error;
        }
      }
      const fastStart = Date.now();
      let result: GenerationResult;
      let acknowledgment = false;
      for (let number = 0; ; number++) {
        const fastProvider = plan ? plan.fast.candidate.binding.fast! : this.fastProvider;
        await fastAttempt
          .start(
            this.timelineStore,
            plan ? this.dispatch!.metadata(plan.fast) : fixedMetadata(this.fastProvider.metadata)
          )
          .catch((error) => {
            this.dispatch?.release(plan?.fast);
            throw error;
          });
        try {
          if (!fastAttempt.active) {
            this.dispatch?.release(plan?.fast);
            throw new GenerationError("CANCELLED", false);
          }
          const invoke = async () => {
            const generated = await fastProvider.createProvisionalReply(
              {
                message,
                correctedText: adaptedAnalysis.correctedText,
                routeDecision,
                context: cloneConversationContext(plan?.fast.context ?? context)
              },
              fastAttempt.control
            );
            if (Buffer.byteLength(generated.text) > 1024 * 1024)
              throw new GenerationError("ANSWER_TOO_LARGE", false);
            if (plan)
              this.dispatch!.validateAnswer(plan.fast, generated.text, generated.finishReason);
            return generated;
          };
          result = plan
            ? await this.dispatch!.execute(plan.fast, fastAttempt.control, sizeBand, invoke)
            : await invoke();
          if (Buffer.byteLength(result.text) > 1024 * 1024)
            throw new GenerationError("ANSWER_TOO_LARGE", false);
          break;
        } catch (error) {
          const failure = normalizeGenerationError(error);
          if (fastAttempt.status === "cancelled" || failure.code === "CANCELLED") {
            await fastAttempt.finish("cancelled");
            result = { text: fastAttempt.text, finishReason: "cancelled" };
            break;
          }
          const fallback =
            (failure.retryable || failure.code === "QUOTA_EXHAUSTED") &&
            !fastAttempt.text &&
            plan &&
            this.dispatch!.fallback(plan.fast, failure.code);
          const retry = !!fallback || (failure.retryable && !fastAttempt.text && number < 2);
          const next = retry
            ? lifecycle.create(message.conversationId, messageId, "fast", this.timelineStore)
            : undefined;
          if (next) next.dispatchId = plan?.fast.id;
          await fastAttempt.finish("error", undefined, failure.code, retry);
          if (next) {
            fastAttempt = next;
            next.dispatchId = plan?.fast.id;
            if (plan) next.model = this.dispatch!.metadata(plan.fast);
            await next.queued(true);
            continue;
          }
          if (!deepTask) throw failure;
          acknowledgment = fastAttempt.text.length === 0;
          result = {
            text: acknowledgment ? "Your request is queued for deeper analysis." : fastAttempt.text,
            finishReason: "stop"
          };
          break;
        }
      }
      if (fastAttempt.status === "cancelled")
        result = { text: fastAttempt.text, finishReason: "cancelled" };
      if (!plan)
        this.adaptiveRouting?.recordFastLatency(routeDecision, sizeBand, Date.now() - fastStart);
      const processingStatus =
        fastAttempt.status === "cancelled" || result.finishReason === "cancelled"
          ? "cancelled"
          : result.finishReason === "length"
            ? "incomplete"
            : fastAttempt.status === "error" && !deepTask
              ? "failed"
              : deepTask
                ? "provisional"
                : "complete";
      if (fastAttempt.active) {
        fastAttempt.text = result.text;
        await fastAttempt.finish(result.finishReason, {
          text: result.text,
          routeDecision,
          processingStatus,
          finishReason: result.finishReason,
          answerKind: "substantive"
        });
      } else if (
        acknowledgment &&
        lifecycle.get(message.conversationId, messageId, "deep")?.status !== "cancelled"
      ) {
        await this.timelineStore.appendEvent(message.conversationId, {
          type: "provisional",
          messageId,
          phase: "fast",
          attemptId: fastAttempt.attemptId,
          text: result.text,
          answerKind: "acknowledgment",
          processingStatus: "provisional",
          routeDecision,
          createdAtIso: nowIso()
        });
      }
      return {
        messageId,
        fastResponse: {
          provisionalReply: result.text,
          analysis: adaptedAnalysis,
          processingStatus
        },
        ...(deepTask ? { deepTask } : {})
      };
    } finally {
      if (!lifecycle.get(message.conversationId, messageId, "fast"))
        this.dispatch?.complete(plan?.fast);
      if (!deepQueued) {
        this.dispatch?.complete(plan?.deep);
        if (deepTask) this.deadLetterStore?.release?.(deepTask.taskId);
      }
    }
  }
  async cancel(conversationId: string, messageId: string) {
    const lifecycle = generationLifecycle(this.queue);
    const preparation = this.preparing.get(JSON.stringify([conversationId, messageId]));
    preparation?.abort(new GenerationError("CANCELLED", false));
    for (const role of ["fast", "deep"] as const) {
      const id = lifecycle.get(conversationId, messageId, role)?.dispatchId;
      this.dispatch?.release(this.dispatch.get(id));
    }
    const result = await lifecycle.cancel(conversationId, messageId);
    // Before its attempts exist, the turn ends without history of its own.
    return (
      result ??
      (preparation ? { messageId, phases: {}, preparation: "cancelled" as const } : undefined)
    );
  }
  /** Shutdown: ends every turn that has not yet created its attempts. */
  cancelPreparations() {
    this.preparationsClosed = true;
    for (const preparation of this.preparing.values())
      preparation.abort(new GenerationError("CANCELLED", false));
  }
  retentionStats() {
    return { preparing: this.preparing.size };
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
    adaptiveRouting?: AdaptiveRoutingCoordinator,
    private readonly dispatch?: CatalogDispatch
  ) {
    this.timelineStore = timelineStore ?? new NoopConversationTimelineStore();
    this.maxRetries = maxRetries;
    this.deadLetterStore = deadLetterStore ?? new NoopDeadLetterStore();
    this.adaptiveRouting = adaptiveRouting;
  }

  prepareReplay(task: DeepTask) {
    const selected = this.dispatch?.get(task.dispatchId);
    if (task.dispatchId && !selected)
      throw new GenerationError("DISPATCH_SNAPSHOT_UNAVAILABLE", false);
    if (selected) this.dispatch!.activate(selected);
    return () => this.dispatch?.complete(selected);
  }
  retentionStats() {
    return { retryCounters: this.attemptsByTaskId.size };
  }

  async discardQueued(task: DeepTask) {
    const lifecycle = generationLifecycle(this.queue);
    const attempt = lifecycle.get(task.conversationId, task.messageId ?? task.taskId, "deep");
    try {
      if (attempt?.active) await attempt.finish("cancelled");
    } finally {
      this.dispatch?.complete(this.dispatch.get(task.dispatchId));
      lifecycle.releaseTask(task.taskId);
      this.deadLetterStore.release?.(task.taskId);
    }
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

    const lifecycle = generationLifecycle(this.queue);
    const messageId = task.messageId ?? task.taskId;
    const selected = this.dispatch?.get(task.dispatchId);
    let requeued = false;
    try {
      // Attempt creation can reject expired or full histories after dequeue.
      // Keep it inside recovery so the task remains available as a dead letter.
      const attempt =
        lifecycle.get(task.conversationId, messageId, "deep") ??
        lifecycle.create(task.conversationId, messageId, "deep", this.timelineStore, task.taskId);
      if (selected) this.dispatch!.activate(selected);
      attempt.dispatchId = task.dispatchId;
      if (!attempt.active) {
        this.dispatch?.release(selected);
        this.attemptsByTaskId.delete(task.taskId);
        return undefined;
      }
      await attempt
        .start(
          this.timelineStore,
          selected ? this.dispatch!.metadata(selected) : fixedMetadata(this.deepProvider.metadata)
        )
        .catch((error) => {
          this.dispatch?.release(selected);
          throw error;
        });
      try {
        if (!attempt.active) {
          this.dispatch?.release(selected);
          return undefined;
        }
        if (task.dispatchId && !selected)
          throw new GenerationError("DISPATCH_SNAPSHOT_UNAVAILABLE", false);
        const invoke = async () => {
          const result = await (
            selected?.candidate.binding.deep ?? this.deepProvider
          ).resolveDeepTask(
            selected
              ? {
                  ...task,
                  context: cloneConversationContext(selected.context),
                  selection: selected.candidate.selection
                }
              : task,
            attempt.control
          );
          if (Buffer.byteLength(result.finalReply) > 1024 * 1024)
            throw new GenerationError("ANSWER_TOO_LARGE", false);
          if (selected)
            this.dispatch!.validateAnswer(selected, result.finalReply, result.finishReason);
          return result;
        };
        const result = selected
          ? await this.dispatch!.execute(
              selected,
              attempt.control,
              task.sizeBand ?? "medium",
              invoke
            )
          : await invoke();
        if (!attempt.active) return undefined;
        if (Buffer.byteLength(result.finalReply) > 1024 * 1024)
          throw new GenerationError("ANSWER_TOO_LARGE", false);
        this.attemptsByTaskId.delete(task.taskId);
        attempt.text = result.finalReply;
        await attempt.finish(result.finishReason, {
          routeDecision: "deep",
          processingStatus:
            result.finishReason === "stop"
              ? "complete"
              : result.finishReason === "length"
                ? "incomplete"
                : "cancelled",
          text: result.finalReply,
          finishReason: result.finishReason,
          answerKind: "substantive"
        });
        if (!selected)
          this.adaptiveRouting?.recordDeepLatency(task.sizeBand ?? "medium", result.totalLatencyMs);
        return result;
      } catch (error) {
        if (attempt.status === "cancelled") {
          this.attemptsByTaskId.delete(task.taskId);
          return undefined;
        }
        const failure = normalizeGenerationError(error);
        if (failure.code === "CANCELLED") {
          await attempt.finish("cancelled");
          this.attemptsByTaskId.delete(task.taskId);
          return undefined;
        }
        const attempts = (this.attemptsByTaskId.get(task.taskId) ?? 0) + 1;
        this.attemptsByTaskId.set(task.taskId, attempts);
        const fallback =
          (failure.retryable || failure.code === "QUOTA_EXHAUSTED") &&
          !attempt.text &&
          selected &&
          this.dispatch!.fallback(selected, failure.code);
        const retry =
          !!fallback || (failure.retryable && !attempt.text && attempts <= this.maxRetries);
        // Publish the next attempt synchronously so cancellation during the terminal write also cancels the retry.
        const next = retry
          ? lifecycle.create(
              task.conversationId,
              messageId,
              "deep",
              this.timelineStore,
              task.taskId
            )
          : undefined;
        if (next) next.dispatchId = task.dispatchId;
        await attempt.finish("error", undefined, failure.code, retry);
        if (next) {
          next.dispatchId = task.dispatchId;
          if (selected) next.model = this.dispatch!.metadata(selected);
          if (next.active) {
            await next.queued(true);
            await this.queue.enqueue(task);
            // Queues without removal must keep the cancellation record pinned until dequeue.
            requeued = next.active || !this.queue.removeMessage;
            if (!requeued) this.queue.removeMessage?.(task.conversationId, messageId);
          }
          return undefined;
        }
        this.attemptsByTaskId.delete(task.taskId);
        await this.deadLetterStore.add({ task, errorMessage: failure.code, failedAtIso: nowIso() });
        return undefined;
      }
    } catch (error) {
      await this.deadLetterStore.add({
        task,
        errorMessage: normalizeGenerationError(error).code,
        failedAtIso: nowIso()
      });
      throw error;
    } finally {
      // Queued retries retain their pin even if cancellation wins after enqueue.
      if (!requeued) {
        const current = lifecycle.get(task.conversationId, messageId, "deep");
        try {
          if (current?.active) await current.finish("error", undefined, "WORKER_EXECUTION_FAILED");
        } finally {
          this.attemptsByTaskId.delete(task.taskId);
          this.dispatch?.complete(selected);
          lifecycle.releaseTask(task.taskId);
          // No-op once the failure became a record; otherwise the settled task frees its slot.
          this.deadLetterStore.release?.(task.taskId);
        }
      }
    }
  }
}
