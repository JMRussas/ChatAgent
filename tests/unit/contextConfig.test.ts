import { describe, expect, it } from "vitest";
import data from "../../data/model-catalog.json";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { modelCatalogSchema } from "../../src/config/modelCatalog";
import type { RuntimeProviderConfig } from "../../src/config/providerConfig";
import { ContextManager } from "../../src/app/contextManager";
import { ContextBudgetError } from "../../src/app/contextBuilder";
import { ChatOrchestrator } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";

const config: RuntimeProviderConfig = {
  fast: { provider: "mock", model: "fast", temperature: 0 },
  deep: { provider: "mock", model: "deep", temperature: 0 }
};
function catalog(fast?: number, deep?: number) {
  return modelCatalogSchema.parse({ version: 1, models: [
    ...["fast", "deep"].map((model, index) => ({
      ...data.models[0], id: model, model,
      limits: { contextTokens: [fast, deep][index] }
    })),
    { ...data.models[0], id: "unselected", model: "unselected", limits: { contextTokens: 100 } },
    { ...data.models[0], id: "other-provider", provider: "ollama", model: "fast", limits: { contextTokens: 100 } }
  ] });
}

describe("selected model context limits", () => {
  it.each([
    [4096, 6000, 4096], [6000, 4096, 4096],
    [16000, 32000, 8192], [undefined, 4096, 4096],
    [undefined, undefined, 8192]
  ])("resolves fast=%s deep=%s to window=%s", (fast, deep, expected) => {
    expect(loadContextBudgetConfigFromEnv({}, { config, catalog: catalog(fast, deep) }).windowTokens).toBe(expected);
  });

  it("keeps the application bound for unlisted selections", () => {
    const unlisted = { ...config, fast: { ...config.fast, model: "missing-fast" }, deep: { ...config.deep, model: "missing-deep" } };
    expect(loadContextBudgetConfigFromEnv({}, { config: unlisted, catalog: catalog(4096, 4096) }).windowTokens).toBe(8192);
  });

  it("rejects reserves consuming the selected model window", () => {
    expect(() => loadContextBudgetConfigFromEnv({}, { config, catalog: catalog(2048, 8192) }))
      .toThrow(/effective context window \(2048/);
  });

  it("rejects a turn that fits the application but not the model before any provider or timeline work", async () => {
    const timeline = new InMemoryConversationTimelineStore();
    const queue = new InMemoryTaskQueue();
    let calls = 0;
    const fast = { createProvisionalReply: async () => { calls++; return { text: "answer", finishReason: "stop" as const }; } };
    const budget = loadContextBudgetConfigFromEnv({}, { config, catalog: catalog(4096, 8192) });
    const orchestrator = new ChatOrchestrator(fast, queue, timeline, undefined, new ContextManager(timeline, budget));
    const message = { conversationId: "c", userId: "u", text: "x".repeat(2000), timestampIso: "2026-09-25T00:00:00Z" };
    await expect(orchestrator.handleUserMessage(message)).rejects.toBeInstanceOf(ContextBudgetError);
    expect(calls).toBe(0);
    expect(await timeline.getEvents("c")).toEqual([]);
    expect(queue.size()).toBe(0);
    await expect(new ChatOrchestrator(fast, queue, timeline).handleUserMessage(message)).resolves.toBeDefined();
    expect(calls).toBe(1);
  });
});
