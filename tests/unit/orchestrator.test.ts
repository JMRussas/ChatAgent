import type { GenerationResult } from "../../src/domain/generation";
import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ContextBudgetError } from "../../src/app/contextBuilder";
import { ContextManager } from "../../src/app/contextManager";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import type { ConversationContext } from "../../src/domain/context";
import type { FastModelProvider } from "../../src/providers/interfaces";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

describe("orchestrator", () => {
  it("returns complete response for direct route", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    const result = await orchestrator.handleUserMessage({
      conversationId: "conv1",
      userId: "user1",
      text: "Explain what event sourcing is",
      timestampIso: new Date().toISOString()
    });

    expect(result.fastResponse.processingStatus).toBe("complete");
    expect(result.deepTask).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it("enqueues deep task and returns provisional response", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    const result = await orchestrator.handleUserMessage({
      conversationId: "conv2",
      userId: "user2",
      text: "Find latest inflation data and cite sources",
      timestampIso: new Date().toISOString()
    });

    expect(result.fastResponse.processingStatus).toBe("provisional");
    expect(result.deepTask).toBeDefined();
    expect(queue.size()).toBe(1);
  });

  it("routes clarify through fast provider without deep enqueue", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    const result = await orchestrator.handleUserMessage({
      conversationId: "conv-clarify",
      userId: "user-clarify",
      text: "Do it",
      timestampIso: new Date().toISOString()
    });

    expect(result.fastResponse.analysis.routeDecision).toBe("clarify");
    expect(result.fastResponse.processingStatus).toBe("complete");
    expect(result.fastResponse.provisionalReply).toContain("I can help. Can you add one more detail");
    expect(result.deepTask).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it("routes current-day question as direct without deep enqueue", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    const result = await orchestrator.handleUserMessage({
      conversationId: "conv-day",
      userId: "user-day",
      text: "WHAT DAY IS IT?",
      timestampIso: "2026-09-25T12:00:00.000Z"
    });

    expect(result.fastResponse.analysis.routeDecision).toBe("direct");
    expect(result.fastResponse.processingStatus).toBe("complete");
    expect(result.fastResponse.provisionalReply).toContain("Quick answer:");
    expect(result.deepTask).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it("passes independent context copies to the fast provider and the queued deep task", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();

    let capturedFastContext: ConversationContext | undefined;
    class CapturingFastProvider implements FastModelProvider {
      async createProvisionalReply(input: { context?: ConversationContext }): Promise<GenerationResult> {
        capturedFastContext = input.context;
        return { text: "provisional", finishReason: "stop" };
      }
    }

    const orchestrator = new ChatOrchestrator(new CapturingFastProvider(), queue, timeline);

    await orchestrator.handleUserMessage({
      conversationId: "conv-context",
      userId: "user-context",
      text: "Find latest inflation data and cite sources",
      timestampIso: new Date().toISOString()
    });

    const task = await queue.dequeue();
    expect(task?.context).toBeDefined();
    expect(capturedFastContext).toBeDefined();
    expect(capturedFastContext).not.toBe(task!.context);

    // Mutating the fast provider's copy must never affect the queued task's snapshot.
    (capturedFastContext!.messages as unknown as unknown[]).push({ role: "user", content: "injected", messageId: "x" });
    expect(task!.context!.messages).not.toEqual(capturedFastContext!.messages);
  });

  it("rejects an oversized turn before appending events or enqueuing work (413 CONTEXT_TOO_LARGE)", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const tinyBudget = { windowTokens: 10, maxHistoryTurns: 12, safetyTokens: 0, fastOutputTokens: 1, deepOutputTokens: 1 };
    const contextManager = new ContextManager(timeline, tinyBudget);
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline, undefined, contextManager);

    await expect(
      orchestrator.handleUserMessage({
        conversationId: "conv-huge",
        userId: "user-huge",
        text: "a".repeat(500),
        timestampIso: new Date().toISOString()
      })
    ).rejects.toBeInstanceOf(ContextBudgetError);

    expect(await timeline.getEvents("conv-huge")).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("worker resolves one deep task", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);
    const worker = new DeepWorker(queue, new MockDeepProvider());

    await orchestrator.handleUserMessage({
      conversationId: "conv3",
      userId: "user3",
      text: "Search latest cloud outage report",
      timestampIso: new Date().toISOString()
    });

    const deepResult = await worker.runSingle();
    expect(deepResult?.finalReply).toContain("Refined answer");
    expect(queue.size()).toBe(0);
  });
});
