import { buildContext, ContextBudgetError, type ContextBudget, type ConversationContext } from "./contextBuilder";
import type { ConversationTimelineStore } from "./timelineStore";
import { buildSystemInstruction, ROLE_INSTRUCTIONS, type TrustedRuntimeFacts } from "./systemInstructions";

export interface PrepareContextInput {
  conversationId: string;
  currentMessageId: string;
  currentUserText: string;
  trustedFacts: TrustedRuntimeFacts;
}

/**
 * Owns context preparation: captures one immutable timeline snapshot per turn and
 * hands it to the pure `buildContext`. Spec 01B (summarization/source lookup) adds
 * memory derivation and resolveSources() here without changing the orchestrator's
 * call site; both are not implemented yet (memory stays null, sources stay empty).
 */
export class ContextManager {
  constructor(
    private readonly timelineStore: ConversationTimelineStore,
    private readonly budget: ContextBudget
  ) {}

  async prepare(input: PrepareContextInput): Promise<ConversationContext | ContextBudgetError> {
    const events = await this.timelineStore.getEvents(input.conversationId);

    return buildContext({
      conversationId: input.conversationId,
      events,
      currentMessageId: input.currentMessageId,
      currentUserText: input.currentUserText,
      capturedAtIso: new Date().toISOString(),
      systemInstruction: buildSystemInstruction(input.trustedFacts),
      roleInstructions: ROLE_INSTRUCTIONS,
      budget: this.budget,
      memory: null
    });
  }
}
