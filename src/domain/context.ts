// Shared conversation-context types (spec 01 + its memory extension). Lives in
// domain/ (not app/contextBuilder.ts) so DeepTask and other domain types can
// reference ConversationContext without an app -> domain dependency inversion.

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  messageId: string;
}

export interface SourceRef {
  conversationId: string;
  eventId: string;
  messageId: string;
  contentHash: string;
}

export type ActiveTaskState =
  "queued" | "running" | "retrying" | "failed" | "cancelled" | "incomplete";

export interface ActiveTaskContext {
  messageId: string;
  requestText: string;
  state: ActiveTaskState;
  source: SourceRef;
}

// Source-backed derived memory, selected and budgeted by ContextManager (01B).
export interface MemoryItem {
  id: string;
  kind: "goal" | "decision" | "constraint" | "open-question" | "claim";
  text: string;
  provenance: "user-stated" | "tool-observed" | "assistant-claimed";
  sources: readonly SourceRef[];
  status: "active" | "superseded" | "disputed";
  supersedes?: string;
}

export interface ContextMemory {
  id: string;
  revision: number;
  coveredThroughSequence: number;
  sourceDigest: string;
  items: readonly MemoryItem[];
  method: "extractive-v1" | "model-v1";
}

/**
 * An attributed handoff view from a predecessor session (Hekate plan 034), attached
 * only by `attachHandoffView`. Rendered as delimited untrusted data, never as an
 * instruction or a message.
 */
export interface HandoffViewContext {
  /** The exact emitted view part: header, canonical view, digest line. */
  readonly part: string;
  readonly viewDigest: string;
  readonly candidateDigest: string;
  readonly viewCost: number;
  /** Estimated tokens of the rendered block, including its separator. */
  readonly renderedTokens: number;
}

export interface ConversationContext {
  budgetUsage?: import("./contextBudgetUsage").ContextBudgetUsage;
  version: 2;
  snapshotId: string;
  capturedAtIso: string;
  systemInstruction: string;
  roleInstructions: Readonly<{ fast: string; deep: string }>;
  memory: ContextMemory | null;
  resolvedSources: readonly { source: SourceRef; text: string }[];
  unavailableSources: readonly SourceRef[];
  /**
   * Host-only, never rendered: distinct requested source events shown in no form,
   * neither as a resolved excerpt, an unavailable marker nor an included exact
   * history pair, because even their marker did not fit the memory allowance.
   */
  omittedSourceCount: number;
  activeTasks: readonly ActiveTaskContext[];
  omittedActiveTaskIds: readonly string[];
  messages: readonly ContextMessage[];
  includedTurnIds: readonly string[];
  omittedTurnIds: readonly string[];
  estimatedInputTokens: number;
  budgetMethod: "utf8-conservative-v1";
  /** Present only on a worker context built by `attachHandoffView`. */
  readonly handoffView?: HandoffViewContext;
}

/** Deep-clones a context snapshot so mutating one caller's copy never affects another's. */
export function cloneConversationContext(context: ConversationContext): ConversationContext {
  return structuredClone(context);
}
