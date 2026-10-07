import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { projectTurnEvent } from "../../src/app/protocolV1";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { ContextManager } from "../../src/app/contextManager";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { GenerationError } from "../../src/domain/generation";
import type { ChatTimelineEvent } from "../../src/domain/types";
import { FakeResponse, fakeRequest, frames } from "../helpers/fakeResponse";
import { allowAllTestAuth } from "../helpers/testAuth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(maxEventStreams = 2) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
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
  return { server, service, base, conversation, v1Path, postV1, postLegacy, open, fake };
}

it("shares one stream limit across legacy and v1 routes and refuses before any stream work", async () => {
  const h = await setup(2);
  const legacy = await h.open("/conversations/c1/events/stream");
  const v1 = await h.open(h.v1Path);
  expect(legacy.response.status).toBe(200);
  expect(v1.response.status).toBe(200);
  expect(h.server.retentionStats().streams).toBe(2);

  const reads = vi.spyOn(h.service, "getTimeline");
  const afterReads = vi.spyOn(h.service, "getTimelineAfter");
  const before = reads.mock.calls.length + afterReads.mock.calls.length;
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
  expect(reads.mock.calls.length + afterReads.mock.calls.length).toBe(before);
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
  const internalId = reads.mock.calls[0][0];
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
  const res = new FakeResponse();
  res.allowance = 0; // the first snapshot is buffered but reports full
  h.server.emit("request", fakeRequest("/conversations/c/events/stream"), res.asResponse());
  cleanups.push(async () => void res.destroy());
  await vi.waitFor(() => expect(frames(res)).toHaveLength(1));
  const readsWhenBlocked = reads.mock.calls.length;
  await new Promise((r) => setTimeout(r, 800));
  expect(reads.mock.calls.length).toBe(readsWhenBlocked);
  expect(frames(res)).toHaveLength(1);
  // Each frame is one write, so a full buffer cannot split event from data.
  expect(res.chunks[0]).toMatch(/^event: timeline\ndata: \{"events":\[/);

  res.drain();
  await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(readsWhenBlocked));
  await new Promise((r) => setTimeout(r, 400));
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
