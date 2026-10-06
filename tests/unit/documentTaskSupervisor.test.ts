import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTaskError } from "../../src/app/documentTasks";
import {
  DocumentTaskSupervisor,
  type DocumentTaskChild
} from "../../src/app/documentTaskSupervisor";

const supervisors: DocumentTaskSupervisor[] = [];
afterEach(() => {
  // Close every supervisor, which settles readiness and clears its deadline.
  for (const s of supervisors.splice(0)) s.close();
  vi.useRealTimers();
});
const track = (s: DocumentTaskSupervisor) => (supervisors.push(s), s);

const HEALTH = { service: "chatagent-document-tasks", protocol: 1 };

/** A fake sidecar bridge whose health answer and exit the test controls. */
function fakeChild() {
  let answer!: { resolve: (v: unknown) => void; reject: (e: Error) => void };
  const c = {
    state: "up" as "up" | "terminating" | "down",
    lastFailureCode: "",
    health: new Promise<unknown>((resolve, reject) => (answer = { resolve, reject })),
    requests: [] as Record<string, unknown>[],
    request: vi.fn((data: Record<string, unknown>) => {
      c.requests.push(data);
      return data.op === "health" ? c.health : Promise.resolve(`answer:${String(data.op)}`);
    }),
    abort: vi.fn((code: string) => {
      if (c.state !== "up") return;
      c.state = "terminating";
      c.lastFailureCode = code;
      answer.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE", "health"));
    }),
    close: vi.fn(() => {
      if (c.state === "up") c.state = "terminating";
    }),
    diagnostics: () => ({ state: c.state, lastFailureCode: c.lastFailureCode }),
    answer: (v: unknown) => answer.resolve(v),
    refuse: (code: string) => answer.reject(new DocumentTaskError(code, "health")),
    /** The child failed by itself, as on a crash, and its exit is confirmed. */
    crash(code = "CHILD_EXITED") {
      if (c.state === "up") c.lastFailureCode = code;
      c.state = "down";
      answer.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE", "health"));
    },
    exit() {
      c.state = "down";
    }
  };
  // Its rejection is observed by the supervisor when it asked; never left unhandled.
  c.health.catch(() => undefined);
  return c;
}
type Fake = ReturnType<typeof fakeChild>;

function supervisor(readyTimeoutMs = 5_000) {
  const children: Fake[] = [];
  const factory = vi.fn(() => {
    const c = fakeChild();
    children.push(c);
    return c as DocumentTaskChild;
  });
  const s = track(new DocumentTaskSupervisor(factory, readyTimeoutMs));
  return { s, children, factory };
}
const flush = () => new Promise((r) => setImmediate(r));
const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: v }),
    (e) => ({ code: e.code, status: e.status })
  );

describe("startup", () => {
  it("starts generation 1 and refuses work until health answers with the fixed payload", async () => {
    const { s, children } = supervisor();
    expect(s.status()).toEqual({
      phase: "starting",
      generation: 1,
      restartable: false,
      failureCode: null
    });
    await expect(s.request({ op: "list" })).rejects.toMatchObject({
      code: "BRIDGE_UNAVAILABLE",
      op: "list"
    });
    expect(children[0].requests).toEqual([{ op: "health" }]);
    children[0].answer(HEALTH);
    await flush();
    expect(s.status().phase).toBe("ready");
    expect(await s.request({ op: "list" })).toBe("answer:list");
  });

  it.each([
    ["an unexpected payload", (c: Fake) => c.answer({ ...HEALTH, protocol: 2 }), "HEALTH_INVALID"],
    ["an extra field", (c: Fake) => c.answer({ ...HEALTH, path: "/x" }), "HEALTH_INVALID"],
    ["an error reply", (c: Fake) => c.refuse("INVALID_OPERATION"), "HEALTH_REFUSED"],
    ["a request timeout", (c: Fake) => c.refuse("BRIDGE_TIMEOUT"), "HEALTH_TIMEOUT"]
  ])("never becomes ready on %s, and terminates the child", async (_, act, code) => {
    const { s, children } = supervisor();
    act(children[0]);
    await flush();
    expect(children[0].abort).toHaveBeenCalledWith(code);
    // Terminated, but kept until its exit is confirmed.
    expect(s.status()).toEqual({
      phase: "stopping",
      generation: 1,
      restartable: false,
      failureCode: code
    });
    children[0].exit();
    expect(s.status()).toMatchObject({ phase: "failed", restartable: true, failureCode: code });
    await expect(s.request({ op: "list" })).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
  });

  it.each([["CHILD_ERROR"], ["CHILD_EXITED"], ["STDOUT_CLOSED"]])(
    "reports the child's own failure (%s) without overwriting it",
    async (code) => {
      const { s, children } = supervisor();
      children[0].crash(code);
      await flush();
      expect(children[0].abort).not.toHaveBeenCalled();
      expect(s.status()).toEqual({
        phase: "failed",
        generation: 1,
        restartable: true,
        failureCode: code
      });
    }
  );

  it("terminates a child that does not answer health within the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { s, children } = supervisor(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.status().phase).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0].abort).toHaveBeenCalledWith("HEALTH_TIMEOUT");
    // A late answer changes nothing.
    children[0].answer(HEALTH);
    await flush();
    expect(s.status()).toMatchObject({ phase: "stopping", failureCode: "HEALTH_TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline once health has answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { s, children } = supervisor();
    children[0].answer(HEALTH);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.status().phase).toBe("ready");
  });

  it("turns a throwing factory into a sanitized, restartable startup failure", async () => {
    let calls = 0;
    const s = track(
      new DocumentTaskSupervisor(() => {
        calls++;
        throw new Error("spawn C:\\secret\\python.exe ENOENT");
      })
    );
    expect(s.status()).toEqual({
      phase: "failed",
      generation: 1,
      restartable: true,
      failureCode: "SPAWN_FAILED"
    });
    expect(await outcome(s.restart(1))).toMatchObject({
      code: "STARTUP_FAILED",
      status: { phase: "failed", generation: 2, failureCode: "SPAWN_FAILED" }
    });
    expect(calls).toBe(2);
  });

  it("treats a health request that throws as a refusal, terminating the kept child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = fakeChild();
    c.request.mockImplementationOnce(() => {
      throw new Error("EPIPE C:\\secret");
    });
    const s = track(new DocumentTaskSupervisor(() => c as DocumentTaskChild));
    await flush();
    expect(c.abort).toHaveBeenCalledWith("HEALTH_REFUSED");
    expect(s.status()).toEqual({
      phase: "stopping",
      generation: 1,
      restartable: false,
      failureCode: "HEALTH_REFUSED"
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not ready when health passes but the child has already failed", async () => {
    const { s, children } = supervisor();
    const c = children[0];
    c.lastFailureCode = "STDOUT_CLOSED";
    c.state = "terminating";
    c.answer(HEALTH);
    await flush();
    expect(s.status()).toMatchObject({ phase: "stopping", failureCode: "STDOUT_CLOSED" });
  });
});

describe("restart", () => {
  async function failedSupervisor() {
    const t = supervisor();
    t.children[0].crash();
    await flush();
    return t;
  }

  it("replaces only a failed generation whose exit is confirmed, and answers once ready", async () => {
    const { s, children, factory } = await failedSupervisor();
    const restarted = s.restart(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(s.status()).toMatchObject({ phase: "starting", generation: 2 });
    children[1].answer(HEALTH);
    expect(await restarted).toEqual({
      phase: "ready",
      generation: 2,
      restartable: false,
      failureCode: null
    });
    expect(await s.request({ op: "status" })).toBe("answer:status");
    // The failed child receives nothing more.
    expect(children[0].requests).toEqual([{ op: "health" }]);
  });

  it("refuses a healthy, starting or still-terminating generation without spawning", async () => {
    const { s, children, factory } = supervisor();
    expect(await outcome(s.restart(1))).toMatchObject({
      code: "NOT_FAILED",
      status: { phase: "starting" }
    });
    children[0].answer(HEALTH);
    await flush();
    expect(await outcome(s.restart(1))).toMatchObject({
      code: "NOT_FAILED",
      status: { phase: "ready" }
    });
    children[0].state = "terminating";
    expect(await outcome(s.restart(1))).toMatchObject({
      code: "NOT_EXITED",
      status: { phase: "stopping" }
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(children[0].abort).not.toHaveBeenCalled();
    expect(children[0].close).not.toHaveBeenCalled();
  });

  it("spawns at most once for concurrent and stale restarts", async () => {
    const { s, children, factory } = await failedSupervisor();
    const first = s.restart(1);
    const concurrent = outcome(s.restart(1));
    const stale = outcome(s.restart(7));
    expect(await concurrent).toMatchObject({
      code: "STALE_GENERATION",
      status: { generation: 2 }
    });
    expect(await stale).toMatchObject({ code: "STALE_GENERATION" });
    expect(factory).toHaveBeenCalledTimes(2);
    children[1].answer(HEALTH);
    expect((await first).phase).toBe("ready");
  });

  it("reports a replacement that never becomes ready as a startup failure", async () => {
    const { s, children } = await failedSupervisor();
    const restarted = outcome(s.restart(1));
    children[1].crash("CHILD_EXITED");
    expect(await restarted).toMatchObject({
      code: "STARTUP_FAILED",
      status: { phase: "failed", generation: 2, failureCode: "CHILD_EXITED" }
    });
  });

  it("ignores everything an earlier generation does afterwards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { s, children } = supervisor();
    // Generation 1 times out, is terminated and exits.
    await vi.advanceTimersByTimeAsync(5_000);
    children[0].exit();
    const restarted = s.restart(1);
    children[1].answer(HEALTH);
    await restarted;
    // Its late health answer and any later state cannot touch generation 2.
    children[0].answer(HEALTH);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.status()).toEqual({
      phase: "ready",
      generation: 2,
      restartable: false,
      failureCode: null
    });
    expect(children[1].abort).not.toHaveBeenCalled();
  });

  it("refuses to number a generation past the largest safe integer", async () => {
    const { s, children } = await failedSupervisor();
    (s as unknown as { current: { number: number } }).current.number = Number.MAX_SAFE_INTEGER;
    expect(await outcome(s.restart(Number.MAX_SAFE_INTEGER))).toMatchObject({
      code: "STARTUP_FAILED"
    });
    expect(children).toHaveLength(1);
  });
});

describe("close", () => {
  it("settles a pending restart at once, clears the deadline and never promotes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { s, children, factory } = supervisor();
    children[0].crash();
    await flush();
    const restarted = outcome(s.restart(1));
    s.close();
    expect(await restarted).toMatchObject({ code: "CLOSED", status: { phase: "closed" } });
    expect(vi.getTimerCount()).toBe(0);
    // The child is closed, not forgotten: a late health answer promotes nothing.
    expect(children[1].close).toHaveBeenCalledTimes(1);
    children[1].answer(HEALTH);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.status().phase).toBe("closed");
    expect(children[1].abort).not.toHaveBeenCalled();
    await expect(s.request({ op: "list" })).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
    expect(await outcome(s.restart(2))).toMatchObject({ code: "CLOSED" });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("closes a ready child once and spawns nothing afterwards", async () => {
    const { s, children, factory } = supervisor();
    children[0].answer(HEALTH);
    await flush();
    s.close();
    s.close();
    expect(children[0].close).toHaveBeenCalledTimes(1);
    children[0].exit();
    expect(s.status()).toMatchObject({ phase: "closed", restartable: false });
    expect(await outcome(s.restart(1))).toMatchObject({ code: "CLOSED" });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
