import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ChatService } from "../../src/app/chatService";
import {
  GenerationError,
  type GenerationControl,
  type GenerationResult
} from "../../src/domain/generation";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import {
  InMemoryTaskQueue,
  type FastModelProvider,
  type DeepModelProvider
} from "../../src/providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";
import { ContextManager } from "../../src/app/contextManager";
import { ContextBudgetError } from "../../src/app/contextBuilder";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import { GenerationAttempt, generationLifecycle } from "../../src/app/generationLifecycle";
import { OllamaFastProvider } from "../../src/providers/ollamaProviders";
import { deriveTurns } from "../../src/ui/turnViewModel";

const message = {
  conversationId: "c",
  messageId: "11111111-1111-4111-8111-111111111111",
  userId: "u",
  text: "Find latest news",
  timestampIso: "2026-09-25T00:00:00Z"
};
function setup(
  fast: FastModelProvider = new MockFastProvider(),
  deep: DeepModelProvider = new MockDeepProvider()
) {
  const timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore();
  const orchestrator = new ChatOrchestrator(fast, queue, timeline);
  const worker = new DeepWorker(queue, deep, timeline, 2, dead);
  const service = new ChatService(orchestrator, worker, timeline, queue, dead);
  return { timeline, queue, dead, orchestrator, worker, service };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("generation lifecycle", () => {
  it("turns a malformed provider stream after text into a visible terminal failure without retry", async () => {
    const transport = vi.fn(
      async () => new Response('{"message":{"content":"partial"},"done":false}\nmalformed\n')
    );
    vi.stubGlobal("fetch", transport);
    const s = setup(new OllamaFastProvider("http://fixture.invalid", "fixture", 0));
    await expect(
      s.service.submitMessage({ ...message, text: "Explain gravity" })
    ).rejects.toMatchObject({ code: "INVALID_STREAM" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(deriveTurns(await s.timeline.getEvents("c"))[0]).toMatchObject({
      active: false,
      status: "Failed",
      answers: [{ text: "partial" }]
    });
  });
  it.each([false, true])(
    "retries fast failures only before output (emitted=%s)",
    async (emitted) => {
      const ids: string[] = [];
      const s = setup({
        createProvisionalReply: async (_input, control) => {
          ids.push(control!.attemptId);
          if (emitted) await control!.onDelta("partial fast answer");
          throw new GenerationError("PROVIDER_UNAVAILABLE", true);
        }
      });
      await expect(
        s.service.submitMessage({ ...message, text: "Explain gravity" })
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(new Set(ids).size).toBe(emitted ? 1 : 3);
      const events = await s.timeline.getEvents("c");
      expect(events.at(-1)).toMatchObject({
        type: "terminal",
        finishReason: "error",
        retrying: false
      });
      expect(
        events
          .filter((e) => e.type === "delta")
          .map((e) => e.text)
          .join("")
      ).toBe(emitted ? "partial fast answer" : "");
    }
  );

  it("keeps truncated deep output out of accepted history and records cancellation for later turns", async () => {
    const s = setup(undefined, {
      resolveDeepTask: async (task) => ({
        taskId: task.taskId,
        finalReply: "unfinished",
        finishReason: "length",
        confidence: 1,
        citations: [],
        totalLatencyMs: 1
      })
    });
    await s.service.submitMessage(message);
    await s.worker.runSingle();
    const manager = new ContextManager(s.timeline, loadContextBudgetConfigFromEnv({}));
    const prepare = () =>
      manager.prepare({
        conversationId: "c",
        currentMessageId: "next",
        currentUserText: "status?",
        trustedFacts: {
          fastProvider: "mock",
          deepProvider: "mock",
          fastModel: "m",
          deepModel: "m",
          generatedAtIso: message.timestampIso
        }
      });
    const first = await prepare();
    if (first instanceof ContextBudgetError) throw first;
    expect(first.messages).toHaveLength(1);
    expect(first.activeTasks[0].state).toBe("incomplete");
    await s.service.submitMessage({ ...message, messageId: "second" });
    await s.service.cancelMessage("c", "second");
    const second = await prepare();
    if (second instanceof ContextBudgetError) throw second;
    expect(second.activeTasks.find((t) => t.messageId === "second")?.state).toBe("cancelled");
  });

  it("atomically rejects duplicate IDs while the original fast call is pending", async () => {
    let finish!: (result: GenerationResult) => void;
    const s = setup({
      createProvisionalReply: () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    });
    const first = s.service.submitMessage(message);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(s.service.submitMessage(message)).rejects.toMatchObject({
      code: "DUPLICATE_MESSAGE_ID"
    });
    expect((await s.timeline.getEvents("c")).filter((e) => e.type === "user")).toHaveLength(1);
    finish({ text: "answer", finishReason: "stop" });
    await first;
    await expect(s.service.submitMessage(message)).rejects.toMatchObject({
      code: "DUPLICATE_MESSAGE_ID"
    });
  });

  it("cancels pending fast and queued deep once, suppressing uncooperative late output", async () => {
    let control!: GenerationControl, finish!: (result: GenerationResult) => void;
    const deep = vi.fn(new MockDeepProvider().resolveDeepTask);
    const s = setup(
      {
        createProvisionalReply: (_input, c) => {
          control = c!;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
      },
      { resolveDeepTask: deep }
    );
    const pending = s.service.submitMessage(message);
    await vi.waitFor(() => expect(control).toBeDefined());
    await control.onDelta("early");
    const cancelled = await s.service.cancelMessage("c", message.messageId);
    expect(control.signal.aborted).toBe(true);
    expect(await s.service.cancelMessage("c", message.messageId)).toEqual(cancelled);
    await control.onDelta("late");
    finish({ text: "late final", finishReason: "stop" });
    expect((await pending).fastResponse.processingStatus).toBe("cancelled");
    await s.worker.runSingle();
    expect(deep).not.toHaveBeenCalled();
    expect(await s.dead.list()).toEqual([]);
    const events = await s.timeline.getEvents("c");
    expect(
      events.filter((e) => e.type === "terminal" && e.finishReason === "cancelled")
    ).toHaveLength(2);
    expect(events.filter((e) => e.type !== "user").some((e) => e.text.includes("late"))).toBe(
      false
    );
    expect(await s.service.cancelMessage("c", "unknown")).toBeUndefined();
  });

  it("cancels a running deep call and never retries or dead-letters it", async () => {
    let control!: GenerationControl, finish!: () => void;
    const s = setup(undefined, {
      resolveDeepTask: async (task, c) => {
        control = c!;
        await control.onDelta("partial");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await control.onDelta("late");
        return {
          taskId: task.taskId,
          finalReply: "late",
          finishReason: "stop",
          confidence: 1,
          citations: [],
          totalLatencyMs: 1
        };
      }
    });
    await s.service.submitMessage(message);
    const run = s.worker.runSingle();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await s.service.cancelMessage("c", message.messageId);
    finish();
    await run;
    expect(control.signal.aborted).toBe(true);
    expect(s.queue.size()).toBe(0);
    expect(await s.dead.list()).toEqual([]);
    expect((await s.timeline.getEvents("c")).some((e) => e.type === "refined")).toBe(false);
  });

  it("leaves completed turns unchanged on cancellation", async () => {
    const s = setup();
    await s.service.submitMessage(message);
    await s.worker.runSingle();
    const before = await s.timeline.getEvents("c");
    expect((await s.service.cancelMessage("c", message.messageId))?.phases).toEqual({
      fast: "stop",
      deep: "stop"
    });
    expect(await s.timeline.getEvents("c")).toEqual(before);
  });

  it.each(["", "partial"])("keeps length finish %j out of accepted history", async (text) => {
    const s = setup({ createProvisionalReply: async () => ({ text, finishReason: "length" }) });
    await s.service.submitMessage({ ...message, text: "Explain gravity" });
    const manager = new ContextManager(s.timeline, loadContextBudgetConfigFromEnv({}));
    const context = await manager.prepare({
      conversationId: "c",
      currentMessageId: "next",
      currentUserText: "why?",
      trustedFacts: {
        fastProvider: "mock",
        deepProvider: "mock",
        fastModel: "m",
        deepModel: "m",
        generatedAtIso: message.timestampIso
      }
    });
    if (context instanceof ContextBudgetError) throw context;
    expect(context.messages).toHaveLength(1);
    expect(context.activeTasks[0].state).toBe("incomplete");
    expect(
      (await s.timeline.getEvents("c")).find((e) => e.type === "provisional")?.processingStatus
    ).toBe("incomplete");
  });

  it.each([false, true])(
    "retries transient deep failure only before output (emitted=%s)",
    async (emitted) => {
      const ids: string[] = [];
      const s = setup(undefined, {
        resolveDeepTask: async (_task, control) => {
          ids.push(control!.attemptId);
          if (emitted) await control!.onDelta("partial");
          throw new GenerationError("PROVIDER_UNAVAILABLE", true);
        }
      });
      await s.service.submitMessage(message);
      await s.worker.runSingle();
      expect(s.queue.size()).toBe(emitted ? 0 : 1);
      if (!emitted) {
        await s.worker.runSingle();
        await s.worker.runSingle();
        expect(new Set(ids).size).toBe(3);
      }
      expect(await s.dead.list()).toHaveLength(1);
      expect(
        (await s.timeline.getEvents("c"))
          .filter((e) => e.type === "delta" && e.phase === "deep")
          .map((e) => e.text)
          .join("")
      ).toBe(emitted ? "partial" : "");
    }
  );

  it("never retries a typed context overflow", async () => {
    const s = setup(undefined, {
      resolveDeepTask: async () => {
        throw new GenerationError("CONTEXT_TOO_LARGE", false);
      }
    });
    await s.service.submitMessage(message);
    await s.worker.runSingle();
    expect(s.queue.size()).toBe(0);
    expect((await s.timeline.getEvents("c")).at(-1)).toMatchObject({
      type: "terminal",
      errorCode: "CONTEXT_TOO_LARGE",
      retrying: false
    });
  });

  it("coalesces deltas every 50ms and flushes pending text before terminal", async () => {
    vi.useFakeTimers();
    const timeline = new InMemoryConversationTimelineStore();
    const attempt = new GenerationAttempt("c", "m", "fast", timeline);
    await attempt.start(timeline);
    await attempt.control.onDelta("a");
    await attempt.control.onDelta("b");
    await attempt.control.onDelta("c");
    expect((await timeline.getEvents("c")).filter((e) => e.type === "delta")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    await attempt.control.onDelta("d");
    await attempt.finish("stop");
    const events = await timeline.getEvents("c");
    expect(events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["a", "bc", "d"]);
    expect(events.at(-1)?.type).toBe("terminal");
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("protects the identity of a replay whose original lifecycle record expired", async () => {
  vi.useFakeTimers();
  const s = setup(undefined, {
    resolveDeepTask: async () => {
      throw new GenerationError("PROVIDER_AUTH", false);
    }
  });
  await s.service.submitMessage(message);
  await s.worker.runSingle();
  const record = (await s.dead.list())[0];
  await vi.advanceTimersByTimeAsync(300001);
  expect(generationLifecycle(s.queue).get("c", message.messageId, "deep")).toBeUndefined();
  expect(await s.service.replayDeadLetter(record.task.taskId)).toBe(true);
  await expect(s.service.submitMessage(message)).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE_ID"
  });
  await s.service.cancelRemaining();
  await s.service.discardPending();
  expect(generationLifecycle(s.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
});
