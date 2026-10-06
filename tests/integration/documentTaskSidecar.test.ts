import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
import { DocumentTaskSupervisor } from "../../src/app/documentTaskSupervisor";
import { abandonResultSchema, taskViewSchema } from "../../src/server";

// The real Python sidecar, offline. It uses the repository's uv-managed virtual
// environment, temporary stores and seeded checkpoints. No live model is contacted.
// A missing interpreter fails when required; otherwise these cases are skipped.
const PYTHON = resolve(
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"
);
const SCRIPT = resolve("experiments/doc-agent/chat_bridge.py");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

// CI sets DOC_TASK_SIDECAR_REQUIRED=true: there a missing interpreter is a failure,
// not a silent skip. Elsewhere (Windows CI, local runs) the suite is optional.
const AVAILABLE = existsSync(PYTHON);
if (process.env.DOC_TASK_SIDECAR_REQUIRED === "true" && !AVAILABLE)
  it("requires the uv-managed sidecar environment", () => {
    throw new Error(
      `DOC_TASK_SIDECAR_REQUIRED is set but ${PYTHON} is missing. Create .venv with uv and install experiments/doc-agent/requirements-durable.txt.`
    );
  });

describe.skipIf(!AVAILABLE)("real document-task sidecar (offline)", () => {
  async function start(existing?: string) {
    const root = existing ?? (await mkdtemp(join(tmpdir(), "doc-sidecar-")));
    const bridge = new PythonDocumentTasks(PYTHON, SCRIPT, root);
    cleanups.push(async () => {
      bridge.close();
      await vi.waitFor(() => expect(bridge.diagnostics().state).toBe("down"), { timeout: 15_000 });
      await rm(root, { recursive: true, force: true });
    });
    const list = () => bridge.request({ op: "list", conversationId: "c", userId: "u" });
    return { root, bridge, list };
  }

  it("answers a list, and once killed stays down without respawning or re-sending", async () => {
    const s = await start();
    expect(await s.list()).toEqual([]);
    const pid = (s.bridge as unknown as { child: { pid: number } }).child.pid;
    process.kill(pid, "SIGKILL");
    await vi.waitFor(() => expect(s.bridge.diagnostics().state).toBe("down"), { timeout: 15_000 });
    // Whichever is observed first: the reply channel closing or the exit itself.
    expect(["CHILD_EXITED", "STDOUT_CLOSED"]).toContain(s.bridge.diagnostics().lastFailureCode);
    await expect(s.list()).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
  }, 60_000);

  it("delivers non-ASCII labels exactly, whatever the sidecar's stdin encoding", async () => {
    // 150 supplementary characters are 150 Python code points, within the sidecar's
    // 200-character scope limit only if each surrogate pair arrives as one character.
    const conversationId = "\u{1d11e}".repeat(150);
    const owner = "é".repeat(200);
    // The owner is written by Python itself, offline, from ASCII-escaped JSON; the
    // labels sent over stdin must then match it exactly.
    const root = await mkdtemp(join(tmpdir(), "doc-sidecar-"));
    const seeded = spawnSync(
      PYTHON,
      [
        resolve("tests/fixtures/document_task_owner.py"),
        root,
        JSON.stringify({ conversationId, userId: owner }).replace(
          /[\u0080-\uffff]/g,
          (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
        )
      ],
      { encoding: "utf8" }
    );
    expect(seeded.status, seeded.stderr).toBe(0);
    const s = await start(root);
    expect(await s.bridge.request({ op: "list", conversationId, userId: owner })).toEqual([]);
    // The stored owner is the exact string: one different accent is someone else.
    await expect(
      s.bridge.request({ op: "list", conversationId, userId: "é".repeat(199) + "è" })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    await expect(
      s.bridge.request({ op: "list", conversationId, userId: "é".repeat(201) })
    ).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    expect(s.bridge.diagnostics()).toMatchObject({ state: "up", protocolFailures: 0 });
  }, 60_000);

  it("is answered for a line of exactly the sidecar's limit and refuses a longer one before sending it", async () => {
    const s = await start();
    const request = (bytes: number) => {
      const data = { op: "list", conversationId: "c", userId: "u", pad: "é".repeat(2000) };
      // Escaped é is six bytes; the rest of the line is ASCII. The id here is 2 or 3.
      const json = JSON.stringify({ ...data, id: 2 });
      return { ...data, pad: data.pad + "x".repeat(bytes - (json.length + 5 * 2000 + 1)) };
    };
    expect(await s.list()).toEqual([]);
    expect(await s.bridge.request(request(16_000))).toEqual([]);
    await expect(s.bridge.request(request(16_001))).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE"
    });
    expect(await s.list()).toEqual([]);
    expect(s.bridge.diagnostics()).toMatchObject({ state: "up", protocolFailures: 0 });
  }, 60_000);

  it("refuses a second sidecar on the same root while the first is alive", async () => {
    const s = await start();
    // The first sidecar holds its exclusive owner lock once it is serving.
    expect(await s.list()).toEqual([]);
    const second = spawn(PYTHON, [SCRIPT, "--root", s.root], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let spawnError: Error | undefined;
    second.stderr.on("data", (chunk) => (stderr += chunk));
    second.on("error", (error) => (spawnError = error));
    const closed = new Promise<number | null>((done) => second.once("close", done));
    // Registered before any wait, and run before the first sidecar's cleanup, so a
    // second sidecar that wrongly keeps serving cannot hold the root open.
    cleanups.unshift(async () => {
      if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
      await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000))]);
    });
    const exitCode = await Promise.race([
      closed,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))
    ]);
    expect(spawnError).toBeUndefined();
    expect(exitCode).not.toBe("timeout");
    expect(exitCode).not.toBe(0);
    // Refused by the owner lock specifically, not by some unrelated failure.
    expect(stderr).toMatch(/database is locked/);
    // The first is unaffected.
    expect(await s.list()).toEqual([]);
  }, 60_000);
});

describe.skipIf(!AVAILABLE)("real document-task supervisor (offline)", () => {
  type Internals = { current: { child?: PythonDocumentTasks } };
  const childOf = (s: DocumentTaskSupervisor) =>
    (s as unknown as Internals).current.child as PythonDocumentTasks;
  const exited = (s: DocumentTaskSupervisor) =>
    vi.waitFor(() => expect(childOf(s).diagnostics().state).toBe("down"), { timeout: 15_000 });
  const ready = (s: DocumentTaskSupervisor) =>
    vi.waitFor(() => expect(s.status().phase).toBe("ready"), { timeout: 30_000 });

  async function supervise(root: string) {
    const s = new DocumentTaskSupervisor(
      () => new PythonDocumentTasks(PYTHON, SCRIPT, root),
      30_000
    );
    cleanups.unshift(async () => {
      s.close();
      await exited(s);
    });
    return s;
  }

  it("restarts a crashed sidecar on the same store without scheduling or replaying work", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-supervisor-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fixture = spawnSync(PYTHON, [resolve("tests/fixtures/document_task_store.py"), root], {
      encoding: "utf8"
    });
    expect(fixture.status, fixture.stderr).toBe(0);
    const ids = JSON.parse(fixture.stdout) as { paused: string; running: string };
    const scope = { conversationId: "conversation-1", userId: "owner-1" };
    const tasks = async (s: DocumentTaskSupervisor) =>
      (await s.request({ op: "list", ...scope })) as Record<string, unknown>[];
    // The paused task's durable checkpoint and the scripted model's call log.
    const checkpoint = join(root, `${ids.paused}.sqlite`);
    const evidence = async () => ({
      checkpoint: createHash("sha256")
        .update(await readFile(checkpoint))
        .digest("hex"),
      modelCalls: (await readFile(join(root, "fixture.calls"), "utf8")).trim().split("\n")
    });
    const before = await evidence();
    expect(before.modelCalls).toEqual(["0"]);

    const s = await supervise(root);
    await ready(s);
    const listed = await tasks(s);
    expect(listed).toMatchObject([
      {
        taskId: ids.paused,
        question: "A paused question",
        status: "paused",
        modelCalls: 1,
        scheduled: false
      },
      // Abandoned while running: uncertain, and never resumed automatically.
      { taskId: ids.running, question: "A running question", status: "uncertain", scheduled: false }
    ]);
    const expected = listed;

    process.kill((childOf(s) as unknown as { child: { pid: number } }).child.pid, "SIGKILL");
    await exited(s);
    expect(s.status()).toMatchObject({ phase: "failed", generation: 1, restartable: true });
    await expect(s.request({ op: "list", ...scope })).rejects.toMatchObject({
      code: "BRIDGE_UNAVAILABLE"
    });

    expect(await s.restart(1)).toEqual({
      phase: "ready",
      generation: 2,
      restartable: false,
      failureCode: null
    });
    // Same tasks, same views, nothing scheduled; the checkpoint is byte-identical and
    // no model was called again.
    expect(await tasks(s)).toEqual(expected);
    expect(await evidence()).toEqual(before);
    // The owner survives the restart.
    await expect(
      s.request({ op: "list", conversationId: "conversation-1", userId: "someone-else" })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  }, 120_000);

  it("lets an operator inspect and abandon an orphaned task, keeping its checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-supervisor-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fixture = spawnSync(PYTHON, [resolve("tests/fixtures/document_task_store.py"), root], {
      encoding: "utf8"
    });
    expect(fixture.status, fixture.stderr).toBe(0);
    const ids = JSON.parse(fixture.stdout) as { paused: string; running: string };
    const scope = { conversationId: "conversation-1", userId: "owner-1" };
    const checkpoint = join(root, `${ids.paused}.sqlite`);
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(checkpoint))
        .digest("hex");
    const before = await hash();
    const s = await supervise(root);
    await ready(s);
    const { result: view } = (await s.operate(1, {
      op: "inspect_task",
      ...scope,
      taskId: ids.running
    })) as { result: { persistedStatus: string; effectiveStatus: string; digest: string } };
    expect(view).toMatchObject({ persistedStatus: "running", effectiveStatus: "uncertain" });
    // The real sidecar output satisfies the server's operator response contract.
    expect(taskViewSchema.safeParse(view).success).toBe(true);
    const request = {
      op: "abandon_task",
      ...scope,
      taskId: ids.running,
      operationId: "00000000-0000-4000-8000-000000000001",
      expectedDigest: view.digest
    };
    const first = await s.operate(1, request);
    expect(first.result).toMatchObject({
      receipt: { previousStatus: "running", externalOutcome: "unknown" },
      task: { persistedStatus: "abandoned" }
    });
    expect(abandonResultSchema.safeParse(first.result).success).toBe(true);
    // Resending the same operation replays the recorded outcome exactly.
    expect(await s.operate(1, request)).toEqual(first);
    const listed = (await s.request({ op: "list", ...scope })) as Record<string, unknown>[];
    expect(listed.find((t) => t.taskId === ids.running)).toMatchObject({
      status: "abandoned",
      answer: null,
      externalOutcome: "unknown"
    });
    // The paused task and its checkpoint are untouched.
    expect(listed.find((t) => t.taskId === ids.paused)).toMatchObject({ status: "paused" });
    expect(await hash()).toBe(before);
  }, 120_000);

  it("never becomes ready while another sidecar holds the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-supervisor-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await supervise(root);
    await ready(first);
    const second = await supervise(root);
    await exited(second);
    expect(second.status()).toMatchObject({ phase: "failed", generation: 1, restartable: true });
    expect(second.status().failureCode).toMatch(/^(CHILD_EXITED|STDOUT_CLOSED)$/);
    // The first is unaffected.
    expect(first.status().phase).toBe("ready");
  }, 120_000);
});
