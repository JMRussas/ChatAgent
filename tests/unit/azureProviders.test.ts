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
