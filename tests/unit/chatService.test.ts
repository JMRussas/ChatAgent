import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ChatService, ConversationOwnershipConflictError } from "../../src/app/chatService";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

function buildService() {
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
  const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
  const service = new ChatService(orchestrator, worker, timeline);
  return { service, timeline };
}

describe("ChatService conversation ownership", () => {
  it("claims a conversation for the first submitting userId", async () => {
    const { service } = buildService();

    await expect(
      service.submitMessage({
        conversationId: "conv-a",
        userId: "alice",
        text: "hello",
        timestampIso: new Date().toISOString()
      })
    ).resolves.toBeDefined();
  });

  it("lets the same userId keep submitting to the conversation it owns", async () => {
    const { service } = buildService();

    await service.submitMessage({
      conversationId: "conv-a",
      userId: "alice",
      text: "hello",
      timestampIso: new Date().toISOString()
    });

    await expect(
      service.submitMessage({
        conversationId: "conv-a",
        userId: "alice",
        text: "again",
        timestampIso: new Date().toISOString()
      })
    ).resolves.toBeDefined();
  });

  it("rejects a different userId submitting to an already-claimed conversation with 409-mapped error, before reading context or appending events", async () => {
    const { service, timeline } = buildService();

    await service.submitMessage({
      conversationId: "conv-shared",
      userId: "alice",
      text: "hello",
      timestampIso: new Date().toISOString()
    });

    await expect(
      service.submitMessage({
        conversationId: "conv-shared",
        userId: "bob",
        text: "hi",
        timestampIso: new Date().toISOString()
      })
    ).rejects.toBeInstanceOf(ConversationOwnershipConflictError);

    const events = await timeline.getEvents("conv-shared");
    expect(events.filter((e) => e.type === "user")).toHaveLength(1);
  });
});
