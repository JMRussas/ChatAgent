import { GenerationError, httpGenerationError, type GenerationControl, type GenerationResult } from "../domain/generation";
import { AnswerCollector, parseFrame, sseData, withGenerationDeadline } from "./streaming";
import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface AzureChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callAzureChat(args: {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
  temperature: number;
  timeoutMs: number;
  messages: AzureChatMessage[];
  maxOutputTokens?: number;
  control?: GenerationControl;
}): Promise<GenerationResult> {
  const base = args.endpoint.replace(/\/$/, "");
  const url = `${base}/openai/deployments/${args.deployment}/chat/completions?api-version=${encodeURIComponent(args.apiVersion)}`;

  return withGenerationDeadline("Azure OpenAI", args.timeoutMs, args.control, async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": args.apiKey
      },
      body: JSON.stringify({
        messages: args.messages,
        stream: Boolean(args.control),
        temperature: args.temperature,
        ...(args.maxOutputTokens !== undefined ? { max_tokens: args.maxOutputTokens } : {})
      }),
      signal
    });

    if (!response.ok) throw httpGenerationError(response.status);
    const collector = new AnswerCollector(args.control);
    if (!args.control) {
      const payload = await response.json();
      await collector.add(payload.choices?.[0]?.message?.content ?? "");
      return collector.finish(payload.choices?.[0]?.finish_reason ?? "stop");
    }
    let finish: string | undefined;
    for await (const data of sseData(response, signal)) {
      if (data === "[DONE]") {
        if (!finish) throw new GenerationError("INVALID_STREAM", false);
        return collector.finish(finish);
      }
      const frame = parseFrame(data);
      if (frame.error || !Array.isArray(frame.choices) || frame.choices.some((item: unknown) => !item || typeof item !== "object")) throw new GenerationError("INVALID_STREAM", false);
      const choice = frame.choices.find((item: any) => item.index === 0);
      if (!choice) continue; // Usage and prompt-filter frames contain no answer.
      if (choice.delta?.content != null) {
        if (finish) throw new GenerationError("INVALID_STREAM", false);
        await collector.add(choice.delta.content);
      }
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
    throw new GenerationError("INVALID_STREAM", false);

  });
}

/** Legacy current-prompt-only shape, used only when no ConversationContext is supplied. */
function legacyFastMessages(input: { message: UserMessage; correctedText: string; routeDecision: string }): AzureChatMessage[] {
  const prompt = [
    "You are the fast-response layer in a dual-path chatbot.",
    `Route: ${input.routeDecision}`,
    `Original: ${input.message.text}`,
    `Normalized: ${input.correctedText}`,
    "Respond with one short paragraph."
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function contextFastMessages(context: ConversationContext): AzureChatMessage[] {
  const { system, messages } = buildSystemAndMessages(context, "fast");
  return [{ role: "system", content: system }, ...messages];
}

function legacyDeepMessages(normalizedPrompt: string): AzureChatMessage[] {
  const prompt = [
    "You are the deep-analysis layer in a dual-path chatbot.",
    "Generate a refined answer and include citations when external facts are used.",
    `Prompt: ${normalizedPrompt}`
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function contextDeepMessages(context: ConversationContext): AzureChatMessage[] {
  const { system, messages } = buildSystemAndMessages(context, "deep");
  return [{ role: "system", content: system }, ...messages];
}

export class AzureFastProvider implements FastModelProvider {
  get metadata() { return { provider: "azure", model: this.deployment }; }
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
    private readonly deployment: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly maxOutputTokens?: number
  ) {}

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
    context?: ConversationContext;
  }, control?: GenerationControl): Promise<GenerationResult> {
    const messages = input.context ? contextFastMessages(input.context) : legacyFastMessages(input);

    return callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      messages,
      timeoutMs: this.timeoutMs,
      maxOutputTokens: this.maxOutputTokens,
      control
    });
  }
}

export class AzureDeepProvider implements DeepModelProvider {
  get metadata() { return { provider: "azure", model: this.deployment }; }
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
    private readonly deployment: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly maxOutputTokens?: number
  ) {}

  async resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult> {
    const start = Date.now();
    const messages = input.context ? contextDeepMessages(input.context) : legacyDeepMessages(input.normalizedPrompt);

    const result = await callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      messages,
      timeoutMs: this.timeoutMs,
      maxOutputTokens: this.maxOutputTokens,
      control
    });

    return {
      taskId: input.taskId,
      finalReply: result.text,
      finishReason: result.finishReason,
      confidence: 0.85,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
