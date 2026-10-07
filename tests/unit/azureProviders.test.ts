import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDeepProvider, AzureFastProvider } from "../../src/providers/azureProviders";
import { sampleContext } from "../helpers/contextFixtures";

describe("azure providers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps fast provider request to Azure chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: " quick answer " } }]
      })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AzureFastProvider(
      "https://example.openai.azure.com/",
      "test-key",
      "2024-10-21",
      "gpt-fast",
      0.3
    );

    const result = await provider.createProvisionalReply({
      message: {
        conversationId: "c1",
        userId: "u1",
        text: "hello",
        timestampIso: new Date().toISOString()
      },
      correctedText: "hello",
      routeDecision: "direct"
    });

    expect(result.text).toBe(" quick answer ");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/openai/deployments/gpt-fast/chat/completions");
    expect(url).toContain("api-version=2024-10-21");
    expect(options.method).toBe("POST");
  });

  it("maps deep provider response to DeepResult", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "deep answer" } }]
      })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AzureDeepProvider(
      "https://example.openai.azure.com",
      "test-key",
      "2024-10-21",
      "gpt-deep",
      0.2
    );

    const result = await provider.resolveDeepTask({
      taskId: "t1",
      conversationId: "c1",
      normalizedPrompt: "explain event loops",
      createdAtIso: new Date().toISOString()
    });

    expect(result.taskId).toBe("t1");
    expect(result.finalReply).toBe("deep answer");
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends role-based system+history messages and the configured output cap when a context is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "answer" } }] })
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AzureFastProvider(
      "https://example.openai.azure.com/",
      "test-key",
      "2024-10-21",
      "gpt-fast",
      0.3,
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
    expect(body.max_tokens).toBe(512);
  });

  it("throws clear error when Azure call fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized"
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AzureFastProvider(
      "https://example.openai.azure.com",
      "bad-key",
      "2024-10-21",
      "gpt-fast",
      0.2
    );

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
    ).rejects.toThrow("PROVIDER_AUTH");
  });

  it("times out hung Azure requests", async () => {
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

    const provider = new AzureFastProvider(
      "https://example.openai.azure.com/",
      "test-key",
      "2024-10-21",
      "gpt-fast",
      0.3,
      5
    );

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

    const assertion = expect(promise).rejects.toThrow("Azure OpenAI request timed out after 5ms");

    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("azure per-call usage", () => {
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
  // An undefined usage or finish_reason is dropped by JSON serialization.
  const answer = (finish_reason: unknown = "stop", usage?: unknown, content = "answer") => ({
    choices: [{ index: 0, message: { content }, finish_reason }],
    usage
  });
  const fast = () => new AzureFastProvider("https://fixture.invalid", "k", "2024-10-21", "d", 0);
  const deep = () => new AzureDeepProvider("https://fixture.invalid", "k", "2024-10-21", "d", 0);
  const usage = (inputTokens: number, outputTokens: number) => ({
    source: "provider-response",
    inputTokens,
    outputTokens
  });

  it("reports a finished non-streaming response's prompt and completion tokens", async () => {
    // Detail counts are subsets of the totals and are not added again.
    reply(
      answer("stop", {
        prompt_tokens: 30,
        completion_tokens: 10,
        total_tokens: 40,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 5 }
      })
    );
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "answer",
      finishReason: "stop",
      usage: usage(30, 10)
    });
    reply(answer("length", { prompt_tokens: 12, completion_tokens: 64 }, ""));
    expect(await fast().createProvisionalReply(input)).toEqual({
      text: "",
      finishReason: "length",
      usage: usage(12, 64)
    });
  });

  it("keeps a valid zero count", async () => {
    reply(answer("stop", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));
    expect((await fast().createProvisionalReply(input)).usage).toEqual(usage(0, 0));
  });

  it.each([
    ["no usage object", undefined],
    ["a null usage object", null],
    ["a string usage object", "40"],
    ["a missing prompt count", { completion_tokens: 10 }],
    ["a missing completion count", { prompt_tokens: 30 }],
    ["a negative count", { prompt_tokens: -1, completion_tokens: 10 }],
    ["a fractional count", { prompt_tokens: 1.5, completion_tokens: 10 }],
    ["a string count", { prompt_tokens: "30", completion_tokens: 10 }],
    ["a null count", { prompt_tokens: null, completion_tokens: 10 }],
    ["an unsafe count", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0 }],
    ["an overflowing sum", { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }],
    ["a disagreeing total", { prompt_tokens: 30, completion_tokens: 10, total_tokens: 41 }],
    ["a null total", { prompt_tokens: 30, completion_tokens: 10, total_tokens: null }]
  ] as [string, unknown][])("keeps the answer but omits usage with %s", async (_label, counts) => {
    reply(answer("stop", counts));
    const result = await fast().createProvisionalReply(input);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
    expect(result).not.toHaveProperty("usage");
  });

  it("omits usage when the choice has no explicit finish reason", async () => {
    for (const finish_reason of [undefined, null]) {
      reply({
        choices: [{ index: 0, message: { content: "answer" }, finish_reason }],
        usage: { prompt_tokens: 30, completion_tokens: 10 }
      });
      const result = await fast().createProvisionalReply(input);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(result).not.toHaveProperty("usage");
    }
  });

  it("reports nothing when there is no choice to finish", async () => {
    reply({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } });
    await expect(fast().createProvisionalReply(input)).rejects.toThrow("EMPTY_RESPONSE");
  });

  it.each([
    ["content_filter", "answer", "UNSUPPORTED_FINISH"],
    ["tool_calls", "answer", "UNSUPPORTED_FINISH"],
    ["stop", "", "EMPTY_RESPONSE"]
  ])(
    "reports nothing when a %s completion with %j content is rejected",
    async (finish, content, code) => {
      reply(answer(finish, { prompt_tokens: 30, completion_tokens: 10 }, content));
      await expect(fast().createProvisionalReply(input)).rejects.toThrow(code);
    }
  );

  it("propagates deep usage from a non-streaming completion", async () => {
    reply(answer("stop", { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }));
    expect(await deep().resolveDeepTask(deepTask)).toMatchObject({
      finalReply: "answer",
      finishReason: "stop",
      usage: usage(30, 10)
    });
    reply(answer("length", { prompt_tokens: 3, completion_tokens: 9 }));
    expect((await deep().resolveDeepTask(deepTask)).usage).toEqual(usage(3, 9));
    reply(answer("stop"));
    expect(await deep().resolveDeepTask(deepTask)).not.toHaveProperty("usage");
  });
});

describe("azure streamed usage (api-version 2024-10-21)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const input = {
    message: { conversationId: "c", userId: "u", text: "hi", timestampIso: "2026-10-07T00:00:00Z" },
    correctedText: "hi",
    routeDecision: "direct" as const
  };
  const sse = (...frames: unknown[]) =>
    frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
  const stream = (wire: string) => {
    const fetchMock = vi.fn(async () => new Response(wire));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };
  const control = (onDelta: () => Promise<void> = async () => {}) => {
    const controller = new AbortController();
    return { controller, value: { signal: controller.signal, attemptId: "a", onDelta } };
  };
  const fast = (apiVersion = "2024-10-21") =>
    new AzureFastProvider("https://fixture.invalid", "k", apiVersion, "d", 0, 10_000, 64);
  const deep = (apiVersion = "2024-10-21") =>
    new AzureDeepProvider("https://fixture.invalid", "k", apiVersion, "d", 0);
  const usage = (inputTokens: number, outputTokens: number) => ({
    source: "provider-response",
    inputTokens,
    outputTokens
  });
  // The documented shape: prompt-filter chunk, content chunks with null usage, the
  // finish, then the whole-request usage in an empty-choices chunk before [DONE].
  const promptFilter = { choices: [], prompt_filter_results: [{ prompt_index: 0 }], usage: null };
  const content = (text: string) => ({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    usage: null
  });
  const finished = (finish_reason = "stop") => ({
    choices: [{ index: 0, delta: {}, finish_reason }],
    usage: null
  });
  const totals = (prompt_tokens = 30, completion_tokens = 10, extra: object = {}) => ({
    choices: [],
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 5 },
      ...extra
    }
  });
  const body = (fetchMock: { mock: { calls: unknown[] } }) =>
    JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

  it("requests a usage chunk only for streamed 2024-10-21 calls", async () => {
    const wire = sse(content("answer"), finished(), "[DONE]");
    let fetchMock = stream(wire);
    await fast().createProvisionalReply(input, control().value);
    expect(body(fetchMock)).toEqual({
      messages: expect.any(Array),
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 64
    });
    for (const apiVersion of [
      "2024-08-01-preview",
      "2025-01-01-preview",
      "2024-10-21 ",
      "custom"
    ]) {
      fetchMock = stream(wire);
      await fast(apiVersion).createProvisionalReply(input, control().value);
      expect(body(fetchMock)).toEqual({
        messages: expect.any(Array),
        stream: true,
        temperature: 0,
        max_tokens: 64
      });
    }
    const nonStream = vi.fn(async () =>
      Response.json({ choices: [{ index: 0, message: { content: "a" }, finish_reason: "stop" }] })
    );
    global.fetch = nonStream as unknown as typeof fetch;
    await fast().createProvisionalReply(input);
    expect(body(nonStream)).toEqual({
      messages: expect.any(Array),
      stream: false,
      temperature: 0,
      max_tokens: 64
    });
  });

  it("reports streamed usage from the final empty-choices chunk", async () => {
    stream(sse(promptFilter, content("ans"), content("wer"), finished(), totals(), "[DONE]"));
    expect(await fast().createProvisionalReply(input, control().value)).toEqual({
      text: "answer",
      finishReason: "stop",
      usage: usage(30, 10)
    });
    stream(sse(content("part"), finished("length"), totals(12, 64), "[DONE]"));
    expect(await fast().createProvisionalReply(input, control().value)).toEqual({
      text: "part",
      finishReason: "length",
      usage: usage(12, 64)
    });
    stream(sse(content("a"), finished(), totals(0, 0), "[DONE]"));
    expect((await fast().createProvisionalReply(input, control().value)).usage).toEqual(
      usage(0, 0)
    );
  });

  it("propagates streamed deep usage", async () => {
    stream(sse(promptFilter, content("deep"), finished(), totals(7, 3), "[DONE]"));
    const result = await deep().resolveDeepTask(
      {
        taskId: "t",
        conversationId: "c",
        normalizedPrompt: "p",
        createdAtIso: input.message.timestampIso
      },
      control().value
    );
    expect(result).toMatchObject({ finalReply: "deep", finishReason: "stop", usage: usage(7, 3) });
  });

  it("ignores a usage chunk on other API versions", async () => {
    stream(sse(content("answer"), finished(), totals(), "[DONE]"));
    const result = await fast("2024-08-01-preview").createProvisionalReply(input, control().value);
    expect(result).toEqual({ text: "answer", finishReason: "stop" });
  });

  it.each([
    ["no usage chunk arrives", [content("answer"), finished()]],
    ["usage arrives before the finish", [content("answer"), totals(), finished()]],
    [
      "usage rides on a choice chunk",
      [content("answer"), { ...finished(), usage: totals().usage }]
    ],
    ["usage is reported twice", [content("answer"), finished(), totals(), totals()]],
    ["a chunk follows the usage chunk", [content("answer"), finished(), totals(), promptFilter]],
    ["usage counts are malformed", [content("answer"), finished(), totals(-1, 10)]],
    [
      "usage totals disagree",
      [content("answer"), finished(), totals(30, 10, { total_tokens: 41 })]
    ],
    ["usage is not an object", [content("answer"), finished(), { choices: [], usage: "40" }]]
  ] as [string, unknown[]][])(
    "keeps a streamed answer but omits usage when %s",
    async (_l, frames) => {
      stream(sse(...frames, "[DONE]"));
      const result = await fast().createProvisionalReply(input, control().value);
      expect(result).toEqual({ text: "answer", finishReason: "stop" });
      expect(result).not.toHaveProperty("usage");
    }
  );

  it("reports nothing when a usage-bearing stream is truncated, rejected or cancelled", async () => {
    stream(sse(content("answer"), finished(), totals()));
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "INVALID_STREAM"
    );
    stream(sse(content("answer"), finished("content_filter"), totals(), "[DONE]"));
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "UNSUPPORTED_FINISH"
    );
    stream(sse(totals(), "[DONE]"));
    await expect(fast().createProvisionalReply(input, control().value)).rejects.toThrow(
      "INVALID_STREAM"
    );
    stream(sse(content("a"), content("b"), finished(), totals(), "[DONE]"));
    const c = control(async () => c.controller.abort());
    await expect(fast().createProvisionalReply(input, c.value)).rejects.toThrow("CANCELLED");
  });
});
