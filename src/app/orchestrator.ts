import { generationLifecycle } from "./generationLifecycle";
import { GenerationError, normalizeGenerationError, type GenerationResult } from "../domain/generation";
import { randomUUID } from "node:crypto";
import { analyzeFast } from "../domain/router";
import type { DeepResult, OrchestratorResponse, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider, TaskQueue } from "../providers/interfaces";
import type { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import { ContextBudgetError, cloneConversationContext } from "./contextBuilder";
import { ContextManager } from "./contextManager";
import { NoopDeadLetterStore, type DeadLetterStore } from "./deadLetterStore";
import type { TrustedRuntimeFacts } from "./systemInstructions";
import { NoopConversationTimelineStore, type ConversationTimelineStore } from "./timelineStore";

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

  constructor(
    private readonly fastProvider: FastModelProvider,
    private readonly queue: TaskQueue,
    private readonly timelineStore: ConversationTimelineStore = new NoopConversationTimelineStore(),
    private readonly adaptiveRouting?: AdaptiveRoutingCoordinator,
    contextManager?: ContextManager,
    trustedFactsProvider?: () => TrustedRuntimeFacts
  ) {
    this.contextManager = contextManager ?? new ContextManager(this.timelineStore, DEFAULT_CONTEXT_BUDGET);
    this.trustedFactsProvider = trustedFactsProvider ?? defaultTrustedFacts;
  }

  async handleUserMessage(message: UserMessage): Promise<OrchestratorResponse> {
    const messageId = message.messageId ?? randomUUID();
    const lifecycle = generationLifecycle(this.queue);
    lifecycle.claim(message.conversationId, messageId);
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
    const contextResult = await this.contextManager.prepare({
      conversationId: message.conversationId,
      currentMessageId: messageId,
      currentUserText: message.text,
      trustedFacts: this.trustedFactsProvider(),
      routeDecision
    }).catch(error => { lifecycle.release(message.conversationId, messageId); throw error; });

    if (contextResult instanceof ContextBudgetError) {
      lifecycle.release(message.conversationId, messageId);
      throw contextResult;
    }

    const context = contextResult;

    await this.timelineStore.appendEvent(message.conversationId, {
      messageId,
      type: "user",
      text: message.text,
      createdAtIso: message.timestampIso
    });

    const deepTask = routeDecision === "deep" ? {
      taskId: randomUUID(),
      messageId,
      conversationId: message.conversationId,
      normalizedPrompt: adaptedAnalysis.correctedText,
      createdAtIso: nowIso(),
      sizeBand,
      context: cloneConversationContext(context)
    } : undefined;

    let fastAttempt = lifecycle.create(message.conversationId, messageId, "fast", this.timelineStore);
    if (deepTask) {
      const deepAttempt = lifecycle.create(message.conversationId, messageId, "deep", this.timelineStore, deepTask.taskId);
      await deepAttempt.queued();
      await this.queue.enqueue(deepTask);
    }
    const fastStart = Date.now();
    let result: GenerationResult;
    let acknowledgment = false;
    for (let number = 0; ; number++) {
      await fastAttempt.start(this.timelineStore, this.fastProvider.metadata);
      try {
        if (!fastAttempt.active) throw new GenerationError("CANCELLED", false);
        result = await this.fastProvider.createProvisionalReply({
          message, correctedText: adaptedAnalysis.correctedText, routeDecision,
          context: cloneConversationContext(context)
        }, fastAttempt.control);
        if (Buffer.byteLength(result.text) > 1024 * 1024) throw new GenerationError("ANSWER_TOO_LARGE", false);
        break;
      } catch (error) {
        const failure = normalizeGenerationError(error);
        if (fastAttempt.status === "cancelled" || failure.code === "CANCELLED") {
          await fastAttempt.finish("cancelled");
          result = { text: fastAttempt.text, finishReason: "cancelled" }; break;
        }
        const retry = failure.retryable && !fastAttempt.text && number < 2;
        const next = retry ? lifecycle.create(message.conversationId, messageId, "fast", this.timelineStore) : undefined;
        await fastAttempt.finish("error", undefined, failure.code, retry);
        if (next) { fastAttempt = next; await next.queued(true); continue; }
        if (!deepTask) throw failure;
        acknowledgment = fastAttempt.text.length === 0;
        result = { text: acknowledgment ? "Your request is queued for deeper analysis." : fastAttempt.text, finishReason: "stop" }; break;
      }
    }
    if (fastAttempt.status === "cancelled") result = { text: fastAttempt.text, finishReason: "cancelled" };
    this.adaptiveRouting?.recordFastLatency(routeDecision, sizeBand, Date.now() - fastStart);
    const processingStatus = fastAttempt.status === "cancelled" || result.finishReason === "cancelled" ? "cancelled"
      : result.finishReason === "length" ? "incomplete" : fastAttempt.status === "error" && !deepTask ? "failed"
      : deepTask ? "provisional" : "complete";
    if (fastAttempt.active) {
      fastAttempt.text = result.text;
      await fastAttempt.finish(result.finishReason, {
        text: result.text, routeDecision, processingStatus, finishReason: result.finishReason, answerKind: "substantive"
      });
    } else if (acknowledgment && lifecycle.get(message.conversationId, messageId, "deep")?.status !== "cancelled") {
      await this.timelineStore.appendEvent(message.conversationId, {
        type: "provisional", messageId, phase: "fast", attemptId: fastAttempt.attemptId,
        text: result.text, answerKind: "acknowledgment", processingStatus: "provisional", routeDecision, createdAtIso: nowIso()
      });
    }
    return { messageId, fastResponse: { provisionalReply: result.text, analysis: adaptedAnalysis, processingStatus }, ...(deepTask ? { deepTask } : {}) };
  }
  cancel(conversationId: string, messageId: string) {
    return generationLifecycle(this.queue).cancel(conversationId, messageId);
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

    const lifecycle = generationLifecycle(this.queue);
    const messageId = task.messageId ?? task.taskId;
    const attempt = lifecycle.get(task.conversationId, messageId, "deep") ??
      lifecycle.create(task.conversationId, messageId, "deep", this.timelineStore, task.taskId);
    if (!attempt.active) { this.attemptsByTaskId.delete(task.taskId); return undefined; }
    await attempt.start(this.timelineStore, this.deepProvider.metadata);
    try {
      if (!attempt.active) return undefined;
      const result = await this.deepProvider.resolveDeepTask(task, attempt.control);
      if (!attempt.active) return undefined;
      if (Buffer.byteLength(result.finalReply) > 1024 * 1024) throw new GenerationError("ANSWER_TOO_LARGE", false);
      this.attemptsByTaskId.delete(task.taskId);
      attempt.text = result.finalReply;
      await attempt.finish(result.finishReason, {
        routeDecision: "deep", processingStatus: result.finishReason === "stop" ? "complete" : result.finishReason === "length" ? "incomplete" : "cancelled",
        text: result.finalReply, finishReason: result.finishReason, answerKind: "substantive"
      });
      this.adaptiveRouting?.recordDeepLatency(task.sizeBand ?? "medium", result.totalLatencyMs);
      return result;
    } catch (error) {
      if (attempt.status === "cancelled") { this.attemptsByTaskId.delete(task.taskId); return undefined; }
      const failure = normalizeGenerationError(error);
      if (failure.code === "CANCELLED") { await attempt.finish("cancelled"); this.attemptsByTaskId.delete(task.taskId); return undefined; }
      const attempts = (this.attemptsByTaskId.get(task.taskId) ?? 0) + 1;
      this.attemptsByTaskId.set(task.taskId, attempts);
      const retry = failure.retryable && !attempt.text && attempts <= this.maxRetries;
      // Publish the next attempt synchronously so cancellation during the terminal write also cancels the retry.
      const next = retry ? lifecycle.create(task.conversationId, messageId, "deep", this.timelineStore, task.taskId) : undefined;
      await attempt.finish("error", undefined, failure.code, retry);
      if (next) {
        if (next.active) { await next.queued(true); await this.queue.enqueue(task); }
        return undefined;
      }
      this.attemptsByTaskId.delete(task.taskId);
      await this.deadLetterStore.add({ task, errorMessage: failure.code, failedAtIso: nowIso() });
      return undefined;
    }
  }
}
