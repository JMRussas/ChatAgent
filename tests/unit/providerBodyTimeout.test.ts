import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureFastProvider } from "../../src/providers/azureProviders";
import { OllamaFastProvider } from "../../src/providers/ollamaProviders";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("provider response body timeouts", () => {
  it.each([
    [
      "Azure OpenAI",
      () => new AzureFastProvider("https://example.test", "test", "test", "model", 0.2, 10)
    ],
    ["Ollama", () => new OllamaFastProvider("http://localhost:11434", "model", 0.2, 10)]
  ] as const)("aborts %s after headers when the body stalls", async (label, createProvider) => {
    vi.useFakeTimers();
    let readingBody = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => ({
        ok: true,
        json: () => {
          readingBody = true;
          return new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          });
        }
      }))
    );
    const promise = createProvider().createProvisionalReply({
      message: {
        conversationId: "c",
        userId: "u",
        text: "hello",
        timestampIso: new Date().toISOString()
      },
      correctedText: "hello",
      routeDecision: "direct"
    });
    const assertion = expect(promise).rejects.toThrow(`${label} request timed out after 10ms`);
    await vi.advanceTimersByTimeAsync(0);
    expect(readingBody).toBe(true);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });
});
