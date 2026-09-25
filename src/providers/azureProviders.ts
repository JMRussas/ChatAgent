import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface AzureChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
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
  prompt: string;
}): Promise<string> {
  const base = args.endpoint.replace(/\/$/, "");
  const url = `${base}/openai/deployments/${args.deployment}/chat/completions?api-version=${encodeURIComponent(args.apiVersion)}`;

  const response = await withTimeout(args.timeoutMs, (signal) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": args.apiKey
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: args.prompt }],
        temperature: args.temperature
      }),
      signal
    })
  );

  if (!response.ok) {
    throw new Error(`Azure OpenAI request failed (${response.status} ${response.statusText})`);
  }

  const payload = (await response.json()) as AzureChatResponse;
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

export class AzureFastProvider implements FastModelProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
    private readonly deployment: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000
  ) {}

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
  }): Promise<string> {
    const prompt = [
      "You are the fast-response layer in a dual-path chatbot.",
      `Route: ${input.routeDecision}`,
      `Original: ${input.message.text}`,
      `Normalized: ${input.correctedText}`,
      "Respond with one short paragraph."
    ].join("\n");

    return callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      prompt,
      timeoutMs: this.timeoutMs
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
    private readonly timeoutMs: number = 10_000
  ) {}

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    const start = Date.now();
    const prompt = [
      "You are the deep-analysis layer in a dual-path chatbot.",
      "Generate a refined answer and include citations when external facts are used.",
      `Prompt: ${input.normalizedPrompt}`
    ].join("\n");

    const finalReply = await callAzureChat({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      deployment: this.deployment,
      temperature: this.temperature,
      prompt,
      timeoutMs: this.timeoutMs
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
