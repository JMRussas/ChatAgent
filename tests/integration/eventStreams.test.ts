import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { projectTurnEvent } from "../../src/app/protocolV1";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import {
  InMemoryConversationTimelineStore,
  type ConversationTimelineStore
} from "../../src/app/timelineStore";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import { scopedOwnerKey } from "../../src/auth/authenticator";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { ContextManager } from "../../src/app/contextManager";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { GenerationError } from "../../src/domain/generation";
import type { ChatTimelineEvent } from "../../src/domain/types";
import { FakeResponse, fakeRequest, frames } from "../helpers/fakeResponse";
import { allowAllTestAuth, testOwner } from "../helpers/testAuth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(
  maxEventStreams = 2,
  timeline: ConversationTimelineStore = new InMemoryConversationTimelineStore()
) {
  const queue = new InMemoryTaskQueue();
  const service = new ChatService(
    new ChatOrchestrator(
      {
        createProvisionalReply: async (input) => ({
          text: `re: ${input.message.text}`,
          finishReason: "stop"
        })
      },
      queue,
      timeline,
      undefined,
      new ContextManager(timeline, loadContextBudgetConfigFromEnv({}))
    ),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const server = createChatServer(service, {
    auth: allowAllTestAuth,
    maxEventStreams,
    streamStallTimeoutMs: 1000
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const conversation = randomUUID();
  const scope = "accountId=a&projectId=p";
  const v1Path = `/v1/conversations/${conversation}/events/stream?${scope}`;
  const postV1 = async (text: string) => {
    const response = await fetch(`${base}/v1/conversations/${conversation}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.0",
        accountId: "a",
        projectId: "p",
        messageId: randomUUID(),
        text,
        clientTimestampIso: new Date().toISOString()
      })
    });
    expect(response.status).toBe(200);
    await response.json();
  };
  const postLegacy = async (conversationId: string, text: string) => {
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        userId: "u",
        messageId: randomUUID(),
        text,
        timestampIso: new Date().toISOString()
      })
    });
    expect(response.status).toBe(200);
    await response.json();
  };
  /** Opens a real stream and returns once its headers arrived. */
  const open = async (path: string) => {
    const controller = new AbortController();
    const response = await fetch(`${base}${path}`, { signal: controller.signal });
    cleanups.push(async () => controller.abort());
    return { response, abort: () => controller.abort() };
  };
  /** Drives the server's request handler with a response whose writes can report full. */
  const fake = (path: string) => {
    const res = new FakeResponse();
    server.emit("request", fakeRequest(path), res.asResponse());
    cleanups.push(async () => void res.destroy());
    return res;
  };
  return {
    server,
    service,
    timeline,
    base,
    conversation,
    v1Path,
    postV1,
    postLegacy,
    open,
    fake
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;

/**
 * Makes `id` owned by the test principal without any message, and returns a direct
 * append, so every timeline change in a test is explicit.
 */
function owned(h: Harness, id: string) {
  vi.spyOn(h.service, "conversationOwner").mockImplementation((c) =>
    c === id ? testOwner("u") : undefined
  );
  return (text: string) =>
    h.timeline.appendEvent(id, { type: "user", text, createdAtIso: new Date().toISOString() });
}

/** Waits until a spied read has been called n more times, i.e. n more polls ran. */
async function polls(spy: { mock: { calls: unknown[][] } }, n: number) {
  const target = spy.mock.calls.length + n;
  await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(target), {
    timeout: 5000
  });
}

const texts = (frame: { data: { events: ChatTimelineEvent[] } }) =>
  frame.data.events.map((e) => e.text);

it("shares one stream limit across legacy and v1 routes and refuses before any stream work", async () => {
  const h = await setup(2);
  const legacy = await h.open("/conversations/c1/events/stream");
  const v1 = await h.open(h.v1Path);
  expect(legacy.response.status).toBe(200);
  expect(v1.response.status).toBe(200);
  expect(h.server.retentionStats().streams).toBe(2);

  const reads = vi.spyOn(h.service, "getTimeline");
  const afterReads = vi.spyOn(h.service, "getTimelineAfter");
  const lastReads = vi.spyOn(h.service, "lastTimelineSequence");
  const count = () =>
    reads.mock.calls.length + afterReads.mock.calls.length + lastReads.mock.calls.length;
  const before = count();
  for (const path of [
    "/conversations/c2/events/stream",
    `/v1/conversations/${randomUUID()}/events/stream?accountId=a&projectId=p`
  ]) {
    const refused = await fetch(`${h.base}${path}`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(refused.headers.get("content-type")).toContain("application/json");
    expect(await refused.json()).toMatchObject({ code: "STREAM_CAPACITY" });
  }
  // Refusal read no timeline and allocated no protocol identity.
  expect(count()).toBe(before);
  expect(h.server.retentionStats()).toMatchObject({ streams: 2, wireConversations: 0 });

  // Closing a stream frees its slot; a new stream on the other route is admitted.
  legacy.abort();
  await vi.waitFor(() => expect(h.server.retentionStats().streams).toBe(1));
  const reopened = await h.open("/conversations/c3/events/stream");
  expect(reopened.response.status).toBe(200);
  expect(h.server.retentionStats().streams).toBe(2);
});

it("frees the slot when a stream is refused after admission by an expired or unavailable history", async () => {
  const h = await setup(1);
  vi.spyOn(h.service, "getTimeline").mockRejectedValueOnce(
    new GenerationError("CONVERSATION_EXPIRED", false)
  );
  const expired = await fetch(`${h.base}/conversations/gone/events/stream`);
  expect(expired.status).toBe(410);
  await expired.text();
  expect(h.server.retentionStats().streams).toBe(0);

  await h.postV1("hello");
  const unavailable = await fetch(`${h.base}${h.v1Path}&afterSequence=999`);
  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toEqual({ code: "CURSOR_UNAVAILABLE" });
  expect(h.server.retentionStats().streams).toBe(0);

  // Validation failures are answered before admission.
  const invalid = await fetch(`${h.base}${h.v1Path}&afterSequence=-1`);
  expect(invalid.status).toBe(400);
  const ok = await h.open(h.v1Path);
  expect(ok.response.status).toBe(200);
});

it("keeps a slot while a pre-header read is pending after the client leaves", async () => {
  const h = await setup(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const original = h.service.getTimeline.bind(h.service);
  vi.spyOn(h.service, "getTimeline").mockImplementationOnce(async (id) => {
    await held;
    return original(id);
  });
  const res = h.fake("/conversations/slow/events/stream");
  await vi.waitFor(() => expect(h.server.retentionStats().streams).toBe(1));
  res.destroy();
  expect(h.server.retentionStats()).toMatchObject({ streams: 1, settlingStreams: 1 });
  const refused = await fetch(`${h.base}/conversations/other/events/stream`);
  expect(refused.status).toBe(429);
  await refused.text();
  release();
  await vi.waitFor(() => expect(h.server.retentionStats().streams).toBe(0));
  // The abandoned request never sent headers or frames.
  expect(res.chunks).toHaveLength(0);
});

it("v1: a full write advances the cursor, blocks reads, and resumes without gaps or duplicates", async () => {
  const h = await setup(2);
  await h.postV1("one");
  await h.postV1("two");
  const reads = vi.spyOn(h.service, "getTimeline");
  // The pump reads only events after its cursor.
  const pumpReads = vi.spyOn(h.service, "getTimelineAfter");
  const res = new FakeResponse();
  res.allowance = 2; // ready + first turn frame; the second turn frame reports full.
  h.server.emit("request", fakeRequest(h.v1Path), res.asResponse());
  cleanups.push(async () => void res.destroy());
  await vi.waitFor(() => expect(frames(res).filter((f) => f.event === "turn")).toHaveLength(2));
  const readsWhenBlocked = reads.mock.calls.length + pumpReads.mock.calls.length;
  await new Promise((r) => setTimeout(r, 350));
  // Blocked: no timeline reads and nothing more written across several poll intervals.
  expect(reads.mock.calls.length + pumpReads.mock.calls.length).toBe(readsWhenBlocked);
  expect(frames(res).filter((f) => f.event === "turn")).toHaveLength(2);

  res.drain();
  // The stream reads its own internal conversation; project it the same way.
  const internalId = pumpReads.mock.calls[0][0];
  const expected = (await h.service.getTimeline(internalId))
    .map((e) => projectTurnEvent(h.conversation, e))
    .filter((w) => w !== undefined)
    .map((w) => w.sequence);
  expect(expected.length).toBeGreaterThan(2);
  await vi.waitFor(() =>
    expect(
      frames(res)
        .filter((f) => f.event === "turn")
        .map((f) => f.id)
    ).toEqual(expected)
  );
  const ids = frames(res)
    .filter((f) => f.event === "turn")
    .map((f) => f.id!);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
});

for (const route of ["v1", "legacy"] as const)
  it(`${route}: a frame skipped because a heartbeat blocked the stream mid-read is sent after drain`, async () => {
    const h = await setup(2);
    const post = (text: string) => (route === "v1" ? h.postV1(text) : h.postLegacy("c", text));
    await post("first");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    cleanups.push(async () => void vi.useRealTimers());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holdNext = false;
    let holding = false;
    const hold = async () => {
      if (holdNext) {
        holdNext = false;
        holding = true;
        await held;
      }
    };
    // Each route polls through its own read: v1 copies only events after its cursor.
    const original = h.service.getTimeline.bind(h.service);
    const originalAfter = h.service.getTimelineAfter.bind(h.service);
    const reads =
      route === "v1"
        ? vi.spyOn(h.service, "getTimelineAfter").mockImplementation(async (id, after) => {
            await hold();
            return originalAfter(id, after);
          })
        : vi.spyOn(h.service, "getTimeline").mockImplementation(async (id) => {
            await hold();
            return original(id);
          });
    const res = new FakeResponse();
    const path = route === "v1" ? h.v1Path : "/conversations/c/events/stream";
    h.server.emit("request", fakeRequest(path), res.asResponse());
    cleanups.push(async () => void res.destroy());
    const content = () =>
      frames(res).filter((f) => f.event === (route === "v1" ? "turn" : "timeline"));
    await vi.waitFor(() => expect(content().length).toBeGreaterThan(0));
    const before = content().length;

    // New history exists; the next poll's read is held while a heartbeat fills the buffer.
    await post("second");
    res.allowance = 0;
    holdNext = true;
    vi.advanceTimersByTime(400);
    await vi.waitFor(() => expect(holding).toBe(true));
    vi.advanceTimersByTime(15_000);
    expect(res.text).toContain(": ping");
    release();
    await new Promise((r) => setTimeout(r, 50));
    // The frame was refused while blocked, not recorded as sent.
    expect(content()).toHaveLength(before);

    res.drain();
    if (route === "legacy") {
      await vi.waitFor(() => expect(content()).toHaveLength(before + 1));
      const last = content().at(-1)!.data.events as ChatTimelineEvent[];
      expect(last.some((e) => e.type === "user" && e.text === "second")).toBe(true);
      return;
    }
    const expected = (await original(reads.mock.calls[0][0]))
      .map((e) => projectTurnEvent(h.conversation, e))
      .filter((w) => w !== undefined)
      .map((w) => w.sequence);
    await vi.waitFor(() => expect(content().map((f) => f.id)).toEqual(expected));
  });

it("legacy: a buffered snapshot is not resent after drain, and new changes still arrive", async () => {
  const h = await setup(2);
  await h.postLegacy("c", "first");
  const reads = vi.spyOn(h.service, "getTimeline");
  const revisions = vi.spyOn(h.service, "timelineRevision");
  const res = new FakeResponse();
  res.allowance = 0; // the first snapshot is buffered but reports full
  h.server.emit("request", fakeRequest("/conversations/c/events/stream"), res.asResponse());
  cleanups.push(async () => void res.destroy());
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  const readsWhenBlocked = reads.mock.calls.length;
  const revisionsWhenBlocked = revisions.mock.calls.length;
  await new Promise((r) => setTimeout(r, 800));
  // Blocked: not even the revision is read.
  expect(reads.mock.calls.length).toBe(readsWhenBlocked);
  expect(revisions.mock.calls.length).toBe(revisionsWhenBlocked);
  expect(frames(res)).toHaveLength(1);
  // Each frame is one write, so a full buffer cannot split event from data.
  expect(res.chunks[0]).toMatch(/^event: timeline\ndata: \{"events":\[/);

  res.drain();
  // After drain the stream polls again. The buffered snapshot was accepted, so with
  // its revision unchanged it is neither copied again nor resent.
  await polls(revisions, 2);
  expect(reads.mock.calls.length).toBe(readsWhenBlocked);
  expect(frames(res)).toHaveLength(1);

  await h.postLegacy("c", "second");
  await vi.waitFor(() => expect(frames(res).length).toBeGreaterThan(1));
  const last = frames(res).at(-1)!.data.events as ChatTimelineEvent[];
  expect(last.some((e) => e.type === "user" && e.text === "second")).toBe(true);
});

it("never overlaps timeline reads for one stream when reads are slower than the poll", async () => {
  const h = await setup(2);
  await h.postV1("hello");
  const original = h.service.getTimeline.bind(h.service);
  let inFlight = 0,
    maxInFlight = 0;
  vi.spyOn(h.service, "getTimeline").mockImplementation(async (id) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 250));
    inFlight--;
    return original(id);
  });
  const res = h.fake(h.v1Path);
  const legacy = h.fake("/conversations/c/events/stream");
  await new Promise((r) => setTimeout(r, 1200));
  // Two streams, so at most one read each.
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(res.destroyed || legacy.destroyed).toBe(false);
});

it("disconnects a stream that stays blocked past the stall timeout and frees its slot", async () => {
  const h = await setup(1);
  await h.postLegacy("c", "first");
  const res = new FakeResponse();
  res.allowance = 0;
  h.server.emit("request", fakeRequest("/conversations/c/events/stream"), res.asResponse());
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  expect(res.destroyed).toBe(false);
  await vi.waitFor(() => expect(res.destroyed).toBe(true), { timeout: 2500 });
  expect(h.server.retentionStats().streams).toBe(0);
});

it("closeStreams releases every stream at once and destroys blocked ones", async () => {
  const h = await setup(3);
  await h.postLegacy("c", "first");
  const real = await h.open("/conversations/c/events/stream");
  const blocked = new FakeResponse();
  blocked.allowance = 0;
  h.server.emit("request", fakeRequest("/conversations/c/events/stream"), blocked.asResponse());
  await vi.waitFor(() => expect(frames(blocked)).toHaveLength(1));
  const reader = real.response.body!.getReader();
  await reader.read();
  h.server.closeStreams();
  expect(blocked.destroyed).toBe(true);
  await vi.waitFor(() => expect(h.server.retentionStats().streams).toBe(0));
  // The idle stream ended normally.
  let done = false;
  while (!done) done = (await reader.read()).done;
});

// Legacy polls with a revision-capable store: an unchanged revision is not copied.
const LEGACY = "/conversations/c/events/stream";

it("legacy: idle polls copy nothing, and a change is copied and sent once", async () => {
  const h = await setup(2);
  const append = owned(h, "c");
  await append("first");
  const reads = vi.spyOn(h.service, "getTimeline");
  const revisions = vi.spyOn(h.service, "timelineRevision");
  const res = h.fake(LEGACY);
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  // The pre-header read and the first snapshot.
  expect(reads).toHaveBeenCalledTimes(2);
  await polls(revisions, 2);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(frames(res)).toHaveLength(1);

  await append("second");
  await vi.waitFor(() => expect(frames(res)).toHaveLength(2));
  expect(reads).toHaveBeenCalledTimes(3);
  expect(frames(res).map(texts)).toEqual([["first"], ["first", "second"]]);
  await polls(revisions, 2);
  expect(reads).toHaveBeenCalledTimes(3);
  expect(frames(res)).toHaveLength(2);
});

it("legacy: an empty conversation still gets its first empty snapshot, then idles", async () => {
  const h = await setup(2);
  const reads = vi.spyOn(h.service, "getTimeline");
  const revisions = vi.spyOn(h.service, "timelineRevision");
  const res = h.fake("/conversations/empty/events/stream");
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  expect(frames(res)[0]).toEqual({ event: "timeline", data: { events: [] }, id: undefined });
  expect(reads).toHaveBeenCalledTimes(2);
  await polls(revisions, 2);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(frames(res)).toHaveLength(1);
});

it("legacy: an unchanged revision still ends the stream when another principal owns it", async () => {
  const other = scopedOwnerKey("local:other", ["u"]);
  for (const claimed of [false, true]) {
    const h = await setup(2);
    // Unclaimed and empty, or claimed by the test principal with one event.
    if (claimed) await owned(h, "c")("first");
    const reads = vi.spyOn(h.service, "getTimeline");
    const res = h.fake(LEGACY);
    await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
    // The owner changes; the timeline does not.
    vi.spyOn(h.service, "conversationOwner").mockImplementation((c) =>
      c === "c" ? other : undefined
    );
    await vi.waitFor(() => expect(res.writableEnded).toBe(true));
    expect(frames(res)).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(2);
  }
});

it("legacy: an unchanged revision still ends the stream as expired when the version changes", async () => {
  const h = await setup(2);
  await owned(h, "c")("first");
  const reads = vi.spyOn(h.service, "getTimeline");
  const res = h.fake(LEGACY);
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  // A retired id reused by new work, with the same sequence.
  vi.spyOn(h.service, "conversationVersion").mockReturnValue(Symbol("reused"));
  await vi.waitFor(() => expect(res.writableEnded).toBe(true));
  expect(frames(res).map((f) => f.event)).toEqual(["timeline", "conversation-expired"]);
  expect(frames(res)[1].data).toEqual({ code: "CONVERSATION_EXPIRED" });
  expect(reads).toHaveBeenCalledTimes(2);
});

it("legacy: an idle stream ends as expired when its history expires", async () => {
  let clock = Date.now();
  const store = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ idleTtlMs: 60_000 }),
    () => clock
  );
  const h = await setup(2, store);
  await owned(h, "c")("first");
  const reads = vi.spyOn(h.service, "getTimeline");
  const res = h.fake(LEGACY);
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  clock += 120_000;
  await vi.waitFor(() => expect(res.writableEnded).toBe(true));
  expect(frames(res).map((f) => f.event)).toEqual(["timeline", "conversation-expired"]);
  expect(reads).toHaveBeenCalledTimes(2);
});

it("legacy: an event appended after a snapshot was read is sent on the next poll", async () => {
  const h = await setup(2);
  const append = owned(h, "c");
  await append("first");
  const original = h.service.getTimeline.bind(h.service);
  let appendLate = false;
  vi.spyOn(h.service, "getTimeline").mockImplementation(async (id) => {
    const events = await original(id);
    if (appendLate) {
      appendLate = false;
      await append("late");
    }
    return events;
  });
  const revisions = vi.spyOn(h.service, "timelineRevision");
  const res = h.fake(LEGACY);
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  appendLate = true;
  await append("second");
  // The accepted revision is the delivered snapshot's last sequence, not a re-read.
  await vi.waitFor(() => expect(frames(res)).toHaveLength(3));
  expect(frames(res).map(texts)).toEqual([
    ["first"],
    ["first", "second"],
    ["first", "second", "late"]
  ]);
  await polls(revisions, 2);
  expect(frames(res)).toHaveLength(3);
});

it("legacy: a store without a revision keeps exactly one full read per poll", async () => {
  const backing = new InMemoryConversationTimelineStore();
  const getEvents = vi.fn((id: string) => backing.getEvents(id));
  const plain: ConversationTimelineStore = {
    appendEvent: (id, e) => backing.appendEvent(id, e),
    getEvents
  };
  const h = await setup(2, plain);
  const append = owned(h, "c");
  await append("first");
  const revisions = vi.spyOn(h.service, "timelineRevision");
  const res = h.fake(LEGACY);
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  await polls(revisions, 3);
  expect(revisions.mock.results.every((r) => r.value === undefined)).toBe(true);
  // One per poll plus the pre-header read; never a second read for a revision.
  expect(getEvents.mock.calls.length).toBe(revisions.mock.calls.length + 1);
  // Unchanged content is still not resent, and a change still arrives once.
  expect(frames(res)).toHaveLength(1);
  await append("second");
  await vi.waitFor(() => expect(frames(res)).toHaveLength(2));
  expect(frames(res).map(texts)).toEqual([["first"], ["first", "second"]]);
  await polls(revisions, 2);
  expect(frames(res)).toHaveLength(2);
  expect(getEvents.mock.calls.length).toBe(revisions.mock.calls.length + 1);
});

it.each([
  ["missing", undefined],
  ["zero", 0],
  ["not a number", Number.NaN]
])(
  "legacy: a revision store whose snapshot's last sequence is %s compares content instead",
  async (_label, bad) => {
    const backing = new InMemoryConversationTimelineStore();
    // Nonempty snapshots whose last event has no usable sequence.
    const getEvents = vi.fn(async (id: string) => {
      const events = await backing.getEvents(id);
      if (events.length) {
        const { sequence: _sequence, ...rest } = events[events.length - 1];
        events[events.length - 1] = bad === undefined ? rest : { ...rest, sequence: bad };
      }
      return events;
    });
    const store: ConversationTimelineStore = {
      appendEvent: (id, e) => backing.appendEvent(id, e),
      getEvents,
      lastSequence: (id) => backing.lastSequence(id)
    };
    const h = await setup(2, store);
    const append = owned(h, "c");
    await append("first");
    const revisions = vi.spyOn(h.service, "timelineRevision");
    const res = h.fake(LEGACY);
    await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
    await polls(revisions, 3);
    // The revision is available and unchanged, but no snapshot sequence was accepted:
    // every poll reads in full, and unchanged content is not resent.
    expect(revisions.mock.results.at(-1)?.value).toBe(1);
    expect(getEvents.mock.calls.length).toBe(revisions.mock.calls.length + 1);
    expect(frames(res)).toHaveLength(1);

    await append("second");
    await vi.waitFor(() => expect(frames(res)).toHaveLength(2));
    expect(frames(res).map(texts)).toEqual([["first"], ["first", "second"]]);
    await polls(revisions, 2);
    expect(frames(res)).toHaveLength(2);
  }
);
