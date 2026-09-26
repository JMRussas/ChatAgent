import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

describe("timeline workflow", () => {
  it("persists user and fast events for direct route", async () => {
    const timeline = new InMemoryConversationTimelineStore();
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);

    await orchestrator.handleUserMessage({
      conversationId: "conv-direct",
      userId: "u1",
      text: "Explain event-driven architecture",
      timestampIso: new Date().toISOString()
    });

    const events = await timeline.getEvents("conv-direct");
    expect(events.map((e) => e.type)).toEqual(["user", "activity", "delta", "provisional", "terminal"]);
  });

  it("persists refined event after deep worker completes", async () => {
    const timeline = new InMemoryConversationTimelineStore();
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);

    await orchestrator.handleUserMessage({
      conversationId: "conv-deep",
      userId: "u2",
      text: "Find latest inflation data and cite sources",
      timestampIso: new Date().toISOString()
    });

    await worker.runSingle();

    const events = await timeline.getEvents("conv-deep");
    expect(events.map((e) => e.type)).toEqual(["user", "activity", "activity", "delta", "provisional", "terminal", "activity", "delta", "refined", "terminal"]);
    expect(events.filter((e) => e.type === "activity").map((e) => e.activity)).toEqual(["queued", "running", "running"]);
  });
});
