import {
  GenerationError,
  providerUsage,
  type GenerationControl,
  type GenerationResult,
  type ProviderUsage
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

/** Longest wait, after an accepted messageStop, for the metadata event carrying usage. */
export const METADATA_TAIL_MS = 250;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * A response's TokenUsage. inputTokens excludes cache reads and writes (prompt
 * caching guide), so input is inputTokens plus cacheReadInputTokens plus
 * cacheWriteInputTokens, an absent cache count being zero; output is outputTokens.
 * Every count and sum must be a non-negative safe integer and totalTokens must equal
 * the normalized sum; otherwise there is no usage. cacheDetails are breakdowns and
 * are not added again.
 */
function bedrockUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const absentIsZero = (value: unknown) => (value === undefined ? 0 : value);
  let input = 0;
  for (const part of [
    usage.inputTokens,
    absentIsZero(usage.cacheReadInputTokens),
    absentIsZero(usage.cacheWriteInputTokens)
  ]) {
    if (!isCount(part) || !Number.isSafeInteger(input + part)) return undefined;
    input += part;
  }
  const counted = providerUsage(input, usage.outputTokens);
  return counted && usage.totalTokens === counted.inputTokens + counted.outputTokens
    ? counted
    : undefined;
}

type Step<T> = { result: IteratorResult<T> } | { error: unknown } | undefined;

/**
 * The iterator's next step, or undefined once signal aborts or ms elapses. The
 * pending next() is never awaited past that point: its later settlement is absorbed,
 * and no timer or abort listener is left behind.
 */
function nextStep<T>(iterator: AsyncIterator<T>, signal: AbortSignal, ms?: number) {
  return new Promise<Step<T>>((resolve) => {
    if (signal.aborted) return resolve(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (step: Step<T>) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abandon);
      resolve(step);
    };
    const abandon = () => settle(undefined);
    signal.addEventListener("abort", abandon, { once: true });
    if (ms !== undefined) timer = setTimeout(abandon, ms);
    let next: Promise<IteratorResult<T>>;
    try {
      next = Promise.resolve(iterator.next());
    } catch (error) {
      return settle({ error });
    }
    next.then(
      (result) => settle({ result }),
      (error) => settle({ error })
    );
  });
}

/** Asks the iterator to finish without awaiting: return() can queue behind a pending next(). */
function release(iterator: AsyncIterator<unknown>) {
  try {
    Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    // The transport abort that follows releases the stream either way.
  }
}

/**
 * Reads at most one event after an accepted messageStop, within METADATA_TAIL_MS and
 * the request's own signal and deadline. Only a metadata-only event within the event
 * size limit and with valid usage counts. End of stream, any other, oversized or
 * malformed event, a rejection, a throw while inspecting it, cancellation (even one
 * that lands just after the read resolved) or the wait bound gives no usage and
 * leaves the completed answer as it is.
 */
async function metadataUsage(iterator: AsyncIterator<unknown>, signal: AbortSignal) {
  const step = await nextStep(iterator, signal, METADATA_TAIL_MS);
  // A read that resolved just before cancellation is not accepted after it.
  if (!step || "error" in step || signal.aborted) return undefined;
  try {
    const next = step.result as IteratorResult<unknown> | null;
    if (!next || typeof next !== "object" || next.done) return undefined;
    const event = next.value as Record<string, unknown> | null;
    if (!event || typeof event !== "object") return undefined;
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_ANSWER_BYTES) return undefined;
    const members = Object.keys(event).filter((key) => event[key] !== undefined);
    if (members.length !== 1 || members[0] !== "metadata") return undefined;
    return bedrockUsage((event.metadata as { usage?: unknown } | null)?.usage);
  } catch {
    // Serialization or normalization failed after the answer was accepted.
    return undefined;
  }
}

async function converseBedrock(
  client: BedrockRuntimeClient,
  modelId: string,
  messages: BedrockConverseMessage[],
  temperature: number,
  system?: string,
  maxOutputTokens?: number,
  control?: GenerationControl,
  timeoutMs = 60_000
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
  return withGenerationDeadline("Bedrock", timeoutMs, control, async (signal) => {
    const collector = new AnswerCollector(control);
    if (!control) {
      const response = await client.send(new ConverseCommand(input), { abortSignal: signal });
      for (const block of response.output?.message?.content ?? [])
        if (block.text !== undefined) await collector.add(block.text);
      const result = collector.finish(response.stopReason ?? "end_turn");
      // Usage only for an explicit stop reason the collector accepted.
      const usage =
        typeof response.stopReason === "string" ? bedrockUsage(response.usage) : undefined;
      return usage ? { ...result, usage } : result;
    }
    const response = await client.send(new ConverseStreamCommand(input), { abortSignal: signal });
    if (!response.stream) throw new GenerationError("INVALID_STREAM", false);
    // Driven by hand so no wait ever sits behind a next() the transport has not settled.
    const iterator = response.stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const step = await nextStep(iterator, signal);
        if (!step) {
          signal.throwIfAborted();
          throw new GenerationError("CANCELLED", false);
        }
        if ("error" in step) throw step.error;
        const next = step.result;
        if (next.done) throw new GenerationError("INVALID_STREAM", false);
        const event = next.value;
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
        // Metadata before messageStop is not the request's usage and is ignored.
        if (event.messageStop) {
          const result = collector.finish(event.messageStop.stopReason);
          const usage = await metadataUsage(iterator, signal);
          return usage ? { ...result, usage } : result;
        }
      }
    } finally {
      release(iterator);
    }
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
    private readonly maxOutputTokens?: number,
    private readonly timeoutMs = 60_000
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
        control,
        this.timeoutMs
      );
    }

    return converseBedrock(
      this.client,
      this.modelId,
      legacyFastMessages(input),
      this.temperature,
      undefined,
      this.maxOutputTokens,
      control,
      this.timeoutMs
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
    private readonly maxOutputTokens?: number,
    private readonly timeoutMs = 60_000
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
            control,
            this.timeoutMs
          );
        })()
      : await converseBedrock(
          this.client,
          this.modelId,
          legacyDeepMessages(input.normalizedPrompt),
          this.temperature,
          undefined,
          this.maxOutputTokens,
          control,
          this.timeoutMs
        );

    return {
      taskId: input.taskId,
      finalReply: result.text,
      finishReason: result.finishReason,
      confidence: 0.86,
      citations: [],
      totalLatencyMs: Date.now() - start,
      ...(result.usage ? { usage: result.usage } : {})
    };
  }
}
