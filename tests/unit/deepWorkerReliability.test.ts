import { describe, expect, it } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockFastProvider } from "../../src/providers/mockProviders";
import type { DeepResult, DeepTask } from "../../src/domain/types";
import type { DeepModelProvider } from "../../src/providers/interfaces";

class FailingThenPassingProvider implements DeepModelProvider {
  private attempts = 0;

  async resolveDeepTask(input: DeepTask): Promise<DeepResult> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("transient failure");
    }

    return {
      taskId: input.taskId,
      finalReply: "recovered answer",
      confidence: 0.8,
      citations: [],
      totalLatencyMs: 100
    };
  }
}

class AlwaysFailingProvider implements DeepModelProvider {
  async resolveDeepTask(_input: DeepTask): Promise<DeepResult> {
    throw new Error("permanent failure");
  }
}

describe("deep worker reliability", () => {
  it("retries failed deep task and eventually succeeds", async () => {
    const queue = new InMemoryTaskQueue();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue);

    await orchestrator.handleUserMessage({
      conversationId: "conv-retry-success",
      userId: "u1",
      text: "Find latest inflation data and cite sources",
      timestampIso: new Date().toISOString()
    });

    const worker = new DeepWorker(queue, new FailingThenPassingProvider(), undefined, 2);

    const first = await worker.runSingle();
    expect(first).toBeUndefined();
    expect(queue.size()).toBe(1);

    const second = await worker.runSingle();
    expect(second?.finalReply).toBe("recovered answer");
    expect(queue.size()).toBe(0);
  });

  it("moves task to dead-letter store after max retries", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const deadLetters = new InMemoryDeadLetterStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);

    await orchestrator.handleUserMessage({
      conversationId: "conv-dead-letter",
      userId: "u2",
      text: "Find latest unemployment data and cite sources",
      timestampIso: new Date().toISOString()
    });

    const worker = new DeepWorker(queue, new AlwaysFailingProvider(), timeline, 1, deadLetters);

    await worker.runSingle();
    expect(queue.size()).toBe(1);

    await worker.runSingle();
    expect(queue.size()).toBe(0);

    const failed = await deadLetters.list();
    expect(failed.length).toBe(1);
    expect(failed[0].errorMessage).toContain("permanent failure");
    const events = await timeline.getEvents("conv-dead-letter");
    expect(events.filter((event) => event.type === "activity").map((event) => event.activity))
      .toEqual(["queued", "thinking", "retrying", "thinking", "failed"]);
    expect(new Set(events.map((event) => event.messageId)).size).toBe(1);
  });
});
