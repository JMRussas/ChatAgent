import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

export class MockFastProvider implements FastModelProvider {
  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }): Promise<string> {
    if (input.routeDecision === "clarify") {
      return "I can help. Can you add one more detail so I can be precise?";
    }

    if (input.routeDecision === "deep") {
      return "Quick take: I am analyzing this in depth and will follow up with a sourced answer.";
    }

    return `Quick answer: ${input.correctedText}`;
  }
}

export class MockDeepProvider implements DeepModelProvider {
  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    return {
      taskId: input.taskId,
      finalReply: `Refined answer for: ${input.normalizedPrompt}`,
      confidence: 0.88,
      citations: ["https://example.com/source"],
      totalLatencyMs: 2200
    };
  }
}
