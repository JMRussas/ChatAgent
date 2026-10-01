import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import {
  deadLetterRetentionSchema,
  loadDeadLetterRetention
} from "../../src/config/deadLetterRetention";
import { GenerationError } from "../../src/domain/generation";
import type { DeepResult, DeepTask } from "../../src/domain/types";
import { InMemoryTaskQueue, type DeepModelProvider } from "../../src/providers/interfaces";
import { MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { entry, message as dispatchMessage, runtime } from "../helpers/dispatchFixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const task = (taskId: string, normalizedPrompt = "q"): DeepTask => ({
  taskId,
  messageId: taskId,
  conversationId: "c",
  normalizedPrompt,
  createdAtIso: new Date().toISOString()
});
const record = (taskId: string) => ({
  task: task(taskId),
  errorMessage: "failed",
  failedAtIso: new Date().toISOString()
});
const done = (input: DeepTask): DeepResult => ({
  taskId: input.taskId,
  finalReply: "done",
  finishReason: "stop",
  confidence: 1,
  citations: [],
  totalLatencyMs: 0
});
function setup(limits: { maxRecords?: number; maxBytes?: number } = {}, maxRetries = 0) {
  let failure: GenerationError | undefined = new GenerationError("PROVIDER_AUTH", false);
  const deep: DeepModelProvider = {
    resolveDeepTask: vi.fn(async (input) => {
      if (failure) throw failure;
      return done(input);
    })
  };
  const timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore(
      deadLetterRetentionSchema.parse({ maxRecords: 2, ...limits })
    );
  const orchestrator = new ChatOrchestrator(
    new MockFastProvider(),
    queue,
    timeline,
    undefined,
    undefined,
    undefined,
    undefined,
    dead
  );
  const service = new ChatService(
    orchestrator,
    new DeepWorker(queue, deep, timeline, maxRetries, dead),
    timeline,
    queue,
    dead
  );
  const message = (messageId: string, text = "What is the latest news?") => ({
    messageId,
    conversationId: "c",
    userId: "u",
    text,
    timestampIso: new Date().toISOString()
  });
  const fail = async (messageId: string) => {
    const response = await service.submitMessage(message(messageId));
    await service.runDeepWorkerOnce();
    return response.deepTask!.taskId;
  };
  return {
    timeline,
    queue,
    dead,
    deep,
    service,
    message,
    fail,
    lifecycle: generationLifecycle(queue),
    failWith: (next?: GenerationError) => {
      failure = next;
    }
  };
}

it("bounds records plus reservations by count and bytes without evicting", async () => {
  const dead = new InMemoryDeadLetterStore({ maxRecords: 2, maxBytes: 16777216 });
  dead.reserve(task("a"));
  dead.reserve(task("a"));
  await dead.add(record("b"));
  expect(dead.retentionStats()).toMatchObject({ records: 1, reservations: 1 });
  expect(() => dead.reserve(task("c"))).toThrow("DEAD_LETTER_CAPACITY");
  await expect(dead.add(record("c"))).rejects.toMatchObject({ code: "DEAD_LETTER_CAPACITY" });
  expect((await dead.list()).map((r) => r.task.taskId)).toEqual(["b"]);
  await dead.add(record("a"));
  dead.release("a");
  await dead.add({ ...record("a"), errorMessage: "again" });
  expect((await dead.list()).map((r) => r.errorMessage)).toEqual(["failed", "again"]);
  expect(dead.retentionStats()).toMatchObject({ records: 2, reservations: 0, reservedBytes: 0 });
  expect(await dead.claim("a")).toMatchObject({ errorMessage: "again" });
  expect(() => dead.reserve(task("c"))).toThrow("DEAD_LETTER_CAPACITY");
  dead.release("a");
  expect(await dead.remove("b")).toBeDefined();
  expect(dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, bytes: 0 });

  const bytes = Buffer.byteLength(JSON.stringify(task("a", "x".repeat(100))));
  const small = new InMemoryDeadLetterStore({ maxRecords: 10, maxBytes: bytes * 2 - 1 });
  small.reserve(task("a", "x".repeat(100)));
  expect(() => small.reserve(task("b", "x".repeat(100)))).toThrow("DEAD_LETTER_CAPACITY");
  await small.add({ ...record("a"), task: task("a", "x".repeat(100)) });
  expect(small.retentionStats()).toMatchObject({ bytes, reservedBytes: 0 });
  await expect(
    small.add({ ...record("b"), task: task("b", "x".repeat(100)) })
  ).rejects.toMatchObject({ code: "DEAD_LETTER_CAPACITY" });
});

it("validates manual dead-letter configuration", () => {
  expect(loadDeadLetterRetention({})).toEqual({ maxRecords: 100, maxBytes: 16777216 });
  expect(loadDeadLetterRetention({ DEAD_LETTER_MAX_RECORDS: "3" }).maxRecords).toBe(3);
  expect(() => loadDeadLetterRetention({ DEAD_LETTER_MAX_RECORDS: "0" })).toThrow();
  expect(() => loadDeadLetterRetention({ DEAD_LETTER_MAX_BYTES: "1.5" })).toThrow();
  expect(() => loadDeadLetterRetention({ DEAD_LETTER_MAX_BYTES: "many" })).toThrow();
});

it("rejects deep admission at capacity before the user event and keeps the message ID reusable", async () => {
  const r = setup();
  const first = await r.fail("m1");
  await r.fail("m2");
  const before = await r.timeline.getEvents("c");
  await expect(r.service.submitMessage(r.message("m3"))).rejects.toMatchObject({
    code: "DEAD_LETTER_CAPACITY"
  });
  expect(await r.timeline.getEvents("c")).toEqual(before);
  expect(r.queue.size()).toBe(0);
  expect(r.lifecycle.retentionStats()).toMatchObject({ claimed: 2, consumers: 0, tasks: 0 });
  expect((await r.service.listDeadLetters()).map((d) => d.errorMessage)).toEqual([
    "PROVIDER_AUTH",
    "PROVIDER_AUTH"
  ]);
  // Direct turns need no failure room and continue under dead-letter pressure.
  await expect(r.service.submitMessage(r.message("direct", "Hello"))).resolves.toBeDefined();
  expect(await r.service.discardDeadLetter(first)).toBe(true);
  expect(await r.service.discardDeadLetter(first)).toBe(false);
  expect((await r.service.submitMessage(r.message("m3"))).deepTask).toBeDefined();
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 1 });
});

it("holds a slot for queued and running deep work and frees it on success", async () => {
  const r = setup();
  r.failWith(undefined);
  await r.service.submitMessage(r.message("m1"));
  await r.service.submitMessage(r.message("m2"));
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 2 });
  await expect(r.service.submitMessage(r.message("m3"))).rejects.toMatchObject({
    code: "DEAD_LETTER_CAPACITY"
  });
  expect((await r.service.runDeepWorkerOnce())?.finalReply).toBe("done");
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 1 });
  await expect(r.service.submitMessage(r.message("m3"))).resolves.toBeDefined();
  await r.service.runDeepWorkerOnce();
  await r.service.runDeepWorkerOnce();
  expect(r.dead.retentionStats()).toMatchObject({ reservations: 0, bytes: 0, reservedBytes: 0 });
});

it("keeps the slot of a replayed record so a failed replay is restored at capacity", async () => {
  const r = setup({ maxRecords: 1 });
  const taskId = await r.fail("m1");
  vi.spyOn(r.queue, "enqueue").mockImplementationOnce(async () => {
    // The record is out of the store here; a competing admission must not take its slot.
    await expect(r.service.submitMessage(r.message("m2"))).rejects.toMatchObject({
      code: "DEAD_LETTER_CAPACITY"
    });
    throw Error("QUEUE_FAILED");
  });
  await expect(r.service.replayDeadLetter(taskId)).rejects.toThrow("QUEUE_FAILED");
  expect((await r.service.listDeadLetters()).map((d) => d.task.taskId)).toEqual([taskId]);
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });

  expect(await r.service.replayDeadLetter(taskId)).toBe(true);
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 1 });
  await expect(r.service.submitMessage(r.message("m2"))).rejects.toMatchObject({
    code: "DEAD_LETTER_CAPACITY"
  });
  await r.service.runDeepWorkerOnce();
  expect((await r.service.listDeadLetters()).map((d) => d.task.taskId)).toEqual([taskId]);

  r.failWith(undefined);
  expect(await r.service.replayDeadLetter(taskId)).toBe(true);
  expect((await r.service.runDeepWorkerOnce())?.finalReply).toBe("done");
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, bytes: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("keeps one slot across a queued retry and leaves one record after the final failure", async () => {
  const r = setup({ maxRecords: 1 }, 1);
  r.failWith(new GenerationError("PROVIDER_UNAVAILABLE", true));
  await r.service.submitMessage(r.message("m1"));
  await r.service.runDeepWorkerOnce();
  expect(r.queue.size()).toBe(1);
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 1 });
  await r.service.runDeepWorkerOnce();
  expect(r.deep.resolveDeepTask).toHaveBeenCalledTimes(2);
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("frees slots for cancelled, discarded and cancelled-replay work", async () => {
  const r = setup();
  await r.service.submitMessage(r.message("cancelled"));
  await r.service.cancelMessage("c", "cancelled");
  expect(r.dead.retentionStats().reservations).toBe(1);
  await r.service.runDeepWorkerOnce();
  expect(r.deep.resolveDeepTask).not.toHaveBeenCalled();
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0 });

  // A record whose message was cancelled is dropped by replay, as before; its slot is freed.
  await r.dead.add({ ...record("old"), task: { ...task("old"), messageId: "cancelled" } });
  expect(await r.service.replayDeadLetter("old")).toBe(false);
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0 });

  await r.service.submitMessage(r.message("pending-1"));
  await r.service.submitMessage(r.message("pending-2"));
  await r.service.cancelRemaining();
  await r.service.discardPending();
  await r.service.whenIdle();
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, reservedBytes: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("frees the slot when an admitted turn fails before its task is queued", async () => {
  const r = setup({ maxRecords: 1 });
  vi.spyOn(r.queue, "enqueue").mockRejectedValueOnce(Error("QUEUE_FAILED"));
  await expect(r.service.submitMessage(r.message("m1"))).rejects.toThrow("QUEUE_FAILED");
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, reservedBytes: 0 });
  vi.spyOn(r.timeline, "appendEvent").mockRejectedValueOnce(Error("WRITE_FAILED"));
  await expect(r.service.submitMessage(r.message("m2"))).rejects.toThrow("WRITE_FAILED");
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, reservedBytes: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("keeps the record when a failure terminal write fails", async () => {
  const r = setup({ maxRecords: 1 });
  await r.service.submitMessage(r.message("m1"));
  const append = r.timeline.appendEvent.bind(r.timeline);
  vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (c, e) => {
    if (e.phase === "deep" && e.type === "terminal") throw Error("WRITE_FAILED");
    await append(c, e);
  });
  await expect(r.service.runDeepWorkerOnce()).rejects.toThrow("WRITE_FAILED");
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("plateaus across repeated failures with explicit discard", async () => {
  const r = setup({ maxRecords: 1 });
  for (let n = 0; n < 50; n++) {
    const taskId = await r.fail(`m${n}`);
    expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
    expect(await r.service.discardDeadLetter(taskId)).toBe(true);
  }
  expect(r.dead.retentionStats()).toMatchObject({
    records: 0,
    reservations: 0,
    bytes: 0,
    reservedBytes: 0
  });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("releases catalog dispatch reservations when dead-letter capacity rejects a turn", async () => {
  vi.stubEnv("DEAD_LETTER_MAX_RECORDS", "1");
  const r = runtime([entry("a")], {
    a: {
      deep: {
        resolveDeepTask: async () => {
          throw new GenerationError("PROVIDER_AUTH", false);
        }
      }
    }
  });
  try {
    await r.service.submitMessage(dispatchMessage("Find latest news", "first"));
    await r.service.runDeepWorkerOnce();
    const phases = r.dispatch.retentionStats().phases;
    await expect(
      r.service.submitMessage(dispatchMessage("Find latest news", "second"))
    ).rejects.toMatchObject({ code: "DEAD_LETTER_CAPACITY" });
    expect(r.dispatch.admission.snapshot().some((c) => c.status === "reserved")).toBe(false);
    expect(r.dispatch.retentionStats().phases).toBeLessThanOrEqual(phases + 2);
    expect(r.calls.get("a")!.fast.createProvisionalReply).toHaveBeenCalledTimes(1);
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
    expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
  } finally {
    await r.manager.shutdown();
  }
});

it("returns explicit HTTP capacity, discard and capacity-inspection responses", async () => {
  const r = setup({ maxRecords: 1 });
  const taskId = await r.fail("m1");
  const server = createChatServer(r.service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = JSON.stringify(r.message(randomUUID()));
  const submit = () =>
    fetch(base + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
  const rejected = await submit();
  expect(rejected.status).toBe(503);
  expect((await rejected.json()).code).toBe("DEAD_LETTER_CAPACITY");
  const listed = await (await fetch(base + "/workers/deep/dead-letters")).json();
  expect(listed.records).toHaveLength(1);
  expect(listed.capacity).toMatchObject({ records: 1, reservations: 0, maxRecords: 1 });
  const path = `${base}/workers/deep/dead-letters/${taskId}`;
  const discarded = await fetch(path, { method: "DELETE" });
  expect(discarded.status).toBe(200);
  expect(await discarded.json()).toEqual({ discarded: true, taskId });
  const missing = await fetch(path, { method: "DELETE" });
  expect(missing.status).toBe(404);
  await missing.text();
  const accepted = await submit();
  expect(accepted.status).toBe(200);
  await accepted.text();
});

it("owns reserved task snapshots even when provider and replay copies grow", async () => {
  const dead = new InMemoryDeadLetterStore({ maxRecords: 1, maxBytes: 512 });
  const original = task("a");
  const snapshot = structuredClone(original);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  dead.reserve(original);
  original.normalizedPrompt = "x".repeat(1000000);
  await dead.add({ ...record("a"), task: original });
  expect((await dead.list())[0].task).toEqual(snapshot);
  expect(dead.retentionStats()).toMatchObject({ bytes, reservedBytes: 0 });
  const replay = (await dead.claim("a"))!;
  replay.task.normalizedPrompt = "y".repeat(1000000);
  await dead.add(replay);
  expect((await dead.list())[0].task).toEqual(snapshot);
  expect(dead.retentionStats()).toMatchObject({ records: 1, reservations: 0, bytes });
});

it("defensively copies added records and list results", async () => {
  const dead = new InMemoryDeadLetterStore({ maxRecords: 1, maxBytes: 512 });
  const input = record("a");
  const snapshot = structuredClone(input);
  await dead.add(input);
  input.task.normalizedPrompt = "changed";
  input.errorMessage = "changed";
  const listed = await dead.list();
  listed[0].task.normalizedPrompt = "x".repeat(1000000);
  listed[0].errorMessage = "changed again";
  expect(await dead.list()).toEqual([snapshot]);
});

it("accounts for replacement growth and shrinkage and rejects overflow atomically", async () => {
  const dead = new InMemoryDeadLetterStore({ maxRecords: 2, maxBytes: 512 });
  await dead.add(record("a"));
  dead.reserve(task("b"));
  const before = dead.retentionStats();
  await expect(
    dead.add({ ...record("a"), task: task("a", "x".repeat(1000000)) })
  ).rejects.toMatchObject({ code: "DEAD_LETTER_CAPACITY" });
  expect(dead.retentionStats()).toEqual(before);
  expect((await dead.list())[0].task.normalizedPrompt).toBe("q");
  const larger = { ...record("a"), task: task("a", "x".repeat(50)) };
  await dead.add(larger);
  expect(dead.retentionStats().bytes).toBe(Buffer.byteLength(JSON.stringify(larger.task)));
  const smaller = record("a");
  await dead.add(smaller);
  expect(dead.retentionStats().bytes).toBe(Buffer.byteLength(JSON.stringify(smaller.task)));
  await dead.add(record("b"));
  expect(dead.retentionStats()).toMatchObject({ records: 2, reservations: 0 });
});
