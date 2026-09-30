import { test as base, expect } from "@playwright/test";
import { createChatServer } from "../../src/server";
import { createRuntimeHandle } from "../../src/app/runtimeHandle";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue, type FastModelProvider, type DeepModelProvider } from "../../src/providers/interfaces";
import { GenerationError, type GenerationControl, type GenerationResult } from "../../src/domain/generation";

async function runtime() {
  const pending = new Map<string, { emit(text: string): Promise<void>; finish(): void }>();
  const controls = { worker: true };
  async function generate(phase: string, text: string, control?: GenerationControl): Promise<GenerationResult> {
    if (phase === "fast") await control?.onDelta(`Draft: ${text}`);
    if (phase === "fast" && text.includes("cite")) return { text: `Draft: ${text}`, finishReason: "stop" };
    await new Promise<void>((resolve, reject) => {
      const abort = () => { pending.delete(`${phase}:${text}`); reject(new GenerationError("CANCELLED", false)); };
      if (control?.signal.aborted) return abort();
      control?.signal.addEventListener("abort", abort, { once: true });
      pending.set(`${phase}:${text}`, { emit: async chunk => { await control?.onDelta(chunk); }, finish: () => {
        control?.signal.removeEventListener("abort", abort); pending.delete(`${phase}:${text}`); resolve();
      } });
    });
    if (text.includes("auth failure")) throw new GenerationError("PROVIDER_AUTH", false);
    if (text.includes("quota failure")) throw new GenerationError("QUOTA_EXHAUSTED", false);
    if (text.includes("provider failure")) throw new GenerationError("PROVIDER_ERROR", false);
    return { text: `${phase === "deep" ? "Refined" : "Final"}: ${text}`, finishReason: text.includes("length limit") ? "length" : "stop" };
  }
  const fast: FastModelProvider = { metadata: { provider: "mock", model: "browser-fast" }, createProvisionalReply: (input, c) => generate("fast", input.message.text, c) };
  const deep: DeepModelProvider = { metadata: { provider: "mock", model: "browser-deep", reasoningEnabled: true }, resolveDeepTask: async (task, c) => {
    const result = await generate("deep", task.normalizedPrompt, c);
    return { taskId: task.taskId, finalReply: result.text, finishReason: result.finishReason, confidence: 1, citations: [], totalLatencyMs: 0 };
  } };
  const timeline = new InMemoryConversationTimelineStore(), queue = new InMemoryTaskQueue();
  const service = new ChatService(new ChatOrchestrator(fast, queue, timeline), new DeepWorker(queue, deep, timeline), timeline, queue);
  const server = createChatServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let workerError: unknown;
  const worker = setInterval(() => { if (controls.worker) void service.runDeepWorkerOnce().catch(e => { workerError = e; }); }, 10);
  const handle = createRuntimeHandle(server, service, { config: { graceMs: 0, timeoutMs: 2000 },
    stopBackground: () => clearInterval(worker), stopInternal: async () => {}, persist: async () => {} });
  return { url: `http://127.0.0.1:${handle.address.port}`, pending, controls,
    disconnect: () => server.closeStreams(), close: async () => { await handle.shutdown(); if (workerError) throw workerError; } };
}
export const test = base.extend<{ app: Awaited<ReturnType<typeof runtime>> }>({ app: async ({}, use) => {
  const app = await runtime(); try { await use(app); } finally { await app.close(); }
} });
export { expect };
