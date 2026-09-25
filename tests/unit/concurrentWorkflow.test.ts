import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider } from "../../src/providers/mockProviders";

const message = {
  conversationId: "overlap", userId: "user", text: "Find latest news and cite sources",
  timestampIso: "2026-09-25T12:00:00.000Z"
};

describe("concurrent workflow", () => {
  it("runs deep work before fast completes and correlates every event", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    let finishFast!: (reply: string) => void;
    let started!: () => void;
    const fastStarted = new Promise<void>((resolve) => { started = resolve; });
    const orchestrator = new ChatOrchestrator({
      createProvisionalReply: () => {
        started();
        return new Promise<string>((resolve) => { finishFast = resolve; });
      }
    }, queue, timeline);
    const pending = orchestrator.handleUserMessage(message);
    await fastStarted;
    expect(queue.size()).toBe(1);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    await worker.runSingle();
    finishFast("Still working");
    const response = await pending;
    const events = await timeline.getEvents(message.conversationId);
    expect(events.map((event) => event.type)).toEqual(["user", "refined", "provisional"]);
    expect(new Set(events.map((event) => event.messageId))).toEqual(new Set([response.messageId]));
    expect(response.deepTask?.messageId).toBe(response.messageId);
  });

  it("keeps deep work available when the fast provider fails", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator({
      createProvisionalReply: async () => { throw new Error("unavailable"); }
    }, queue);
    const results = await Promise.all([orchestrator.handleUserMessage(message), orchestrator.handleUserMessage(message)]);
    expect(queue.size()).toBe(2);
    expect(results[0].deepTask?.taskId).not.toBe(results[1].deepTask?.taskId);
    expect(results[0].fastResponse.provisionalReply).toContain("queued");
    await expect(orchestrator.handleUserMessage({ ...message, text: "Explain gravity" })).rejects.toThrow("unavailable");
  });

  it("limits simultaneous timer/manual worker calls to one task", async () => {
    const queue = new InMemoryTaskQueue();
    for (const taskId of ["first", "second"]) {
      await queue.enqueue({ taskId, conversationId: "c", normalizedPrompt: "prompt", createdAtIso: message.timestampIso });
    }
    let release!: () => void;
    let started!: () => void;
    const processing = new Promise<void>((resolve) => { started = resolve; });
    const worker = new DeepWorker(queue, {
      resolveDeepTask: async (task) => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return { taskId: task.taskId, finalReply: "done", confidence: 1, citations: [], totalLatencyMs: 1 };
      }
    });
    const first = worker.runSingle();
    await processing;
    expect(await worker.runSingle()).toBeUndefined();
    expect(queue.size()).toBe(1);
    release();
    expect((await first)?.taskId).toBe("first");
    const second = worker.runSingle();
    // dequeue resumes on the next microtask.
    await Promise.resolve();
    release();
    expect((await second)?.taskId).toBe("second");
  });
});
