import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import {
  conversationRetentionSchema,
  loadConversationRetention
} from "../../src/config/conversationRetention";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import { InMemorySourceStore } from "../../src/app/sourceStore";
import { InMemorySummaryStore } from "../../src/app/summaryStore";
import { ContextManager } from "../../src/app/contextManager";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { createChatServer } from "../../src/server";
import type { AddressInfo } from "node:net";
import { allowAllTestAuth } from "../helpers/testAuth";
const event = (id = "m") => ({
  type: "user" as const,
  text: "hello",
  messageId: id,
  createdAtIso: new Date().toISOString()
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});
function setup(overrides = {}, deep = new MockDeepProvider()) {
  let now = 0;
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({
      maxIdentities: 4,
      maxHistories: 2,
      idleTtlMs: 10,
      ...overrides
    }),
    () => now
  );
  const queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore();
  const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
  const service = new ChatService(
    orchestrator,
    new DeepWorker(queue, deep, timeline, 2, dead),
    timeline,
    queue,
    dead
  );
  const message = (id = "m", conversationId = "c") => ({
    messageId: id,
    conversationId,
    userId: "u",
    text: "Hello",
    timestampIso: new Date().toISOString()
  });
  return {
    timeline,
    queue,
    dead,
    service,
    orchestrator,
    message,
    advance: (n: number) => {
      now += n;
    }
  };
}
it("expires history without making identities available for reuse; reads do not extend TTL", async () => {
  const r = setup();
  await r.service.submitMessage(r.message());
  r.advance(9);
  expect((await r.timeline.getEvents("c")).length).toBeGreaterThan(0);
  r.advance(1);
  await expect(r.timeline.getEvents("c")).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
  expect(r.timeline.retentionStats()).toMatchObject({
    identities: 1,
    histories: 0,
    events: 0,
    bytes: 0,
    pins: 0
  });
  await expect(r.service.submitMessage(r.message())).rejects.toMatchObject({
    code: "CONVERSATION_EXPIRED"
  });
  await expect(
    r.service.submitMessage({ ...r.message("other"), userId: "intruder" })
  ).rejects.toMatchObject({ code: "CONVERSATION_OWNER_MISMATCH" });
  expect(() => r.service.claimConversation("c", "intruder", false)).toThrow();
});
it("bounds history and tombstones independently and preserves existing owners at capacity", async () => {
  const r = setup({ maxIdentities: 3, maxHistories: 1 });
  for (let n = 0; n < 3; n++) await r.service.submitMessage(r.message("m", `c${n}`));
  expect(r.timeline.retentionStats()).toMatchObject({
    identities: 3,
    histories: 1,
    expired: 2,
    pins: 0
  });
  expect(r.service.conversationRetentionStats()).toEqual({ owners: 3, scopes: 0 });
  await expect(r.service.submitMessage(r.message("m", "extra"))).rejects.toMatchObject({
    code: "CONVERSATION_CAPACITY"
  });
  await expect(r.service.submitMessage(r.message("next", "c2"))).resolves.toBeDefined();
});
it("keeps a held submission and queued/physically-running task protected across TTL and pressure", async () => {
  const r = setup({ maxHistories: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = r.orchestrator.handleUserMessage.bind(r.orchestrator);
  vi.spyOn(r.orchestrator, "handleUserMessage").mockImplementation(async (m) => {
    await held;
    return original(m);
  });
  const submission = r.service.submitMessage(r.message());
  await Promise.resolve();
  r.advance(100);
  await expect(r.service.submitMessage(r.message("m", "other"))).rejects.toMatchObject({
    code: "CONVERSATION_CAPACITY"
  });
  release();
  await submission;
  const lifecycle = generationLifecycle(r.queue);
  const attempt = lifecycle.create("c", "background", "deep", r.timeline, "task");
  r.advance(100);
  expect((await r.timeline.getEvents("c")).length).toBeGreaterThan(0);
  await attempt.finish("cancelled");
  r.advance(100);
  expect(r.timeline.retentionStats().histories).toBe(1);
  lifecycle.releaseTask("task");
  r.advance(10);
  await expect(r.timeline.getEvents("c")).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
});
it("holds history until delayed terminal writes settle, including failed writes", async () => {
  const r = setup();
  const lifecycle = generationLifecycle(r.queue);
  const attempt = lifecycle.create("c", "m", "fast", r.timeline);
  let reject!: (e: Error) => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(r.timeline, "appendEvent").mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
        started();
      })
  );
  const finish = attempt.finish("error");
  const checked = expect(finish).rejects.toThrow("disk");
  await writing;
  r.advance(100);
  expect(r.timeline.retentionStats().histories).toBe(1);
  reject(new Error("disk"));
  await checked;
  expect(r.timeline.retentionStats().pins).toBe(0);
  r.advance(10);
  expect(r.timeline.retentionStats().histories).toBe(0);
});
it("rejects expired replay and restores the dead letter without creating a task pin", async () => {
  const r = setup();
  await r.service.submitMessage(r.message());
  const record = {
    task: {
      taskId: "task",
      conversationId: "c",
      userId: "u",
      messageId: "m",
      originalText: "q",
      createdAtIso: new Date().toISOString()
    } as any,
    errorMessage: "failed",
    failedAtIso: new Date().toISOString()
  };
  await r.dead.add(record);
  r.advance(10);
  await expect(r.service.replayDeadLetter("task")).rejects.toMatchObject({
    code: "CONVERSATION_EXPIRED"
  });
  expect(await r.dead.list()).toHaveLength(1);
  expect(generationLifecycle(r.queue).retentionStats().tasks).toBe(0);
  expect(r.timeline.retentionStats().pins).toBe(0);
});
it("rejects append overflow atomically and never evicts pinned events", async () => {
  const r = setup({ maxEvents: 1 });
  const release = r.timeline.retainConversation("c");
  await r.timeline.appendEvent("c", event());
  const before = await r.timeline.getEvents("c");
  await expect(r.timeline.appendEvent("c", event("2"))).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  expect(await r.timeline.getEvents("c")).toEqual(before);
  release();
  const small = setup({ maxBytes: 1 });
  await expect(small.timeline.appendEvent("c", event())).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  expect(small.timeline.retentionStats()).toMatchObject({ events: 0, bytes: 0 });
});
it("cleans scopes, summary memory and source identity indexes on expiry", async () => {
  const r = setup();
  const scoped = r.service.openScopedConversation("u", {
    path: ["sports"],
    entity: { provider: "fixture", id: "team", name: "Team" },
    reference: null
  });
  expect(r.service.conversationRetentionStats().scopes).toBe(1);
  const sources = new InMemorySourceStore(),
    summaries = new InMemorySummaryStore();
  const sourceCleanup = vi.spyOn(sources, "forgetConversation"),
    summaryCleanup = vi.spyOn(summaries, "forgetConversation");
  const manager = new ContextManager(r.timeline, loadContextBudgetConfigFromEnv({}), {
    sourceStore: sources,
    summaryStore: summaries
  });
  await r.service.submitMessage(r.message());
  const snapshot = sources.capture("c", await r.timeline.getEvents("c"));
  expect(snapshot.records.length).toBeGreaterThan(0);
  r.advance(10);
  r.timeline.retentionStats();
  expect(r.service.conversationRetentionStats().scopes).toBe(0);
  expect(() => r.service.getSelectedContext(scoped.conversationId, "u")).toThrow(
    "CONVERSATION_EXPIRED"
  );
  expect(sourceCleanup).toHaveBeenCalledWith("c");
  expect(summaryCleanup).toHaveBeenCalledWith("c");
  expect(sources.resolve(snapshot.records[0].source, snapshot)).toBeUndefined();
  await manager.shutdown();
});
it("returns explicit HTTP expiry and capacity errors", async () => {
  const r = setup({ maxIdentities: 1, maxHistories: 1 });
  const server = createChatServer(r.service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await r.service.submitMessage(r.message());
  r.advance(10);
  for (const path of ["/conversations/c/events", "/conversations/c/events/stream"]) {
    const response = await fetch(base + path);
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe("CONVERSATION_EXPIRED");
  }
  const response = await fetch(base + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...r.message(randomUUID(), "other"), text: "hello" })
  });
  expect(response.status).toBe(503);
  await response.text();
});
it("validates manual retention configuration", () => {
  expect(() => loadConversationRetention({ CONVERSATION_MAX_BYTES: "0" })).toThrow();
  expect(() =>
    loadConversationRetention({ CONVERSATION_MAX_IDENTITIES: "2", CONVERSATION_MAX_HISTORIES: "3" })
  ).toThrow();
  expect(loadConversationRetention({ CONVERSATION_MAX_EVENTS: "12" }).maxEvents).toBe(12);
});

it("protects actual queued and cancelled-but-draining deep work until worker cleanup", async () => {
  const deep = new MockDeepProvider();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(deep, "resolveDeepTask").mockImplementation(async (task) => {
    started();
    await held;
    return {
      taskId: task.taskId,
      finalReply: "late",
      confidence: 1,
      citations: [],
      totalLatencyMs: 0,
      finishReason: "stop"
    };
  });
  const r = setup({ maxHistories: 1 }, deep);
  const result = await r.service.submitMessage({
    ...r.message(),
    text: "What is the latest news?"
  });
  expect(result.deepTask).toBeDefined();
  r.advance(100);
  await expect(r.service.submitMessage(r.message("m", "new"))).rejects.toMatchObject({
    code: "CONVERSATION_CAPACITY"
  });
  const work = r.service.runDeepWorkerOnce();
  await entered;
  await r.service.cancelMessage("c", "m");
  r.advance(100);
  expect(r.timeline.retentionStats().histories).toBe(1);
  release();
  await work;
  expect(r.timeline.retentionStats().pins).toBe(0);
  expect(
    (await r.timeline.getEvents("c")).some((e) => e.type === "refined" && e.text === "late")
  ).toBe(false);
  r.advance(10);
  expect(r.timeline.retentionStats().histories).toBe(0);
});
it("releases leases after submission preparation fails before a generation exists", async () => {
  const r = setup();
  vi.spyOn(r.orchestrator, "handleUserMessage").mockRejectedValueOnce(new Error("prepare failed"));
  await expect(r.service.submitMessage(r.message())).rejects.toThrow("prepare failed");
  expect(r.timeline.retentionStats().pins).toBe(0);
  r.advance(10);
  expect(r.timeline.retentionStats().histories).toBe(0);
});
it("releases generation and submission leases when history fills during generation setup", async () => {
  const r = setup({ maxEvents: 1, maxHistories: 1 });
  await expect(r.service.submitMessage(r.message())).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  expect(r.timeline.retentionStats()).toMatchObject({ pins: 0, events: 2 });
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
  // Pressure can now retire the failed conversation; failure did not strand its lease.
  r.service.claimConversation("replacement", "u");
  await expect(r.timeline.getEvents("c")).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
});

it.each([6, 7, 8])(
  "publishes bounded failure and preserves dead letters when deep history fills at %i events",
  async (maxEvents) => {
    const r = setup({ maxEvents });
    await r.service.submitMessage({ ...r.message(), text: "What is the latest news?" });
    await expect(r.service.runDeepWorkerOnce()).rejects.toMatchObject({
      code: "CONVERSATION_HISTORY_CAPACITY"
    });
    const events = await r.timeline.getEvents("c");
    expect(events.find((e) => e.type === "terminal" && e.phase === "deep")).toMatchObject({
      finishReason: "error",
      errorCode: "CONVERSATION_HISTORY_CAPACITY"
    });
    expect(await r.dead.list()).toHaveLength(1);
    expect(r.timeline.retentionStats().pins).toBe(0);
    expect(events.length).toBeLessThanOrEqual(maxEvents * 2);
  }
);
it("bounds emergency terminal reservations and handles byte overflow", async () => {
  const r = setup({ maxBytes: 1, maxEvents: 2 });
  const lifecycle = generationLifecycle(r.queue);
  const attempt = lifecycle.create("c", "m", "fast", r.timeline);
  await expect(attempt.start(r.timeline)).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  await expect(attempt.finish("error")).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  expect(await r.timeline.getEvents("c")).toHaveLength(1);
  const second = lifecycle.create("c", "n", "fast", r.timeline);
  await expect(second.finish("cancelled")).rejects.toMatchObject({
    code: "CONVERSATION_HISTORY_CAPACITY"
  });
  expect(() => lifecycle.create("c", "o", "fast", r.timeline)).toThrow(
    "CONVERSATION_HISTORY_CAPACITY"
  );
  expect(r.timeline.retentionStats()).toMatchObject({ pins: 0, events: 2 });
  expect(r.timeline.retentionStats().bytes).toBeLessThanOrEqual(2048);
});
it("does not allocate identities for invalid streams or unknown cancellation", async () => {
  const r = setup({ maxIdentities: 1, maxHistories: 1 });
  const server = createChatServer(r.service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/conversations`;
  for (const [suffix, method, status] of [
    ["events/stream?accountId=a&projectId=p&afterSequence=bad", "GET", 400],
    ["events/stream?accountId=a&projectId=p&afterSequence=1", "GET", 409],
    ["events/stream?accountId=a&projectId=p&runtimeId=old", "GET", 409],
    [`messages/${randomUUID()}/cancel?accountId=a&projectId=p`, "POST", 404]
  ] as const) {
    const response = await fetch(`${base}/${randomUUID()}/${suffix}`, { method });
    expect(response.status).toBe(status);
    await response.text();
  }
  const abandoned = await fetch(`${base}/${randomUUID()}/events/stream?accountId=a&projectId=p`);
  expect(abandoned.status).toBe(200);
  await abandoned.body!.cancel();
  const response = await fetch(`${base}/${randomUUID()}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "1.0",
      accountId: "a",
      projectId: "p",
      messageId: randomUUID(),
      text: "hello",
      clientTimestampIso: new Date().toISOString()
    })
  });
  expect(response.status).toBe(200);
  await response.text();
});
it("tells an open legacy stream why it ends when its history expires", async () => {
  const r = setup();
  const server = createChatServer(r.service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await r.service.submitMessage(r.message());
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/conversations/c/events/stream`
  );
  const reader = response.body!.getReader();
  let received = "";
  const readUntil = async (marker: string) => {
    while (!received.includes(marker)) {
      const part = await reader.read();
      if (part.done) throw new Error("stream ended before " + marker);
      received += Buffer.from(part.value).toString();
    }
  };
  await readUntil("event: timeline");
  r.advance(10);
  await readUntil('event: conversation-expired\ndata: {"code":"CONVERSATION_EXPIRED"}');
  expect((await reader.read()).done).toBe(true);
  await vi.waitFor(() => expect(server.retentionStats().streams).toBe(0));
});
