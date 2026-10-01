/** Real Node HTTP -> Python -> local Ollama check, with mock foreground providers. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createChatServer } from "../../src/server";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";

const [python, output] = process.argv.slice(2);
if (!python || !output)
  throw new Error("Usage: chat_smoke.ts python-executable fresh-output-directory");
await mkdir(output, { recursive: false });
await writeFile(resolve(output, ".gitignore"), "tasks/\n");
const bridge = new PythonDocumentTasks(
  python,
  resolve("experiments/doc-agent/chat_bridge.py"),
  resolve(output, "tasks")
);
const queue = new InMemoryTaskQueue(),
  timeline = new InMemoryConversationTimelineStore();
const service = new ChatService(
  new ChatOrchestrator(new MockFastProvider(), queue, timeline),
  new DeepWorker(queue, new MockDeepProvider(), timeline),
  timeline
);
const server = createChatServer(service, { documentTasks: bridge });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const records: unknown[] = [];
async function post(path: string, body: unknown) {
  const start = performance.now();
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  records.push({
    path,
    request: body,
    status: response.status,
    elapsedMs: performance.now() - start,
    data
  });
  return { status: response.status, data };
}
const scope = { conversationId: "smoke-" + randomUUID(), userId: "local-smoke" };
try {
  const question =
    "Does the implemented ContextManager wait for a new background summary before answering?";
  const request = { ...scope, op: "start", requestId: randomUUID(), question };
  const a = await post("/document-tasks", request);
  if (a.status !== 202) throw new Error("Task admission failed");
  const duplicate = await post("/document-tasks", request);
  if (duplicate.data.taskId !== a.data.taskId) throw new Error("Duplicate start created new task");
  const b = await post("/document-tasks", {
    ...scope,
    op: "start",
    requestId: randomUUID(),
    question: "What is the default summary mode?"
  });
  await post("/document-tasks", { ...scope, op: "cancel", taskId: b.data.taskId });
  const foreground = await post("/messages", { ...scope, text: "hello" });
  if (foreground.status !== 200) throw new Error("Foreground chat failed");
  const denied = await post("/document-tasks", { ...scope, userId: "other", op: "list" });
  if (denied.status !== 409) throw new Error("Ownership guard failed");
  let tasks: any[] = [];
  for (let n = 0; n < 90; n++) {
    tasks = (await post("/document-tasks", { ...scope, op: "list" })).data;
    if (tasks.every((t) => ["completed", "failed", "cancelled", "uncertain"].includes(t.status)))
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (tasks.find((t) => t.taskId === b.data.taskId)?.status !== "cancelled")
    throw new Error("Cancellation failed");
  if (!tasks.some((t) => t.taskId === a.data.taskId && ["completed", "failed"].includes(t.status)))
    throw new Error("Task did not settle");
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ foreground: "mock", background: "local gemma4:26b", tasks, records }, null, 2)
  );
  console.log(
    JSON.stringify({
      tasks: tasks.map((t) => ({ taskId: t.taskId, status: t.status })),
      foregroundStatus: foreground.status
    })
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
