// Source: Ollama official API docs (github.com/ollama/ollama, docs/api.md),
// verified 2026-09-25. POST /api/chat request: {model, messages, stream, options}.
// Non-streaming response: {message: {role, content, thinking?}, done, done_reason}.
// (Previously used /api/generate's {prompt} request / {response, thinking, done_reason}
// response shape; migrated per spec 01 so role-based system/history messages can be sent.)
import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    thinking?: string;
  };
  done_reason?: string;
}

function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return operation(controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) {
        throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
      }

      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
    });
}

async function callOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  temperature: number,
  timeoutMs: number,
  numPredict: number
): Promise<string> {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature,
          num_predict: numPredict
        }
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status} ${response.statusText})`);
    }

    const payload = (await response.json()) as OllamaChatResponse;
    const text = payload.message?.content?.trim() ?? "";
    if (text.length > 0) {
      return text;
    }

    // Some local models emit only "thinking" when token budget is exhausted,
    // resulting in an empty answer unless callers raise num_predict.
    if ((payload.message?.thinking?.trim().length ?? 0) > 0 && payload.done_reason === "length") {
      throw new Error(
        `Ollama returned no final response text for model ${model} before token limit. Increase num_predict or use a faster model.`
      );
    }

    throw new Error(`Ollama returned an empty response for model ${model}`);
  });
}

function legacyFastMessages(input: { message: UserMessage; correctedText: string; routeDecision: string }): OllamaChatMessage[] {
  const prompt = [
    "You are the fast-response layer for a dual-path assistant.",
    "Return concise, practical text.",
    `Route: ${input.routeDecision}`,
    `TimestampUTC: ${input.message.timestampIso}`,
    `Original: ${input.message.text}`,
    `Normalized: ${input.correctedText}`,
    "If route is deep, provide a short provisional response that says deeper analysis is in progress.",
    "If route is clarify, ask one concise clarifying question.",
    "If route is direct, provide a direct short answer.",
    "For temporal questions (day/date/time), assume the user means now at TimestampUTC unless they specify a timezone.",
    "Answer first, then optionally ask one concise timezone clarifier if needed."
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function legacyDeepMessages(normalizedPrompt: string): OllamaChatMessage[] {
  const prompt = [
    "You are the deep-analysis layer for a dual-path assistant.",
    "Produce a refined answer with concise reasoning and references if available.",
    `Prompt: ${normalizedPrompt}`
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function contextMessagesFor(context: ConversationContext, role: "fast" | "deep"): OllamaChatMessage[] {
  const { system, messages } = buildSystemAndMessages(context, role);
  return [{ role: "system", content: system }, ...messages];
}

export class OllamaFastProvider implements FastModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly numPredict: number = 384
  ) {}

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
    context?: ConversationContext;
  }): Promise<string> {
    const messages = input.context ? contextMessagesFor(input.context, "fast") : legacyFastMessages(input);

    return callOllamaChat(this.baseUrl, this.model, messages, this.temperature, this.timeoutMs, this.numPredict);
  }
}

export class OllamaDeepProvider implements DeepModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly numPredict: number = 768
  ) {}

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();
    const messages = input.context ? contextMessagesFor(input.context, "deep") : legacyDeepMessages(input.normalizedPrompt);

    const finalReply = await callOllamaChat(this.baseUrl, this.model, messages, this.temperature, this.timeoutMs, this.numPredict);

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.8,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
