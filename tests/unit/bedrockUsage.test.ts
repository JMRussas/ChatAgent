import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockDeepProvider,
  BedrockFastProvider,
  METADATA_TAIL_MS
} from "../../src/providers/bedrockProviders";
import type { GenerationControl } from "../../src/domain/generation";
import { MAX_ANSWER_BYTES } from "../../src/providers/streaming";

// Offline: send() is replaced; no request leaves the process.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const input = {
  message: { conversationId: "c", userId: "u", text: "hi", timestampIso: "2026-10-07T00:00:00Z" },
  correctedText: "hi",
  routeDecision: "direct" as const
};
const deepTask = {
  taskId: "t",
  conversationId: "c",
  normalizedPrompt: "analyze",
  createdAtIso: "2026-10-07T00:00:00Z"
};
const usage = (inputTokens: number, outputTokens: number) => ({
  source: "provider-response",
  inputTokens,
  outputTokens
});
function control() {
  const controller = new AbortController();
  const chunks: string[] = [];
  const value: GenerationControl = {
    signal: controller.signal,
    attemptId: "a",
    onDelta: async (text) => {
      chunks.push(text);
    }
  };
  return { controller, chunks, value };
}
const fast = () => new BedrockFastProvider("us-east-1", "model", 0);
const deep = () => new BedrockDeepProvider("us-east-1", "model", 0);
/** Replaces send(); returns the spy so the request's abort signal can be inspected. */
const respond = (response: unknown) =>
  vi
    .spyOn(BedrockRuntimeClient.prototype, "send")
    .mockImplementation((async () => response) as any);
const sentSignal = (send: ReturnType<typeof respond>) =>
  (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal;

/** A hand-driven stream: scripted events, then whatever `after` supplies. */
function scripted(
  events: unknown[],
  after: () => Promise<IteratorResult<unknown>> = async () => ({ done: true, value: undefined }),
  onReturn: () => unknown = async () => ({ done: true, value: undefined })
) {
  let i = 0;
  const returned = vi.fn(onReturn);
  const iterator = {
    next: () =>
      i < events.length ? Promise.resolve({ done: false, value: events[i++] }) : after(),
    return: returned,
    [Symbol.asyncIterator]() {
      return iterator;
    }
  };
  return { stream: iterator, returned };
}
const never = () => new Promise<IteratorResult<unknown>>(() => {});
const delta = (text: string) => ({ contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } });
const stop = (stopReason = "end_turn") => ({ messageStop: { stopReason } });
const counts = (over: Record<string, unknown> = {}) => ({
  inputTokens: 10,
  outputTokens: 7,
  totalTokens: 17,
  ...over
});
const metadata = (tokenUsage: unknown = counts()) => ({
  metadata: { usage: tokenUsage, metrics: { latencyMs: 5 } }
});

describe("bedrock usage normalization", () => {
  it("adds cache reads and writes to input and requires a matching total", async () => {
    respond({
      output: { message: { content: [{ text: "answer" }] } },
      stopReason: "end_turn",
      usage: counts({
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 5,
        totalTokens: 122,
        cacheDetails: [{ inputTokens: 5, ttl: "5m" }]
      })
    });
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "answer",
      finishReason: "stop",
      usage: usage(115, 7)
    });
    respond({
      output: { message: { content: [{ text: "part" }] } },
      stopReason: "max_tokens",
      usage: counts()
    });
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "part",
      finishReason: "length",
      usage: usage(10, 7)
    });
    respond({
      output: { message: { content: [{ text: "a" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0 }
    });
    expect((await fast().createProvisionalReply(input)).usage).toEqual(usage(0, 0));
  });

  it.each([
    ["no usage", undefined],
    ["a null usage", null],
    ["a missing total", { inputTokens: 10, outputTokens: 7 }],
    ["a disagreeing total", counts({ totalTokens: 18 })],
    ["a total that ignores cache reads", counts({ cacheReadInputTokens: 100 })],
    ["a missing input count", { outputTokens: 7, totalTokens: 7 }],
    ["a missing output count", { inputTokens: 10, totalTokens: 10 }],
    ["a negative count", counts({ inputTokens: -1, totalTokens: 6 })],
    ["a fractional count", counts({ outputTokens: 1.5, totalTokens: 11.5 })],
    ["a string count", counts({ inputTokens: "10" })],
    ["a null cache read", counts({ cacheReadInputTokens: null })],
    ["an invalid cache write", counts({ cacheWriteInputTokens: -5, totalTokens: 12 })],
    ["an unsafe count", counts({ inputTokens: Number.MAX_SAFE_INTEGER + 1 })],
    [
      "an unsafe input sum with cache",
      counts({ inputTokens: Number.MAX_SAFE_INTEGER, cacheReadInputTokens: 1 })
    ],
    [
      "an unsafe input and output sum",
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
        totalTokens: Number.MAX_SAFE_INTEGER
      }
    ]
  ] as [string, unknown][])(
    "keeps the answer but omits usage with %s",
    async (_label, tokenUsage) => {
      respond({
        output: { message: { content: [{ text: "answer" }] } },
        stopReason: "end_turn",
        usage: tokenUsage
      });
      const result = await fast().createProvisionalReply(input);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(result).not.toHaveProperty("usage");
    }
  );

  it("omits usage without an explicit stop reason", async () => {
    respond({ output: { message: { content: [{ text: "answer" }] } }, usage: counts() });
    const result = await fast().createProvisionalReply(input);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
    expect(result).not.toHaveProperty("usage");
  });

  it.each([
    ["tool_use", "answer", "UNSUPPORTED_FINISH"],
    ["guardrail_intervened", "answer", "UNSUPPORTED_FINISH"],
    ["end_turn", "", "EMPTY_RESPONSE"]
  ])("reports nothing when a %s stop with %j text is rejected", async (stopReason, text, code) => {
    respond({ output: { message: { content: [{ text }] } }, stopReason, usage: counts() });
    await expect(fast().createProvisionalReply(input)).rejects.toThrow(code);
  });

  it("propagates deep usage from a non-streaming response", async () => {
    respond({
      output: { message: { content: [{ text: "deep" }] } },
      stopReason: "end_turn",
      usage: counts({ cacheWriteInputTokens: 3, totalTokens: 20 })
    });
    expect(await deep().resolveDeepTask(deepTask)).toMatchObject({
      finalReply: "deep",
      usage: usage(13, 7)
    });
  });
});

describe("bedrock streamed metadata tail", () => {
  it("reports usage from the metadata event that follows an accepted messageStop", async () => {
    const { stream, returned } = scripted([delta("ans"), delta("wer"), stop(), metadata()]);
    const send = respond({ stream });
    const c = control();
    expect(await fast().createProvisionalReply(input, c.value)).toEqual({
      text: "answer",
      finishReason: "stop",
      usage: usage(10, 7)
    });
    expect(c.chunks).toEqual(["ans", "wer"]);
    expect(returned).toHaveBeenCalled();
    expect(sentSignal(send).aborted).toBe(true); // the transport is released afterwards
  });

  it("propagates streamed deep usage", async () => {
    respond({ stream: scripted([delta("deep"), stop("max_tokens"), metadata()]).stream });
    expect(await deep().resolveDeepTask(deepTask, control().value)).toMatchObject({
      finalReply: "deep",
      finishReason: "length",
      usage: usage(10, 7)
    });
  });

  it("ignores metadata that arrives before messageStop", async () => {
    respond({ stream: scripted([metadata(), delta("answer"), stop()]).stream });
    const result = await fast().createProvisionalReply(input, control().value);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
  });

  it.each([
    ["ends the stream", [] as unknown[], undefined],
    ["carries malformed usage", [metadata(counts({ totalTokens: 99 }))], undefined],
    ["carries metadata without usage", [{ metadata: { metrics: { latencyMs: 5 } } }], undefined],
    ["is another event", [delta("late")], undefined],
    ["mixes metadata with another member", [{ ...metadata(), throttlingException: {} }], undefined],
    [
      "is a metadata event over the event size limit",
      [{ metadata: { ...metadata().metadata, trace: "x".repeat(MAX_ANSWER_BYTES) } }],
      undefined
    ],
    // JSON serialization of a BigInt throws.
    ["cannot be serialized", [metadata(counts({ inputTokens: 10n }))], undefined],
    [
      "throws while its usage is read",
      [
        {
          metadata: {
            get usage() {
              throw new Error("malformed");
            }
          }
        }
      ],
      undefined
    ],
    ["is a null iterator result", [] as unknown[], async () => null as never],
    ["is a non-object iterator result", [] as unknown[], async () => "metadata" as never],
    [
      "rejects",
      [] as unknown[],
      async () => {
        throw new Error("stream reset");
      }
    ]
  ] as [string, unknown[], (() => Promise<IteratorResult<unknown>>) | undefined][])(
    "keeps the streamed answer without usage when the tail %s",
    async (_label, tail, after) => {
      respond({ stream: scripted([delta("answer"), stop(), ...tail], after).stream });
      const c = control();
      const result = await fast().createProvisionalReply(input, c.value);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(c.chunks).toEqual(["answer"]);
    }
  );

  it("returns at the tail bound when the next read never settles, clearing its timers and abort listeners", async () => {
    vi.useFakeTimers();
    const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    // The scripted read deliberately never settles; only the bounded return is proven.
    const { stream, returned } = scripted([delta("answer"), stop()], never);
    const send = respond({ stream });
    let settled = false;
    const call = fast()
      .createProvisionalReply(input, control().value)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(METADATA_TAIL_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toEqual({ text: "answer", finishReason: "stop" });
    expect(vi.getTimerCount()).toBe(0);
    const abortListeners = (spy: { mock: { calls: unknown[][]; contexts: unknown[] } }) =>
      spy.mock.calls.flatMap((args, i) =>
        args[0] === "abort" ? [[spy.mock.contexts[i], args[1]] as const] : []
      );
    const left = abortListeners(added).filter(
      ([target, listener]) =>
        !abortListeners(removed).some(([t, l]) => t === target && l === listener)
    );
    expect(left).toEqual([]);
    expect(returned).toHaveBeenCalled();
    expect(sentSignal(send).aborted).toBe(true);
  });

  it("does not accept metadata whose read resolved just before cancellation", async () => {
    const c = control();
    const read = Promise.resolve({ done: false, value: metadata() });
    const { stream } = scripted([delta("answer"), stop()], () => {
      // Subscribes after the adapter does, so the abort runs after the read settles
      // the wait but before the adapter's continuation inspects it.
      queueMicrotask(() => void read.then(() => c.controller.abort()));
      return read;
    });
    respond({ stream });
    const result = await fast().createProvisionalReply(input, c.value);
    expect(c.controller.signal.aborted).toBe(true);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
    expect(result).not.toHaveProperty("usage");
  });

  it("returns the answer without usage when cancelled during the tail", async () => {
    const c = control();
    // The tail read itself triggers the cancel, so the abort lands while it waits.
    const { stream } = scripted([delta("answer"), stop()], () => {
      c.controller.abort();
      return never();
    });
    respond({ stream });
    const started = Date.now();
    const result = await fast().createProvisionalReply(input, c.value);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
    expect(Date.now() - started).toBeLessThan(METADATA_TAIL_MS);
  });

  it.each([
    ["rejects", async () => Promise.reject(new Error("close failed"))],
    [
      "throws",
      () => {
        throw new Error("close failed");
      }
    ],
    ["never settles", () => new Promise(() => {})]
  ] as [string, () => unknown][])(
    "returns the answer and absorbs the close when the stream's return() %s",
    async (_label, onReturn) => {
      // A return() that never settles stays pending by design; what is proven is that
      // the answer returns and a rejecting or throwing close is handled.
      for (const tail of [never, async () => ({ done: false, value: metadata() })]) {
        const { stream, returned } = scripted([delta("answer"), stop()], tail, onReturn);
        respond({ stream });
        const result = await fast().createProvisionalReply(input, control().value);
        expect(result.text).toBe("answer");
        expect(returned).toHaveBeenCalled();
      }
    }
  );

  it("preserves errors and cancellation before messageStop", async () => {
    respond({
      stream: scripted([delta("partial")], async () => {
        throw new Error("stream reset");
      }).stream
    });
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "PROVIDER_ERROR"
    );
    respond({ stream: scripted([delta("partial"), { throttlingException: {} }, stop()]).stream });
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    respond({ stream: scripted([delta("partial")]).stream });
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "INVALID_STREAM"
    );
    // A stalled read before messageStop ends promptly on cancellation.
    const c = control();
    const { stream, returned } = scripted([delta("partial")], () => {
      setTimeout(() => c.controller.abort(), 0);
      return never();
    });
    respond({ stream });
    await expect(fast().createProvisionalReply(input, c.value)).rejects.toMatchObject({
      code: "CANCELLED"
    });
    expect(returned).toHaveBeenCalled();
  });

  it("rejects an invalid finish even when metadata follows", async () => {
    respond({ stream: scripted([delta("answer"), stop("tool_use"), metadata()]).stream });
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "UNSUPPORTED_FINISH"
    );
    respond({ stream: scripted([stop(), metadata()]).stream });
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "EMPTY_RESPONSE"
    );
  });
});
