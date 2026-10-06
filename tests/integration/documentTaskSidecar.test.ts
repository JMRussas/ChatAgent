import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonDocumentTasks } from "../../src/app/documentTasks";

// The real Python sidecar, offline. It uses the repository's uv-managed virtual
// environment and only list requests, so no model is contacted and no task runs.
// Skipped when that interpreter is not present.
const PYTHON = resolve(
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"
);
const SCRIPT = resolve("experiments/doc-agent/chat_bridge.py");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe.skipIf(!existsSync(PYTHON))("real document-task sidecar (offline)", () => {
  async function start() {
    const root = await mkdtemp(join(tmpdir(), "doc-sidecar-"));
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
