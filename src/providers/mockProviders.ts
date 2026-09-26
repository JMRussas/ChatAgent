import type { GenerationControl, GenerationResult } from "../domain/generation";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

export class MockFastProvider implements FastModelProvider {
  readonly metadata = { provider: "mock", model: "mock-v1" };
  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }, control?: GenerationControl): Promise<GenerationResult> {
    const emit = async (text: string): Promise<GenerationResult> => {
      control?.signal.throwIfAborted();
      await control?.onDelta(text);
      return { text, finishReason: "stop" };
    };
    if (input.routeDecision === "clarify") {
      return emit("I can help. Can you add one more detail so I can be precise?");
    }

    if (input.routeDecision === "deep") {
      return emit("Your request is queued for deeper analysis.");
    }

    return emit(`Quick answer: ${input.correctedText}`);
  }
}

export class MockDeepProvider implements DeepModelProvider {
  readonly metadata = { provider: "mock", model: "mock-v1" };
  async resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult> {
    control?.signal.throwIfAborted();
    await control?.onDelta(`Refined answer for: ${input.normalizedPrompt}`);
    return {
      taskId: input.taskId,
      finishReason: "stop",
      finalReply: `Refined answer for: ${input.normalizedPrompt}`,
      confidence: 0.88,
      citations: ["https://example.com/source"],
      totalLatencyMs: 2200
    };
  }
}
