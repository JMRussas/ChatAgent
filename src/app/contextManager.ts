import { randomUUID } from "node:crypto";
import { buildContext, ContextBudgetError, groupIntoTurns, type ContextBudget, type ConversationContext } from "./contextBuilder";
import type { ConversationTimelineStore } from "./timelineStore";
import { buildSystemInstruction, roleInstructionsForRoute, type TrustedRuntimeFacts } from "./systemInstructions";
import type { ContextMemory, MemoryItem, SourceRef } from "../domain/context";
import { contentHash, InMemorySourceStore, resolveSources, type SourceRecord, type SourceSnapshot, type SourceStore } from "./sourceStore";
import { InMemorySummaryStore, type SummaryStore } from "./summaryStore";
import { sourceChunks, ExtractiveContextSummarizer, isCorrection, validateSummary, type ContextSummarizer } from "./contextSummarizer";
import { summaryConfigSchema, type SummaryConfig } from "../config/summaryConfig";
import type { ChatTimelineEvent } from "../domain/types";

export interface PrepareContextInput {
  conversationId: string;
  currentMessageId: string;
  currentUserText: string;
  trustedFacts: TrustedRuntimeFacts;
  routeDecision?: "direct" | "clarify" | "deep";
}
export interface ContextMemoryOptions {
  config?: SummaryConfig;
  sourceStore?: SourceStore;
  summaryStore?: SummaryStore;
  summarizer?: ContextSummarizer;
}
const digest = (records: readonly SourceRecord[]) => contentHash(JSON.stringify(records));
const checkPrompt = (text: string) => /\b(how do you know|check that|verify that|what did I say)\b/i.test(text);
interface Job { digest: string; controller: AbortController; promise: Promise<void> }

/** Captures once; summary jobs never delay the current request or mutate its snapshot. */
export class ContextManager {
  private readonly config: SummaryConfig;
  private readonly sources: SourceStore;
  private readonly summaries: SummaryStore;
  private readonly summarizer: ContextSummarizer;
  private readonly jobs = new Map<string, Job>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private readonly counts = { scheduled: 0, published: 0, failed: 0, cancelled: 0, timedOut: 0, requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  constructor(private readonly timelineStore: ConversationTimelineStore, private readonly budget: ContextBudget, options: ContextMemoryOptions = {}) {
    this.config = summaryConfigSchema.parse(options.config ?? {});
    if (this.config.mode === "model" && (!options.summarizer || options.summarizer.method !== "model-v1"))
      throw new Error("CONTEXT_SUMMARY_MODE=model requires an explicitly configured summarization provider");
    if (this.config.mode === "extractive" && options.summarizer?.method === "model-v1")
      throw new Error("Model summarizers require CONTEXT_SUMMARY_MODE=model");
    this.sources = options.sourceStore ?? new InMemorySourceStore();
    this.summaries = options.summaryStore ?? new InMemorySummaryStore();
    this.summarizer = options.summarizer ?? new ExtractiveContextSummarizer(this.config.maxTokens);
  }
  getSummaryTelemetry() { return { ...this.counts, activeJobs: this.jobs.size }; }
  private eligible(events: readonly ChatTimelineEvent[], snapshot: SourceSnapshot) {
    const turns = groupIntoTurns(events).filter(t => t.assistantEvent);
    const ids = new Set(turns.flatMap(t => [t.userEvent.eventId, t.assistantEvent!.eventId]));
    return { turns, records: snapshot.records.filter(r => ids.has(r.source.eventId)) };
  }
  private valid(memory: ContextMemory, events: readonly ChatTimelineEvent[], snapshot: SourceSnapshot): boolean {
    const { turns, records } = this.eligible(events, snapshot);
    const ids = new Set(turns.filter(t => (t.userEvent.sequence ?? Infinity) <= memory.coveredThroughSequence &&
      (t.assistantEvent!.sequence ?? Infinity) <= memory.coveredThroughSequence).flatMap(t => [t.userEvent.eventId, t.assistantEvent!.eventId]));
    const eligible = records.filter(r => ids.has(r.source.eventId));
    return digest(eligible) === memory.sourceDigest &&
      memory.items.every(i => i.sources.every(ref => !!this.sources.resolve(ref, snapshot))) &&
      !events.some(e => e.type === "user" && (e.sequence ?? 0) > memory.coveredThroughSequence && isCorrection(e.text));
  }
  resolveSources(refs: readonly SourceRef[], snapshot: SourceSnapshot, allowance: number) {
    return resolveSources(refs, snapshot, this.sources, allowance);
  }
  async capture(input: PrepareContextInput) {
    const capturedInput = structuredClone(input);
    const events = structuredClone(await this.timelineStore.getEvents(input.conversationId));
    const snapshot = this.sources.capture(input.conversationId, events);
    const stored = this.config.mode === "off" ? null : this.summaries.get(input.conversationId);
    const memory = stored && this.valid(stored, events, snapshot) && !isCorrection(input.currentUserText) ? structuredClone(stored) : null;
    const capturedAtIso = new Date().toISOString();
    const baseFor = (budget: ContextBudget, facts = capturedInput.trustedFacts, taskIntent?: string) => ({
      conversationId: capturedInput.conversationId, events,
      currentMessageId: capturedInput.currentMessageId, currentUserText: capturedInput.currentUserText,
      capturedAtIso, systemInstruction: buildSystemInstruction(facts),
      roleInstructions: { ...roleInstructionsForRoute(capturedInput.routeDecision ?? "direct"),
        fast: roleInstructionsForRoute(capturedInput.routeDecision ?? "direct").fast + (taskIntent ? `\nTask intent: ${taskIntent}. No tool execution is available.` : "") },
      budget, memory, summaryMaxTokens: this.config.maxTokens
    });
    let scheduled = false;
    return {
      preview: (budget: ContextBudget = this.budget, facts = capturedInput.trustedFacts, taskIntent?: string): ConversationContext | ContextBudgetError => {
        const base = baseFor(budget, facts, taskIntent);
        let context = buildContext(base);
        if (context instanceof ContextBudgetError) return context;
        if (checkPrompt(capturedInput.currentUserText) && context.memory) {
          const refs = context.memory.items.slice(0, 4).flatMap(i => i.sources).filter((ref, index, refs) => refs.findIndex(r => r.eventId === ref.eventId) === index).slice(0, 4);
          const resolved = this.resolveSources(refs, snapshot, this.config.maxTokens);
          context = buildContext({ ...base, resolvedSources: resolved.resolved, unavailableSources: resolved.unavailable });
        }
        return context;
      },
      schedule: (budget: ContextBudget = this.budget, facts = capturedInput.trustedFacts, taskIntent?: string) => {
        if (scheduled) return;
        scheduled = true;
        const mandatory = buildContext({ ...baseFor(budget, facts, taskIntent), events: [], memory: null });
        if (!(mandatory instanceof ContextBudgetError)) {
          const usable = budget.windowTokens - Math.max(budget.fastOutputTokens, budget.deepOutputTokens) - budget.safetyTokens - mandatory.estimatedInputTokens;
          this.schedule(capturedInput.conversationId, events, snapshot, usable);
        }
      }
    };
  }
  async prepare(input: PrepareContextInput): Promise<ConversationContext | ContextBudgetError> {
    const captured = await this.capture(input);
    const context = captured.preview();
    if (!(context instanceof ContextBudgetError)) captured.schedule();
    return context;
  }
  private schedule(conversationId: string, events: ChatTimelineEvent[], snapshot: SourceSnapshot, allowance: number) {
    if (this.stopped || this.config.mode === "off") return;
    const { turns, records } = this.eligible(events, snapshot);
    const uncompressedCost = records.reduce((sum, r) => sum + Buffer.byteLength(r.text) + 16, 0);
    if (turns.length < 5 || (turns.length <= this.budget.maxHistoryTurns && uncompressedCost <= allowance * this.config.triggerRatio)) return;
    const boundary = turns.slice(-4)[0].userEvent.sequence ?? 0;
    const older = turns.slice(0, -4).filter(t => (t.assistantEvent!.sequence ?? Infinity) < boundary);
    const ids = new Set(older.flatMap(t => [t.userEvent.eventId, t.assistantEvent!.eventId]));
    const prefix = records.filter(r => ids.has(r.source.eventId) && r.sequence < boundary);
    if (!prefix.length) return;
    const sourceDigest = digest(prefix), previous = this.summaries.get(conversationId);
    if (previous?.sourceDigest === sourceDigest && this.valid(previous, events, snapshot)) return;
    if (this.jobs.get(conversationId)?.digest === sourceDigest) return;
    this.jobs.get(conversationId)?.controller.abort();
    const controller = new AbortController();
    const job: Job = { digest: sourceDigest, controller, promise: Promise.resolve() };
    this.jobs.set(conversationId, job); this.counts.scheduled++;
    // Defer *all* summarizer work until after the current prepare call can finish.
    job.promise = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const start = Date.now(); const timer = setTimeout(() => controller.abort(new Error("SUMMARY_TIMEOUT")), this.config.timeoutMs);
      try {
        controller.signal.throwIfAborted();
        const items: MemoryItem[] = [];
        for (const chunk of sourceChunks([...prefix].reverse(), this.summarizer.inputLimit)) {
          await new Promise<void>(resolve => setImmediate(resolve));
          controller.signal.throwIfAborted();
          this.counts.requests++; this.counts.inputTokens += Buffer.byteLength(JSON.stringify(chunk));
          const output = await this.callSummarizer(chunk, controller.signal);
          const validated = validateSummary(output, chunk, this.summarizer);
          this.counts.outputTokens += Buffer.byteLength(JSON.stringify(output));
          for (const item of validated) {
            if (items.length >= 32) break;
            if (items.some(i => i.sources.some(s => item.sources.some(ref => ref.eventId === s.eventId)))) continue;
            if (Buffer.byteLength(JSON.stringify([...items, item])) <= this.config.maxTokens) items.push(item);
          }
          // Newest-first selection: avoid paid requests once the memory allowance is nearly full.
          if (Buffer.byteLength(JSON.stringify(items)) >= this.config.maxTokens * 0.8) break;
        }
        const sequences = new Map(prefix.map(r => [r.source.eventId, r.sequence]));
        const newest = (item: MemoryItem) => Math.max(...item.sources.map(s => sequences.get(s.eventId) ?? 0));
        items.sort((a, b) => newest(b) - newest(a));
        const finalItems = validateSummary(items, prefix, this.summarizer, this.config.maxTokens);
        const memory: ContextMemory = { id: randomUUID(), revision: (previous?.revision ?? 0) + 1,
          coveredThroughSequence: Math.max(...prefix.map(r => r.sequence)), sourceDigest, items: finalItems, method: this.summarizer.method };
        // A new refinement/deletion can invalidate this captured prefix while a job runs.
        const latest = structuredClone(await this.timelineStore.getEvents(conversationId));
        const latestSources = this.sources.capture(conversationId, latest);
        if (this.stopped || controller.signal.aborted || this.jobs.get(conversationId) !== job || !this.valid(memory, latest, latestSources)) return;
        if (this.summaries.compareAndSwap(conversationId, previous?.revision ?? 0, memory)) this.counts.published++;
      } catch {
        if (controller.signal.aborted) {
          if (controller.signal.reason?.message === "SUMMARY_TIMEOUT") this.counts.timedOut++;
          else this.counts.cancelled++;
        } else this.counts.failed++;
      } finally {
        clearTimeout(timer); this.counts.latencyMs += Date.now() - start;
        if (this.jobs.get(conversationId) === job) this.jobs.delete(conversationId);
      }
    });
    this.pending.add(job.promise);
    void job.promise.finally(() => this.pending.delete(job.promise));
  }
  private async callSummarizer(records: SourceRecord[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([this.summarizer.summarize(structuredClone(records), signal), cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  /** Bounded even for a non-cooperative port; discarded results can never publish. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.pending]);
  }
}
