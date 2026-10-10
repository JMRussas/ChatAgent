import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQueueCli } from "../../scripts/runCheckpointQueue";
import { claimKeyOf, type ContinuationResult } from "../../src/checkpoint/checkpointContinuation";
import { runQueueService, type QueueDeps } from "../../src/checkpoint/checkpointQueueService";
import { fetchCoordinationStatus } from "../../src/integrations/hekate/devCoordination";
import {
  initialRecord,
  queueLockPath,
  queueRecordPath,
  queueStopPath,
  withTransition,
  type QueueRecord
} from "../../src/checkpoint/checkpointQueueState";
import { OTHER_REF } from "../helpers/checkpointFixtures";
import {
  makeQueueFixture,
  waitForRecord,
  type QueueFixture,
  type QueueFixtureOptions
} from "../helpers/queueServiceFixtures";

/**
 * Real loopback plan API with a request log, real linked worktrees and the real unchanged
 * continuation with owned worker and check processes. The worker is a local stand-in, so none of
 * this proves real model delivery. Tests marked as seam tests inject only the continuation function.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const open: QueueFixture[] = [];
afterEach(async () => {
  for (const fx of open.splice(0)) await fx.cleanup();
});
const make = async (count: number, options?: QueueFixtureOptions) => {
  const fx = await makeQueueFixture(count, options);
  open.push(fx);
  return fx;
};
const arm = (fx: QueueFixture, extra?: QueueDeps) =>
  runQueueService(fx.bytes(), "arm", fx.deps(extra));
const resume = (fx: QueueFixture, extra?: QueueDeps) =>
  runQueueService(fx.bytes(), "resume", fx.deps(extra));
/** Ordered `node:transition` pairs of every mutating request the plan API received. */
const mutations = (fx: QueueFixture) =>
  fx.plan
    .posts()
    .map((r) => `${fx.plan.nodes.findIndex((n) => r.path.includes(n.id))}:${String(r.body?.to)}`);
const lockFile = (fx: QueueFixture) => queueLockPath(fx.queueDir, fx.queue.queueId);
const waiting = (index: number) => (r: QueueRecord) => r.items[index].state === "waiting_review";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("successful sequencing", () => {
  it("starts and finishes one targeted node per item; B starts only after external acceptance of A", async () => {
    const fx = await make(2, { after: { 1: [0] }, unrelated: 1 });
    const running = arm(fx);

    const first = await waitForRecord(fx, waiting(0));
    // Blocked successor and unrelated ready sibling are untouched while A awaits review.
    expect(first.items[1].state).toBe("pending");
    expect(fx.plan.nodes.map((n) => n.work)).toEqual(["done", "todo", "todo"]);
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
    expect(fx.plan.posts(0)[0].body).toMatchObject({
      to: "in_progress",
      attemptId: "at-1",
      executorRef: "exec-1",
      expectedStateRevision: 0,
      actor: "queue-operator"
    });
    expect(first.admitted).toEqual({
      units: 10,
      outputBytes: 1024 * 1024,
      providerCapMicros: 100_000
    });
    expect(fx.workerLog()).toHaveLength(1);

    const acceptedAt = Date.now();
    fx.plan.accept(0);
    await waitForRecord(fx, waiting(1));
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done", "1:in_progress", "1:done"]);
    expect(fx.workerLog()[1]).toBeGreaterThanOrEqual(acceptedAt);

    fx.plan.accept(1);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.record).toMatchObject({
      phase: "completed",
      reason: "all_accepted",
      index: 2,
      invocations: 1,
      integration: "not_observed",
      delivery: "not_sent",
      wake: "none"
    });
    expect(result.record!.items.map((i) => i.state)).toEqual(["accepted", "accepted"]);
    // Final acceptance and completion were one publication: exactly one terminal transition,
    // the persisted record parses as completed, and the accepted items match the returned ones.
    const terminal = result.record!.transitions.filter((t) => t.phase === "completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ reason: "all_accepted", index: 2 });
    expect(result.record!.transitions[result.record!.transitions.length - 1]).toBe(terminal[0]);
    expect(fx.record()).toEqual(result.record);
    expect(fx.plan.posts(0)).toHaveLength(2);
    expect(fx.plan.posts(1)).toHaveLength(2);
    expect(fx.workerLog()).toHaveLength(2);
    // Never the global first-ready claim route, and the unrelated sibling was never mutated.
    expect(fx.plan.log.some((r) => r.path.includes("claims"))).toBe(false);
    expect(fx.plan.posts(2)).toEqual([]);
    expect(existsSync(lockFile(fx))).toBe(false);
  });
});

describe("authority before any effect", () => {
  it("refuses a dirty source, a changed content revision, over-admission and an unavailable API without a POST", async () => {
    const dirty = await make(1);
    writeFileSync(join(dirty.worktree(0), "src", "a.ts"), "export const a = 99;\n");
    expect((await arm(dirty)).refusal).toBe("source_invalid");

    const changed = await make(1);
    changed.plan.nodes[0].contentRevision = 2;
    expect((await arm(changed)).refusal).toBe("authority_mismatch");

    const started = await make(1);
    started.plan.nodes[0].work = "in_progress";
    expect((await arm(started)).refusal).toBe("authority_mismatch");

    const heavy = await make(2, { totalUnits: 15 });
    expect((await arm(heavy)).refusal).toBe("admission_exceeded");

    const down = await make(1);
    down.plan.readMode = "down";
    expect((await arm(down)).refusal).toBe("authority_unavailable");

    for (const fx of [dirty, changed, started, heavy, down]) {
      expect(fx.plan.posts()).toEqual([]);
      expect(fx.workerLog()).toEqual([]);
      expect(readdirSync(fx.queueDir)).toEqual([]);
    }
  });

  it("refuses changed item bytes and unknown manifest fields before any plan request", async () => {
    const fx = await make(1);
    writeFileSync(fx.itemPaths[0], `${readFileSync(fx.itemPaths[0], "utf8")} `);
    expect((await arm(fx)).refusal).toBe("item_pin_mismatch");

    const extra = Buffer.from(JSON.stringify({ ...fx.queue, command: "rm" }));
    expect((await runQueueService(extra, "arm", fx.deps())).refusal).toBe("manifest_invalid");
    expect(fx.plan.log).toEqual([]);
    expect(readdirSync(fx.queueDir)).toEqual([]);
  });

  it.each([
    ["content", "fence_moved"],
    ["source", "source_invalid"]
  ])("a stale %s for the next node prevents its POST and launch", async (kind, reason) => {
    const fx = await make(2, { after: { 1: [0] } });
    const running = arm(fx);
    await waitForRecord(fx, waiting(0));
    if (kind === "content") fx.plan.nodes[1].contentRevision = 2;
    else writeFileSync(join(fx.worktree(1), "src", "a.ts"), "export const a = 99;\n");
    fx.plan.accept(0);
    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.record).toMatchObject({ phase: "needs_operator", reason, index: 1 });
    expect(result.record!.items[1].state).toBe("pending");
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
    expect(fx.workerLog()).toHaveLength(1);
  });

  it.each([
    ["artifact", { artifactRef: OTHER_REF }, "acceptance_mismatch"],
    ["epoch", { epochBump: true }, "fence_moved"],
    ["actor", { decidedBy: "intruder" }, "acceptor_not_allowed"]
  ])("a wrong %s acceptance does not advance", async (_name, decision, reason) => {
    const fx = await make(2, { after: { 1: [0] } });
    const running = arm(fx);
    await waitForRecord(fx, waiting(0));
    fx.plan.accept(0, decision);
    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.record).toMatchObject({ phase: "needs_operator", reason, index: 0 });
    expect(result.record!.items[0].state).toBe("waiting_review");
    // The successor became ready in PlanStore, but nothing exact was accepted: no start.
    expect(fx.plan.nodes[1].work).toBe("todo");
    expect(fx.plan.posts(1)).toEqual([]);
  });
});

describe("repair regressions", () => {
  const claimLease = (fx: QueueFixture, index: number) =>
    join(fx.items[index].run.recordDir, `.claim-${claimKeyOf(fx.items[index].run.identity)}.lease`);

  it("waits on a current pending review beside an older decision until a new exact acceptance", async () => {
    const fx = await make(1, { epoch: 2 });
    const running = arm(fx);
    const pending = await waitForRecord(fx, waiting(0));
    fx.plan.recordOlderDecision(0);
    // Several polls see review_pending plus acceptanceHistorical; none may end or advance the wait.
    await new Promise((done) => setTimeout(done, 400));
    expect(fx.record()).toEqual(pending);
    expect(fx.record()!.phase).toBe("running");
    fx.plan.accept(0);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.record).toMatchObject({ phase: "completed", reason: "all_accepted", index: 1 });
    expect(result.record!.items[0]).toEqual({ ...pending.items[0], state: "accepted" });
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
  });

  it("refuses a preexisting runner claim lease without a start, a worker or removing it", async () => {
    const armed = await make(1);
    writeFileSync(claimLease(armed, 0), '{"marker":true}');
    expect((await arm(armed)).refusal).toBe("source_invalid");
    expect(armed.plan.posts()).toEqual([]);
    expect(armed.workerLog()).toEqual([]);
    expect(readFileSync(claimLease(armed, 0), "utf8")).toBe('{"marker":true}');

    // The same slot check guards the pre-start refusal of a later item.
    const fx = await make(2, { after: { 1: [0] } });
    const running = arm(fx);
    await waitForRecord(fx, waiting(0));
    writeFileSync(claimLease(fx, 1), '{"marker":true}');
    fx.plan.accept(0);
    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.record).toMatchObject({ phase: "needs_operator", reason: "source_invalid" });
    expect(result.record!.items[1]).toMatchObject({ state: "pending", start: "not_attempted" });
    expect(fx.plan.posts(1)).toEqual([]);
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
    expect(fx.workerLog()).toHaveLength(1);
    expect(readFileSync(claimLease(fx, 1), "utf8")).toBe('{"marker":true}');
  });

  it("stops cleanly when the sentinel appears during the final preflight authority read", async () => {
    const fx = await make(1);
    let reads = 0;
    const result = await arm(fx, {
      // Read 1 is the arm-time TODO check; read 2 is the start preflight for the only item.
      fetchStatus: async (...args) => {
        const status = await fetchCoordinationStatus(...args);
        if (++reads === 2) writeFileSync(queueStopPath(fx.queueDir, fx.queue.queueId), "");
        return status;
      }
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result.exitCode).toBe(3);
    expect(result.record).toMatchObject({
      phase: "stopped",
      reason: "stop_requested",
      admitted: { units: 0, outputBytes: 0, providerCapMicros: 0 }
    });
    expect(result.record!.items[0]).toMatchObject({ state: "pending", start: "not_attempted" });
    expect(fx.plan.posts()).toEqual([]);
    expect(fx.workerLog()).toEqual([]);
    // Only the owned lock was removed; the operator's sentinel is left for the operator.
    expect(existsSync(lockFile(fx))).toBe(false);
    expect(existsSync(queueStopPath(fx.queueDir, fx.queue.queueId))).toBe(true);
  });
});

describe("lock and ownership", () => {
  it("refuses a duplicate owner and a retained lock without altering either", async () => {
    const retained = await make(1);
    writeFileSync(lockFile(retained), '{"retained":true}');
    expect((await arm(retained)).refusal).toBe("lock_exists");
    expect(readFileSync(lockFile(retained), "utf8")).toBe('{"retained":true}');
    expect(existsSync(queueRecordPath(retained.queueDir, retained.queue.queueId))).toBe(false);
    expect(retained.plan.posts()).toEqual([]);

    const fx = await make(1);
    const running = arm(fx);
    const before = await waitForRecord(fx, waiting(0));
    expect((await arm(fx)).refusal).toBe("lock_exists");
    expect(fx.record()!.generation).toBe(before.generation);
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
    fx.plan.accept(0);
    expect((await running).exitCode).toBe(0);
  });

  it("stops writing and leaves a replaced lock token alone", async () => {
    const fx = await make(1);
    const running = arm(fx);
    await waitForRecord(fx, waiting(0));
    const foreign = JSON.stringify({ queueId: fx.queue.queueId, token: "someone-else" });
    writeFileSync(lockFile(fx), foreign);
    fx.plan.accept(0);
    const result = await running;
    expect(result.exitCode).toBe(4);
    expect(readFileSync(lockFile(fx), "utf8")).toBe(foreign);
    expect(fx.record()!.items[0].state).toBe("waiting_review");
    expect(readdirSync(fx.queueDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("uncertain starts never replay", () => {
  it.each([
    ["drop", "start_uncertain", "uncertain"],
    ["conflict", "start_conflict", "conflict"]
  ] as const)(
    "a %s response keeps the intent and launches nothing",
    async (mode, reason, start) => {
      const fx = await make(1);
      fx.plan.startMode = mode;
      const result = await arm(fx);
      expect(result.exitCode).toBe(1);
      expect(result.record).toMatchObject({ phase: "needs_operator", reason });
      expect(result.record!.items[0]).toMatchObject({ state: "needs_operator", start });
      expect(result.record!.admitted.units).toBe(10);
      expect(fx.workerLog()).toEqual([]);
      expect(mutations(fx)).toEqual(["0:in_progress"]);

      // Neither a second arm nor a resume may send another start.
      fx.plan.startMode = "ok";
      expect((await arm(fx)).refusal).toBe("record_exists");
      expect((await resume(fx)).refusal).toBe("not_resumable");
      expect(mutations(fx)).toEqual(["0:in_progress"]);
      expect(fx.plan.nodes[0].work).toBe("todo");
    }
  );

  it("a record left at starting after a crash cannot be resumed or replayed", async () => {
    const fx = await make(1);
    const crashed = withTransition(
      initialRecord(fx.queue, sha(fx.bytes()), fx.items, "2026-10-09T10:00:00.000Z"),
      {},
      "2026-10-09T10:00:01.000Z"
    );
    crashed.items[0] = { ...crashed.items[0], state: "starting", start: "attempted" };
    crashed.admitted = { ...crashed.items[0].admission };
    writeFileSync(queueRecordPath(fx.queueDir, fx.queue.queueId), JSON.stringify(crashed));
    expect((await resume(fx)).refusal).toBe("not_resumable");
    expect(fx.plan.posts()).toEqual([]);
    expect(fx.workerLog()).toEqual([]);
    expect(existsSync(lockFile(fx))).toBe(false);
  });

  it("refuses an unreadable or foreign retained record on resume", async () => {
    const fx = await make(1);
    const path = queueRecordPath(fx.queueDir, fx.queue.queueId);
    writeFileSync(path, "{not json");
    expect((await resume(fx)).refusal).toBe("record_invalid");
    const foreign = initialRecord(fx.queue, "f".repeat(64), fx.items, "2026-10-09T10:00:00.000Z");
    writeFileSync(path, JSON.stringify(foreign));
    expect((await resume(fx)).refusal).toBe("record_mismatch");
    expect(fx.plan.log).toEqual([]);
    expect(existsSync(lockFile(fx))).toBe(false);
  });

  it("does not trust a continuation outcome without matching terminal records (seam test)", async () => {
    const refused = await make(2, { after: { 1: [0] } });
    const none = await arm(refused, {
      continuation: async () => ({ exitCode: 2, record: null, refusal: "worktree_invalid" })
    });
    expect(none.record).toMatchObject({ phase: "needs_operator", reason: "continuation_refused" });
    expect(none.record!.items[0]).toMatchObject({
      state: "needs_operator",
      continuation: "refused"
    });
    expect(mutations(refused)).toEqual(["0:in_progress"]);

    const forged = await make(1);
    const claimed = {
      phase: "review_pending",
      reason: "checks_passed",
      gate: "written",
      sourceRef: "c".repeat(40)
    };
    const result = await arm(forged, {
      continuation: async (): Promise<ContinuationResult> => ({
        exitCode: 0,
        record: claimed as never
      })
    });
    expect(result.record).toMatchObject({ phase: "needs_operator", reason: "continuation_failed" });
    expect(result.record!.items[0].state).toBe("needs_operator");
  });
});

describe("bounded waits, stop and resume", () => {
  it("stops cleanly at review timeout, keeps admission on resume and revalidates pins", async () => {
    const fx = await make(1, { reviewWaitMs: 200 });
    const first = await arm(fx);
    expect(first.exitCode).toBe(3);
    expect(first.record).toMatchObject({
      phase: "stopped",
      reason: "review_timeout",
      invocations: 1
    });
    expect(first.record!.items[0].state).toBe("waiting_review");
    expect(existsSync(lockFile(fx))).toBe(false);

    // --show is read-only: no plan request, no change to the retained bytes.
    const bytesBefore = readFileSync(queueRecordPath(fx.queueDir, fx.queue.queueId));
    const requests = fx.plan.log.length;
    const shown = await runQueueCli(["--manifest", fx.manifestPath, "--show"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout[0])).toMatchObject({
      recordState: "valid",
      manifestMatchesRecord: true,
      lock: "absent",
      metadata: "retained",
      writerLiveness: "unknown"
    });
    expect(fx.plan.log).toHaveLength(requests);
    expect(readFileSync(queueRecordPath(fx.queueDir, fx.queue.queueId))).toEqual(bytesBefore);

    // A moved source refuses the resume and leaves the stopped record untouched.
    const dirtyFile = join(fx.worktree(0), "src", "dirty.ts");
    writeFileSync(dirtyFile, "export {};\n");
    expect((await resume(fx)).refusal).toBe("source_invalid");
    expect(readFileSync(queueRecordPath(fx.queueDir, fx.queue.queueId))).toEqual(bytesBefore);
    rmSync(dirtyFile);

    fx.plan.accept(0);
    const second = await resume(fx);
    expect(second.exitCode).toBe(0);
    expect(second.record).toMatchObject({ phase: "completed", invocations: 2 });
    expect(second.record!.transitions.filter((t) => t.phase === "completed")).toHaveLength(1);
    expect(second.record!.items[0]).toEqual({ ...first.record!.items[0], state: "accepted" });
    expect(fx.record()).toEqual(second.record);
    // Persisted admission was kept, not reset or double counted, and no second start or worker ran.
    expect(second.record!.admitted).toEqual(first.record!.admitted);
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);
    expect(fx.workerLog()).toHaveLength(1);
  });

  it("reports an unavailable API as a clean stop that advances nothing", async () => {
    const fx = await make(1, { reviewWaitMs: 150 });
    const result = await arm(fx, {
      sleep: async () => {
        fx.plan.readMode = "down";
        await new Promise((done) => setTimeout(done, 40));
      }
    });
    expect(result.exitCode).toBe(3);
    expect(result.record).toMatchObject({ phase: "stopped", reason: "authority_unavailable" });
    expect(result.record!.items[0].state).toBe("waiting_review");
  });

  it("stops cleanly when the queue wall bound is reached while waiting", async () => {
    const fx = await make(1);
    let skew = 0;
    const result = await arm(fx, {
      monotonicNow: () => performance.now() + skew,
      sleep: async () => {
        skew = 10_000_000;
      }
    });
    expect(result.exitCode).toBe(3);
    expect(result.record).toMatchObject({ phase: "stopped", reason: "wall_exceeded" });
    expect(result.record!.items[0].state).toBe("waiting_review");
  });

  it("lets the current child settle on a graceful stop, starts nothing else, then resumes", async () => {
    const fx = await make(2, { after: { 1: [0] } });
    const running = arm(fx);
    await waitForRecord(fx, (r) => r.items[0].state === "running");
    const stop = await runQueueCli(["--manifest", fx.manifestPath, "--stop"]);
    expect(stop.exitCode).toBe(0);
    expect(existsSync(queueStopPath(fx.queueDir, fx.queue.queueId))).toBe(true);

    const stopped = await running;
    expect(stopped.exitCode).toBe(3);
    expect(stopped.record).toMatchObject({ phase: "stopped", reason: "stop_requested", index: 0 });
    // The running child completed its bounded work; nothing further was started.
    expect(stopped.record!.items[0].state).toBe("waiting_review");
    expect(fx.workerLog()).toHaveLength(1);
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done"]);

    fx.plan.accept(0);
    const resumed = runQueueCli(["--manifest", fx.manifestPath, "--resume"], fx.deps());
    await waitForRecord(fx, waiting(1));
    expect(existsSync(queueStopPath(fx.queueDir, fx.queue.queueId))).toBe(false);
    fx.plan.accept(1);
    const finished = await resumed;
    expect(finished.exitCode).toBe(0);
    expect(JSON.parse(finished.stdout[0])).toMatchObject({ phase: "completed", invocations: 2 });
    expect(mutations(fx)).toEqual(["0:in_progress", "0:done", "1:in_progress", "1:done"]);
  });
});
