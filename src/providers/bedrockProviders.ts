import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

async function converseBedrock(client: BedrockRuntimeClient, modelId: string, prompt: string, temperature: number): Promise<string> {
  const command = new ConverseCommand({
    modelId,
    messages: [
      {
        role: "user",
        content: [{ text: prompt }]
      }
    ],
    inferenceConfig: {
      temperature
    }
  });

  const response = await client.send(command);
  const text = response.output?.message?.content?.find((c) => typeof c.text === "string")?.text ?? "";
  return text.trim();
}

export class BedrockFastProvider implements FastModelProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }): Promise<string> {
    const prompt = [
      "You are the fast-response layer in a dual-path assistant.",
      `Route: ${input.routeDecision}`,
      `Original: ${input.message.text}`,
      `Normalized: ${input.correctedText}`,
      "Keep it concise and useful."
    ].join("\n");

    return converseBedrock(this.client, this.modelId, prompt, this.temperature);
  }
}

export class BedrockDeepProvider implements DeepModelProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();
    const prompt = [
      "You are the deep-analysis layer in a dual-path assistant.",
      "Provide refined reasoning and include citations when possible.",
      `Prompt: ${input.normalizedPrompt}`
    ].join("\n");

    const finalReply = await converseBedrock(this.client, this.modelId, prompt, this.temperature);

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.86,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
