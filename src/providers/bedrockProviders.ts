import {
  GenerationError,
  type GenerationControl,
  type GenerationResult
} from "../domain/generation";
import { AnswerCollector, MAX_ANSWER_BYTES, withGenerationDeadline } from "./streaming";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";
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
  maxOutputTokens?: number,
  control?: GenerationControl
): Promise<GenerationResult> {
  const input = {
    modelId,
    messages,
    ...(system !== undefined ? { system: [{ text: system }] } : {}),
    inferenceConfig: {
      temperature,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {})
    }
  };
  return withGenerationDeadline("Bedrock", 60_000, control, async (signal) => {
    const collector = new AnswerCollector(control);
    if (!control) {
      const response = await client.send(new ConverseCommand(input), { abortSignal: signal });
      for (const block of response.output?.message?.content ?? [])
        if (block.text !== undefined) await collector.add(block.text);
      return collector.finish(response.stopReason ?? "end_turn");
    }
    const response = await client.send(new ConverseStreamCommand(input), { abortSignal: signal });
    if (!response.stream) throw new GenerationError("INVALID_STREAM", false);
    for await (const event of response.stream) {
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_ANSWER_BYTES)
        throw new GenerationError("STREAM_TOO_LARGE", false);
      if (
        event.internalServerException ||
        event.modelStreamErrorException ||
        event.serviceUnavailableException ||
        event.throttlingException
      )
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      if (event.validationException) throw new GenerationError("PROVIDER_REQUEST_INVALID", false);
      if (event.$unknown) throw new GenerationError("INVALID_STREAM", false);
      if (event.contentBlockDelta?.delta?.text !== undefined)
        await collector.add(event.contentBlockDelta.delta.text);
      if (event.messageStop) return collector.finish(event.messageStop.stopReason);
    }
    throw new GenerationError("INVALID_STREAM", false);
  });
}

function legacyFastMessages(input: {
  message: UserMessage;
  correctedText: string;
  routeDecision: string;
}): BedrockConverseMessage[] {
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

function contextMessagesFor(
  context: ConversationContext,
  role: "fast" | "deep"
): { system: string; messages: BedrockConverseMessage[] } {
  const { system, messages } = buildSystemAndMessages(context, role);
  return {
    system,
    messages: messages.map((m) => ({ role: m.role, content: [{ text: m.content }] }))
  };
}

export class BedrockFastProvider implements FastModelProvider {
  get metadata() {
    return { provider: "bedrock", model: this.modelId };
  }
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number,
    private readonly maxOutputTokens?: number
  ) {
    this.client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  }

  async createProvisionalReply(
    input: {
      message: UserMessage;
      correctedText: string;
      routeDecision: "direct" | "deep" | "clarify";
      context?: ConversationContext;
    },
    control?: GenerationControl
  ): Promise<GenerationResult> {
    if (input.context) {
      const { system, messages } = contextMessagesFor(input.context, "fast");
      return converseBedrock(
        this.client,
        this.modelId,
        messages,
        this.temperature,
        system,
        this.maxOutputTokens,
        control
      );
    }

    return converseBedrock(
      this.client,
      this.modelId,
      legacyFastMessages(input),
      this.temperature,
      undefined,
      this.maxOutputTokens,
      control
    );
  }
}

export class BedrockDeepProvider implements DeepModelProvider {
  get metadata() {
    return { provider: "bedrock", model: this.modelId };
  }
  private readonly client: BedrockRuntimeClient;

  constructor(
    region: string,
    private readonly modelId: string,
    private readonly temperature: number,
    private readonly maxOutputTokens?: number
  ) {
    this.client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  }

  async resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult> {
    const start = Date.now();

    const result = input.context
      ? await (async () => {
          const { system, messages } = contextMessagesFor(input.context!, "deep");
          return converseBedrock(
            this.client,
            this.modelId,
            messages,
            this.temperature,
            system,
            this.maxOutputTokens,
            control
          );
        })()
      : await converseBedrock(
          this.client,
          this.modelId,
          legacyDeepMessages(input.normalizedPrompt),
          this.temperature,
          undefined,
          this.maxOutputTokens,
          control
        );

    return {
      taskId: input.taskId,
      finalReply: result.text,
      finishReason: result.finishReason,
      confidence: 0.86,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
