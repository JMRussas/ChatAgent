import { afterEach, expect, it, vi } from "vitest";
import { runtime, message, entry } from "../helpers/dispatchFixtures";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import type { DeepModelProvider } from "../../src/providers/interfaces";
import { GenerationError } from "../../src/domain/generation";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function smallRetention() {
  vi.stubEnv("EXECUTION_RETENTION_MAX_COMPLETED", "2");
  vi.stubEnv("EXECUTION_RETENTION_MAX_METRICS", "3");
}
it("bounds completed lifecycle and dispatch records after repeated direct turns", async () => {
  smallRetention();
  const r = runtime();
  for (let i = 0; i < 12; i++) await r.service.submitMessage(message("Hello", `turn-${i}`));
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({
    turns: 2,
    claimed: 2,
    retained: 2,
    consumers: 0
  });
  expect(r.dispatch.retentionStats()).toMatchObject({ phases: 2, retained: 2, metrics: 3 });
  await expect(r.service.submitMessage(message("Hello", "turn-11"))).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE_ID"
  });
  await expect(r.service.submitMessage(message("Hello", "turn-0"))).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE_ID"
  });
  await r.manager.shutdown();
});
it("preserves a queued then held deep task while completed turns are evicted", async () => {
  smallRetention();
  const held = gate(),
    started = gate();
  const deep = vi.fn<DeepModelProvider["resolveDeepTask"]>(async (task, control) => {
    started.resolve();
    await held.promise;
    await control!.onDelta("late");
    return {
      taskId: task.taskId,
      finalReply: "late",
      finishReason: "stop" as const,
      confidence: 1,
      citations: [],
      totalLatencyMs: 0
    };
  });
  const r = runtime([entry("a")], { a: { deep: { resolveDeepTask: deep } } });
  const response = await r.service.submitMessage(message("What is the latest news?", "held"));
  const id = response.deepTask!.dispatchId!;
  for (let i = 0; i < 5; i++) await r.service.submitMessage(message("Hello", `before-${i}`));
  expect(r.dispatch.get(id)).toBeDefined();
  expect(generationLifecycle(r.queue).get("c", "held", "deep")?.status).toBe("queued");
  const work = r.service.runDeepWorkerOnce();
  await started.promise;
  await r.service.cancelMessage("c", "held");
  for (let i = 0; i < 5; i++) await r.service.submitMessage(message("Hello", `after-${i}`));
  expect(r.dispatch.get(id)).toBeDefined();
  expect(generationLifecycle(r.queue).get("c", "held", "deep")?.status).toBe("cancelled");
  expect(r.dispatch.admission.snapshot().some((c) => c.started && c.status === "reserved")).toBe(
    true
  );
  held.resolve();
  await work;
  expect(r.dispatch.admission.snapshot().some((c) => c.started && c.status === "reserved")).toBe(
    false
  );
  expect(deep).toHaveBeenCalledTimes(1);
  expect(
    (await r.timeline.getEvents("c")).filter((e) => e.messageId === "held" && e.type === "refined")
  ).toHaveLength(0);
  await r.manager.shutdown();
});
it("retains dispatch and replacement attempt across a queued deep retry", async () => {
  smallRetention();
  let calls = 0;
  const r = runtime([entry("a")], {
    a: {
      deep: {
        resolveDeepTask: async (task) => {
          if (++calls === 1) throw new GenerationError("PROVIDER_UNAVAILABLE", true);
          return {
            taskId: task.taskId,
            finalReply: "done",
            finishReason: "stop",
            confidence: 1,
            citations: [],
            totalLatencyMs: 0
          };
        }
      }
    }
  });
  const response = await r.service.submitMessage(message("What is the latest news?", "retry"));
  await r.service.runDeepWorkerOnce();
  for (let i = 0; i < 5; i++) await r.service.submitMessage(message("Hello", `other-${i}`));
  expect(r.dispatch.get(response.deepTask!.dispatchId)).toBeDefined();
  expect(generationLifecycle(r.queue).get("c", "retry", "deep")?.status).toBe("queued");
  await r.service.runDeepWorkerOnce();
  expect(calls).toBe(2);
  expect(
    (await r.timeline.getEvents("c"))
      .filter((e) => e.messageId === "retry" && e.phase === "deep" && e.type === "terminal")
      .map((e) => e.finishReason)
  ).toEqual(["error", "stop"]);
  await r.manager.shutdown();
});
it("pins an explicitly replayed dispatch while queued and rejects expired snapshots without losing the dead letter", async () => {
  smallRetention();
  let fail = true;
  const r = runtime([entry("a")], {
    a: {
      deep: {
        resolveDeepTask: async (task) => {
          if (fail) throw new GenerationError("PROVIDER_AUTH", false);
          return {
            taskId: task.taskId,
            finalReply: "done",
            finishReason: "stop",
            confidence: 1,
            citations: [],
            totalLatencyMs: 0
          };
        }
      }
    }
  });
  const response = await r.service.submitMessage(message("Find latest news", "replay"));
  await r.service.runDeepWorkerOnce();
  fail = false;
  expect(await r.service.replayDeadLetter(response.deepTask!.taskId)).toBe(true);
  for (let i = 0; i < 5; i++) await r.service.submitMessage(message("Hello", `other-${i}`));
  expect((await r.service.runDeepWorkerOnce())?.finalReply).toBe("done");
  fail = true;
  const expired = await r.service.submitMessage(message("Find latest news", "expired"));
  await r.service.runDeepWorkerOnce();
  for (let i = 0; i < 5; i++) await r.service.submitMessage(message("Hello", `expire-${i}`));
  await expect(r.service.replayDeadLetter(expired.deepTask!.taskId)).rejects.toMatchObject({
    code: "DISPATCH_SNAPSHOT_UNAVAILABLE"
  });
  expect((await r.service.listDeadLetters()).map((r) => r.task.taskId)).toContain(
    expired.deepTask!.taskId
  );
  await r.manager.shutdown();
});
it("expires execution records without expiring conversation identity", async () => {
  vi.useFakeTimers();
  smallRetention();
  vi.stubEnv("EXECUTION_RETENTION_TTL_MS", "10");
  const r = runtime();
  try {
    await r.service.submitMessage(message("Hello"));
    const lifecycle = generationLifecycle(r.queue);
    await vi.advanceTimersByTimeAsync(9);
    expect(lifecycle.get("c", "turn-1", "fast")?.status).toBe("stop");
    await expect(r.service.submitMessage(message("Hello"))).rejects.toMatchObject({
      code: "DUPLICATE_MESSAGE_ID"
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.retentionStats()).toMatchObject({ turns: 0, claimed: 0, consumers: 0 });
    expect(r.dispatch.retentionStats()).toMatchObject({ phases: 0, retained: 0 });
    await expect(r.service.submitMessage(message("Hello"))).rejects.toMatchObject({
      code: "DUPLICATE_MESSAGE_ID"
    });
  } finally {
    await r.manager.shutdown();
    vi.useRealTimers();
  }
});
it("bounds failed turns and releases cancelled queue pins on shutdown without refunding started work", async () => {
  smallRetention();
  const r = runtime([entry("a")], {
    a: {
      fast: {
        createProvisionalReply: async () => {
          throw new GenerationError("PROVIDER_AUTH", false);
        }
      }
    }
  });
  for (let i = 0; i < 6; i++)
    await expect(r.service.submitMessage(message("Hello", `failed-${i}`))).rejects.toMatchObject({
      code: "PROVIDER_AUTH"
    });
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({
    turns: 2,
    claimed: 2,
    consumers: 0
  });
  expect(r.dispatch.retentionStats()).toMatchObject({ phases: 2, retained: 2 });
  expect(r.dispatch.admission.snapshot().filter((c) => c.status === "unsettled")).toHaveLength(2);
  expect(r.dispatch.admission.accounting().unsettledCount).toBe(6);
  await r.service.submitMessage(message("Find latest news", "queued"));
  await r.service.cancelRemaining();
  await r.service.discardPending();
  await r.service.whenIdle();
  expect(r.queue.size()).toBe(0);
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
  expect(r.dispatch.retentionStats().phases).toBeLessThanOrEqual(2);
  await r.manager.shutdown();
});

it("removes cancelled queued tasks and allows their settled records to expire", async () => {
  smallRetention();
  const r = runtime();
  await r.service.submitMessage(message("Find latest news", "cancelled"));
  await r.service.cancelMessage("c", "cancelled");
  for (let i = 0; i < 6; i++) await r.service.submitMessage(message("Hello", `other-${i}`));
  expect(r.queue.size()).toBe(0);
  expect(generationLifecycle(r.queue).get("c", "cancelled", "deep")).toBeUndefined();
  await r.service.runDeepWorkerOnce();
  expect(r.calls.get("a")!.deep.resolveDeepTask).not.toHaveBeenCalled();
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
  await r.manager.shutdown();
});
it("holds execution records until terminal writes settle and completion wins a late cancel", async () => {
  smallRetention();
  const r = runtime(),
    writing = gate(),
    release = gate();
  const append = r.timeline.appendEvent.bind(r.timeline);
  vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (conversation, event) => {
    if (event.messageId === "writing" && event.type === "terminal") {
      writing.resolve();
      await release.promise;
    }
    await append(conversation, event);
  });
  const submission = r.service.submitMessage(message("Hello", "writing"));
  await writing.promise;
  for (let i = 0; i < 6; i++) await r.service.submitMessage(message("Hello", `other-${i}`));
  const attempt = generationLifecycle(r.queue).get("c", "writing", "fast")!;
  expect(attempt.status).toBe("stop");
  expect(attempt.writesSettled).toBe(false);
  expect(r.dispatch.get(attempt.dispatchId)).toBeDefined();
  await expect(r.service.submitMessage(message("Hello", "writing"))).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE_ID"
  });
  const cancel = r.service.cancelMessage("c", "writing");
  release.resolve();
  await Promise.all([submission, cancel]);
  const terminal = (await r.timeline.getEvents("c")).filter(
    (e) => e.messageId === "writing" && e.type === "terminal"
  );
  expect(terminal).toHaveLength(1);
  expect(terminal[0].finishReason).toBe("stop");
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ turns: 2, consumers: 0 });
  await r.manager.shutdown();
});
it("cleans a replacement attempt when a retry terminal write fails before enqueue", async () => {
  smallRetention();
  const r = runtime([entry("a")], {
    a: {
      deep: {
        resolveDeepTask: async () => {
          throw new GenerationError("PROVIDER_UNAVAILABLE", true);
        }
      }
    }
  });
  await r.service.submitMessage(message("Find latest news", "failed-write"));
  const append = r.timeline.appendEvent.bind(r.timeline);
  vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (c, e) => {
    if (e.phase === "deep" && e.type === "terminal" && e.retrying) throw Error("WRITE_FAILED");
    await append(c, e);
  });
  await expect(r.service.runDeepWorkerOnce()).rejects.toThrow("WRITE_FAILED");
  expect(r.queue.size()).toBe(0);
  expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({
    tasks: 0,
    consumers: 0,
    retained: 1
  });
  expect(r.dispatch.retentionStats()).toMatchObject({ phases: 2, retained: 2 });
  await r.manager.shutdown();
});
