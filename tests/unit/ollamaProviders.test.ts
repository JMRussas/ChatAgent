import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaDeepProvider, OllamaFastProvider } from "../../src/providers/ollamaProviders";

describe("ollama providers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts expected payload to Ollama generate API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "  provisional reply  " })
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OllamaFastProvider("http://localhost:11434", "llama3.1:8b", 0.2);

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
    expect(url).toBe("http://localhost:11434/api/generate");
    expect(options.method).toBe("POST");

    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("llama3.1:8b");
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.2);
  });

  it("maps deep response into DeepResult", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "deep local answer" })
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
});
