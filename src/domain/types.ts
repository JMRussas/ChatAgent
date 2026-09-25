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
}

export interface OrchestratorResponse {
  messageId?: string;
  fastResponse: FastResponse;
  deepTask?: DeepTask;
}
