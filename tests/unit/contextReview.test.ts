import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { buildProviderPair } from "../../src/providers/providerFactory";
import { buildSystemAndMessages } from "../../src/providers/contextMessages";
import { buildContext, ContextBudgetError } from "../../src/app/contextBuilder";
import { ContextManager } from "../../src/app/contextManager";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ChatService } from "../../src/app/chatService";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import type { RuntimeProviderConfig, ProviderKind } from "../../src/config/providerConfig";
import type { ChatTimelineEvent } from "../../src/domain/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const timestamp = "2026-09-25T00:00:00Z";
const facts = { fastProvider: "mock", fastModel: "test", deepProvider: "mock", deepModel: "test", generatedAtIso: timestamp };
const config = (provider: ProviderKind): RuntimeProviderConfig => ({
  fast: { provider, model: "fast", temperature: 0 }, deep: { provider, model: "deep", temperature: 0 },
  azure: { endpoint: "https://example.invalid", apiKey: "fixture", apiVersion: "fixture" },
  bedrock: { region: "us-east-1" }, ollama: { baseUrl: "http://fixture.invalid" }
});
function transport() {
  const payloads: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: "answer" }, choices: [{ message: { content: "answer" } }] }));
  }));
  vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation((async (command: any) => {
    payloads.push(command.input);
    return { output: { message: { content: [{ text: "answer" }] } } };
  }) as any);
  return payloads;
}

describe("CTX-01 effective caps", () => {
  it.each(["FAST", "DEEP"])("rejects %s Ollama override consuming the window", role => {
    expect(() => loadContextBudgetConfigFromEnv({ [`CHAT_${role}_PROVIDER`]: "ollama", [`OLLAMA_${role}_NUM_PREDICT`]: "8192" })).toThrow(/OLLAMA/);
  });
  it.each(["ollama", "azure", "bedrock"] as const)("reserves the same effective caps sent through %s", async provider => {
    const payloads = transport();
    const budget = loadContextBudgetConfigFromEnv({ CHAT_FAST_PROVIDER: provider, CHAT_DEEP_PROVIDER: provider,
      CONTEXT_WINDOW_TOKENS: "16000", OLLAMA_FAST_NUM_PREDICT: "900", OLLAMA_DEEP_NUM_PREDICT: "8192" });
    expect(budget.fastOutputTokens).toBe(provider === "ollama" ? 900 : 512);
    expect(budget.deepOutputTokens).toBe(provider === "ollama" ? 8192 : 2048);
    const pair = buildProviderPair(config(provider), budget);
    const timeline = new InMemoryConversationTimelineStore();
    const queue = new InMemoryTaskQueue();
    const manager = new ContextManager(timeline, budget);
    const orchestrator = new ChatOrchestrator(pair.fastProvider, queue, timeline, undefined, manager);
    const result = await orchestrator.handleUserMessage({ conversationId: "c", userId: "u", text: "Find latest information", timestampIso: timestamp });
    await pair.deepProvider.resolveDeepTask(result.deepTask!);
    const caps = payloads.map(p => p.options?.num_predict ?? p.max_tokens ?? p.inferenceConfig.maxTokens);
    expect(caps).toEqual([budget.fastOutputTokens, budget.deepOutputTokens]);
    const context = result.deepTask!.context!;
    // This request fits the application window alone, but not after output reservation.
    const tooLarge = await manager.prepare({ conversationId: "empty", currentMessageId: "m", currentUserText: "x".repeat(16000 - budget.deepOutputTokens), trustedFacts: facts });
    expect(tooLarge).toBeInstanceOf(ContextBudgetError);
    expect(context.estimatedInputTokens + budget.deepOutputTokens + budget.safetyTokens).toBeLessThanOrEqual(budget.windowTokens);
  });
  it("uses defaults without overrides and rejects malformed applicable overrides", () => {
    expect(loadContextBudgetConfigFromEnv({}).deepOutputTokens).toBe(2048);
    expect(() => loadContextBudgetConfigFromEnv({ CHAT_FAST_PROVIDER: "ollama", OLLAMA_FAST_NUM_PREDICT: "no" })).toThrow();
  });
});

describe("CTX-02 serialized accounting", () => {
  it.each([false, true])("counts rendered wrappers, UTF-8 and both roles (tasks=%s)", pending => {
    const events: ChatTimelineEvent[] = [
      { type: "user", messageId: "old", text: "é".repeat(400), createdAtIso: timestamp },
      { type: "provisional", messageId: "old", text: "a".repeat(600), processingStatus: "complete", createdAtIso: timestamp },
      ...(pending ? [{ type: "user" as const, messageId: "pending", text: "日本語", createdAtIso: timestamp }] : [])
    ];
    for (const windowTokens of [500, 1600, 2000]) {
      const c = buildContext({ conversationId: "c", events, currentMessageId: "now", currentUserText: "why?", capturedAtIso: timestamp,
        systemInstruction: "system", roleInstructions: { fast: "fast", deep: "longer deep" },
        budget: { windowTokens, maxHistoryTurns: 12, safetyTokens: 0, fastOutputTokens: 1, deepOutputTokens: 1 } });
      if (c instanceof ContextBudgetError) throw c;
      const counts = (["fast", "deep"] as const).map(role => {
        const wire = buildSystemAndMessages(c, role);
        return 32 + 16 + Buffer.byteLength(wire.system, "utf8") + wire.messages.reduce((n, m) => n + 16 + Buffer.byteLength(m.content, "utf8"), 0);
      });
      expect(c.estimatedInputTokens).toBe(Math.max(...counts));
      expect(c.estimatedInputTokens).toBeLessThanOrEqual(windowTokens - 1);
      if (pending && windowTokens >= 1600) expect(c.activeTasks).toHaveLength(1);
      if (pending && windowTokens === 500) expect(c.omittedActiveTaskIds).toEqual(["pending"]);
    }
  });
});

describe("CTX-03 route preservation", () => {
  it.each(["ollama", "azure", "bedrock"] as const)("preserves selected route in %s requests and shared history", async provider => {
    const payloads = transport();
    const pair = buildProviderPair(config(provider), loadContextBudgetConfigFromEnv({}));
    for (const [text, route, phrase] of [
      ["Explain gravity", "direct", "Provide a direct answer"],
      ["do it", "clarify", "Ask one concise clarifying question"],
      ["Find latest information", "deep", "Acknowledge that it is pending"]
    ]) {
      const queue = new InMemoryTaskQueue();
      const orchestrator = new ChatOrchestrator(pair.fastProvider, queue);
      const result = await orchestrator.handleUserMessage({ conversationId: route, userId: "u", text, timestampIso: timestamp });
      const fast = payloads.at(-1);
      const system = provider === "bedrock" ? fast.system[0].text : fast.messages[0].content;
      expect(system).toContain(`Selected route: ${route}`);
      expect(system).toContain(phrase);
      if (route === "deep") {
        expect(queue.size()).toBe(1);
        await pair.deepProvider.resolveDeepTask(result.deepTask!);
        const deep = payloads.at(-1);
        expect(provider === "bedrock" ? fast.messages : fast.messages.slice(1)).toEqual(provider === "bedrock" ? deep.messages : deep.messages.slice(1));
      } else {
        expect(system).toContain("No deep work is queued");
        expect(queue.size()).toBe(0);
      }
    }
  });
});

describe("CTX-04 replay state", () => {
  it("follows failed, replay queued, running, retrying and complete without mutating snapshots", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const dead = new InMemoryDeadLetterStore();
    const manager = new ContextManager(timeline, loadContextBudgetConfigFromEnv({}));
    const orchestrator = new ChatOrchestrator({ createProvisionalReply: async () => "pending" }, queue, timeline);
    let resolve!: (value: any) => void;
    let reject!: (reason: Error) => void;
    const deep = { resolveDeepTask: vi.fn(() => new Promise<any>((yes, no) => { resolve = yes; reject = no; })) };
    const failing = new DeepWorker(queue, { resolveDeepTask: async () => { throw new Error("failed"); } }, timeline, 0, dead);
    const worker = new DeepWorker(queue, deep, timeline, 1, dead);
    const service = new ChatService(orchestrator, worker, timeline, queue, dead);
    const result = await service.submitMessage({ conversationId: "c", userId: "u", text: "Find latest information", timestampIso: timestamp });
    const snapshot = async () => {
      const c = await manager.prepare({ conversationId: "c", currentMessageId: "next", currentUserText: "status?", trustedFacts: facts });
      if (c instanceof ContextBudgetError) throw c;
      return c;
    };
    await failing.runSingle();
    const failed = await snapshot();
    expect(failed.activeTasks[0].state).toBe("failed");
    await service.replayDeadLetter(result.deepTask!.taskId);
    expect((await snapshot()).activeTasks[0].state).toBe("queued");
    const run = worker.runSingle();
    await vi.waitFor(() => expect(deep.resolveDeepTask).toHaveBeenCalledTimes(1));
    expect((await snapshot()).activeTasks[0].state).toBe("running");
    reject(new Error("transient")); await run;
    expect((await snapshot()).activeTasks[0].state).toBe("retrying");
    const retry = worker.runSingle();
    await vi.waitFor(() => expect(deep.resolveDeepTask).toHaveBeenCalledTimes(2));
    resolve({ taskId: result.deepTask!.taskId, finalReply: "completed", totalLatencyMs: 1, confidence: 1, citations: [] }); await retry;
    expect((await snapshot()).activeTasks).toEqual([]);
    expect((await snapshot()).messages.some(m => m.content === "completed")).toBe(true);
    await timeline.appendEvent("c", { type: "refined", messageId: result.messageId, text: "latest completion", processingStatus: "complete", createdAtIso: timestamp });
    expect((await snapshot()).messages.some(m => m.content === "latest completion")).toBe(true);
    expect(failed.activeTasks[0].state).toBe("failed");
    expect(result.deepTask!.context!.messages).toHaveLength(1);
  });
});
