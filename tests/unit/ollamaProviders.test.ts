import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaDeepProvider, OllamaFastProvider } from "../../src/providers/ollamaProviders";
import { sampleContext } from "../helpers/contextFixtures";

describe("ollama providers", () => {
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

    const provider = new OllamaFastProvider("http://localhost:11434", "llama3.1:8b", 0.2, 10_000, 300);

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

    expect(result).toBe("provisional reply");
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

    const provider = new OllamaFastProvider("http://localhost:11434", "llama3.1:8b", 0.2, 10_000, 512);

    await provider.createProvisionalReply({
      message: { conversationId: "c1", userId: "u1", text: "Why?", timestampIso: new Date().toISOString() },
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
    ).rejects.toThrow("Ollama request failed (500 Internal Server Error)");
  });

  it("throws clear error when Ollama returns only thinking and no final response", async () => {
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
    ).rejects.toThrow("Increase num_predict or use a faster model");
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
