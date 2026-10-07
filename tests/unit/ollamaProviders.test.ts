import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaDeepProvider, OllamaFastProvider } from "../../src/providers/ollamaProviders";
import { sampleContext } from "../helpers/contextFixtures";

describe("ollama providers", () => {
  it("verifies per-run thinking options without mutating the shared provider", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ thinking: { values: [true] } })
    ) as typeof fetch;
    const provider = new OllamaFastProvider("http://localhost:11434", "test", 0);
    expect(await provider.thinkingOptions()).toEqual(["on"]);
    const selected = await provider.withThinking("on");
    expect(selected.metadata?.reasoningEnabled).toBe(true);
    expect(provider.metadata.reasoningEnabled).toBeUndefined();
    await expect(provider.withThinking("off")).rejects.toThrow("THINKING_CONFIG_UNSUPPORTED");
  });
  it("cancels thinking verification before inference", async () => {
    let observed: AbortSignal | undefined;
    global.fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal as AbortSignal;
          observed.addEventListener("abort", () => reject(Error("aborted")));
        })
    ) as typeof fetch;
    const controller = new AbortController();
    const pending = new OllamaFastProvider("http://localhost:11434", "test", 0).withThinking("on", {
      signal: controller.signal,
      attemptId: "a",
      onDelta: async () => {}
    });
    controller.abort();
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(observed?.aborted).toBe(true);
  });
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts expected payload to Ollama chat API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { role: "assistant", content: "  provisional reply  " } })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider(
      "http://localhost:11434",
      "llama3.1:8b",
      0.2,
      10_000,
      300
    );

    const result = await provider.createProvisionalReply({
      message: {
        conversationId: "c1",
        userId: "u1",
        text: "latest market data",
        timestampIso: new Date().toISOString()
      },
      correctedText: "latest market data",
      routeDecision: "deep"
    });

    expect(result.text).toBe("  provisional reply  ");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(options.method).toBe("POST");

    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("llama3.1:8b");
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe("user");
    expect(body.options.temperature).toBe(0.2);
    expect(body.options.num_predict).toBe(300);
  });

  it("sends a leading system message, role-based history, and honors the output cap when a context is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { role: "assistant", content: "answer" } })
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider(
      "http://localhost:11434",
      "llama3.1:8b",
      0.2,
      10_000,
      512
    );

    await provider.createProvisionalReply({
      message: {
        conversationId: "c1",
        userId: "u1",
        text: "Why?",
        timestampIso: new Date().toISOString()
      },
      correctedText: "Why?",
      routeDecision: "direct",
      context: sampleContext()
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(options.body));

    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("BASE INSTRUCTIONS AND VERIFIED FACTS");
    expect(body.messages[0].content).toContain("FAST ROLE INSTRUCTIONS");
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "What is event sourcing?" },
      { role: "assistant", content: "It's a pattern where state changes are stored as events." },
      { role: "user", content: "Why?" }
    ]);
    expect(body.options.num_predict).toBe(512);
  });

  it("maps deep response into DeepResult", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { role: "assistant", content: "deep local answer" } })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaDeepProvider("http://localhost:11434", "qwen2.5:14b", 0.1);

    const result = await provider.resolveDeepTask({
      taskId: "task-1",
      conversationId: "conv-1",
      normalizedPrompt: "analyze cloud hiring trend",
      createdAtIso: new Date().toISOString()
    });

    expect(result.taskId).toBe("task-1");
    expect(result.finalReply).toBe("deep local answer");
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws clear error for non-OK Ollama response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error"
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider("http://localhost:11434", "llama3.1:8b", 0.2);

    await expect(
      provider.createProvisionalReply({
        message: {
          conversationId: "c2",
          userId: "u2",
          text: "hello",
          timestampIso: new Date().toISOString()
        },
        correctedText: "hello",
        routeDecision: "direct"
      })
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  });

  it("returns incomplete when Ollama exhausts its output without answer text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { role: "assistant", content: "", thinking: "internal reasoning" },
        done_reason: "length"
      })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider("http://localhost:11434", "qwen3:8b", 0.2, 10_000, 64);

    await expect(
      provider.createProvisionalReply({
        message: {
          conversationId: "c2b",
          userId: "u2b",
          text: "hello",
          timestampIso: new Date().toISOString()
        },
        correctedText: "hello",
        routeDecision: "direct"
      })
    ).resolves.toEqual({ text: "", finishReason: "length" });
  });

  it("times out hung Ollama requests", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(((_url: string, options?: RequestInit) => {
      const signal = options?.signal as AbortSignal | undefined;

      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true }
        );
      });
    }) as typeof fetch);

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider("http://localhost:11434", "llama3.1:8b", 0.2, 5);

    const promise = provider.createProvisionalReply({
      message: {
        conversationId: "c3",
        userId: "u3",
        text: "hello",
        timestampIso: new Date().toISOString()
      },
      correctedText: "hello",
      routeDecision: "direct"
    });

    const assertion = expect(promise).rejects.toThrow("Ollama request timed out after 5ms");

    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("ollama per-call usage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
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
  const reply = (body: unknown) => {
    global.fetch = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
  };
  const stream = (frames: unknown[]) => {
    global.fetch = vi.fn(
      async () => new Response(frames.map((f) => JSON.stringify(f)).join("\n") + "\n")
    ) as unknown as typeof fetch;
  };
  const control = () => {
    const controller = new AbortController();
    return {
      controller,
      value: { signal: controller.signal, attemptId: "a", onDelta: async () => {} }
    };
  };
  const fast = () => new OllamaFastProvider("http://localhost:11434", "m", 0);
  const deep = () => new OllamaDeepProvider("http://localhost:11434", "m", 0);
  const usage = (inputTokens: number, outputTokens: number) => ({
    source: "provider-response",
    inputTokens,
    outputTokens
  });

  it("reports the completed non-streaming response's own counts", async () => {
    reply({
      message: { content: "answer" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 5
    });
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "answer",
      finishReason: "stop",
      usage: usage(12, 5)
    });
    reply({
      message: { content: "" },
      done: true,
      done_reason: "length",
      prompt_eval_count: 3,
      eval_count: 64
    });
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "",
      finishReason: "length",
      usage: usage(3, 64)
    });
  });

  it("omits usage from a non-streaming response not marked done", async () => {
    for (const done of [undefined, false, "true", 1]) {
      reply({ message: { content: "answer" }, done, prompt_eval_count: 12, eval_count: 5 });
      const result = await fast().createProvisionalReply(input);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(result).not.toHaveProperty("usage");
    }
  });

  it.each([
    ["a missing prompt count", { eval_count: 5 }],
    ["a missing generated count", { prompt_eval_count: 5 }],
    ["a negative count", { prompt_eval_count: -1, eval_count: 5 }],
    ["a fractional count", { prompt_eval_count: 1.5, eval_count: 5 }],
    ["a string count", { prompt_eval_count: "12", eval_count: 5 }],
    ["a null count", { prompt_eval_count: null, eval_count: 5 }],
    ["an unsafe count", { prompt_eval_count: Number.MAX_SAFE_INTEGER + 1, eval_count: 0 }],
    ["an overflowing sum", { prompt_eval_count: Number.MAX_SAFE_INTEGER, eval_count: 1 }]
  ] as [string, Record<string, unknown>][])(
    "keeps the answer but omits usage with %s",
    async (_label, counts) => {
      reply({ message: { content: "answer" }, done: true, done_reason: "stop", ...counts });
      const result = await fast().createProvisionalReply(input);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(result).not.toHaveProperty("usage");
      stream([{ message: { content: "answer" }, done: true, done_reason: "stop", ...counts }]);
      const streamed = await fast().createProvisionalReply(input, control().value);
      expect(streamed).toEqual({ text: "answer", finishReason: "stop" });
      expect(streamed).not.toHaveProperty("usage");
    }
  );

  it("reports only the terminal stream frame's counts", async () => {
    stream([
      { message: { content: "a" }, done: false, prompt_eval_count: 900, eval_count: 900 },
      {
        message: { content: "b" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 2
      }
    ]);
    expect(await fast().createProvisionalReply(input, control().value)).toEqual({
      text: "ab",
      finishReason: "stop",
      usage: usage(7, 2)
    });
    stream([
      { message: { content: "a" }, done: false, prompt_eval_count: 900, eval_count: 900 },
      { message: { content: "b" }, done: true, done_reason: "length" }
    ]);
    const result = await fast().createProvisionalReply(input, control().value);
    expect(result).toEqual({ text: "ab", finishReason: "length" });
    expect(result).not.toHaveProperty("usage");
  });

  it("reports nothing for an unaccepted completion, an unterminated stream or a cancellation", async () => {
    stream([
      {
        message: { content: "a" },
        done: true,
        done_reason: "load",
        prompt_eval_count: 7,
        eval_count: 2
      }
    ]);
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "UNSUPPORTED_FINISH"
    );
    stream([{ message: { content: "a" }, done: false, prompt_eval_count: 7, eval_count: 2 }]);
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "INVALID_STREAM"
    );
    stream([
      { message: { content: "a" }, done: false },
      {
        message: { content: "b" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 2
      }
    ]);
    const c = control();
    const cancelling = {
      ...c.value,
      onDelta: async () => {
        c.controller.abort();
      }
    };
    await expect(fast().createProvisionalReply(input, cancelling)).rejects.toThrow("CANCELLED");
  });

  it("propagates deep usage from streaming and non-streaming completions", async () => {
    reply({
      message: { content: "deep" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 30,
      eval_count: 10
    });
    expect((await deep().resolveDeepTask(deepTask)).usage).toEqual(usage(30, 10));
    stream([
      {
        message: { content: "deep" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 4,
        eval_count: 9
      }
    ]);
    const streamed = await deep().resolveDeepTask(deepTask, control().value);
    expect(streamed).toMatchObject({
      finalReply: "deep",
      finishReason: "length",
      usage: usage(4, 9)
    });
    reply({ message: { content: "deep" }, done: true, done_reason: "stop" });
    expect(await deep().resolveDeepTask(deepTask)).not.toHaveProperty("usage");
  });
});
