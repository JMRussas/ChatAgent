import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

describe("prototype success gates", () => {
  it("responds immediately with a provisional answer for deep routes", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    const start = Date.now();
    const result = await orchestrator.handleUserMessage({
      conversationId: "convA",
      userId: "userA",
      text: "Look up current treasury yields and cite your sources",
      timestampIso: new Date().toISOString()
    });

    const latencyMs = Date.now() - start;
    expect(result.fastResponse.processingStatus).toBe("provisional");
    expect(latencyMs).toBeLessThan(1000);
  });

  it("publishes a refined answer from async worker", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);
    const worker = new DeepWorker(queue, new MockDeepProvider());

    await orchestrator.handleUserMessage({
      conversationId: "convB",
      userId: "userB",
      text: "Search latest semiconductor trend report",
      timestampIso: new Date().toISOString()
    });

    const refined = await worker.runSingle();
    expect(refined?.citations.length).toBeGreaterThan(0);
  });
});
