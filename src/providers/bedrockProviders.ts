import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface BedrockConverseMessage {
  role: "user" | "assistant";
  content: Array<{ text: string }>;
}

async function converseBedrock(
  client: BedrockRuntimeClient,
  modelId: string,
  messages: BedrockConverseMessage[],
  temperature: number,
  system?: string,
  maxOutputTokens?: number
): Promise<string> {
  const command = new ConverseCommand({
    modelId,
    messages,
    ...(system !== undefined ? { system: [{ text: system }] } : {}),
    inferenceConfig: {
      temperature,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {})
    }
  });

  const response = await client.send(command);
  const text = response.output?.message?.content?.find((c) => typeof c.text === "string")?.text ?? "";
  return text.trim();
}

function legacyFastMessages(input: { message: UserMessage; correctedText: string; routeDecision: string }): BedrockConverseMessage[] {
  const prompt = [
    "You are the fast-response layer in a dual-path assistant.",
    `Route: ${input.routeDecision}`,
    `Original: ${input.message.text}`,
    `Normalized: ${input.correctedText}`,
    "Keep it concise and useful."
  ].join("\n");

  return [{ role: "user", content: [{ text: prompt }] }];
}

function legacyDeepMessages(normalizedPrompt: string): BedrockConverseMessage[] {
  const prompt = [
    "You are the deep-analysis layer in a dual-path assistant.",
    "Provide refined reasoning and include citations when possible.",
    `Prompt: ${normalizedPrompt}`
  ].join("\n");

  return [{ role: "user", content: [{ text: prompt }] }];
}

function contextMessagesFor(context: ConversationContext, role: "fast" | "deep"): { system: string; messages: BedrockConverseMessage[] } {
  const { system, messages } = buildSystemAndMessages(context, role);
  return { system, messages: messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })) };
}

export class BedrockFastProvider implements FastModelProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number,
    private readonly maxOutputTokens?: number
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
    context?: ConversationContext;
  }): Promise<string> {
    if (input.context) {
      const { system, messages } = contextMessagesFor(input.context, "fast");
      return converseBedrock(this.client, this.modelId, messages, this.temperature, system, this.maxOutputTokens);
    }

    return converseBedrock(this.client, this.modelId, legacyFastMessages(input), this.temperature, undefined, this.maxOutputTokens);
  }
}

export class BedrockDeepProvider implements DeepModelProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number,
    private readonly maxOutputTokens?: number
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();

    const finalReply = input.context
      ? await (async () => {
          const { system, messages } = contextMessagesFor(input.context!, "deep");
          return converseBedrock(this.client, this.modelId, messages, this.temperature, system, this.maxOutputTokens);
        })()
      : await converseBedrock(this.client, this.modelId, legacyDeepMessages(input.normalizedPrompt), this.temperature, undefined, this.maxOutputTokens);

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.86,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
