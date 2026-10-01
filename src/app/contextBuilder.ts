import { renderContextSystem } from "../domain/contextRendering";
export { renderActiveTasksBlock } from "../domain/contextRendering";
import { createHash, randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";
import type {
  ActiveTaskContext,
  ActiveTaskState,
  ContextMemory,
  ContextMessage,
  ConversationContext,
  SourceRef
} from "../domain/context";

export type {
  ActiveTaskContext,
  ActiveTaskState,
  ContextMemory,
  ContextMessage,
  ConversationContext,
  SourceRef
} from "../domain/context";
export { cloneConversationContext } from "../domain/context";

export interface TokenCounter {
  estimateBytes(text: string): number;
}

/** UTF-8 byte length. Labeled "conservative" because it is not a real provider
 * tokenizer and is not a proof of fit — see spec 01's budget policy section. */
export const utf8ConservativeTokenCounter: TokenCounter = {
  estimateBytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
  }
};

const REQUEST_OVERHEAD_TOKENS = 32;
const MESSAGE_OVERHEAD_TOKENS = 16;
const DEFAULT_MAX_ACTIVE_TASKS = 4;
const ACTIVE_TASK_BUDGET_SHARE = 0.2;

export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_TOO_LARGE" as const;

  constructor(
    readonly estimatedInputTokens: number,
    readonly availableInputTokens: number
  ) {
    super(
      `Conversation context (${estimatedInputTokens} estimated tokens) exceeds the available input budget ` +
        `(${availableInputTokens} tokens) even before any history. Shorten the message or reduce configured instructions.`
    );
    this.name = "ContextBudgetError";
  }
}

export interface ContextBudget {
  windowTokens: number;
  maxHistoryTurns: number;
  safetyTokens: number;
  fastOutputTokens: number;
  deepOutputTokens: number;
}

export interface BuildContextInput {
  conversationId: string;
  /** Timeline events captured once, before the current user event is appended. */
  events: readonly ChatTimelineEvent[];
  currentMessageId: string;
  currentUserText: string;
  capturedAtIso: string;
  /** Frozen base instructions plus verified runtime facts, already assembled by the caller. */
  systemInstruction: string;
  roleInstructions: Readonly<{ fast: string; deep: string }>;
  budget: ContextBudget;
  tokenCounter?: TokenCounter;
  /** Validated memory from the captured source prefix. */
  memory?: ContextMemory | null;
  summaryMaxTokens?: number;
  resolvedSources?: ConversationContext["resolvedSources"];
  unavailableSources?: ConversationContext["unavailableSources"];
}

function computeContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface TurnRecord {
  messageId: string;
  userEvent: ChatTimelineEvent;
  userText: string;
  assistantText?: string;
  assistantEvent?: ChatTimelineEvent;
  state?: ActiveTaskState;
}

function deriveUnresolvedState(events: ChatTimelineEvent[]): ActiveTaskState {
  const relevantPhase = events.some((e) => e.phase === "deep" || e.routeDecision === "deep")
    ? "deep"
    : "fast";
  const activities = events.filter(
    (e) =>
      (e.type === "activity" || e.type === "terminal") && (!e.phase || e.phase === relevantPhase)
  );
  const lastActivity = activities[activities.length - 1];

  if (lastActivity?.finishReason === "cancelled") return "cancelled";
  if (lastActivity?.finishReason === "length") return "incomplete";
  if (lastActivity?.finishReason === "error") return lastActivity.retrying ? "retrying" : "failed";
  if (lastActivity?.activity === "running") return "running";
  if (lastActivity?.activity === "failed") return "failed";
  if (lastActivity?.activity === "retrying") return "retrying";
  if (lastActivity?.activity === "thinking") return "running";
  if (lastActivity?.activity === "queued") return "queued";
  return "incomplete";
}

export function groupIntoTurns(events: readonly ChatTimelineEvent[]): TurnRecord[] {
  const order: string[] = [];
  const byMessageId = new Map<string, ChatTimelineEvent[]>();

  for (const event of events) {
    if (!event.messageId) continue; // orphaned/legacy events without IDs are ignored for history
    if (!byMessageId.has(event.messageId)) {
      byMessageId.set(event.messageId, []);
      order.push(event.messageId);
    }
    byMessageId.get(event.messageId)!.push(event);
  }

  const turns: TurnRecord[] = [];

  for (const messageId of order) {
    const groupEvents = byMessageId.get(messageId)!;
    const userEvent = groupEvents.find((e) => e.type === "user");
    if (!userEvent) continue; // never send an unpaired historical assistant/activity event

    const refined = [...groupEvents]
      .reverse()
      .find(
        (e) =>
          e.type === "refined" &&
          (!e.finishReason || e.finishReason === "stop") &&
          (!e.processingStatus || e.processingStatus === "complete")
      );
    const completeProvisional = [...groupEvents]
      .reverse()
      .find((e) => e.type === "provisional" && e.processingStatus === "complete");
    const assistantText = refined?.text ?? completeProvisional?.text;

    turns.push({
      messageId,
      userEvent,
      userText: userEvent.text,
      assistantText,
      assistantEvent: refined ?? completeProvisional,
      state: assistantText === undefined ? deriveUnresolvedState(groupEvents) : undefined
    });
  }

  return turns;
}

function buildSourceRef(conversationId: string, turn: TurnRecord): SourceRef {
  return {
    conversationId,
    eventId: turn.userEvent.eventId ?? `${turn.messageId}-user`,
    messageId: turn.messageId,
    contentHash: computeContentHash(turn.userText)
  };
}

/**
 * Pure builder for the shared per-turn conversation snapshot (spec 01 / 01-context-memory).
 * Never touches the timeline store or the network; src/app/contextManager.ts owns capture
 * and passes in an already-copied events array plus already-assembled instructions.
 */
export function buildContext(input: BuildContextInput): ConversationContext | ContextBudgetError {
  const tokenCounter = input.tokenCounter ?? utf8ConservativeTokenCounter;

  const turns = groupIntoTurns(input.events);
  const completedTurns = turns.filter((t) => t.assistantText !== undefined);
  const unresolvedTurns = turns.filter((t) => t.assistantText === undefined);

  const cappedByTurnLimit = completedTurns.slice(-input.budget.maxHistoryTurns);

  const recentUnresolved = unresolvedTurns.slice(-DEFAULT_MAX_ACTIVE_TASKS);
  const droppedUnresolvedByLimit = unresolvedTurns.slice(
    0,
    unresolvedTurns.length - recentUnresolved.length
  );

  const roleInstructionForBudget =
    tokenCounter.estimateBytes(input.roleInstructions.fast) >=
    tokenCounter.estimateBytes(input.roleInstructions.deep)
      ? input.roleInstructions.fast
      : input.roleInstructions.deep;

  const instructionCost =
    REQUEST_OVERHEAD_TOKENS +
    tokenCounter.estimateBytes(
      renderContextSystem(input.systemInstruction, roleInstructionForBudget, [])
    ) +
    MESSAGE_OVERHEAD_TOKENS;

  const currentUserCost =
    tokenCounter.estimateBytes(input.currentUserText) + MESSAGE_OVERHEAD_TOKENS;

  const outputReserve = Math.max(input.budget.fastOutputTokens, input.budget.deepOutputTokens);
  const availableInputTokens =
    input.budget.windowTokens - outputReserve - input.budget.safetyTokens;

  const fixedCost = instructionCost + currentUserCost;
  if (fixedCost > availableInputTokens) {
    return new ContextBudgetError(fixedCost, availableInputTokens);
  }

  const remainingAfterFixed = availableInputTokens - fixedCost;
  const activeTaskBudget = Math.floor(remainingAfterFixed * ACTIVE_TASK_BUDGET_SHARE);

  const activeTaskCostOf = (turns: TurnRecord[]): number =>
    tokenCounter.estimateBytes(
      renderContextSystem(
        input.systemInstruction,
        roleInstructionForBudget,
        turns.map((t) => ({ state: t.state!, requestText: t.userText }))
      )
    ) -
    tokenCounter.estimateBytes(
      renderContextSystem(input.systemInstruction, roleInstructionForBudget, [])
    );

  const includedUnresolved = [...recentUnresolved];
  const omittedUnresolvedIds: string[] = droppedUnresolvedByLimit.map((t) => t.messageId);
  let unresolvedTotal = activeTaskCostOf(includedUnresolved);

  while (unresolvedTotal > activeTaskBudget && includedUnresolved.length > 0) {
    const dropped = includedUnresolved.shift()!;
    omittedUnresolvedIds.push(dropped.messageId);
    unresolvedTotal = activeTaskCostOf(includedUnresolved);
  }

  const remainingForPairs = remainingAfterFixed - unresolvedTotal;

  const pairCostOf = (turn: TurnRecord): number =>
    tokenCounter.estimateBytes(turn.userText) +
    MESSAGE_OVERHEAD_TOKENS +
    tokenCounter.estimateBytes(turn.assistantText!) +
    MESSAGE_OVERHEAD_TOKENS;

  // Allocate the newest four exact pairs before expendable memory.
  const includedPairs = cappedByTurnLimit.slice(-4);
  let pairsTotal = includedPairs.reduce((sum, t) => sum + pairCostOf(t), 0);
  while (pairsTotal > remainingForPairs && includedPairs.length)
    pairsTotal -= pairCostOf(includedPairs.shift()!);
  const exactIds = new Set(includedPairs.map((t) => t.messageId));
  let memory: ContextMemory | null = null;
  const resolvedSources: ConversationContext["resolvedSources"][number][] = [];
  const unavailableSources: SourceRef[] = [];
  const dataCost = () =>
    tokenCounter.estimateBytes(
      renderContextSystem(
        input.systemInstruction,
        roleInstructionForBudget,
        [],
        memory,
        resolvedSources,
        unavailableSources
      )
    ) -
    tokenCounter.estimateBytes(
      renderContextSystem(input.systemInstruction, roleInstructionForBudget, [])
    );
  const memoryAllowance = Math.min(
    input.summaryMaxTokens ?? 1024,
    Math.floor(remainingAfterFixed * 0.25),
    remainingForPairs - pairsTotal
  );
  // Reserve resolution outcomes first, so one large excerpt cannot hide other
  // attempted lookups. Upgrade unavailable entries to exact excerpts when they fit.
  const requestedRefs = [
    ...(input.resolvedSources ?? []).map((s) => s.source),
    ...(input.unavailableSources ?? [])
  ];
  for (const source of requestedRefs) {
    if (
      exactIds.has(source.messageId) ||
      unavailableSources.some((s) => s.eventId === source.eventId)
    )
      continue;
    unavailableSources.push(structuredClone(source));
    if (dataCost() > memoryAllowance) unavailableSources.pop();
  }
  for (const source of input.resolvedSources ?? []) {
    const index = unavailableSources.findIndex((s) => s.eventId === source.source.eventId);
    if (index < 0) continue;
    const [unavailable] = unavailableSources.splice(index, 1);
    resolvedSources.push(structuredClone(source));
    if (dataCost() > memoryAllowance) {
      resolvedSources.pop();
      unavailableSources.splice(index, 0, unavailable);
    }
  }
  const replaced = new Set([
    ...resolvedSources.map((s) => s.source.eventId),
    ...unavailableSources.map((s) => s.eventId)
  ]);
  for (const item of input.memory?.items ?? []) {
    if (item.sources.some((s) => exactIds.has(s.messageId) || replaced.has(s.eventId))) continue;
    const candidate: ContextMemory = {
      ...input.memory!,
      items: [...(memory?.items ?? []), structuredClone(item)]
    };
    const previous: ContextMemory | null = memory;
    memory = candidate;
    if (dataCost() > memoryAllowance) memory = previous;
  }
  const represented = new Set([
    ...(memory?.items.flatMap((i) => i.sources.map((s) => s.messageId)) ?? []),
    ...resolvedSources.map((s) => s.source.messageId)
  ]);
  let memoryTotal = dataCost();
  // Do not bridge an oversized recent pair to include older exact history.
  if (includedPairs.length === Math.min(4, cappedByTurnLimit.length)) {
    for (const pair of cappedByTurnLimit.slice(0, -4).reverse()) {
      if (represented.has(pair.messageId)) continue;
      const cost = pairCostOf(pair);
      if (pairsTotal + cost + memoryTotal > remainingForPairs) break;
      includedPairs.unshift(pair);
      pairsTotal += cost;
    }
  }
  // Recount the exact rendered data block, including every reference and escape.
  memoryTotal = dataCost();
  const includedIds = new Set(includedPairs.map((p) => p.messageId));
  const omittedPairIds = completedTurns
    .filter((p) => !includedIds.has(p.messageId))
    .map((p) => p.messageId);

  const messages: ContextMessage[] = [];
  for (const pair of includedPairs) {
    messages.push({ role: "user", content: pair.userText, messageId: pair.messageId });
    messages.push({ role: "assistant", content: pair.assistantText!, messageId: pair.messageId });
  }
  messages.push({
    role: "user",
    content: input.currentUserText,
    messageId: input.currentMessageId
  });

  const activeTasks: ActiveTaskContext[] = includedUnresolved.map((turn) => ({
    messageId: turn.messageId,
    requestText: turn.userText,
    state: turn.state!,
    source: buildSourceRef(input.conversationId, turn)
  }));

  const estimatedInputTokens = fixedCost + unresolvedTotal + pairsTotal + memoryTotal;

  return {
    version: 2,
    snapshotId: randomUUID(),
    capturedAtIso: input.capturedAtIso,
    systemInstruction: input.systemInstruction,
    roleInstructions: { fast: input.roleInstructions.fast, deep: input.roleInstructions.deep },
    memory,
    resolvedSources,
    unavailableSources,
    activeTasks,
    omittedActiveTaskIds: omittedUnresolvedIds,
    messages,
    includedTurnIds: includedPairs.map((t) => t.messageId),
    omittedTurnIds: omittedPairIds,
    estimatedInputTokens,
    budgetUsage: {
      method: "utf8-conservative-v1",
      windowTokens: input.budget.windowTokens,
      outputReserve,
      safetyReserve: input.budget.safetyTokens,
      availableInputTokens,
      totalInputTokens: estimatedInputTokens,
      instructions: instructionCost,
      tools: 0,
      references: 0,
      currentMessage: currentUserCost,
      history: pairsTotal,
      activeTasks: unresolvedTotal,
      memory: memoryTotal
    },
    budgetMethod: "utf8-conservative-v1"
  };
}
