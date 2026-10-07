import { describe, expect, it } from "vitest";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import type { ConversationTimelineStore } from "../../src/app/timelineStore";
import type { ChatTimelineEvent } from "../../src/domain/types";

const event = (text: string) =>
  ({
    type: "user",
    conversationId: "c",
    messageId: text,
    text,
    createdAtIso: "2026-10-06T00:00:00.000Z"
  }) as ChatTimelineEvent;

async function filled(count: number, clock = () => 0) {
  const store = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ maxIdentities: 4, maxHistories: 2, idleTtlMs: 10 }),
    clock
  );
  for (let i = 1; i <= count; i++) await store.appendEvent("c", event(`m${i}`));
  return store;
}

describe("reading the timeline after a sequence", () => {
  it("returns exactly the suffix after the cursor", async () => {
    const store = await filled(5);
    const sequences = async (after: number) =>
      (await store.getEventsAfter("c", after)).map((e) => e.sequence);
    expect(await sequences(0)).toEqual([1, 2, 3, 4, 5]);
    expect(await sequences(2)).toEqual([3, 4, 5]);
    expect(await sequences(4)).toEqual([5]);
    expect(await sequences(5)).toEqual([]);
    expect(await sequences(99)).toEqual([]);
    expect(await store.getEventsAfter("unknown", 0)).toEqual([]);
    // The same events as filtering the full read.
    for (const after of [0, 1, 3, 5])
      expect(await store.getEventsAfter("c", after)).toEqual(
        (await store.getEvents("c")).filter((e) => e.sequence! > after)
      );
  });

  it("returns copies the caller cannot use to change the store", async () => {
    const store = await filled(3);
    const [copy] = await store.getEventsAfter("c", 1);
    copy.text = "changed";
    expect((await store.getEvents("c"))[1].text).toBe("m2");
  });

  it("keeps getEvents' availability and access semantics: reading neither revives nor extends", async () => {
    let now = 0;
    const store = await filled(2, () => now);
    now = 5;
    expect(await store.getEventsAfter("c", 0)).toHaveLength(2);
    // Reads do not touch the idle clock: the conversation still expires at 10.
    now = 10;
    await expect(store.getEventsAfter("c", 0)).rejects.toMatchObject({
      code: "CONVERSATION_EXPIRED"
    });
    await expect(store.getEvents("c")).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
  });

  it("falls back to the full read for a store without the method", async () => {
    const backing = await filled(4);
    const plain: ConversationTimelineStore = {
      appendEvent: (id, e) => backing.appendEvent(id, e),
      getEvents: (id) => backing.getEvents(id)
    };
    const make = (timeline: ConversationTimelineStore) => {
      const queue = new InMemoryTaskQueue();
      return new ChatService(
        new ChatOrchestrator(new MockFastProvider(), queue, timeline),
        new DeepWorker(queue, new MockDeepProvider(), timeline),
        timeline,
        queue
      );
    };
    for (const after of [0, 2, 4, 9])
      expect(await make(plain).getTimelineAfter("c", after)).toEqual(
        await make(backing).getTimelineAfter("c", after)
      );
  });
});
