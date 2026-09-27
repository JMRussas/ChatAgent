import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
afterEach(() => vi.useRealTimers());
function child() {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(c as never);
  return c;
}
it("correlates JSON replies without putting the question on a command line", async () => {
  const c = child(), bridge = new PythonDocumentTasks("python", "script.py", "tasks");
  const question = "quotes ' and $(commands)\nsecond line";
  const result = bridge.request({ op: "start", question });
  const request = JSON.parse(c.stdin.read().toString());
  expect(request.question).toBe(question);
  expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).not.toContain(question);
  c.stdout.write(JSON.stringify({ id: request.id, result: { status: "queued" } }) + "\n");
  expect(await result).toEqual({ status: "queued" });
  bridge.close();c.emit("exit",0);
});
it("rejects pending and future commands when the sidecar exits", async () => {
  const c = child(), bridge = new PythonDocumentTasks("python", "script.py", "tasks");
  const pending = expect(bridge.request({ op: "list" })).rejects.toThrow("BRIDGE_UNAVAILABLE");
  c.emit("exit",1);await pending;
  await expect(bridge.request({ op: "list" })).rejects.toThrow("BRIDGE_UNAVAILABLE");
});
it("bounds waiting for an unresponsive bridge", async () => {
  vi.useFakeTimers();const c = child(), bridge = new PythonDocumentTasks("python", "script.py", "tasks");
  const pending = expect(bridge.request({ op: "list" })).rejects.toThrow("BRIDGE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(30000);await pending;
  bridge.close();c.emit("exit",0);
});
