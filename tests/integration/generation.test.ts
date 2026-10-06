import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import type { GenerationControl } from "../../src/domain/generation";
import { deriveTurns } from "../../src/ui/turnViewModel";
import { allowAllTestAuth } from "../helpers/testAuth";

it("HTTP/SSE exposes a delta before POST completes, reconnects exactly once and cancels by client ID", async () => {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  let control!: GenerationControl;
  const orchestrator = new ChatOrchestrator(
    {
      createProvisionalReply: async (_input, c) => {
        control = c!;
        await control.onDelta("partial é");
        await new Promise<void>((_resolve, reject) =>
          control.signal.addEventListener("abort", () => reject(control.signal.reason), {
            once: true
          })
        );
        return { text: "unreachable", finishReason: "stop" };
      }
    },
    queue,
    timeline
  );
  const server = createChatServer(
    new ChatService(
      orchestrator,
      new DeepWorker(queue, new MockDeepProvider(), timeline),
      timeline,
      queue
    ),
    { auth: allowAllTestAuth }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = randomUUID();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const post = () =>
    fetch(base + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: id, conversationId: "c", userId: "u", text: "hello" })
    });
  async function snapshot() {
    const response = await fetch(base + "/conversations/c/events/stream");
    const reader = response.body!.getReader();
    readers.push(reader);
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Missing SSE snapshot");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6)
    ).events;
  }
  try {
    expect(
      (await fetch(base + `/conversations/c/messages/${id}/cancel`, { method: "POST" })).status
    ).toBe(404);
    let completed = false;
    const pending = post().then((response) => {
      completed = true;
      return response;
    });
    await vi.waitFor(() => expect(control).toBeDefined());
    const first = await snapshot();
    expect(first.some((e: any) => e.type === "delta")).toBe(true);
    expect(completed).toBe(false);
    await readers[0].cancel();
    const reconnected = await snapshot();
    expect(deriveTurns(reconnected)).toEqual(deriveTurns(first));
    expect((await post()).status).toBe(409);
    expect(
      (await fetch(base + `/conversations/c/messages/${id}/cancel`, { method: "POST" })).status
    ).toBe(200);
    expect((await (await pending).json()).fastResponse.processingStatus).toBe("cancelled");
    expect(control.signal.aborted).toBe(true);
    const last = await snapshot();
    expect(deriveTurns(last)[0]).toMatchObject({
      status: "Cancelled",
      active: false,
      answers: [{ text: "partial é" }]
    });
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
