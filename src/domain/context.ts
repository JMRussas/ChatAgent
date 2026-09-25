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

export type ActiveTaskState = "queued" | "running" | "retrying" | "failed" | "cancelled" | "incomplete";

export interface ActiveTaskContext {
  messageId: string;
  requestText: string;
  state: ActiveTaskState;
  source: SourceRef;
}

// Defined now for the v2 shape; always null until 01B implements the
// context-manager's internal summarization/memory lifecycle.
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

export interface ConversationContext {
  version: 2;
  snapshotId: string;
  capturedAtIso: string;
  systemInstruction: string;
  roleInstructions: Readonly<{ fast: string; deep: string }>;
  memory: ContextMemory | null;
  resolvedSources: readonly { source: SourceRef; text: string }[];
  unavailableSources: readonly SourceRef[];
  activeTasks: readonly ActiveTaskContext[];
  omittedActiveTaskIds: readonly string[];
  messages: readonly ContextMessage[];
  includedTurnIds: readonly string[];
  omittedTurnIds: readonly string[];
  estimatedInputTokens: number;
  budgetMethod: "utf8-conservative-v1";
}

/** Deep-clones a context snapshot so mutating one caller's copy never affects another's. */
export function cloneConversationContext(context: ConversationContext): ConversationContext {
  return structuredClone(context);
}
