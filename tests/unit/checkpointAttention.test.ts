import { describe, expect, it } from "vitest";
import type { BudgetRecord, GateRecord } from "../../src/checkpoint/checkpointRecord";
import type { CheckpointGateView } from "../../src/integrations/hekate/checkpointBudget";
import type { CheckpointRecordEntry } from "../../src/config/checkpointRecordsConfig";
import {
  finalizeAttention,
  projectAttention
} from "../../src/integrations/hekate/checkpointAttention";
import {
  collectExecutiveOverview,
  type ExecutiveOverview,
  type ExecutiveRootView
} from "../../src/integrations/hekate/executiveOverview";
import { FORBIDDEN_ACTIONS } from "../../src/integrations/hekate/recoveryAssessment";
import type { LeafState } from "../../src/integrations/hekate/devCoordination";
import { ROOT_A, guid, leaf, overviewOf, rootView } from "../helpers/executiveFixtures";
import { FENCE, SOURCE_REF, OTHER_REF, makeGate, makeRecord } from "../helpers/checkpointFixtures";

const SENTINEL_NUMBER = 987_654_321;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const verifierGate = (over: Partial<GateRecord> = {}) =>
  makeGate({ checks: [], outcome: "verifier_unavailable", ...over });

interface Setup {
  n?: number;
  state?: LeafState;
  record?: Partial<BudgetRecord>;
  gate?: CheckpointGateView;
  overdue?: boolean;
  artifactRef?: string | null;
}

/** One registered task per entry; node ids follow the fixture fence for task 1. */
function build(setups: Setup[]): { roots: ExecutiveRootView[]; registry: CheckpointRecordEntry[] } {
  const leaves = setups.map((s, i) =>
    leaf(s.n ?? i + 1, s.state ?? "in_progress", {
      attemptId: "at-1",
      attemptEpoch: 2,
      contentRevision: 3,
      artifactRef: s.artifactRef === undefined ? SOURCE_REF : s.artifactRef
    })
  );
  const view = rootView(ROOT_A, "Delivery", leaves);
  const registry: CheckpointRecordEntry[] = [];
  setups.forEach((s, i) => {
    const task = view.tasks.find((t) => t.nodeId === leaves[i].nodeId)!;
    const record = makeRecord({
      runId: guid(500, i + 1),
      identity: { ...makeRecord().identity, nodeId: task.nodeId },
      ...s.record
    });
    task.checkpointBudget = {
      state: "reported",
      record,
      gate: s.gate ?? { state: "current", gate: makeGate() },
      overdueUnreported: s.overdue ?? false
    };
    task.budgetEvidence = "reported";
    registry.push({ rootId: ROOT_A, nodeId: task.nodeId, recordPath: `/records/${i}.json` });
  });
  return { roots: [view], registry };
}

const attend = (setups: Setup[]) => {
  const { roots, registry } = build(setups);
  return projectAttention(deepFreeze(roots), deepFreeze(registry));
};

const running = {
  state: "running",
  stop: { kind: "none", code: "none" },
  exit: null,
  endedAt: null
} as Partial<BudgetRecord>;

describe("projectAttention derivation", () => {
  const cases: { kind: string; setup: Setup }[] = [
    {
      kind: "cleanup_unconfirmed",
      setup: { record: { stop: { kind: "failed", code: "cleanup_failed" }, rootPid: 4242 } }
    },
    { kind: "overdue_unreported", setup: { record: running, overdue: true } },
    {
      kind: "stopped_tripwire",
      setup: { record: { stop: { kind: "tripwire", code: "hard_wall" } } }
    },
    {
      kind: "stopped_failed",
      setup: { record: { stop: { kind: "failed", code: "exited_nonzero" } } }
    },
    {
      kind: "refused_start",
      setup: { record: { stop: { kind: "refused", code: "claim_already_owned" } } }
    },
    {
      kind: "verification_unavailable",
      setup: { gate: { state: "current", gate: verifierGate() } }
    }
  ];

  for (const { kind, setup } of cases)
    it(`yields exactly one ${kind} item with the recorded fence and run`, () => {
      const attention = attend([setup]);
      expect(attention.items).toHaveLength(1);
      const item = attention.items[0];
      expect(item).toMatchObject({
        kind,
        rootId: FENCE.rootId,
        runId: guid(500, 1),
        fence: { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3 },
        attribution: "unattributed",
        taskListed: true,
        trust: "supplied_not_authenticated",
        writerLiveness: "unknown"
      });
      expect(item.rootPid === null).toBe(kind !== "cleanup_unconfirmed");
      expect(item.gateSourceRef === null).toBe(kind !== "verification_unavailable");
      expect(attention).toMatchObject({
        omitted: 0,
        registeredRecordsUnavailable: 0,
        automaticAllowed: false,
        basis: "supplied_records"
      });
      expect(attention.forbidden).toEqual([
        ...FORBIDDEN_ACTIONS,
        "model_retry",
        "terminate_unknown_pid",
        "second_worker_for_claim"
      ]);
    });

  it("yields both a stop item and a verification item for one task, in kind order", () => {
    const attention = attend([
      {
        record: { stop: { kind: "tripwire", code: "hard_units" } },
        gate: { state: "current", gate: verifierGate() }
      }
    ]);
    expect(attention.items.map((i) => i.kind)).toEqual([
      "stopped_tripwire",
      "verification_unavailable"
    ]);
  });

  it("orders by kind priority before task order", () => {
    const attention = attend([
      { gate: { state: "current", gate: verifierGate() } },
      { record: { stop: { kind: "failed", code: "cleanup_failed" }, rootPid: 7 } }
    ]);
    expect(attention.items.map((i) => i.kind)).toEqual([
      "cleanup_unconfirmed",
      "verification_unavailable"
    ]);
  });

  it("yields nothing for clean, cancelled or missing-stop records", () => {
    expect(attend([{}]).items).toEqual([]);
    expect(attend([{ record: { stop: { kind: "cancelled", code: "cancelled" } } }]).items).toEqual(
      []
    );
    expect(attend([{ record: running }]).items).toEqual([]);
  });

  it("suppresses stop kinds for accepted and cancelled tasks but never cleanup, overdue or verification", () => {
    for (const state of ["accepted", "cancelled"] as const) {
      expect(
        attend([{ state, record: { stop: { kind: "tripwire", code: "hard_wall" } } }]).items
      ).toEqual([]);
      expect(
        attend([{ state, record: { stop: { kind: "refused", code: "pin_mismatch" } } }]).items
      ).toEqual([]);
      expect(
        attend([
          { state, record: { stop: { kind: "failed", code: "cleanup_failed" }, rootPid: 9 } }
        ]).items.map((i) => i.kind)
      ).toEqual(["cleanup_unconfirmed"]);
      expect(
        attend([{ state, gate: { state: "current", gate: verifierGate() } }]).items.map(
          (i) => i.kind
        )
      ).toEqual(["verification_unavailable"]);
    }
  });

  it("does not treat a history gate, another artifact or no artifact as current verification", () => {
    expect(attend([{ gate: { state: "history", gate: verifierGate() } }]).items).toEqual([]);
    expect(
      attend([{ gate: { state: "current", gate: verifierGate({ sourceRef: OTHER_REF }) } }]).items
    ).toEqual([]);
    expect(
      attend([{ artifactRef: null, gate: { state: "current", gate: verifierGate() } }]).items
    ).toEqual([]);
    for (const gate of [
      makeGate(),
      makeGate({ checks: [{ name: "lint", result: "fail" }], outcome: "partial" })
    ])
      expect(attend([{ gate: { state: "current", gate } }]).items).toEqual([]);
    expect(attend([{ gate: { state: "unavailable", reason: "missing" } }]).items).toEqual([]);
  });

  it("keeps an unavailable verifier unattributed even when the gate says source", () => {
    const attention = attend([
      {
        gate: {
          state: "current",
          gate: verifierGate({ failureAttribution: "source", evidenceRefs: ["ev-1"] })
        }
      }
    ]);
    expect(attention.items[0]).toMatchObject({
      kind: "verification_unavailable",
      attribution: "unattributed"
    });
    // The constant forbidden list legitimately names retries; the item itself must not.
    expect(JSON.stringify(attention.items)).not.toMatch(/source_failed|rejected|retry/);
  });

  it("emits no liveness, cause or delivery claims and no percent, ETA or SLO", () => {
    const text = JSON.stringify(
      attend(cases.map((c) => c.setup).map((s, i) => ({ ...s, n: i + 1 })))
    );
    expect(text).not.toMatch(
      /\b(alive|healthy|idle|stalled|hung|dead|delivered|notified|acknowledged|eta|slo)\b|%/i
    );
  });

  it("never lists a record that is quarantined, missing or whose task is unobservable", () => {
    const { roots, registry } = build([{}]);
    const task = roots[0].tasks[0];
    task.checkpointBudget = { state: "unavailable", reason: "stale_identity" };
    task.budgetEvidence = "unavailable";
    const entries = [
      ...registry,
      { rootId: ROOT_A, nodeId: guid(100, 99), recordPath: "/records/absent.json" },
      { rootId: guid(7), nodeId: guid(100, 1), recordPath: "/records/otherroot.json" }
    ];
    const attention = projectAttention(roots, entries);
    expect(attention.items).toEqual([]);
    expect(attention.registeredRecordsUnavailable).toBe(3);
    expect(JSON.stringify(attention)).not.toContain(String(SENTINEL_NUMBER));
  });

  it("counts registered entries under an unavailable root and ignores unregistered records", () => {
    const { roots } = build([{ record: { stop: { kind: "tripwire", code: "hard_wall" } } }]);
    // No registry entry for the task: an unregistered record is outside coverage.
    expect(projectAttention(roots, []).items).toEqual([]);
    const down = {
      ...roots[0],
      status: "unavailable" as const,
      reason: "TIMEOUT" as const,
      tasks: []
    };
    const attention = projectAttention(
      [down],
      [{ rootId: ROOT_A, nodeId: FENCE.nodeId, recordPath: "/r.json" }]
    );
    expect(attention).toMatchObject({ items: [], registeredRecordsUnavailable: 1 });
  });

  it("counts the exact overflow beyond the item cap", () => {
    const setups = Array.from({ length: 4 }, (_, i) => ({
      n: i + 1,
      record: { stop: { kind: "tripwire", code: "hard_wall" } } as Partial<BudgetRecord>
    }));
    const { roots, registry } = build(setups);
    const attention = projectAttention(roots, registry, 3);
    expect(attention.items).toHaveLength(3);
    expect(attention.omitted).toBe(1);
  });

  it("is deterministic and reads no clock, random source or file", () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error("clock");
    };
    try {
      const setup: Setup = { record: { stop: { kind: "failed", code: "spawn_failed" } } };
      expect(JSON.stringify(attend([setup]))).toBe(JSON.stringify(attend([setup])));
    } finally {
      Date.now = realNow;
    }
  });
});

describe("overview integration and caps", () => {
  it("keeps the unregistered response v1 with no attention field", async () => {
    const overview = await collectExecutiveOverview(
      "http://127.0.0.1:1",
      [{ rootId: ROOT_A, label: "Delivery" }],
      {
        fetchStatus: async () => ({
          status: "ok",
          rootId: ROOT_A,
          progress: {
            state: "active",
            rootCompletion: "incomplete",
            rootAcceptance: "pending",
            leafCounts: {}
          },
          leaves: [leaf(1, "ready")]
        }),
        now: () => new Date("2026-10-09T10:00:00Z")
      }
    );
    expect(overview.schema).toBe("executive-overview/v1");
    expect("attention" in overview).toBe(false);
  });

  it("marks omitted task rows without discarding the item, then drops items to fit a tiny cap", () => {
    const { roots, registry } = build([
      { record: { stop: { kind: "tripwire", code: "hard_wall" } } },
      { record: { stop: { kind: "tripwire", code: "hard_units" } } }
    ]);
    const attention = projectAttention(roots, registry);
    const overview: ExecutiveOverview = {
      ...overviewOf({ ...roots[0], tasks: [roots[0].tasks[0]], tasksOmitted: 1 }),
      schema: "executive-overview/v3",
      attention
    };
    const marked = finalizeAttention(overview, 1024 * 1024);
    expect(marked.attention!.items.map((i) => i.taskListed).sort()).toEqual([false, true]);
    expect(marked.attention!.omitted).toBe(0);
    const size = Buffer.byteLength(JSON.stringify(overview), "utf8");
    const trimmed = finalizeAttention(overview, size - 600);
    expect(trimmed.attention!.items.length).toBeLessThan(2);
    expect(trimmed.attention!.omitted).toBe(2 - trimmed.attention!.items.length);
    expect(Buffer.byteLength(JSON.stringify(trimmed), "utf8")).toBeLessThanOrEqual(size - 600);
  });
});
