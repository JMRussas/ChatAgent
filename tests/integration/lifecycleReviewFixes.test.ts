import { afterEach, it, expect, vi } from "vitest";
import { runtime, message, entry } from "../helpers/dispatchFixtures";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import { GenerationError } from "../../src/domain/generation";
import { ChatOrchestrator } from "../../src/app/orchestrator";
import { CapabilityChat } from "../../src/app/capabilityChat";
import { deriveTurns } from "../../src/ui/turnViewModel";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("old replay rejects an active replacement without terminating it", async () => {
  vi.stubEnv("EXECUTION_RETENTION_MAX_COMPLETED", "1");
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
    const old = await r.service.submitMessage(message("Find latest news", "same"));
    await r.service.runDeepWorkerOnce();
    await r.service.submitMessage(message("Hello", "other"));
    // Model an existing legacy/restored collision; new submissions now reject reuse.
    const current = generationLifecycle(r.queue).create(
      "c",
      "same",
      "deep",
      r.timeline,
      "replacement-task"
    );
    expect(current.status).toBe("queued");
    await expect(r.service.replayDeadLetter(old.deepTask!.taskId)).rejects.toMatchObject({
      code: "REPLAY_CONFLICT"
    });
    expect(current.status).toBe("queued");
    expect((await r.service.listDeadLetters()).map((record) => record.task.taskId)).toContain(
      old.deepTask!.taskId
    );
    await current.finish("cancelled");
    generationLifecycle(r.queue).releaseTask("replacement-task");
  } finally {
    await r.manager.shutdown();
  }
});
it("initial queue failure plus terminal write failure releases the task pin", async () => {
  const r = runtime();
  try {
    vi.spyOn(r.queue, "enqueue").mockRejectedValue(Error("QUEUE_FAILED"));
    const append = r.timeline.appendEvent.bind(r.timeline);
    vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (c, e) => {
      if (e.type === "terminal") throw Error("WRITE_FAILED");
      await append(c, e);
    });
    await expect(r.service.submitMessage(message("Find latest news"))).rejects.toThrow();
    expect(r.queue.size()).toBe(0);
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
  } finally {
    await r.manager.shutdown();
  }
});
it.each(["orchestrator", "capability"])(
  "%s rejects historical message IDs after eviction without changing presentation",
  async (kind) => {
    vi.stubEnv("EXECUTION_RETENTION_MAX_COMPLETED", "1");
    const r = runtime();
    try {
      const capability = new CapabilityChat(
        {
          createProvisionalReply: async () => ({
            text: JSON.stringify({ action: "answer", message: "Answer" }),
            finishReason: "stop"
          })
        },
        r.queue,
        r.timeline,
        r.manager,
        () => ({
          fastProvider: "test",
          fastModel: "test",
          deepProvider: "none",
          deepModel: "none",
          generatedAtIso: new Date().toISOString()
        }),
        () => []
      );
      const submit = (input: ReturnType<typeof message>) =>
        kind === "capability"
          ? capability.handleUserMessage(input)
          : r.service.submitMessage(input);
      await submit(message("Explain gravity", "same"));
      await submit(message("Hello", "other"));
      expect(generationLifecycle(r.queue).get("c", "same", "fast")).toBeUndefined();
      const before = await r.timeline.getEvents("c");
      await expect(submit(message("Explain rainbows", "same"))).rejects.toMatchObject({
        code: "DUPLICATE_MESSAGE_ID"
      });
      expect(await r.timeline.getEvents("c")).toEqual(before);
      await submit(message("Explain rainbows", "fresh"));
      expect(deriveTurns(await r.timeline.getEvents("c")).map((t) => t.userText)).toEqual([
        "Explain gravity",
        "Hello",
        "Explain rainbows"
      ]);
    } finally {
      await r.manager.shutdown();
    }
  }
);

it("serializes duplicate submissions across an asynchronous history read", async () => {
  const r = runtime();
  try {
    const results = await Promise.allSettled([
      r.service.submitMessage(message("Hello")),
      r.service.submitMessage(message("Hello"))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await r.timeline.getEvents("c")).filter((e) => e.type === "user")).toHaveLength(1);
    expect(r.calls.get("a")!.fast.createProvisionalReply).toHaveBeenCalledTimes(1);
  } finally {
    await r.manager.shutdown();
  }
});

it("releases a submission claim when the history read fails", async () => {
  const r = runtime();
  try {
    vi.spyOn(r.timeline, "getEvents").mockRejectedValueOnce(Error("HISTORY_UNAVAILABLE"));
    await expect(r.service.submitMessage(message("Hello"))).rejects.toThrow("HISTORY_UNAVAILABLE");
    await expect(r.service.submitMessage(message("Hello"))).resolves.toBeDefined();
    expect(r.calls.get("a")!.fast.createProvisionalReply).toHaveBeenCalledTimes(1);
  } finally {
    await r.manager.shutdown();
  }
});

it("failed replay enqueue releases its attempt and restores the dead letter", async () => {
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
    const old = await r.service.submitMessage(message("Find latest news", "same"));
    await r.service.runDeepWorkerOnce();
    vi.spyOn(r.queue, "enqueue").mockRejectedValueOnce(Error("QUEUE_FAILED"));
    await expect(r.service.replayDeadLetter(old.deepTask!.taskId)).rejects.toThrow("QUEUE_FAILED");
    expect(generationLifecycle(r.queue).get("c", "same", "deep")?.status).toBe("error");
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
    expect((await r.service.listDeadLetters()).map((record) => record.task.taskId)).toContain(
      old.deepTask!.taskId
    );
    expect(r.queue.size()).toBe(0);
  } finally {
    await r.manager.shutdown();
  }
});

it("capability startup write failures release the unstarted tool task", async () => {
  const r = runtime();
  try {
    const execute = vi.fn(async () => ({ ok: true }));
    const chat = new CapabilityChat(
      {
        createProvisionalReply: async () => ({
          text: JSON.stringify({ action: "retrieve", calls: [{ tool: "lookup", arguments: {} }] }),
          finishReason: "stop"
        })
      },
      r.queue,
      r.timeline,
      r.manager,
      () => ({
        fastProvider: "test",
        fastModel: "test",
        deepProvider: "none",
        deepModel: "none",
        generatedAtIso: new Date().toISOString()
      }),
      () => [{ id: "lookup", description: "lookup", inputSchema: {}, validate: (v) => v, execute }]
    );
    const append = r.timeline.appendEvent.bind(r.timeline);
    vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (c, e) => {
      if (e.phase === "deep") throw Error("WRITE_FAILED");
      await append(c, e);
    });
    await expect(chat.handleUserMessage(message("Find latest news"))).rejects.toThrow();
    await chat.whenIdle();
    expect(execute).not.toHaveBeenCalled();
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({
      tasks: 0,
      consumers: 0,
      retained: 1
    });
  } finally {
    await r.manager.shutdown();
  }
});

it("pre-attempt setup failure releases the message claim for retry", async () => {
  const r = runtime();
  try {
    const facts = vi.fn(() => ({
      fastProvider: "test",
      fastModel: "test",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date().toISOString()
    }));
    facts.mockImplementationOnce(() => {
      throw Error("FACTS_UNAVAILABLE");
    });
    const chat = new ChatOrchestrator(
      r.calls.get("a")!.fast,
      r.queue,
      r.timeline,
      undefined,
      r.manager,
      facts
    );
    await expect(chat.handleUserMessage(message("Hello"))).rejects.toThrow("FACTS_UNAVAILABLE");
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({
      claimed: 0,
      consumers: 0
    });
    await expect(chat.handleUserMessage(message("Hello"))).resolves.toBeDefined();
  } finally {
    await r.manager.shutdown();
  }
});

it("discard drains every queued task even if a cancellation write fails", async () => {
  const r = runtime();
  try {
    await r.service.submitMessage(message("Find latest news", "first"));
    await r.service.submitMessage(message("Find latest news", "second"));
    const append = r.timeline.appendEvent.bind(r.timeline);
    vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (c, e) => {
      if (e.phase === "deep" && e.type === "terminal" && e.messageId === "first")
        throw Error("WRITE_FAILED");
      await append(c, e);
    });
    await expect(r.service.discardPending()).rejects.toThrow();
    expect(r.queue.size()).toBe(0);
    expect(generationLifecycle(r.queue).retentionStats()).toMatchObject({ tasks: 0, consumers: 0 });
    expect(generationLifecycle(r.queue).get("c", "second", "deep")?.status).toBe("cancelled");
  } finally {
    await r.manager.shutdown();
  }
});
