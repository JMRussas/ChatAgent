import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface OllamaGenerateResponse {
  response: string;
  thinking?: string;
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

async function callOllama(
  baseUrl: string,
  model: string,
  prompt: string,
  temperature: number,
  timeoutMs: number,
  numPredict: number
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
          temperature,
          num_predict: numPredict
        }
      }),
      signal
    })
  );

  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status} ${response.statusText})`);
  }

  const payload = (await response.json()) as OllamaGenerateResponse;
  const text = payload.response?.trim() ?? "";
  if (text.length > 0) {
    return text;
  }

  // Some local models emit only "thinking" when token budget is exhausted,
  // resulting in an empty answer unless callers raise num_predict.
  if ((payload.thinking?.trim().length ?? 0) > 0 && payload.done_reason === "length") {
    throw new Error(
      `Ollama returned no final response text for model ${model} before token limit. Increase num_predict or use a faster model.`
    );
  }

  throw new Error(`Ollama returned an empty response for model ${model}`);
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

    return callOllama(this.baseUrl, this.model, prompt, this.temperature, this.timeoutMs, this.numPredict);
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
    const prompt = [
      "You are the deep-analysis layer for a dual-path assistant.",
      "Produce a refined answer with concise reasoning and references if available.",
      `Prompt: ${input.normalizedPrompt}`
    ].join("\n");

    const finalReply = await callOllama(this.baseUrl, this.model, prompt, this.temperature, this.timeoutMs, this.numPredict);

    return {
      taskId: input.taskId,
      finalReply,
      confidence: 0.8,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
