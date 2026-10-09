import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTINUATION_LIMITS,
  continuationRecordPath,
  serializeContinuationRecord,
  type ContinuationRecord
} from "../../src/checkpoint/checkpointContinuation";
import { budgetRecordPath } from "../../src/checkpoint/checkpointRecord";
import type { CheckpointRecordEntry } from "../../src/config/checkpointRecordsConfig";
import type { CheckpointBudgetView } from "../../src/integrations/hekate/checkpointBudget";
import {
  CONTINUATION_READ_LIMITS,
  finalizeContinuation,
  projectContinuation,
  readContinuation,
  type ContinuationTask,
  type ContinuationView,
  type ReadContinuationOptions
} from "../../src/integrations/hekate/checkpointContinuationView";
import {
  BASE_REF,
  FENCE,
  OTHER_REF,
  RUN_ID,
  SOURCE_REF,
  STAMP,
  makeRecord
} from "../helpers/checkpointFixtures";
import { ROOT_A, guid, leaf, rootView } from "../helpers/executiveFixtures";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), "ckpt-cont-view-"));
  dirs.push(dir);
  return dir;
}

const NAMES = ["prettier", "typescript", "vitest"] as const;
const check = (
  name: (typeof NAMES)[number],
  result: "pass" | "fail" | "unavailable" = "pass"
): ContinuationRecord["checks"][number] => ({
  name,
  result,
  ran: result !== "unavailable",
  exitCode: result === "pass" ? 0 : result === "fail" ? 1 : null,
  signal: null,
  timedOut: false,
  outputLimited: false,
  outputBytes: 10,
  outputSha256: "e".repeat(64),
  startedAt: STAMP,
  endedAt: STAMP
});

/** A record that satisfies the closed continuation schema; `over` selects the phase. */
function continuation(over: Partial<ContinuationRecord> = {}): ContinuationRecord {
  return {
    schema: "checkpoint-continuation/v1",
    runId: RUN_ID,
    identity: { ...FENCE, observedStateRevision: 4, executorRef: "exec-1" },
    baseRef: BASE_REF,
    phase: "reserved",
    reason: "in_progress",
    startedAt: STAMP,
    updatedAt: STAMP,
    endedAt: null,
    sourceRef: null,
    worker: null,
    finish: "not_attempted",
    checkRole: "mimir_external_checks",
    checks: [],
    gate: "not_written",
    failureAttribution: "unattributed",
    leadAcceptance: "pending",
    semanticReview: "not_performed",
    delivery: "not_sent",
    wake: "none",
    acknowledgment: "none",
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    ...over
  };
}

const IN_FLIGHT: Partial<ContinuationTask> = { state: "in_progress", artifactRef: null };
const FINISHED: Partial<ContinuationTask> = { state: "review_pending", artifactRef: SOURCE_REF };
const SOURCED = { sourceRef: SOURCE_REF, finish: "confirmed", gate: "written" } as const;
const TERMINAL = { endedAt: STAMP } as const;

/** One record per phase, with the task state that phase legitimately follows. */
const PHASES: Record<
  string,
  { record: Partial<ContinuationRecord>; task: Partial<ContinuationTask> }
> = {
  reserved: { record: {}, task: IN_FLIGHT },
  running: { record: { phase: "running" }, task: IN_FLIGHT },
  snapshotting: { record: { phase: "snapshotting" }, task: IN_FLIGHT },
  verifying: {
    record: {
      phase: "verifying",
      sourceRef: SOURCE_REF,
      finish: "confirmed",
      checks: NAMES.map((n) => check(n, "unavailable"))
    },
    task: FINISHED
  },
  review_pending: {
    record: {
      ...TERMINAL,
      ...SOURCED,
      phase: "review_pending",
      reason: "checks_passed",
      checks: NAMES.map((n) => check(n))
    },
    task: FINISHED
  },
  needs_operator: {
    record: {
      ...TERMINAL,
      ...SOURCED,
      phase: "needs_operator",
      reason: "check_failed",
      checks: [check("prettier"), check("typescript", "fail"), check("vitest", "unavailable")]
    },
    task: FINISHED
  }
};

const reportedBudget = (runId = RUN_ID): CheckpointBudgetView => ({
  state: "reported",
  record: makeRecord({ runId }),
  gate: { state: "unavailable", reason: "missing" },
  overdueUnreported: false
});

interface Spec {
  record?: Partial<ContinuationRecord>;
  task?: Partial<ContinuationTask>;
  budget?: CheckpointBudgetView;
  options?: ReadContinuationOptions;
  /** Raw file bytes instead of a serialized record. */
  raw?: string | Buffer;
  /** Skip creating the file. */
  absent?: boolean;
}

async function run(spec: Spec = {}) {
  const dir = await tmp();
  const path = continuationRecordPath(dir, RUN_ID);
  if (!spec.absent)
    await writeFile(path, spec.raw ?? serializeContinuationRecord(continuation(spec.record)));
  const entry = {
    rootId: FENCE.rootId,
    nodeId: FENCE.nodeId,
    recordPath: budgetRecordPath(dir, RUN_ID),
    continuationRecordPath: path
  };
  const task: ContinuationTask = {
    attemptId: FENCE.attemptId,
    attemptEpoch: FENCE.attemptEpoch,
    contentRevision: FENCE.contentRevision,
    artifactRef: null,
    state: "in_progress",
    ...spec.task
  };
  const budget = "budget" in spec ? spec.budget : reportedBudget();
  return { dir, view: await readContinuation(entry, task, budget, spec.options) };
}
const reason = (view: ContinuationView) => (view.state === "unavailable" ? view.reason : "shown");

describe("each recorded phase", () => {
  it.each([
    ["reserved", "none"],
    ["running", "none"],
    ["snapshotting", "none"],
    ["verifying", "none"],
    ["review_pending", "review_pending"],
    ["needs_operator", "needs_operator"]
  ])("%s is shown as an open phase with attention %s", async (phase, attention) => {
    // Only a reserved run can precede its budget record; every later phase has one registered.
    const budget: Spec =
      phase === "reserved" ? { budget: { state: "unavailable", reason: "missing" } } : {};
    const { view } = await run({ ...PHASES[phase], ...budget });
    expect(view).toMatchObject({ state: "reported", phase, relevance: "open", attention });
  });
});

describe("what the view exposes", () => {
  it("is a closed projection: no hashes, base, executor, acceptance, paths or raw fields", async () => {
    const { view, dir } = await run({
      ...PHASES.needs_operator,
      record: {
        ...PHASES.needs_operator.record,
        worker: {
          stop: { kind: "exited", code: "exited" },
          exit: { code: 0, signal: null },
          consumed: { units: 3, wallMs: 10, outputBytes: 99, counterState: "exact_observed" },
          providerReported: { numTurns: 4, costUsd: 0.5, status: "unverified" }
        }
      }
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        "attention",
        "checks",
        "endedAt",
        "finish",
        "gate",
        "phase",
        "reason",
        "relevance",
        "runId",
        "semanticReview",
        "sourceRef",
        "startedAt",
        "state",
        "trust",
        "updatedAt",
        "worker",
        "writerLiveness"
      ].sort()
    );
    const text = JSON.stringify(view);
    for (const secret of ["e".repeat(64), BASE_REF, "exec-1", dir, "leadAcceptance", "costUsd"])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/accept/i);
    expect(view).toMatchObject({
      worker: { stopKind: "exited", stopCode: "exited", exitCode: 0, signal: null },
      trust: "supplied_not_authenticated",
      writerLiveness: "unknown",
      semanticReview: "not_performed"
    });
  });
});

describe("verifier failure, review pending and task acceptance stay separate", () => {
  it("shows failed checks as needing the operator, never as review", async () => {
    const { view } = await run(PHASES.needs_operator);
    expect(view).toMatchObject({
      phase: "needs_operator",
      attention: "needs_operator",
      checks: [
        { name: "prettier", result: "pass" },
        { name: "typescript", result: "fail", exitCode: 1 },
        { name: "vitest", result: "unavailable", ran: false }
      ]
    });
  });

  it("shows passed checks as awaiting review, which is not acceptance", async () => {
    const { view } = await run(PHASES.review_pending);
    expect(view).toMatchObject({ phase: "review_pending", attention: "review_pending" });
  });

  it("does not ask for review of an accepted task from an old terminal phase", async () => {
    const accepted = { ...FINISHED, state: "accepted" } as const;
    for (const phase of ["review_pending", "needs_operator"]) {
      const { view } = await run({ record: PHASES[phase].record, task: accepted });
      expect(view).toMatchObject({
        state: "reported",
        phase,
        relevance: "settled",
        attention: "none"
      });
    }
    // Checks never promote a task: the same passing record on a pending task is only pending.
    const pending = await run(PHASES.review_pending);
    expect(pending.view).toMatchObject({ relevance: "open" });
  });

  it("never shows an in-flight phase as current for an accepted task", async () => {
    const { view } = await run({ record: PHASES.running.record, task: { state: "accepted" } });
    expect(view).toEqual({ state: "unavailable", reason: "stale_state" });
  });
});

describe("unavailable files stay explicit", () => {
  it("reports a missing file and reads nothing when no path is configured", async () => {
    expect((await run({ absent: true })).view).toEqual({ state: "unavailable", reason: "missing" });
    let calls = 0;
    const view = await readContinuation(
      { rootId: FENCE.rootId, nodeId: FENCE.nodeId, recordPath: "/x/y.budget.json" },
      { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3, artifactRef: null, state: "ready" },
      undefined,
      {
        io: {
          lstat: (() => {
            calls++;
            throw new Error("must not read");
          }) as never
        }
      }
    );
    expect(view).toEqual({ state: "unavailable", reason: "missing" });
    expect(calls).toBe(0);
  });

  it("refuses a directory and a symlink-like entry as unreadable", async () => {
    const dir = await tmp();
    const path = continuationRecordPath(dir, RUN_ID);
    await mkdir(path);
    const entry = {
      rootId: FENCE.rootId,
      nodeId: FENCE.nodeId,
      recordPath: budgetRecordPath(dir, RUN_ID),
      continuationRecordPath: path
    };
    const task = { ...FENCE, artifactRef: null, state: "in_progress" } as const;
    expect(await readContinuation(entry, task, reportedBudget())).toEqual({
      state: "unavailable",
      reason: "unreadable"
    });
    const link = await readContinuation(entry, task, reportedBudget(), {
      io: {
        lstat: (async () => ({
          isSymbolicLink: () => true,
          isFile: () => true,
          size: 10
        })) as never
      }
    });
    expect(link).toEqual({ state: "unavailable", reason: "unreadable" });
  });

  it("refuses an oversize file before parsing it", async () => {
    const big = "x".repeat(CONTINUATION_LIMITS.maxRecordBytes + 1);
    expect((await run({ raw: big })).view).toEqual({ state: "unavailable", reason: "too_large" });
    // A file that grows after the size check is still bounded while reading.
    const grown = await run({
      raw: serializeContinuationRecord(continuation()),
      options: {
        io: {
          lstat: (async () => ({
            isSymbolicLink: () => false,
            isFile: () => true,
            size: 10
          })) as never,
          open: (async () => ({
            stat: async () => ({ isFile: () => true, size: 10 }),
            read: async (buffer: Buffer) => {
              buffer.fill(32);
              return { bytesRead: buffer.length };
            },
            close: async () => undefined
          })) as never
        }
      }
    });
    expect(grown.view).toEqual({ state: "unavailable", reason: "too_large" });
    expect(CONTINUATION_READ_LIMITS.maxBytes).toBe(CONTINUATION_LIMITS.maxRecordBytes);
  });

  it("refuses malformed, unsupported and non-closed content", async () => {
    expect((await run({ raw: "{not json" })).view).toEqual({
      state: "unavailable",
      reason: "invalid"
    });
    const base = JSON.parse(serializeContinuationRecord(continuation()));
    const raw = (patch: object) => JSON.stringify({ ...base, ...patch });
    expect((await run({ raw: raw({ schema: "checkpoint-continuation/v2" }) })).view).toEqual({
      state: "unavailable",
      reason: "unsupported_schema"
    });
    expect((await run({ raw: raw({ extra: "<img src=x>" }) })).view).toEqual({
      state: "unavailable",
      reason: "invalid"
    });
    // An impossible combination: review_pending that never wrote its gate.
    expect(
      (
        await run({
          raw: raw({ phase: "review_pending", reason: "checks_passed", endedAt: STAMP })
        })
      ).view
    ).toEqual({ state: "unavailable", reason: "invalid" });
  });

  it("times out a read that never settles", async () => {
    const { view } = await run({
      options: { deadlineMs: 20, io: { open: (() => new Promise(() => undefined)) as never } }
    });
    expect(view).toEqual({ state: "unavailable", reason: "timeout" });
  });
});

describe("exact matching", () => {
  it.each([
    ["root", { rootId: guid(9) }],
    ["node", { nodeId: guid(100, 9) }],
    ["attempt", { attemptId: "at-2" }],
    ["epoch", { attemptEpoch: 3 }],
    ["content", { contentRevision: 4 }]
  ])("a different %s is a stale identity", async (_name, identity) => {
    const { view } = await run({
      record: { identity: { ...continuation().identity, ...identity } }
    });
    expect(view).toEqual({ state: "unavailable", reason: "stale_identity" });
  });

  it("a task without a current attempt matches nothing", async () => {
    const { view } = await run({ task: { attemptId: null } });
    expect(view).toEqual({ state: "unavailable", reason: "stale_identity" });
  });

  it("refuses a record whose run is not the file's run or the registered budget run", async () => {
    expect((await run({ record: { runId: guid(7) } })).view).toEqual({
      state: "unavailable",
      reason: "run_mismatch"
    });
    expect((await run({ budget: reportedBudget(guid(8)) })).view).toEqual({
      state: "unavailable",
      reason: "run_mismatch"
    });
  });

  it("refuses to guess the run when the budget record cannot confirm it", async () => {
    const missing: CheckpointBudgetView = { state: "unavailable", reason: "missing" };
    const stale: CheckpointBudgetView = { state: "unavailable", reason: "stale_identity" };
    // Only a reserved run can legitimately precede its budget record.
    expect((await run({ ...PHASES.reserved, budget: missing })).view).toMatchObject({
      state: "reported"
    });
    for (const budget of [missing, stale]) {
      expect((await run({ ...PHASES.running, budget })).view).toEqual({
        state: "unavailable",
        reason: "run_unverified"
      });
    }
    expect((await run({ ...PHASES.reserved, budget: stale })).view).toEqual({
      state: "unavailable",
      reason: "run_unverified"
    });
    expect((await run({ ...PHASES.reserved, budget: undefined })).view).toEqual({
      state: "unavailable",
      reason: "run_unverified"
    });
  });

  it("refuses a continuation with a contradictory source base for the same run", async () => {
    expect((await run({ record: { baseRef: OTHER_REF } })).view).toEqual({
      state: "unavailable",
      reason: "stale_source"
    });
  });

  it("matches the candidate source for source-bearing phases", async () => {
    for (const phase of ["verifying", "review_pending", "needs_operator"]) {
      const spec = PHASES[phase];
      for (const artifactRef of [OTHER_REF, null])
        expect(
          (await run({ record: spec.record, task: { ...spec.task, artifactRef } })).view
        ).toEqual({ state: "unavailable", reason: "stale_source" });
    }
    // A candidate that exists before the finish is also refused against another artifact.
    const early = await run({
      record: { phase: "snapshotting", sourceRef: SOURCE_REF, finish: "attempted" },
      task: { state: "review_pending", artifactRef: OTHER_REF }
    });
    expect(early.view).toEqual({ state: "unavailable", reason: "stale_source" });
    // ...but is current while the task has not recorded any artifact yet.
    const pending = await run({
      record: { phase: "snapshotting", sourceRef: SOURCE_REF, finish: "attempted" },
      task: IN_FLIGHT
    });
    expect(pending.view).toMatchObject({ state: "reported", phase: "snapshotting" });
  });

  it("refuses a review_pending phase for a task that is no longer awaiting review", async () => {
    const { view } = await run({
      record: PHASES.review_pending.record,
      task: { state: "rejected", artifactRef: SOURCE_REF }
    });
    expect(view).toEqual({ state: "unavailable", reason: "stale_state" });
  });
});

describe("summary projection", () => {
  async function scene(
    specs: { phase: string; task?: Partial<ContinuationTask> }[],
    extra: { skipPath?: number; max?: number } = {}
  ) {
    const dir = await tmp();
    const registry: CheckpointRecordEntry[] = [];
    const leaves = [];
    for (let i = 0; i < specs.length; i++) {
      const n = i + 1;
      const spec = specs[i];
      const runId = guid(60, n);
      const identity = {
        ...FENCE,
        nodeId: guid(100, n),
        observedStateRevision: 4,
        executorRef: "e"
      };
      const base = PHASES[spec.phase];
      const path = continuationRecordPath(dir, runId);
      await writeFile(
        path,
        serializeContinuationRecord(continuation({ ...base.record, runId, identity }))
      );
      const task = { ...base.task, ...spec.task };
      leaves.push(
        leaf(n, task.state ?? "in_progress", {
          attemptId: FENCE.attemptId,
          attemptEpoch: FENCE.attemptEpoch,
          contentRevision: FENCE.contentRevision,
          artifactRef: task.artifactRef ?? null
        })
      );
      registry.push({
        rootId: ROOT_A,
        nodeId: guid(100, n),
        recordPath: budgetRecordPath(dir, runId),
        ...(extra.skipPath === i ? {} : { continuationRecordPath: path })
      });
    }
    const root = rootView(ROOT_A, "Root", leaves);
    for (const task of root.tasks) {
      const entry = registry.find((e) => e.nodeId === task.nodeId)!;
      const runId = guid(60, Number(task.nodeId.split("-")[4]));
      task.continuation = await readContinuation(entry, task, reportedBudget(runId));
    }
    return { root, registry, summary: projectContinuation([root], registry, extra.max) };
  }

  it("counts every phase, separates settled and unavailable, and ranks attention first", async () => {
    const { summary } = await scene([
      { phase: "reserved" },
      { phase: "running" },
      { phase: "snapshotting" },
      { phase: "verifying" },
      { phase: "review_pending" },
      { phase: "needs_operator" },
      { phase: "review_pending", task: { state: "accepted" } },
      { phase: "running", task: { state: "accepted" } }
    ]);
    expect(summary.phases).toEqual({
      reserved: 1,
      running: 1,
      snapshotting: 1,
      verifying: 1,
      review_pending: 1,
      needs_operator: 1
    });
    expect(summary).toMatchObject({ configured: 8, settled: 1, unavailable: 1, omitted: 0 });
    expect(summary.items.map((i) => i.phase)).toEqual([
      "needs_operator",
      "review_pending",
      "verifying",
      "snapshotting",
      "running",
      "reserved"
    ]);
    expect(summary.items.map((i) => i.attention)).toEqual([
      "needs_operator",
      "review_pending",
      "none",
      "none",
      "none",
      "none"
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/accept/i);
  });

  it("bounds items with an exact omitted count and ignores entries without a path", async () => {
    const { summary } = await scene(
      [{ phase: "running" }, { phase: "running" }, { phase: "running" }, { phase: "reserved" }],
      { max: 2, skipPath: 3 }
    );
    expect(summary).toMatchObject({ configured: 3, omitted: 1 });
    expect(summary.items).toHaveLength(2);
  });

  it("counts a registered task that is not listed as unavailable coverage", async () => {
    const { root, registry } = await scene([{ phase: "running" }]);
    const ghost = {
      ...registry[0],
      nodeId: guid(100, 99),
      continuationRecordPath: "/x/ghost.json"
    };
    const summary = projectContinuation([root], [...registry, ghost]);
    expect(summary).toMatchObject({ configured: 2, unavailable: 1 });
    expect(summary.phases.running).toBe(1);
  });

  it("marks omitted task rows and drops trailing items to fit the size bound", async () => {
    const { root, summary } = await scene([{ phase: "needs_operator" }, { phase: "running" }]);
    const overview = { roots: [{ ...root, tasks: root.tasks.slice(0, 1) }], continuation: summary };
    const marked = finalizeContinuation(overview, 1_000_000);
    expect(marked.continuation!.items.map((i) => i.taskListed)).toEqual(
      summary.items.map((i) => i.nodeId === root.tasks[0].nodeId)
    );
    const tight = finalizeContinuation(overview, JSON.stringify(overview).length - 100);
    expect(tight.continuation!.items.length).toBeLessThan(summary.items.length);
    expect(tight.continuation!.items.length + tight.continuation!.omitted).toBe(
      summary.items.length
    );
  });
});
