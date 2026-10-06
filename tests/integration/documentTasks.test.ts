import { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";
import { DocumentTaskError } from "../../src/app/documentTasks";
import { allowAllTestAuth } from "../helpers/testAuth";
const servers: ReturnType<typeof createChatServer>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function setup(enabled = true) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline
  );
  const bridge = {
    request: vi.fn(async (_: Record<string, unknown>): Promise<unknown> => ({
      taskId: "a".repeat(32),
      status: "queued"
    })),
    close: vi.fn()
  };
  const server = createChatServer(service, {
    auth: allowAllTestAuth,
    ...(enabled ? { documentTasks: bridge } : {})
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  return { base, bridge, post };
}
const scope = { conversationId: "c", userId: "u" };
it("acknowledges background tasks without awaiting inference and still serves chat", async () => {
  const { base, bridge, post } = await setup();
  const submitted = await post("/document-tasks", {
    ...scope,
    op: "start",
    requestId: crypto.randomUUID(),
    question: "Read the docs"
  });
  expect(submitted.status).toBe(202);
  expect((await submitted.json()).status).toBe("queued");
  const chat = await post("/messages", { ...scope, text: "hello" });
  expect(chat.status).toBe(200);
  const html = await (await fetch(base)).text();
  expect(html).toContain('id="documentTaskStart"');
  expect(html).toContain('id="sendButton"');
  expect(bridge.request).toHaveBeenCalledOnce();
});
it("keeps foreground HTTP responsive while a task command is pending", async () => {
  const { bridge, post } = await setup();
  let release!: (v: unknown) => void;
  bridge.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      })
  );
  const pending = post("/document-tasks", { ...scope, op: "list" });
  await vi.waitFor(() => expect(release).toBeDefined());
  try {
    expect((await post("/messages", { ...scope, text: "hello" })).status).toBe(200);
  } finally {
    release([]);
    await pending;
  }
});
it("checks ownership, validates input and maps admission failure", async () => {
  const { bridge, post } = await setup();
  await post("/messages", { ...scope, text: "hello" });
  expect((await post("/document-tasks", { ...scope, userId: "other", op: "list" })).status).toBe(
    409
  );
  expect((await post("/document-tasks", { ...scope, op: "start" })).status).toBe(400);
  expect(bridge.request).not.toHaveBeenCalled();
  bridge.request.mockRejectedValueOnce(new DocumentTaskError("CAPACITY_FULL"));
  expect(
    (
      await post("/document-tasks", {
        ...scope,
        op: "start",
        requestId: crypto.randomUUID(),
        question: "q"
      })
    ).status
  ).toBe(429);
});
it("leaves the task feature disabled by default", async () => {
  const { base, post } = await setup(false);
  expect((await post("/document-tasks", { ...scope, op: "list" })).status).toBe(404);
  expect(await (await fetch(base)).text()).not.toContain('id="documentTaskStart"');
});
