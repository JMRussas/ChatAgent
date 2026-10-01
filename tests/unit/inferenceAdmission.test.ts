import { expect, it } from "vitest";
import { AdmissionGate } from "../../experiments/doc-agent/contention_gateway";
const signal = () => new AbortController().signal;
it("prioritizes foreground without preempting active work, preserves FIFO within lanes, and limits bypass", async () => {
  const gate = new AdmissionGate("foreground-priority");
  const active = await gate.acquire("background", signal());
  const order: string[] = [];
  const queued = (lane: "foreground" | "background", label: string) =>
    gate.acquire(lane, signal()).then((release) => {
      order.push(label);
      release();
    });
  const jobs = [
    queued("background", "b1"),
    queued("background", "b2"),
    ...[1, 2, 3, 4, 5].map((n) => queued("foreground", "f" + n))
  ];
  await Promise.resolve();
  expect(order).toEqual([]);
  active();
  active(); // release is idempotent
  await Promise.all(jobs);
  expect(order).toEqual(["f1", "f2", "f3", "b1", "f4", "f5", "b2"]);
});
it("removes cancelled waiters and bounds the queue", async () => {
  const gate = new AdmissionGate("foreground-priority", 1);
  const release = await gate.acquire("background", signal());
  const cancelled = new AbortController();
  const waiting = expect(gate.acquire("foreground", cancelled.signal)).rejects.toThrow("cancel");
  await expect(gate.acquire("background", signal())).rejects.toThrow("CAPACITY_FULL");
  cancelled.abort(Error("cancel"));
  await waiting;
  const next = gate.acquire("background", signal());
  release();
  (await next)();
  await expect(gate.acquire("foreground", cancelled.signal)).rejects.toThrow("cancel");
});
it("concurrent control does not serialize calls", async () => {
  const gate = new AdmissionGate("concurrent");
  const releases = await Promise.all([
    gate.acquire("background", signal()),
    gate.acquire("foreground", signal())
  ]);
  releases.forEach((r) => r());
});
it("FIFO control preserves arrival order across lanes", async () => {
  const gate = new AdmissionGate("fifo");
  const release = await gate.acquire("background", signal());
  const order: string[] = [];
  const b = gate.acquire("background", signal()).then((r) => {
    order.push("b");
    r();
  });
  const f = gate.acquire("foreground", signal()).then((r) => {
    order.push("f");
    r();
  });
  release();
  await Promise.all([b, f]);
  expect(order).toEqual(["b", "f"]);
});
it("expires a waiting admission before dispatch and leaves the slot usable", async () => {
  const gate = new AdmissionGate("foreground-priority");
  const release = await gate.acquire("background", signal());
  await expect(gate.acquire("foreground", AbortSignal.timeout(10))).rejects.toMatchObject({
    name: "TimeoutError"
  });
  const next = gate.acquire("background", signal());
  release();
  (await next)();
});
