import { describe, expect, it, vi } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import type { DeepTask } from "../../src/domain/types";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

describe("mock conversation component flow", () => {
  it("returns and records a correlated provisional answer before explicitly requested worker refinement", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: (task: DeepTask) => void;
    const providerStarted = new Promise<DeepTask>((resolve) => {
      started = resolve;
    });
    const mockDeep = new MockDeepProvider();
    const resolveDeepTask = vi.fn(async (...args: Parameters<typeof mockDeep.resolveDeepTask>) => {
      started(args[0]);
      await completion;
      return mockDeep.resolveDeepTask(...args);
    });
    const worker = new DeepWorker(queue, { resolveDeepTask }, timeline);
    const message = {
      conversationId: "conv-provisional",
      messageId: "11111111-1111-4111-8111-111111111111",
      userId: "user-provisional",
      text: "Look up current treasury yields and cite your sources",
      timestampIso: "2026-10-10T12:00:00.000Z"
    };

    const response = await orchestrator.handleUserMessage(message);
    expect(response.fastResponse.processingStatus).toBe("provisional");
    expect(response.deepTask).toMatchObject({
      conversationId: message.conversationId,
      messageId: message.messageId
    });
    expect(queue.size()).toBe(1);
    expect(resolveDeepTask).not.toHaveBeenCalled();
    const initialAnswers = (await timeline.getEvents(message.conversationId)).filter((event) =>
      ["provisional", "refined"].includes(event.type)
    );
    expect(initialAnswers).toHaveLength(1);
    expect(initialAnswers[0]).toMatchObject({
      type: "provisional",
      messageId: response.messageId,
      text: response.fastResponse.provisionalReply,
      processingStatus: "provisional"
    });

    const pending = worker.runSingle();
    const receivedTask = await providerStarted;
    try {
      expect(receivedTask).toMatchObject({
        taskId: response.deepTask!.taskId,
        conversationId: message.conversationId,
        messageId: response.messageId
      });
      expect(resolveDeepTask).toHaveBeenCalledTimes(1);
      expect(
        (await timeline.getEvents(message.conversationId)).filter(
          (event) => event.type === "refined"
        )
      ).toEqual([]);
    } finally {
      release();
    }
    const refined = await pending;
    expect(refined?.taskId).toBe(response.deepTask!.taskId);
    const answers = (await timeline.getEvents(message.conversationId)).filter((event) =>
      ["provisional", "refined"].includes(event.type)
    );
    expect(answers.map((event) => event.type)).toEqual(["provisional", "refined"]);
    expect(new Set(answers.map((event) => event.messageId))).toEqual(new Set([response.messageId]));
    expect(answers[1]).toMatchObject({
      taskId: response.deepTask!.taskId,
      text: refined!.finalReply,
      processingStatus: "complete"
    });
    expect(answers[1].sequence).toBeGreaterThan(answers[0].sequence!);
    expect(queue.size()).toBe(0);
  });

  it("preserves the mock refined-answer fields and citation shape", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);
    const worker = new DeepWorker(queue, new MockDeepProvider());

    const response = await orchestrator.handleUserMessage({
      conversationId: "conv-citation-shape",
      userId: "user-citation-shape",
      text: "Search latest semiconductor trend report",
      timestampIso: "2026-10-10T12:00:00.000Z"
    });

    const refined = await worker.runSingle();
    expect(refined).toMatchObject({
      taskId: response.deepTask!.taskId,
      finishReason: "stop",
      finalReply: expect.any(String),
      confidence: expect.any(Number),
      citations: expect.any(Array)
    });
    // Mock citation presence checks response shape, not retrieval or grounding.
    expect(refined!.citations.length).toBeGreaterThan(0);
    for (const citation of refined!.citations) expect(citation).toEqual(expect.any(String));
  });
});
