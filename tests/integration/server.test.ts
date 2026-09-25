import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ChatService } from "../../src/app/chatService";
import type { DeepResult, DeepTask } from "../../src/domain/types";
import type { DeepModelProvider } from "../../src/providers/interfaces";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});

describe("chat server", () => {
  it("supports provisional then refined flow through HTTP endpoints", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const messageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-http",
        userId: "user-http",
        text: "Find latest inflation data and cite sources"
      })
    });

    expect(messageResponse.status).toBe(200);

    const messagePayload = (await messageResponse.json()) as {
      fastResponse: { processingStatus: string };
    };
    expect(messagePayload.fastResponse.processingStatus).toBe("provisional");

    const runWorkerResponse = await fetch(`${baseUrl}/workers/deep/run-once`, {
      method: "POST"
    });
    expect(runWorkerResponse.status).toBe(200);

    const eventsResponse = await fetch(`${baseUrl}/conversations/conv-http/events`);
    expect(eventsResponse.status).toBe(200);

    const eventsPayload = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(eventsPayload.events.map((e) => e.type)).toEqual(["user", "provisional", "refined"]);
  });

  it("exposes dead-letter records and supports replay", async () => {
    class AlwaysFailingProvider implements DeepModelProvider {
      async resolveDeepTask(_input: DeepTask): Promise<DeepResult> {
        throw new Error("forced failure");
      }
    }

    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const deadLetters = new InMemoryDeadLetterStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new AlwaysFailingProvider(), timeline, 0, deadLetters);
    const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-dead-letter-http",
        userId: "user-http",
        text: "Find latest inflation data and cite sources"
      })
    });

    await fetch(`${baseUrl}/workers/deep/run-once`, { method: "POST" });

    const listResponse = await fetch(`${baseUrl}/workers/deep/dead-letters`);
    expect(listResponse.status).toBe(200);

    const listPayload = (await listResponse.json()) as {
      records: Array<{ task: { taskId: string } }>;
    };
    expect(listPayload.records.length).toBe(1);

    const taskId = listPayload.records[0].task.taskId;
    const replayResponse = await fetch(`${baseUrl}/workers/deep/dead-letters/${taskId}/replay`, {
      method: "POST"
    });
    expect(replayResponse.status).toBe(200);

    const listAfterReplay = await fetch(`${baseUrl}/workers/deep/dead-letters`);
    const afterPayload = (await listAfterReplay.json()) as {
      records: Array<{ task: { taskId: string } }>;
    };
    expect(afterPayload.records.length).toBe(0);
    expect(queue.size()).toBe(1);
  });
});
