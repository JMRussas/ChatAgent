import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { LocalAuthenticator, scopedOwnerKey } from "../../src/auth/authenticator";
import type { LocalIdentity } from "../../src/auth/localIdentity";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
import { DocumentTaskSupervisor } from "../../src/app/documentTaskSupervisor";

// Operator recovery after a Node server restart, end to end: real authentication,
// real HTTP and the real Python sidecar on a temporary store seeded offline with a
// scripted fake model. Each "restart" is a fresh server, service and supervisor on
// the same store. No live model is contacted and no task is scheduled.
const PYTHON = resolve(
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"
);
const SCRIPT = resolve("experiments/doc-agent/chat_bridge.py");
const AVAILABLE = existsSync(PYTHON);
// As in documentTaskSidecar: where the sidecar is required, a missing interpreter
// fails instead of skipping this suite, even in a filtered run.
if (process.env.DOC_TASK_SIDECAR_REQUIRED === "true" && !AVAILABLE)
  it("requires the uv-managed sidecar environment", () => {
    throw new Error(
      `DOC_TASK_SIDECAR_REQUIRED is set but ${PYTHON} is missing. Create .venv with uv and install experiments/doc-agent/requirements-durable.txt.`
    );
  });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const secret = () => randomBytes(32).toString("base64url");
const newIdentity = (): LocalIdentity => ({
  version: 1,
  principalId: `local:${randomUUID()}`,
  sessionKey: secret(),
  clientToken: secret(),
  operatorToken: secret(),
  epoch: 0
});

async function seed(owner?: string) {
  const root = await mkdtemp(join(tmpdir(), "doc-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = spawnSync(
    PYTHON,
    [resolve("tests/fixtures/document_task_store.py"), root, ...(owner ? [owner] : [])],
    { encoding: "utf8" }
  );
  expect(fixture.status, fixture.stderr).toBe(0);
  return { root, ids: JSON.parse(fixture.stdout) as { paused: string; running: string } };
}

/** One server instance with its own service and sidecar supervisor; stop() ends both. */
async function instance(identity: LocalIdentity, root: string) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const tasks = new DocumentTaskSupervisor(
    () => new PythonDocumentTasks(PYTHON, SCRIPT, root),
    30_000
  );
  const server = createChatServer(service, {
    auth: new LocalAuthenticator(identity),
    documentTasks: tasks,
    documentTaskControl: tasks
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    // Closing the server also closes its sidecar; wait for the store lock to go.
    await vi.waitFor(() => expect(tasks.status().phase).toBe("closed"), { timeout: 15_000 });
    const child = (tasks as unknown as { current: { child?: PythonDocumentTasks } }).current.child;
    if (child)
      await vi.waitFor(() => expect(child.diagnostics().state).toBe("down"), {
        timeout: 15_000
      });
  };
  cleanups.unshift(stop);
  await vi.waitFor(() => expect(tasks.status().phase).toBe("ready"), { timeout: 30_000 });
  const send = (path: string, token: string, body?: unknown, method = "POST") =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  const operator = (path: string, body: unknown) =>
    send("/workers/document-tasks/" + path, identity.operatorToken, body);
  const client = (body: unknown) => send("/document-tasks", identity.clientToken, body);
  return { service, tasks, operator, client, send, identity, stop };
}

const conversationId = "conversation-1";

describe.skipIf(!AVAILABLE)("operator recovery after a server restart (offline)", () => {
  it("inspects and abandons through the stored owner, creating no ownership or access", async () => {
    const owner = newIdentity(),
      other = newIdentity();
    const ownerKey = scopedOwnerKey(owner.principalId, ["u"]);
    const { root, ids } = await seed(ownerKey);

    // Before the restart: the owner's own client reaches its tasks, and an operator
    // inspects with this server's owner record as the expected owner.
    const first = await instance(owner, root);
    const listed = await first.client({ op: "list", conversationId, userId: "u" });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as unknown[]).length).toBe(2);
    first.service.claimConversation(conversationId, ownerKey);
    const known = { expectedGeneration: 1, conversationId, taskId: ids.running };
    expect((await first.operator("inspect", known)).status).toBe(200);
    // A server owner that differs from the stored owner is refused, not preferred.
    const elsewhere = await seed(ownerKey);
    const misled = await instance(other, elsewhere.root);
    misled.service.claimConversation(conversationId, scopedOwnerKey(other.principalId, ["u"]));
    const refused = await misled.operator("inspect", { ...known, taskId: elsewhere.ids.running });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "OWNER_MISMATCH" });
    await misled.stop();
    await first.stop();

    // After the restart, served under another principal: this server knows no owner.
    const second = await instance(other, root);
    expect(second.service.conversationOwner(conversationId)).toBeUndefined();
    const stats = second.service.retentionStats();
    const target = { expectedGeneration: 1, conversationId, taskId: ids.running };
    const viewed = await second.operator("inspect", target);
    expect(viewed.status).toBe(200);
    const viewedText = await viewed.text();
    expect(viewedText).not.toContain("o1:");
    const { task } = JSON.parse(viewedText) as {
      task: { effectiveStatus: string; digest: string };
    };
    expect(task.effectiveStatus).toBe("uncertain");

    const abandon = { ...target, operationId: randomUUID(), expectedDigest: task.digest };
    const stale = await second.operator("abandon", { ...abandon, expectedGeneration: 2 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_GENERATION" });
    const done = await second.operator("abandon", abandon);
    expect(done.status).toBe(200);
    const doneText = await done.text();
    expect(doneText).not.toContain("o1:");
    expect(JSON.parse(doneText)).toMatchObject({
      generation: 1,
      receipt: { operationId: abandon.operationId, externalOutcome: "unknown" },
      task: { persistedStatus: "abandoned" }
    });
    const replayed = await second.operator("abandon", abandon);
    expect(await replayed.text()).toBe(doneText);

    // Recovery adopted nothing: no owner, scope or history on this server.
    expect(second.service.conversationOwner(conversationId)).toBeUndefined();
    expect(second.service.retentionStats()).toEqual(stats);
    // This principal's client is still refused by the durable owner, for every
    // document operation, and gains no hold on the conversation.
    for (const body of [
      { op: "list", conversationId, userId: "u" },
      { op: "status", conversationId, userId: "u", taskId: ids.paused },
      { op: "cancel", conversationId, userId: "u", taskId: ids.paused }
    ]) {
      const r = await second.client(body);
      expect(r.status, body.op).toBe(409);
      expect(await r.json()).toMatchObject({ code: "OWNER_MISMATCH" });
    }
    expect(second.service.conversationOwner(conversationId)).toBeUndefined();
    // Legacy reads of an unclaimed, empty conversation show nothing; cancelling is
    // refused because nobody here owns it.
    const events = await second.send(
      `/conversations/${conversationId}/events`,
      other.clientToken,
      undefined,
      "GET"
    );
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject({ events: [] });
    const cancel = await second.send(
      `/conversations/${conversationId}/messages/${randomUUID()}/cancel`,
      other.clientToken,
      {}
    );
    expect(cancel.status).toBe(404);
    await second.stop();

    // The owner's principal, on a later instance, still reaches its tasks.
    const third = await instance(owner, root);
    const own = await third.client({ op: "list", conversationId, userId: "u" });
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { taskId: string; status: string }[]).find(
        (t) => t.taskId === ids.running
      )
    ).toMatchObject({ status: "abandoned" });
  }, 180_000);

  it("refuses a legacy owner label rather than adopting it", async () => {
    const { root, ids } = await seed();
    const s = await instance(newIdentity(), root);
    for (const [path, body] of [
      ["inspect", { expectedGeneration: 1, conversationId, taskId: ids.running }],
      [
        "abandon",
        {
          expectedGeneration: 1,
          conversationId,
          taskId: ids.running,
          operationId: randomUUID(),
          expectedDigest: "0".repeat(64)
        }
      ]
    ] as const) {
      const r = await s.operator(path, body);
      expect(r.status, path).toBe(409);
      expect(await r.json()).toMatchObject({ code: "OWNER_UNSCOPED" });
    }
    expect(s.service.conversationOwner(conversationId)).toBeUndefined();
  }, 120_000);
});
