import { afterEach, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ContextManager } from "../../src/app/contextManager";
import type { ContextSummarizer } from "../../src/app/contextSummarizer";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import { deadLetterRetentionSchema } from "../../src/config/deadLetterRetention";
import { loadSummaryConfig } from "../../src/config/summaryConfig";
import { GenerationError } from "../../src/domain/generation";
import type { DeepTask } from "../../src/domain/types";
import { InMemoryTaskQueue, type DeepModelProvider } from "../../src/providers/interfaces";
import { MockFastProvider } from "../../src/providers/mockProviders";

const managers: ContextManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.shutdown()));
  vi.restoreAllMocks();
});
const task = (taskId: string): DeepTask => ({
  taskId,
  messageId: taskId,
  conversationId: "c",
  normalizedPrompt: "q",
  createdAtIso: new Date().toISOString()
});
function setup(maxRecords = 2) {
  const deep: DeepModelProvider = {
    resolveDeepTask: vi.fn(async () => {
      throw new GenerationError("PROVIDER_AUTH", false);
    })
  };
  const timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore(deadLetterRetentionSchema.parse({ maxRecords }));
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
    new DeepWorker(queue, deep, timeline, 0, dead),
    timeline,
    queue,
    dead
  );
  return { timeline, queue, dead, deep, service, lifecycle: generationLifecycle(queue) };
}

it("direct enqueues below queue capacity hold no slot, lease or task pin until dequeued", async () => {
  const r = setup(1);
  for (const id of ["a", "b", "c"]) await r.queue.enqueue(task(id));
  expect(r.queue.size()).toBe(3);
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ turns: 0, consumers: 0, tasks: 0 });
  expect(r.timeline.retentionStats()).toMatchObject({ identities: 0, pins: 0 });

  await r.service.runDeepWorkerOnce();
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
  // With no reserved slot, the second failure cannot be recorded; only its terminal event remains.
  await expect(r.service.runDeepWorkerOnce()).rejects.toMatchObject({
    code: "DEAD_LETTER_CAPACITY"
  });
  expect((await r.dead.list()).map((record) => record.task.taskId)).toEqual(["a"]);
  expect(
    (await r.timeline.getEvents("c")).filter((e) => e.type === "terminal").map((e) => e.messageId)
  ).toEqual(["a", "b"]);
  expect(r.queue.size()).toBe(1);
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
  expect(r.timeline.retentionStats().pins).toBe(0);
});

it("cancelling queued work promptly releases its queue entry, slot, task pin and history lease", async () => {
  const r = setup();
  const response = await r.service.submitMessage({
    messageId: "m",
    conversationId: "c",
    userId: "u",
    text: "What is the latest news?",
    timestampIso: new Date().toISOString()
  });
  expect(response.deepTask).toBeDefined();
  expect(await r.service.cancelMessage("c", "m")).toMatchObject({ phases: { deep: "cancelled" } });
  expect(await r.service.runDeepWorkerOnce()).toBeUndefined();
  expect(r.deep.resolveDeepTask).not.toHaveBeenCalled();
  expect(r.queue.size()).toBe(0);
  expect(r.dead.retentionStats()).toMatchObject({ records: 0, reservations: 0, reservedBytes: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
  expect(r.timeline.retentionStats().pins).toBe(0);
});

it("keeps at most one pending summary snapshot per conversation and drops it on expiry", async () => {
  let now = 0;
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ idleTtlMs: 10 }),
    () => now
  );
  const pair = async (conversationId: string, n: number) => {
    for (const type of ["user", "provisional"] as const)
      await timeline.appendEvent(conversationId, {
        type,
        messageId: `m${n}`,
        text: `${type} ${n}`,
        processingStatus: "complete",
        createdAtIso: "now"
      });
  };
  const signals: AbortSignal[] = [];
  const hanging: ContextSummarizer = {
    method: "model-v1",
    inputLimit: 8192,
    outputLimit: 4096,
    summarize: (_records, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    }
  };
  const manager = new ContextManager(
    timeline,
    {
      windowTokens: 24000,
      maxHistoryTurns: 4,
      safetyTokens: 256,
      fastOutputTokens: 512,
      deepOutputTokens: 2048
    },
    { config: { ...loadSummaryConfig({}), mode: "model", timeoutMs: 60000 }, summarizer: hanging }
  );
  managers.push(manager);
  const prepare = (conversationId: string) =>
    manager.prepare({
      conversationId,
      currentMessageId: "current",
      currentUserText: "continue",
      trustedFacts: {
        fastProvider: "mock",
        fastModel: "f",
        deepProvider: "mock",
        deepModel: "d",
        generatedAtIso: "2026-10-01T00:00:00Z"
      }
    });
  const started = async (count: number) => {
    await vi.waitFor(() => expect(signals).toHaveLength(count));
  };
  for (const id of ["a", "b"]) for (let n = 1; n <= 6; n++) await pair(id, n);

  await prepare("a");
  await prepare("a"); // Same source prefix: joins the existing job.
  await prepare("b");
  await started(2);
  expect(manager.getSummaryTelemetry()).toMatchObject({ scheduled: 2, activeJobs: 2 });

  await pair("a", 7);
  await prepare("a"); // New prefix: the superseded job is aborted, not accumulated.
  await started(3);
  expect(signals[0].aborted).toBe(true);
  expect(manager.getSummaryTelemetry()).toMatchObject({ scheduled: 3, activeJobs: 2 });

  now += 10;
  timeline.retentionStats(); // Lazy expiry notifies the manager.
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await vi.waitFor(() => expect(manager.getSummaryTelemetry().activeJobs).toBe(0));
  expect(manager.getSummaryTelemetry()).toMatchObject({ cancelled: 3, published: 0, timedOut: 0 });
});

it("preserves a dequeued task when its conversation expired before attempt creation", async () => {
  let now = 0;
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ idleTtlMs: 10 }),
    () => now
  );
  await timeline.appendEvent("c", {
    type: "user",
    messageId: "old",
    text: "old",
    createdAtIso: "now"
  });
  const queue = new InMemoryTaskQueue();
  const dead = new InMemoryDeadLetterStore();
  const deep: DeepModelProvider = { resolveDeepTask: vi.fn() };
  const worker = new DeepWorker(queue, deep, timeline, 0, dead);
  const queued = task("expired");
  await queue.enqueue(queued);
  now = 10;

  await expect(worker.runSingle()).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
  expect(await dead.list()).toEqual([
    expect.objectContaining({
      task: queued,
      errorMessage: "CONVERSATION_EXPIRED"
    })
  ]);
  expect(deep.resolveDeepTask).not.toHaveBeenCalled();
  expect(queue.size()).toBe(0);
  expect(generationLifecycle(queue).retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
  expect(timeline.retentionStats().pins).toBe(0);
});

it("releases a cancelled queued task while the serial worker is blocked on another task", async () => {
  const r = setup();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(r.deep.resolveDeepTask).mockImplementationOnce(async () => {
    await held;
    throw new GenerationError("PROVIDER_AUTH", false);
  });
  const send = (messageId: string) =>
    r.service.submitMessage({
      messageId,
      conversationId: "c",
      userId: "u",
      text: "What is the latest news?",
      timestampIso: new Date().toISOString()
    });
  await send("running");
  const worker = r.service.runDeepWorkerOnce();
  try {
    await vi.waitFor(() => expect(r.deep.resolveDeepTask).toHaveBeenCalledTimes(1));
    await send("queued");
    await r.service.cancelMessage("c", "queued");
    expect(r.queue.size()).toBe(0);
    expect(r.dead.retentionStats()).toMatchObject({ reservations: 1 });
    expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 1, tasks: 1 });
    expect(r.timeline.retentionStats().pins).toBe(2); // Running attempt plus its task lease.
  } finally {
    release();
    await worker;
  }
  expect(r.deep.resolveDeepTask).toHaveBeenCalledTimes(1);
  expect(r.dead.retentionStats()).toMatchObject({ records: 1, reservations: 0 });
  expect(r.lifecycle.retentionStats()).toMatchObject({ consumers: 0, tasks: 0 });
});

it("a custom queue without removal retains a cancelled retry until physical dequeue", async () => {
  const entries: DeepTask[] = [task("custom-retry")];
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enqueued = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const queue = {
    async enqueue(value: DeepTask) {
      entries.push(value);
      entered();
      await pending;
    },
    async dequeue() {
      return entries.shift();
    }
  };
  const timeline = new InMemoryConversationTimelineStore();
  const deep: DeepModelProvider = {
    resolveDeepTask: vi.fn(async () => {
      throw new GenerationError("PROVIDER_UNAVAILABLE", true);
    })
  };
  const worker = new DeepWorker(queue, deep, timeline, 1);
  const lifecycle = generationLifecycle(queue);
  const running = worker.runSingle();
  await enqueued;
  await lifecycle.cancel("c", "custom-retry");
  release();
  await running;
  expect(entries).toHaveLength(1);
  expect(lifecycle.retentionStats()).toMatchObject({ tasks: 1, consumers: 1 });
  expect(lifecycle.get("c", "custom-retry", "deep")?.active).toBe(false);
  await worker.runSingle();
  expect(deep.resolveDeepTask).toHaveBeenCalledTimes(1);
  expect(entries).toHaveLength(0);
  expect(lifecycle.retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
  expect(timeline.retentionStats().pins).toBe(0);
});
