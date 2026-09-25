import type { ConversationContext } from "./context";

export type RouteDecision = "direct" | "deep" | "clarify";

export interface UserMessage {
  conversationId: string;
  userId: string;
  text: string;
  timestampIso: string;
}

export interface FastAnalysis {
  correctedText: string;
  needsExternalData: boolean;
  needsClarification: boolean;
  routeDecision: RouteDecision;
  confidence: number;
  reasons: string[];
}

export interface FastResponse {
  provisionalReply: string;
  analysis: FastAnalysis;
  processingStatus: "provisional" | "complete";
}

export interface DeepTask {
  taskId: string;
  messageId?: string;
  conversationId: string;
  normalizedPrompt: string;
  createdAtIso: string;
  sizeBand?: "small" | "medium" | "large";
  providerHint?: string;
  // Frozen conversation snapshot from contextBuilder (spec 01). Optional so
  // legacy/direct-constructed tasks (existing unit tests, dead-letter replay
  // of older tasks) keep working via each adapter's current-prompt-only
  // fallback; every task the orchestrator itself enqueues carries one.
  context?: ConversationContext;
}

export interface DeepResult {
  taskId: string;
  finalReply: string;
  confidence: number;
  citations: string[];
  totalLatencyMs: number;
}

export interface ChatTimelineEvent {
  activity?: "queued" | "thinking" | "retrying" | "failed";
  messageId?: string;
  routeDecision?: RouteDecision;
  processingStatus?: "provisional" | "complete";
  type: "user" | "provisional" | "refined" | "activity";
  text: string;
  createdAtIso: string;
  // Assigned by the timeline store on append (spec 01's context-memory
  // extension: "add stable eventId and monotonically increasing per-conversation
  // sequence in timelineStore now"). Absent on events from a store that does not
  // track them (e.g. NoopConversationTimelineStore, which never returns history).
  eventId?: string;
  sequence?: number;
}

export interface OrchestratorResponse {
  messageId?: string;
  fastResponse: FastResponse;
  deepTask?: DeepTask;
}
