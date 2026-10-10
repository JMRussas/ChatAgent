import { randomUUID } from "node:crypto";
import { ContextManager } from "../app/contextManager";
import { InMemoryConversationTimelineStore } from "../app/timelineStore";
import { ContextBudgetError, type ContextBudget } from "../app/contextBuilder";
import type { TrustedRuntimeFacts } from "../app/systemInstructions";
import type { FastModelProvider } from "../providers/interfaces";
import type { CatalogDispatch, DispatchPlan } from "../routing/catalogDispatch";
import { WorkflowError, type WorkflowContext } from "./types";

/** Reuses provider selection/admission; step inputs are explicit and independent of chat history. */
export function workflowModelAction(
  provider: FastModelProvider,
  budget: ContextBudget,
  facts: () => TrustedRuntimeFacts,
  dispatch?: CatalogDispatch
) {
  return async (prompt: string, inputs: unknown, caller: WorkflowContext): Promise<unknown> => {
    const signal = caller.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const messageId = randomUUID();
    const conversationId = `workflow:${caller.operationId}`;
    const text = `${prompt}\n\nStep inputs (data):\n${JSON.stringify(inputs)}`;
    const manager = new ContextManager(new InMemoryConversationTimelineStore(), budget);
    const input = {
      conversationId,
      currentMessageId: messageId,
      currentUserText: text,
      trustedFacts: facts(),
      routeDecision: "direct" as const
    };
    let selection: DispatchPlan | undefined;
    try {
      selection = dispatch ? await dispatch.prepare(manager, input, undefined, signal) : undefined;
      const context = selection?.context ?? (await manager.prepare(input));
      if (context instanceof ContextBudgetError)
        throw new WorkflowError(
          "MODEL_INPUT_TOO_LARGE",
          "The model step input exceeds its context allowance.",
          413
        );
      const selected = selection ? selection.fast.candidate.binding.fast! : provider;
      const control = { signal, attemptId: messageId, onDelta: async (_text: string) => undefined };
      const work = () =>
        selected.createProvisionalReply(
          {
            message: {
              messageId,
              conversationId,
              userId: caller.principal.principalId,
              text,
              timestampIso: new Date().toISOString()
            },
            correctedText: text,
            routeDecision: "direct",
            context
          },
          control
        );
      const result = selection
        ? await dispatch!.execute(selection.fast, control, "workflow", work)
        : await work();
      signal.throwIfAborted();
      if (selection) dispatch!.validateAnswer(selection.fast, result.text, result.finishReason);
      if (result.finishReason !== "stop")
        throw new WorkflowError(
          "MODEL_INCOMPLETE",
          "The model step was cancelled or truncated; no complete result is available.",
          502
        );
      return {
        text: result.text,
        model: selected.metadata ?? null,
        ...(result.usage ? { usage: result.usage } : {})
      };
    } finally {
      dispatch?.complete(selection?.fast);
      dispatch?.complete(selection?.deep);
      await manager.shutdown();
    }
  };
}
