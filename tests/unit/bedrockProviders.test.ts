import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleContext } from "../helpers/contextFixtures";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class ConverseCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class BedrockRuntimeClient {
    send = sendMock;

    constructor(_config: unknown) {}
  }

  return {
    BedrockRuntimeClient,
    ConverseCommand
  };
});

describe("bedrock providers", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("maps fast provider call to Bedrock converse command", async () => {
    sendMock.mockResolvedValue({
      output: {
        message: {
          content: [{ text: " fast bedrock answer " }]
        }
      }
    });

    const { BedrockFastProvider } = await import("../../src/providers/bedrockProviders");
    const provider = new BedrockFastProvider("us-east-1", "anthropic.model-fast", 0.2);

    const result = await provider.createProvisionalReply({
      message: {
        conversationId: "c1",
        userId: "u1",
        text: "hello",
        timestampIso: new Date().toISOString()
      },
      correctedText: "hello",
      routeDecision: "direct"
    });

    expect(result.text).toBe(" fast bedrock answer ");
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0][0] as { input: { modelId: string } };
    expect(command.input.modelId).toBe("anthropic.model-fast");
  });

  it("maps deep provider response to DeepResult", async () => {
    sendMock.mockResolvedValue({
      output: {
        message: {
          content: [{ text: "deep bedrock answer" }]
        }
      }
    });

    const { BedrockDeepProvider } = await import("../../src/providers/bedrockProviders");
    const provider = new BedrockDeepProvider("us-east-1", "anthropic.model-deep", 0.2);

    const result = await provider.resolveDeepTask({
      taskId: "task1",
      conversationId: "conv1",
      normalizedPrompt: "analyze this",
      createdAtIso: new Date().toISOString()
    });

    expect(result.taskId).toBe("task1");
    expect(result.finalReply).toBe("deep bedrock answer");
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends a separate system field, role-based messages, and the output cap when a context is supplied", async () => {
    sendMock.mockResolvedValue({
      output: { message: { content: [{ text: "answer" }] } }
    });

    const { BedrockFastProvider } = await import("../../src/providers/bedrockProviders");
    const provider = new BedrockFastProvider("us-east-1", "anthropic.model-fast", 0.2, 512);

    await provider.createProvisionalReply({
      message: { conversationId: "c1", userId: "u1", text: "Why?", timestampIso: new Date().toISOString() },
      correctedText: "Why?",
      routeDecision: "direct",
      context: sampleContext()
    });

    const command = sendMock.mock.calls[0][0] as {
      input: { system?: Array<{ text: string }>; messages: Array<{ role: string; content: Array<{ text: string }> }>; inferenceConfig: { maxTokens?: number } };
    };

    expect(command.input.system?.[0]?.text).toContain("BASE INSTRUCTIONS AND VERIFIED FACTS");
    expect(command.input.system?.[0]?.text).toContain("FAST ROLE INSTRUCTIONS");
    expect(command.input.messages).toEqual([
      { role: "user", content: [{ text: "What is event sourcing?" }] },
      { role: "assistant", content: [{ text: "It's a pattern where state changes are stored as events." }] },
      { role: "user", content: [{ text: "Why?" }] }
    ]);
    expect(command.input.inferenceConfig.maxTokens).toBe(512);
  });

  it("propagates Bedrock errors", async () => {
    sendMock.mockRejectedValue(new Error("bedrock failure"));

    const { BedrockFastProvider } = await import("../../src/providers/bedrockProviders");
    const provider = new BedrockFastProvider("us-east-1", "anthropic.model-fast", 0.2);

    await expect(
      provider.createProvisionalReply({
        message: {
          conversationId: "c2",
          userId: "u2",
          text: "hello",
          timestampIso: new Date().toISOString()
        },
        correctedText: "hello",
        routeDecision: "direct"
      })
    ).rejects.toThrow("PROVIDER_ERROR");
  });
});
