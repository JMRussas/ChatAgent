import type { FinishReason, GenerationMetadata } from "./generation";
import type { ConversationContext } from "./context";

export type RouteDecision = "direct" | "deep" | "clarify";

export interface UserMessage {
  referenceSelections?: import("../app/referenceSelection").ReferenceSelection;
  attachedReferences?: import("../app/referenceSelection").AttachedReference[];
  runControls?: import("../app/runControls").RunControls;
  /** Server-owned selection; never accepted directly from request JSON. */
  selectedContext?: ReturnType<typeof import("../app/conversationScope").scopeForModel>;
  messageId?: string;
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
  confidence: number | null;
  reasons: string[];
}

export interface FastResponse {
  provisionalReply: string;
  analysis: FastAnalysis;
  processingStatus: "provisional" | "complete" | "incomplete" | "cancelled" | "failed";
}

export interface DeepTask {
  dispatchId?: string;
  selection?: import("../routing/modelSelector").ModelSelection;
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
  finishReason: FinishReason;
  taskId: string;
  finalReply: string;
  confidence: number;
  citations: string[];
  totalLatencyMs: number;
}

export interface ChatTimelineEvent {
  contextBudget?: import("./contextBudgetUsage").ContextBudgetUsage;
  roleExecution?: import("../app/roleCatalog").RoleExecution;
  /** UI/evaluation only; never serialize into model history. */
  payloadResults?: import("../app/toolResult").ToolResult[];
  attachedReferences?: UserMessage["attachedReferences"];
  selectedContext?: UserMessage["selectedContext"];
  runControls?: import("../app/runControls").RunControls;
  capabilityPlan?: unknown;
  selections?: { fast: import("../routing/modelSelector").ModelSelection; deep?: import("../routing/modelSelector").ModelSelection };
  activity?: "queued" | "thinking" | "running" | "generating" | "retrying" | "failed";
  phase?: "fast" | "deep";
  attemptId?: string;
  taskId?: string;
  finishReason?: FinishReason | "error";
  errorCode?: string;
  retrying?: boolean;
  model?: GenerationMetadata;
  answerKind?: "acknowledgment" | "substantive";
  messageId?: string;
  routeDecision?: RouteDecision;
  processingStatus?: "provisional" | "complete" | "incomplete" | "cancelled" | "failed";
  type: "user" | "provisional" | "refined" | "activity" | "delta" | "terminal";
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
