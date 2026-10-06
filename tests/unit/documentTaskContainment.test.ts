import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { PythonDocumentTasks } from "../../src/app/documentTasks";

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
});

function child() {
  const c = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  });
  vi.mocked(spawn).mockReturnValue(c as never);
  return c;
}
type Child = ReturnType<typeof child>;
const bridge = () => new PythonDocumentTasks("python", "script.py", "tasks");
/** Requests written so far, parsed. */
const sent = (c: Child) =>
  String(c.stdin.read() ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const reply = (c: Child, data: string | Buffer) =>
  new Promise<void>((resolve) => c.stdout.write(data, () => setImmediate(resolve)));
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => `${e.code}${e.op ? `:${e.op}` : ""}`
  );

describe("framing", () => {
  it("joins chunks, keeps a multibyte character split across them, and accepts CRLF", async () => {
    const c = child(),
      b = bridge();
    const first = b.request({ op: "status" }),
      second = b.request({ op: "status" });
    const line = Buffer.from('{"id":1,"result":"é"}\n{"id":2,"result":2}\r\n');
    const split = line.indexOf(Buffer.from("é")) + 1; // inside the two-byte é
    await reply(c, line.subarray(0, split));
    await reply(c, line.subarray(split));
    expect(await first).toBe("é");
    expect(await second).toBe(2);
    expect(b.diagnostics().state).toBe("up");
  });

  it("assembles a line delivered one byte per chunk", async () => {
    const c = child(),
      b = bridge();
    const pending = b.request({ op: "status" });
    const line = Buffer.from(JSON.stringify({ id: 1, result: "x".repeat(3000) + "é" }) + "\n");
    for (let i = 0; i < line.length - 1; i++) c.stdout.write(line.subarray(i, i + 1));
    await reply(c, line.subarray(line.length - 1));
    expect(await pending).toBe("x".repeat(3000) + "é");
    expect(b.diagnostics().state).toBe("up");
  });

  it("fails on a line over 1 MiB, complete or not, without buffering past the bound", async () => {
    for (const ending of ["", "\n"]) {
      const c = child(),
        b = bridge();
      const pending = code(b.request({ op: "status" }));
      // One chunk: an unterminated line, or a complete newline-terminated one.
      await reply(c, Buffer.concat([Buffer.alloc(1024 * 1024 + 1, 0x61), Buffer.from(ending)]));
      expect(await pending).toBe("BRIDGE_UNAVAILABLE:status");
      expect(b.diagnostics()).toMatchObject({
        state: "terminating",
        lastFailureCode: "LINE_TOO_LONG"
      });
      expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("accepts a line of exactly 1 MiB", async () => {
    const c = child(),
      b = bridge();
    const pending = b.request({ op: "status" });
    const shell = JSON.stringify({ id: 1, result: "" });
    const line = JSON.stringify({ id: 1, result: "y".repeat(1024 * 1024 - shell.length) });
    expect(Buffer.byteLength(line)).toBe(1024 * 1024);
    await reply(c, line + "\n");
    expect(((await pending) as string).length).toBe(1024 * 1024 - shell.length);
    expect(b.diagnostics().state).toBe("up");
  });

  it("fails on invalid UTF-8 and on malformed JSON", async () => {
    for (const bad of [Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), Buffer.from("not json\n")]) {
      const c = child(),
        b = bridge();
      const pending = code(b.request({ op: "list" }));
      await reply(c, bad);
      expect(await pending).toBe("BRIDGE_UNAVAILABLE:list");
      expect(b.diagnostics().lastFailureCode).toBe("MALFORMED_RESPONSE");
    }
  });

  it("stops processing the rest of a chunk at the first failure", async () => {
    const c = child(),
      b = bridge();
    const first = code(b.request({ op: "list" })),
      second = code(b.request({ op: "list" }));
    await reply(c, 'garbage\n{"id":2,"result":"must not resolve"}\n');
    expect(await first).toBe("BRIDGE_UNAVAILABLE:list");
    expect(await second).toBe("BRIDGE_UNAVAILABLE:list");
  });

  it("does not look at anything after the failing line, not even a late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    const timedOut = code(b.request({ op: "status" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    await reply(c, 'garbage\n{"id":1,"result":"late"}\n');
    expect(b.diagnostics()).toMatchObject({
      lateReplies: 0,
      lastFailureCode: "MALFORMED_RESPONSE"
    });
  });
});

describe("response envelope", () => {
  it("accepts exactly {id, result} or {id, error: CODE}", async () => {
    for (const bad of [
      { id: 1, result: 1, extra: true },
      { id: 0, result: 1 },
      { id: -1, result: 1 },
      { id: 1.5, result: 1 },
      { id: "1", result: 1 },
      { id: 1, error: "lowercase" },
      { id: 1, error: "X".repeat(65) },
      { id: 1, error: 7 },
      { id: 1, result: 1, error: "BOTH" },
      { id: 1 },
      [1],
      null
    ]) {
      const c = child(),
        b = bridge();
      const pending = code(b.request({ op: "status" }));
      await reply(c, JSON.stringify(bad) + "\n");
      expect(await pending, JSON.stringify(bad)).toBe("BRIDGE_UNAVAILABLE:status");
    }
    const c = child(),
      b = bridge();
    const ok = code(b.request({ op: "status" }));
    await reply(c, '{"id":1,"error":"TASK_NOT_FOUND"}\n');
    expect(await ok).toBe("TASK_NOT_FOUND:status");
    expect(b.diagnostics().state).toBe("up");
  });
});

describe("replies that match no pending request", () => {
  it("drops one late reply for a timed-out request; any other id is a protocol failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    const timedOut = code(b.request({ op: "status" }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await timedOut).toBe("BRIDGE_TIMEOUT:status");
    await reply(c, '{"id":1,"result":"late"}\n');
    expect(b.diagnostics()).toMatchObject({ state: "up", lateReplies: 1 });
    expect(c.kill).not.toHaveBeenCalled();
    // A second reply for the same id is not late but a disagreement.
    await reply(c, '{"id":1,"result":"again"}\n');
    expect(b.diagnostics()).toMatchObject({
      state: "terminating",
      lastFailureCode: "UNKNOWN_RESPONSE_ID"
    });
  });

  it("fails on an id that was never sent", async () => {
    const c = child(),
      b = bridge();
    await reply(c, '{"id":99,"result":1}\n');
    expect(b.diagnostics().lastFailureCode).toBe("UNKNOWN_RESPONSE_ID");
  });

  it("remembers only the last 64 timed-out ids", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    // Timed out one at a time, so pending never exceeds its own limit.
    for (let i = 0; i < 65; i++) {
      const p = code(b.request({ op: "status" }));
      await vi.advanceTimersByTimeAsync(30_000);
      await p;
    }
    // id 2 is still remembered; id 1 was evicted, so its reply is a failure.
    await reply(c, '{"id":2,"result":"late"}\n');
    expect(b.diagnostics()).toMatchObject({ state: "up", lateReplies: 1 });
    await reply(c, '{"id":1,"result":"late"}\n');
    expect(b.diagnostics().lastFailureCode).toBe("UNKNOWN_RESPONSE_ID");
  });
});

describe("what an unanswered request reports", () => {
  it("on failure: sent start, resume and cancel are uncertain; reads are unavailable", async () => {
    const c = child(),
      b = bridge();
    const results = ["start", "resume", "cancel", "list", "status"].map((op) =>
      code(b.request({ op }))
    );
    c.emit("exit", 1);
    expect(await Promise.all(results)).toEqual([
      "BRIDGE_UNCERTAIN:start",
      "BRIDGE_UNCERTAIN:resume",
      "BRIDGE_UNCERTAIN:cancel",
      "BRIDGE_UNAVAILABLE:list",
      "BRIDGE_UNAVAILABLE:status"
    ]);
  });

  it("on timeout: mutations are uncertain, reads time out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    child();
    const b = bridge();
    const start = code(b.request({ op: "start" })),
      list = code(b.request({ op: "list" }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect([await start, await list]).toEqual(["BRIDGE_UNCERTAIN:start", "BRIDGE_TIMEOUT:list"]);
  });

  it("a full write buffer still counts as sent; a throwing write does not", async () => {
    const c = child(),
      b = bridge();
    vi.spyOn(c.stdin, "write").mockReturnValueOnce(false as never);
    const buffered = code(b.request({ op: "start" }));
    c.emit("exit", 1);
    expect(await buffered).toBe("BRIDGE_UNCERTAIN:start");

    const c2 = child(),
      b2 = bridge();
    vi.spyOn(c2.stdin, "write").mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    expect(await code(b2.request({ op: "start" }))).toBe("BRIDGE_UNAVAILABLE:start");
    expect(b2.diagnostics().lastFailureCode).toBe("STDIN_ERROR");
  });

  it("after a failure, new requests are unavailable and never written", async () => {
    const c = child(),
      b = bridge();
    c.emit("exit", 1);
    expect(await code(b.request({ op: "start" }))).toBe("BRIDGE_UNAVAILABLE:start");
    expect(sent(c)).toEqual([]);
  });
});

describe("termination", () => {
  it("terminates once, escalates to SIGKILL only if the child outlives the grace, and never respawns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    await reply(c, "garbage\n");
    expect(c.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(c.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(b.diagnostics().state).toBe("terminating");
    c.emit("exit", null);
    expect(b.diagnostics().state).toBe("down");
    expect(vi.getTimerCount()).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not escalate when the child exits within the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    await reply(c, "garbage\n");
    c.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(b.diagnostics().state).toBe("down");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails at once when stdout ends while the child is still alive, even mid-line", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    const start = code(b.request({ op: "start" })),
      list = code(b.request({ op: "list" }));
    await reply(c, '{"id":1,"res');
    c.stdout.end();
    // Settled immediately, not after the 30 second deadline.
    expect([await start, await list]).toEqual([
      "BRIDGE_UNCERTAIN:start",
      "BRIDGE_UNAVAILABLE:list"
    ]);
    expect(b.diagnostics()).toMatchObject({
      state: "terminating",
      lastFailureCode: "STDOUT_CLOSED"
    });
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    c.emit("exit", null);
    expect(b.diagnostics().state).toBe("down");
  });

  it("ignores stdout closing as expected after a failure or close", async () => {
    const c = child(),
      b = bridge();
    await reply(c, "garbage\n");
    c.stdout.end();
    await new Promise((r) => setImmediate(r));
    expect(b.diagnostics()).toMatchObject({
      protocolFailures: 1,
      lastFailureCode: "MALFORMED_RESPONSE"
    });
  });

  it("settles a failed spawn, which emits error and close but never exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    const pending = code(b.request({ op: "start" }));
    c.emit("error", new Error("ENOENT"));
    c.emit("close", -2);
    expect(await pending).toBe("BRIDGE_UNCERTAIN:start");
    expect(b.diagnostics().state).toBe("down");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close settles pending once, clears request timers, and kills only if the child lingers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = child(),
      b = bridge();
    const start = code(b.request({ op: "start" })),
      list = code(b.request({ op: "list" }));
    b.close();
    b.close();
    expect([await start, await list]).toEqual([
      "BRIDGE_UNCERTAIN:start",
      "BRIDGE_UNAVAILABLE:list"
    ]);
    expect(c.stdin.writableEnded).toBe(true);
    expect(c.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    c.emit("exit", null);
    expect(vi.getTimerCount()).toBe(0);
    expect(b.diagnostics().state).toBe("down");
  });
});
