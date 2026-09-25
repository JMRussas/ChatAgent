import type { ConversationContext } from "../../src/domain/context";

/** A minimal, valid ConversationContext for adapter request-shape tests. */
export function sampleContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    version: 2,
    snapshotId: "snapshot-1",
    capturedAtIso: "2026-09-25T12:00:00.000Z",
    systemInstruction: "BASE INSTRUCTIONS AND VERIFIED FACTS",
    roleInstructions: { fast: "FAST ROLE INSTRUCTIONS", deep: "DEEP ROLE INSTRUCTIONS" },
    memory: null,
    resolvedSources: [],
    unavailableSources: [],
    activeTasks: [],
    omittedActiveTaskIds: [],
    messages: [
      { role: "user", content: "What is event sourcing?", messageId: "m1" },
      { role: "assistant", content: "It's a pattern where state changes are stored as events.", messageId: "m1" },
      { role: "user", content: "Why?", messageId: "current" }
    ],
    includedTurnIds: ["m1"],
    omittedTurnIds: [],
    estimatedInputTokens: 123,
    budgetMethod: "utf8-conservative-v1",
    ...overrides
  };
}
