import {
  GenerationError,
  httpGenerationError,
  providerUsage,
  type GenerationControl,
  type GenerationResult,
  type ProviderUsage
} from "../domain/generation";
import { AnswerCollector, parseFrame, sseData, withGenerationDeadline } from "./streaming";
import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface AzureChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The only API version whose streamed usage chunk is verified: the stable
 * 2024-10-21 inference spec's stream_options.include_usage sends whole-request
 * usage in a final empty-choices chunk before [DONE], with null usage on every
 * other chunk. Other versions, including later or custom ones, are not inferred.
 */
const STREAM_USAGE_API_VERSION = "2024-10-21";

/**
 * A response's own usage: prompt_tokens as input and completion_tokens as output.
 * Cached-prompt and reasoning detail counts are not added again. A total_tokens
 * that is present must equal their sum; otherwise there is no usage.
 */
function azureUsage(payload: unknown): ProviderUsage | undefined {
  const usage = (payload as { usage?: unknown } | null)?.usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
    | null
    | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const counted = providerUsage(usage.prompt_tokens, usage.completion_tokens);
  if (
    !counted ||
    (usage.total_tokens !== undefined &&
      usage.total_tokens !== counted.inputTokens + counted.outputTokens)
  )
    return undefined;
  return counted;
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
  // Text-only requests without data_sources; every other request shape is unchanged.
  const streamUsage = Boolean(args.control) && args.apiVersion === STREAM_USAGE_API_VERSION;

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
        ...(streamUsage ? { stream_options: { include_usage: true } } : {}),
        temperature: args.temperature,
        ...(args.maxOutputTokens !== undefined ? { max_tokens: args.maxOutputTokens } : {})
      }),
      signal
    });

    if (!response.ok) throw httpGenerationError(response.status);
    const collector = new AnswerCollector(args.control);
    if (!args.control) {
      const payload = await response.json();
      const choice = payload.choices?.[0];
      await collector.add(choice?.message?.content ?? "");
      const result = collector.finish(choice?.finish_reason ?? "stop");
      // Usage only for an explicitly finished choice the collector accepted.
      const usage = typeof choice?.finish_reason === "string" ? azureUsage(payload) : undefined;
      return usage ? { ...result, usage } : result;
    }
    let finish: string | undefined;
    // Usage counts only from one empty-choices chunk after the finish and directly
    // before [DONE]. Early, choice-bearing, repeated or non-final usage withdraws the
    // report but never the answer; null usage on other chunks is ignored.
    let reported: unknown;
    let usageWithdrawn = false;
    for await (const data of sseData(response, signal)) {
      if (data === "[DONE]") {
        if (!finish) throw new GenerationError("INVALID_STREAM", false);
        const result = collector.finish(finish);
        const usage =
          streamUsage && !usageWithdrawn && reported !== undefined
            ? azureUsage({ usage: reported })
            : undefined;
        return usage ? { ...result, usage } : result;
      }
      const frame = parseFrame(data);
      if (
        frame.error ||
        !Array.isArray(frame.choices) ||
        frame.choices.some((item: unknown) => !item || typeof item !== "object")
      )
        throw new GenerationError("INVALID_STREAM", false);
      if (reported !== undefined) usageWithdrawn = true;
      else if (frame.usage != null) {
        if (finish && frame.choices.length === 0) reported = frame.usage;
        else usageWithdrawn = true;
      }
      const choice = frame.choices.find((item: any) => item.index === 0);
      if (!choice) continue; // Usage and prompt-filter chunks contain no answer.
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
function legacyFastMessages(input: {
  message: UserMessage;
  correctedText: string;
  routeDecision: string;
}): AzureChatMessage[] {
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
  get metadata() {
    return { provider: "azure", model: this.deployment };
  }
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
    private readonly deployment: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly maxOutputTokens?: number
  ) {}

  async createProvisionalReply(
    input: {
      message: UserMessage;
      correctedText: string;
      routeDecision: "direct" | "deep" | "clarify";
      context?: ConversationContext;
    },
    control?: GenerationControl
  ): Promise<GenerationResult> {
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
  get metadata() {
    return { provider: "azure", model: this.deployment };
  }
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
    const messages = input.context
      ? contextDeepMessages(input.context)
      : legacyDeepMessages(input.normalizedPrompt);

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
      totalLatencyMs: Date.now() - start,
      ...(result.usage ? { usage: result.usage } : {})
    };
  }
}
