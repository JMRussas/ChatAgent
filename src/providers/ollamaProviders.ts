import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface OllamaGenerateResponse {
  response: string;
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

async function callOllama(
  baseUrl: string,
  model: string,
  prompt: string,
  temperature: number,
  timeoutMs: number
): Promise<string> {
  const response = await withTimeout(timeoutMs, (signal) =>
    fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature
        }
      }),
      signal
    })
  );

  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status} ${response.statusText})`);
  }

  const payload = (await response.json()) as OllamaGenerateResponse;
  return payload.response?.trim() ?? "";
}

export class OllamaFastProvider implements FastModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000
  ) {}

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }): Promise<string> {
    const prompt = [
      "You are the fast-response layer for a dual-path assistant.",
      "Return concise, practical text.",
      `Route: ${input.routeDecision}`,
      `Original: ${input.message.text}`,
      `Normalized: ${input.correctedText}`,
      "If route is deep, provide a short provisional response that says deeper analysis is in progress.",
      "If route is clarify, ask one concise clarifying question.",
      "If route is direct, provide a direct short answer."
    ].join("\n");

    return callOllama(this.baseUrl, this.model, prompt, this.temperature, this.timeoutMs);
  }
}

export class OllamaDeepProvider implements DeepModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000
  ) {}

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();
    const prompt = [
      "You are the deep-analysis layer for a dual-path assistant.",
      "Produce a refined answer with concise reasoning and references if available.",
      `Prompt: ${input.normalizedPrompt}`
    ].join("\n");

    const finalReply = await callOllama(this.baseUrl, this.model, prompt, this.temperature, this.timeoutMs);

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.8,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
