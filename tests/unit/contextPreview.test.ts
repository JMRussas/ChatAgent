import { expect, it, vi } from "vitest";
import { ContextManager } from "../../src/app/contextManager";
import { ContextBudgetError } from "../../src/app/contextBuilder";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { budget, now } from "../helpers/dispatchFixtures";

it("candidate previews share captured state without recapture or per-candidate summary calls", async () => {
  const timeline = new InMemoryConversationTimelineStore();
  for (let i = 0; i < 6; i++) {
    await timeline.appendEvent("c", {
      type: "user",
      messageId: `m${i}`,
      text: "a".repeat(150),
      createdAtIso: now
    });
    await timeline.appendEvent("c", {
      type: "provisional",
      messageId: `m${i}`,
      text: "b".repeat(150),
      processingStatus: "complete",
      createdAtIso: now
    });
  }
  const summarize = vi.fn(async () => []);
  const manager = new ContextManager(
    timeline,
    { ...budget, maxHistoryTurns: 4 },
    {
      config: { mode: "model", maxTokens: 1024, timeoutMs: 5000, triggerRatio: 0.1 },
      summarizer: { method: "model-v1", inputLimit: 8192, outputLimit: 1024, summarize }
    }
  );
  const reads = vi.spyOn(timeline, "getEvents");
  const capture = await manager.capture({
    conversationId: "c",
    currentMessageId: "new",
    currentUserText: "Hello",
    routeDecision: "direct",
    trustedFacts: {
      fastProvider: "mock",
      fastModel: "a",
      deepProvider: "mock",
      deepModel: "b",
      generatedAtIso: now
    }
  });
  await timeline.appendEvent("c", {
    type: "user",
    messageId: "later",
    text: "Do not include this new turn",
    createdAtIso: now
  });
  const large = capture.preview(),
    small = capture.preview({ ...budget, windowTokens: 6000 });
  expect(reads).toHaveBeenCalledTimes(1);
  expect(summarize).not.toHaveBeenCalled();
  expect(large).not.toBeInstanceOf(ContextBudgetError);
  expect(small).not.toBeInstanceOf(ContextBudgetError);
  if (!(large instanceof ContextBudgetError) && !(small instanceof ContextBudgetError)) {
    expect(large.capturedAtIso).toBe(small.capturedAtIso);
    expect(large.activeTasks).toEqual(small.activeTasks);
    expect(large.memory).toEqual(small.memory);
    expect(large.messages.some((m) => m.messageId === "later")).toBe(false);
  }
  capture.schedule();
  capture.schedule();
  await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
  await manager.shutdown();
});
