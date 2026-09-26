import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { AzureFastProvider } from "../../src/providers/azureProviders";
import { OllamaFastProvider } from "../../src/providers/ollamaProviders";
import { BedrockFastProvider } from "../../src/providers/bedrockProviders";
import { verifyThinkingConfig } from "../../src/config/thinkingConfig";
import { type GenerationControl } from "../../src/domain/generation";
import { AnswerCollector } from "../../src/providers/streaming";
const input = { message: { conversationId: "c", userId: "u", text: "hello", timestampIso: "2026-09-25T00:00:00Z" }, correctedText: "hello", routeDecision: "direct" as const };
function control() {
  const controller = new AbortController(); const chunks: string[] = [];
  const value: GenerationControl = { signal: controller.signal, attemptId: "a", onDelta: async text => { chunks.push(text); } };
  return { controller, chunks, value };
}
function bytesResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }));
}
const providers = {
  ollama: () => new OllamaFastProvider("http://fixture.invalid", "model", 0, 1000),
  azure: () => new AzureFastProvider("https://fixture.invalid", "test", "test", "model", 0, 1000)
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("provider streams", () => {
  it.each(["ollama", "azure"] as const)("decodes split UTF-8 and frames in %s without exposing reasoning", async kind => {
    const wire = kind === "ollama"
      ? [{ message: { content: "é", thinking: "secret" }, done: false }, { message: { content: "日本" }, done: true, done_reason: "stop" }].map(x => JSON.stringify(x)).join("\n") + "\n"
      : ': heartbeat\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"é","reasoning_content":"secret"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"日本"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const fetchMock = vi.fn(async () => bytesResponse(wire)); vi.stubGlobal("fetch", fetchMock);
    const c = control(); expect(await providers[kind]().createProvisionalReply(input, c.value)).toEqual({ text: "é日本", finishReason: "stop" });
    expect(c.chunks.join("")).toBe("é日本");
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).stream).toBe(true);
  });
  it.each(["ollama", "azure"] as const)("rejects malformed and unterminated %s streams", async kind => {
    for (const wire of ["not json\n\n", kind === "ollama" ? '{"message":{"content":"partial"},"done":false}\n' : 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n']) {
      vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(wire)));
      await expect(providers[kind]().createProvisionalReply(input, control().value)).rejects.toMatchObject({ code: "INVALID_STREAM", retryable: false });
    }
  });
  it.each(["ollama", "azure"] as const)("retains empty and partial %s length outcomes", async kind => {
    for (const text of ["", "partial"]) {
      const wire = kind === "ollama" ? JSON.stringify({ message: { content: text, thinking: "secret" }, done: true, done_reason: "length" }) + "\n"
        : 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "length" }] }) + '\n\ndata: [DONE]\n\n';
      vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(wire)));
      expect(await providers[kind]().createProvisionalReply(input, control().value)).toEqual({ text, finishReason: "length" });
    }
  });
  it.each(["ollama", "azure"] as const)("aborts stalled %s stream bodies on deadline and user cancellation", async kind => {
    vi.useFakeTimers();
    for (const userCancel of [false, true]) {
      let signal!: AbortSignal; const cancel = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ cancel })); }));
      const c = control(); const pending = providers[kind]().createProvisionalReply(input, c.value);
      const assertion = expect(pending).rejects.toMatchObject({ code: userCancel ? "CANCELLED" : "PROVIDER_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(0);
      if (userCancel) c.controller.abort(); else await vi.advanceTimersByTimeAsync(1001);
      await assertion; expect(signal.aborted).toBe(true); expect(cancel).toHaveBeenCalled();
    }
  });
  it("bounds frame and accumulated answer sizes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1))));
    await expect(providers.ollama().createProvisionalReply(input, control().value)).rejects.toMatchObject({ code: "STREAM_TOO_LARGE" });
    const collector = new AnswerCollector(); await collector.add("x".repeat(1024 * 1024));
    await expect(collector.add("x")).rejects.toMatchObject({ code: "ANSWER_TOO_LARGE" });
  });
  it("streams Bedrock text only, passes abort signal and maps max_tokens", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation((async () => ({ stream: (async function* () {
      yield { contentBlockDelta: { delta: { reasoningContent: { text: "secret" } } } };
      yield { contentBlockDelta: { delta: { text: "answer" } } };
      yield { messageStop: { stopReason: "max_tokens" } };
    })() })) as any);
    const c = control();
    expect(await new BedrockFastProvider("us-east-1", "model", 0).createProvisionalReply(input, c.value)).toEqual({ text: "answer", finishReason: "length" });
    expect(send.mock.calls[0][0]).toBeInstanceOf(ConverseStreamCommand);
    expect((send.mock.calls[0][1] as any).abortSignal).toBeInstanceOf(AbortSignal); expect(c.chunks).toEqual(["answer"]);
  });
  it("normalizes Bedrock stream errors", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation((async () => ({ stream: (async function* () { yield { validationException: { message: "private details" } }; })() })) as any);
    await expect(new BedrockFastProvider("us-east-1", "model", 0).createProvisionalReply(input, control().value)).rejects.toMatchObject({ code: "PROVIDER_REQUEST_INVALID", retryable: false });
  });
});

describe("verified thinking controls", () => {
  const config = { fast: { provider: "ollama" as const, model: "fast", temperature: 0 }, deep: { provider: "mock" as const, model: "deep", temperature: 0 } };
  it("sends supported controls at the top level and exposes only applied reasoning metadata", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/api/version") ? { version: "fixture" } : url.endsWith("/api/show") ? { thinking: { values: [false, true], default: true } } : { message: { content: "answer" }, done: true, done_reason: "stop" })));
    vi.stubGlobal("fetch", fetchMock);
    const verified = await verifyThinkingConfig(config, { OLLAMA_FAST_THINK: "on" }); expect(verified.fast).toBe(true);
    const provider = new OllamaFastProvider("http://fixture.invalid", "fast", 0, 1000, 512, verified.fast);
    await provider.createProvisionalReply(input);
    expect(JSON.parse((fetchMock.mock.calls.at(-1) as any)[1].body)).toMatchObject({ think: true });
    expect(provider.metadata.reasoningEnabled).toBe(true);
  });
  it("rejects missing or unsupported runtime metadata without invoking inference", async () => {
    for (const thinking of [undefined, { values: ["low", "high"] }, { values: [true] }]) {
      const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/api/version") ? { version: "fixture" } : { thinking })));
      vi.stubGlobal("fetch", fetchMock);
      await expect(verifyThinkingConfig(config, {})).rejects.toMatchObject({ code: "THINKING_CONFIG_UNSUPPORTED" });
      expect(fetchMock.mock.calls.some(call => call[0].endsWith("/api/chat"))).toBe(false);
    }
  });
  it("leaves default unspecified without claiming verified reasoning or making metadata calls", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await verifyThinkingConfig(config, { OLLAMA_FAST_THINK: "default" })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled(); expect(new OllamaFastProvider("fixture", "model", 0).metadata.reasoningEnabled).toBeUndefined();
    await expect(verifyThinkingConfig(config, { OLLAMA_FAST_THINK: "bogus" })).rejects.toThrow(/must be/);
  });
});
