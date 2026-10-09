import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  budgetRecordPath,
  gateRecordPath,
  type BudgetRecord
} from "../../src/checkpoint/checkpointRecord";
import {
  BUDGET_READ_LIMITS,
  readCheckpointBudget,
  type CheckpointBudgetView
} from "../../src/integrations/hekate/checkpointBudget";
import {
  collectExecutiveOverview,
  type FetchStatus
} from "../../src/integrations/hekate/executiveOverview";
import type { CoordinationStatus, LeafStatus } from "../../src/integrations/hekate/devCoordination";
import { ROOT_A, guid, leaf } from "../helpers/executiveFixtures";
import {
  FENCE,
  OTHER_REF,
  RUN_ID,
  SOURCE_REF,
  TASK,
  makeGate,
  makeRecord
} from "../helpers/checkpointFixtures";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "ckpt-budget-"));
  dirs.push(dir);
  const entry = {
    rootId: FENCE.rootId,
    nodeId: FENCE.nodeId,
    recordPath: budgetRecordPath(dir, RUN_ID)
  };
  const put = (path: string, value: unknown) =>
    writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return {
    dir,
    entry,
    putRecord: (value: unknown = makeRecord()) => put(entry.recordPath, value),
    putGate: (value: unknown = makeGate()) => put(gateRecordPath(dir, RUN_ID), value)
  };
}
const reason = (view: CheckpointBudgetView) =>
  view.state === "unavailable" ? view.reason : "reported";

describe("bounded record reader", () => {
  it("reports a missing record explicitly", async () => {
    const ws = await workspace();
    expect(await readCheckpointBudget(ws.entry, TASK)).toEqual({
      state: "unavailable",
      reason: "missing"
    });
  });

  it("refuses a symlink and a non-regular file", async () => {
    const ws = await workspace();
    await ws.putGate();
    const target = join(ws.dir, "target.json");
    await writeFile(target, JSON.stringify(makeRecord()));
    try {
      await symlink(target, ws.entry.recordPath);
    } catch {
      return; // Creating a symlink needs a privilege some platforms withhold.
    }
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("unreadable");
    const directory = { ...ws.entry, recordPath: ws.dir };
    expect(reason(await readCheckpointBudget(directory, TASK))).toBe("unreadable");
  });

  it("refuses an oversize, invalid, duplicate-key and unknown-schema record", async () => {
    const ws = await workspace();
    await ws.putRecord(" ".repeat(BUDGET_READ_LIMITS.maxBytes + 1));
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("too_large");
    await ws.putRecord("{not json");
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("invalid");
    await ws.putRecord(
      JSON.stringify(makeRecord()).replace('"state":"ended"', '"state":"ended","state":"ended"')
    );
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("invalid");
    await ws.putRecord({ ...makeRecord(), schema: "checkpoint-budget/v9" });
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("unsupported_schema");
    await ws.putRecord({ ...makeRecord(), consumed: { ...makeRecord().consumed, units: 1.5 } });
    expect(reason(await readCheckpointBudget(ws.entry, TASK))).toBe("invalid");
  });

  it("times out a read that never completes", async () => {
    const ws = await workspace();
    await ws.putRecord();
    const view = await readCheckpointBudget(ws.entry, TASK, {
      deadlineMs: 30,
      io: { open: () => new Promise(() => undefined) as never }
    });
    expect(reason(view)).toBe("timeout");
  });

  it("quarantines an older attempt, epoch or content revision without showing numbers", async () => {
    const ws = await workspace();
    for (const identity of [
      { ...makeRecord().identity, attemptId: "at-0" },
      { ...makeRecord().identity, attemptEpoch: 1 },
      { ...makeRecord().identity, contentRevision: 2 },
      { ...makeRecord().identity, nodeId: guid(100, 9) }
    ]) {
      await ws.putRecord(makeRecord({ identity }));
      const view = await readCheckpointBudget(ws.entry, TASK);
      expect(view).toEqual({ state: "unavailable", reason: "stale_identity" });
      expect(JSON.stringify(view)).not.toContain("987654321");
    }
    expect(reason(await readCheckpointBudget(ws.entry, { ...TASK, attemptId: null }))).toBe(
      "stale_identity"
    );
  });

  it("marks gate evidence current only for the exact artifact and keeps other evidence as history", async () => {
    const ws = await workspace();
    await ws.putRecord();
    await ws.putGate();
    const current = await readCheckpointBudget(ws.entry, TASK);
    expect(current.state === "reported" && current.gate.state).toBe("current");
    const reworked = await readCheckpointBudget(ws.entry, { ...TASK, artifactRef: OTHER_REF });
    expect(reworked.state === "reported" && reworked.gate.state).toBe("history");
    const noArtifact = await readCheckpointBudget(ws.entry, { ...TASK, artifactRef: null });
    expect(noArtifact.state === "reported" && noArtifact.gate.state).toBe("history");
  });

  it("makes missing, old-attempt and invalid gate evidence explicit, never empty", async () => {
    const ws = await workspace();
    await ws.putRecord();
    const gateOf = async () => {
      const view = await readCheckpointBudget(ws.entry, TASK);
      return view.state === "reported" ? view.gate : view;
    };
    expect(await gateOf()).toEqual({ state: "unavailable", reason: "missing" });
    await ws.putGate(makeGate({ identity: { ...FENCE, attemptEpoch: 1 } }));
    expect(await gateOf()).toEqual({ state: "unavailable", reason: "stale_identity" });
    await ws.putGate(makeGate({ runId: guid(7) }));
    expect(await gateOf()).toEqual({ state: "unavailable", reason: "stale_identity" });
    await ws.putGate({ ...makeGate(), outcome: "source_failed" });
    expect(await gateOf()).toEqual({ state: "unavailable", reason: "invalid" });
  });

  it("flags a running record past its wall limit and grace as overdue, otherwise not", async () => {
    const ws = await workspace();
    const running: BudgetRecord = makeRecord({
      state: "running",
      stop: { kind: "none", code: "none" },
      exit: null,
      endedAt: null,
      hard: { units: 60, wallMs: 1000, outputBytes: 1024 }
    });
    await ws.putRecord(running);
    const started = Date.parse(running.startedAt);
    const at = (ms: number) => readCheckpointBudget(ws.entry, TASK, { now: () => started + ms });
    const before = await at(1000 + BUDGET_READ_LIMITS.overdueGraceMs);
    const after = await at(1000 + BUDGET_READ_LIMITS.overdueGraceMs + 1);
    expect(before.state === "reported" && before.overdueUnreported).toBe(false);
    expect(after.state === "reported" && after.overdueUnreported).toBe(true);
  });
});

describe("overview wiring", () => {
  const nodes = { current: guid(100, 1), accepted: guid(100, 2), plain: guid(100, 3) };
  const attempt = {
    attemptId: "at-1",
    attemptEpoch: 2,
    contentRevision: 3,
    attemptPins: "current" as const
  };
  const status = (leaves: LeafStatus[]): CoordinationStatus => ({
    status: "ok",
    rootId: ROOT_A,
    progress: {
      state: "active",
      rootCompletion: "incomplete",
      rootAcceptance: "pending",
      leafCounts: {}
    },
    leaves
  });
  const fetchWith =
    (leaves: LeafStatus[]): FetchStatus =>
    async () =>
      status(leaves);
  const leaves = () => [
    leaf(1, "review_pending", { ...attempt, stateRevision: 6, artifactRef: SOURCE_REF }),
    leaf(2, "accepted", { ...attempt, stateRevision: 9, artifactRef: SOURCE_REF }),
    leaf(3, "ready")
  ];
  const root = [{ rootId: ROOT_A, label: "Root" }];

  it("keeps the v1 contract byte-for-byte without a registry", async () => {
    const options = {
      fetchStatus: fetchWith(leaves()),
      now: () => new Date("2026-10-09T10:00:00Z")
    };
    const plain = await collectExecutiveOverview("http://127.0.0.1:1", root, options);
    expect(plain.schema).toBe("executive-overview/v1");
    expect(JSON.stringify(plain)).not.toContain("checkpointBudget");
    expect(plain.roots[0].tasks.every((t) => t.budgetEvidence === "not_reported")).toBe(true);
  });

  it("emits v2, retains the accepted task's record and gate, and adds no field to unregistered tasks", async () => {
    const ws = await workspace();
    await ws.putRecord();
    await ws.putGate();
    const accepted = { rootId: ROOT_A, nodeId: nodes.accepted, recordPath: ws.entry.recordPath };
    const other = await workspace();
    const entries = [
      { ...accepted, nodeId: nodes.current },
      { rootId: ROOT_A, nodeId: nodes.accepted, recordPath: other.entry.recordPath }
    ];
    // Both tasks carry the recorded attempt fence while their stateRevision (6 and 9) has
    // advanced past the recorded 4 through review and acceptance; neither record is stale.
    await other.putRecord(
      makeRecord({ identity: { ...makeRecord().identity, nodeId: nodes.accepted } })
    );
    await other.putGate(makeGate({ identity: { ...FENCE, nodeId: nodes.accepted } }));
    await ws.putRecord(
      makeRecord({ identity: { ...makeRecord().identity, nodeId: nodes.current } })
    );
    await ws.putGate(makeGate({ identity: { ...FENCE, nodeId: nodes.current } }));
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", root, {
      fetchStatus: fetchWith(leaves()),
      checkpointRecords: entries
    });
    expect(overview.schema).toBe("executive-overview/v3");
    expect(overview.attention?.basis).toBe("supplied_records");
    const byNode = new Map(overview.roots[0].tasks.map((t) => [t.nodeId, t]));
    for (const node of [nodes.current, nodes.accepted]) {
      const task = byNode.get(node)!;
      expect(task.budgetEvidence).toBe("reported");
      expect(task.checkpointBudget).toMatchObject({
        state: "reported",
        gate: { state: "current" }
      });
    }
    expect(byNode.get(nodes.accepted)!.state).toBe("accepted");
    expect(byNode.get(nodes.plain)!.budgetEvidence).toBe("not_reported");
    expect("checkpointBudget" in byNode.get(nodes.plain)!).toBe(false);
  });

  it("shows a stale record as unavailable with no numbers and still returns v2 with an empty match", async () => {
    const ws = await workspace();
    await ws.putRecord(makeRecord({ identity: { ...makeRecord().identity, attemptEpoch: 1 } }));
    const stale = await collectExecutiveOverview("http://127.0.0.1:1", root, {
      fetchStatus: fetchWith(leaves()),
      checkpointRecords: [ws.entry]
    });
    const task = stale.roots[0].tasks.find((t) => t.nodeId === nodes.current)!;
    expect(task.budgetEvidence).toBe("unavailable");
    expect(task.checkpointBudget).toEqual({ state: "unavailable", reason: "stale_identity" });
    expect(JSON.stringify(stale)).not.toContain("987654321");
    const unmatched = await collectExecutiveOverview("http://127.0.0.1:1", root, {
      fetchStatus: fetchWith(leaves()),
      checkpointRecords: [
        { rootId: guid(9), nodeId: nodes.current, recordPath: ws.entry.recordPath }
      ]
    });
    expect(unmatched.schema).toBe("executive-overview/v3");
    expect(unmatched.attention).toMatchObject({ items: [], registeredRecordsUnavailable: 1 });
    expect(unmatched.roots[0].tasks.every((t) => t.budgetEvidence === "not_reported")).toBe(true);
  });
});
