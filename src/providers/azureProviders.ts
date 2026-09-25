import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface AzureChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface AzureChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return operation(controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) {
        throw new Error(`Azure OpenAI request timed out after ${timeoutMs}ms`);
      }

      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
    });
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
}): Promise<string> {
  const base = args.endpoint.replace(/\/$/, "");
  const url = `${base}/openai/deployments/${args.deployment}/chat/completions?api-version=${encodeURIComponent(args.apiVersion)}`;

  return withTimeout(args.timeoutMs, async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": args.apiKey
      },
      body: JSON.stringify({
        messages: args.messages,
        temperature: args.temperature,
        ...(args.maxOutputTokens !== undefined ? { max_tokens: args.maxOutputTokens } : {})
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Azure OpenAI request failed (${response.status} ${response.statusText})`);
    }

    const payload = (await response.json()) as AzureChatResponse;
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("Azure OpenAI returned an empty response");
    return text;
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
  }): Promise<string> {
    const messages = input.context ? contextFastMessages(input.context) : legacyFastMessages(input);

    return callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      messages,
      timeoutMs: this.timeoutMs,
      maxOutputTokens: this.maxOutputTokens
    });
  }
}

export class AzureDeepProvider implements DeepModelProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
    private readonly deployment: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly maxOutputTokens?: number
  ) {}

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();
    const messages = input.context ? contextDeepMessages(input.context) : legacyDeepMessages(input.normalizedPrompt);

    const finalReply = await callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      messages,
      timeoutMs: this.timeoutMs,
      maxOutputTokens: this.maxOutputTokens
    });

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.85,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
