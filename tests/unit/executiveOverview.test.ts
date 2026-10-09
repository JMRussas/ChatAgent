import { describe, expect, it } from "vitest";
import {
  DevCoordinationError,
  type CoordinationStatus,
  type LeafState,
  type LeafStatus
} from "../../src/integrations/hekate/devCoordination";
import {
  EXECUTIVE_LIMITS,
  capOverviewBytes,
  collectExecutiveOverview,
  projectRoot,
  type ExecutiveOverview,
  type FetchStatus
} from "../../src/integrations/hekate/executiveOverview";
import {
  ExecutiveConfigError,
  loadExecutiveOverviewConfig,
  parseExecutiveRoots
} from "../../src/config/executiveOverviewConfig";

const guid = (n: number, tail = 0) =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${tail.toString(16).padStart(12, "0")}`;
const ROOT_A = guid(1);
const ROOT_B = guid(2);
const ROOT_C = guid(3);
const config = (rootId: string, label = "Root") => ({ rootId, label, goal: "Configured goal" });
const NOW = "2026-10-09T10:00:00.000Z";

function leaf(n: number, state: LeafState, over: Partial<LeafStatus> = {}): LeafStatus {
  return {
    nodeId: guid(100, n),
    name: `task-${n}`,
    state,
    executionAcknowledged: "unknown",
    gatesHold: true,
    upstreamChanged: false,
    attemptPins: "none",
    scope: null,
    contentRevision: 1,
    stateRevision: 0,
    attemptId: null,
    attemptEpoch: 0,
    executorRef: null,
    artifactRef: null,
    acceptance: null,
    blockers: [],
    ...over
  };
}
function ok(rootId: string, leaves: LeafStatus[], state = "active" as const): CoordinationStatus {
  const leafCounts: Partial<Record<LeafState, number>> = {};
  for (const l of leaves) leafCounts[l.state] = (leafCounts[l.state] ?? 0) + 1;
  return {
    status: "ok",
    rootId,
    progress: { state, rootCompletion: "incomplete", rootAcceptance: "pending", leafCounts },
    leaves
  };
}
const decision = (attemptEpoch: number, decided: "accepted" | "rejected" = "accepted") => ({
  decision: decided,
  contentRevision: 1,
  artifactRef: null,
  attemptId: "at-1",
  attemptEpoch,
  decidedBy: "lead",
  evidenceRef: null
});

describe("projectRoot", () => {
  it("maps every leaf state to the fixed prod vocabulary", () => {
    const leaves = [
      leaf(1, "review_pending"),
      leaf(2, "rejected", { acceptance: decision(1, "rejected") }),
      leaf(3, "stale"),
      leaf(4, "blocked"),
      leaf(5, "ready"),
      leaf(6, "in_progress", { attemptPins: "current" }),
      leaf(7, "in_progress", { attemptPins: "stale" }),
      leaf(8, "accepted", { acceptance: decision(1) }),
      leaf(9, "cancelled")
    ];
    const view = projectRoot(ok(ROOT_A, leaves), config(ROOT_A), NOW);
    const prod = (n: number) => view.tasks.find((t) => t.nodeId === guid(100, n))!.prod;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(prod)).toEqual([
      "review_needed",
      "decide_rework",
      "refresh_inputs",
      "resolve_dependency",
      "claim_available",
      "confirm_worker_liveness",
      "refresh_inputs",
      "none",
      "none"
    ]);
    expect(view.prods).toEqual([
      { kind: "review_needed", count: 1 },
      { kind: "decide_rework", count: 1 },
      { kind: "refresh_inputs", count: 2 },
      { kind: "resolve_dependency", count: 1 },
      { kind: "claim_available", count: 1 },
      { kind: "confirm_worker_liveness", count: 1 }
    ]);
    expect(view.tasks.every((t) => t.executionAcknowledged === "unknown")).toBe(true);
  });

  it("orders needs-human work first, then by name and id", () => {
    const view = projectRoot(
      ok(ROOT_A, [
        leaf(1, "cancelled"),
        leaf(2, "accepted"),
        leaf(3, "in_progress"),
        leaf(4, "ready", { name: "b" }),
        leaf(5, "ready", { name: "a" }),
        leaf(6, "blocked"),
        leaf(7, "stale"),
        leaf(8, "rejected"),
        leaf(9, "review_pending")
      ]),
      config(ROOT_A),
      NOW
    );
    expect(view.tasks.map((t) => t.state)).toEqual([
      "review_pending",
      "rejected",
      "stale",
      "blocked",
      "ready",
      "ready",
      "in_progress",
      "accepted",
      "cancelled"
    ]);
    expect(view.tasks.filter((t) => t.state === "ready").map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("derives the checkpoint gate from current state only and never from history", () => {
    const view = projectRoot(
      ok(ROOT_A, [
        // An older attempt's acceptance is history: the task awaits review again.
        leaf(1, "review_pending", {
          attemptEpoch: 2,
          acceptance: decision(1),
          acceptanceHistorical: true
        }),
        leaf(2, "accepted", { attemptEpoch: 1, acceptance: decision(1) }),
        leaf(3, "rejected", { attemptEpoch: 1, acceptance: decision(1, "rejected") }),
        leaf(4, "ready"),
        leaf(5, "stale", { acceptance: decision(1) })
      ]),
      config(ROOT_A),
      NOW
    );
    const gate = (n: number) => view.tasks.find((t) => t.nodeId === guid(100, n))!;
    expect(gate(1)).toMatchObject({
      checkpointGate: "awaiting_review",
      acceptanceHistorical: true
    });
    expect(gate(2).checkpointGate).toBe("accepted");
    expect(gate(2).acceptanceHistorical).toBeUndefined();
    expect(gate(3).checkpointGate).toBe("rejected");
    expect(gate(4).checkpointGate).toBe("not_verified");
    expect(gate(5).checkpointGate).toBe("not_verified");
    expect(view.tasks.every((t) => t.budgetEvidence === "not_reported")).toBe(true);
  });

  it("counts accepted tasks, adds no percentage or integration claim", () => {
    const view = projectRoot(
      ok(ROOT_A, [leaf(1, "accepted"), leaf(2, "accepted"), leaf(3, "ready")]),
      config(ROOT_A),
      NOW
    );
    expect(view.acceptedCounts).toEqual({ accepted: 2, total: 3 });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/percent|integrat|deploy/i);
  });

  it("keeps readiness codes of an invalid plan and flags investigation", () => {
    const errors = Array.from({ length: 30 }, (_, i) => ({ code: `E${i}`, nodeId: null }));
    const view = projectRoot({ status: "invalid", rootId: ROOT_A, errors }, config(ROOT_A), NOW);
    expect(view).toMatchObject({
      status: "invalid",
      reason: null,
      planState: null,
      acceptedCounts: null,
      tasks: [],
      prods: [{ kind: "investigate_plan_state", count: 1 }]
    });
    expect(view.invalidCodes).toHaveLength(EXECUTIVE_LIMITS.maxInvalidCodes);
  });

  it("flags an inconsistent plan without hiding its tasks", () => {
    const view = projectRoot(
      ok(ROOT_A, [leaf(1, "accepted")], "inconsistent" as never),
      config(ROOT_A),
      NOW
    );
    expect(view.prods).toEqual([{ kind: "investigate_plan_state", count: 1 }]);
  });

  it("refuses a status for another root", () => {
    expect(projectRoot(ok(ROOT_B, [leaf(1, "ready")]), config(ROOT_A), NOW)).toMatchObject({
      status: "unavailable",
      reason: "ROOT_MISMATCH",
      tasks: []
    });
  });

  it("clips and neutralizes text, and bounds blockers and tasks with accurate omissions", () => {
    const blockers = Array.from({ length: 14 }, (_, i) => ({
      ownerId: guid(100, 1),
      predecessorId: guid(200, i),
      gate: "accepted" as const,
      reason: `reason\u0000${"x".repeat(500)}`,
      predecessorName: "<img src=x onerror=1>"
    }));
    const many = Array.from({ length: 130 }, (_, i) => leaf(i + 2, "ready"));
    const view = projectRoot(
      ok(ROOT_A, [
        leaf(1, "blocked", { name: `<script>${"n".repeat(500)}`, scope: "a‮b", blockers }),
        ...many
      ]),
      config(ROOT_A),
      NOW
    );
    expect(view.tasks).toHaveLength(EXECUTIVE_LIMITS.maxTasks);
    expect(view.tasksOmitted).toBe(131 - EXECUTIVE_LIMITS.maxTasks);
    const blocked = view.tasks.find((t) => t.state === "blocked")!;
    expect(Array.from(blocked.name!).length).toBe(EXECUTIVE_LIMITS.maxTextChars);
    expect(blocked.scope).toBe("a b");
    expect(blocked.blockers).toHaveLength(EXECUTIVE_LIMITS.maxBlockers);
    expect(blocked.blockersOmitted).toBe(4);
    expect(blocked.blockers[0].reason).not.toMatch(/\u0000/);
    expect(Array.from(blocked.blockers[0].reason).length).toBe(EXECUTIVE_LIMITS.maxTextChars);
  });

  it("carries only allowlisted task fields", () => {
    const view = projectRoot(
      ok(ROOT_A, [{ ...leaf(1, "ready"), secret: "SECRET_FIELD" } as LeafStatus]),
      config(ROOT_A),
      NOW
    );
    expect(JSON.stringify(view)).not.toContain("SECRET_FIELD");
  });
});

describe("capOverviewBytes", () => {
  const overview = (): ExecutiveOverview => ({
    schema: "executive-overview/v1",
    generatedAt: NOW,
    atomic: false,
    roots: [ROOT_A, ROOT_B].map((id, i) =>
      projectRoot(
        ok(
          id,
          Array.from({ length: 100 }, (_, n) =>
            leaf(i * 1000 + n, "ready", { name: "n".repeat(200) })
          )
        ),
        config(id),
        NOW
      )
    )
  });
  it("drops trailing tasks with an accurate omitted count and keeps valid JSON", () => {
    const full = overview();
    const limit = 40_000;
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(limit);
    const capped = capOverviewBytes(full, limit);
    const text = JSON.stringify(capped);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(() => JSON.parse(text)).not.toThrow();
    for (const [i, root] of capped.roots.entries()) {
      expect(root.tasks.length + root.tasksOmitted).toBe(full.roots[i].tasks.length);
      // Kept tasks are the leading (most urgent) ones, unchanged.
      expect(root.tasks).toEqual(full.roots[i].tasks.slice(0, root.tasks.length));
    }
    expect(capped.roots.some((r) => r.tasksOmitted > 0)).toBe(true);
  });
  it("leaves a small overview untouched", () => {
    const full = overview();
    expect(capOverviewBytes(full)).toBe(full);
  });
});

describe("collectExecutiveOverview", () => {
  const roots = [config(ROOT_A, "A"), config(ROOT_B, "B"), config(ROOT_C, "C")];
  const clock = () => new Date(NOW);

  it("keeps configured order and isolates per-root failures to codes", async () => {
    const calls: string[] = [];
    const fetchStatus: FetchStatus = async (_base, rootId, options) => {
      calls.push(`${rootId}:${options?.timeoutMs}:${options?.maxBytes}`);
      if (rootId === ROOT_A) return ok(ROOT_A, [leaf(1, "ready")]);
      if (rootId === ROOT_B)
        return { status: "invalid", rootId: ROOT_B, errors: [{ code: "CYCLE", nodeId: null }] };
      throw Object.assign(new DevCoordinationError("HTTP_ERROR", 500), {
        message: "PRIVATE-UPSTREAM-BODY http://127.0.0.1:1/x"
      });
    };
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", roots, {
      fetchStatus,
      now: clock
    });
    expect(overview).toMatchObject({ schema: "executive-overview/v1", atomic: false });
    expect(overview.roots.map((r) => [r.rootId, r.status, r.reason])).toEqual([
      [ROOT_A, "ok", null],
      [ROOT_B, "invalid", null],
      [ROOT_C, "unavailable", "HTTP_ERROR"]
    ]);
    expect(JSON.stringify(overview)).not.toMatch(/PRIVATE|127\.0\.0\.1/);
    expect(calls).toEqual(
      roots.map(
        (r) => `${r.rootId}:${EXECUTIVE_LIMITS.rootTimeoutMs}:${EXECUTIVE_LIMITS.rootMaxBytes}`
      )
    );
  });

  it("maps timeout, oversize, invalid contract and unknown throws to codes only", async () => {
    const outcomes = [
      new DevCoordinationError("TIMEOUT"),
      new DevCoordinationError("RESPONSE_TOO_LARGE"),
      new DevCoordinationError("UNSUPPORTED_CONTRACT")
    ];
    let i = 0;
    const fetchStatus: FetchStatus = async () => {
      throw outcomes[i++];
    };
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", roots, { fetchStatus });
    expect(overview.roots.map((r) => r.reason)).toEqual([
      "TIMEOUT",
      "RESPONSE_TOO_LARGE",
      "UNSUPPORTED_CONTRACT"
    ]);
    const odd = await collectExecutiveOverview("http://127.0.0.1:1", [roots[0]], {
      fetchStatus: async () => {
        throw new Error("SECRET leaked message");
      }
    });
    expect(odd.roots[0]).toMatchObject({ status: "unavailable", reason: "UNAVAILABLE" });
    expect(JSON.stringify(odd)).not.toContain("SECRET");
  });

  it("turns roots still pending at the overall deadline into TIMEOUT without waiting", async () => {
    const fetchStatus: FetchStatus = (_base, rootId) =>
      rootId === ROOT_A
        ? Promise.resolve(ok(ROOT_A, [leaf(1, "ready")]))
        : new Promise<CoordinationStatus>(() => undefined);
    const started = Date.now();
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", roots, {
      fetchStatus,
      overallDeadlineMs: 30
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(overview.roots.map((r) => r.status)).toEqual(["ok", "unavailable", "unavailable"]);
    expect(overview.roots[1].reason).toBe("TIMEOUT");
  });

  it("reads roots concurrently and stamps each root's own read time", async () => {
    let active = 0;
    let peak = 0;
    const fetchStatus: FetchStatus = async (_base, rootId) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return ok(rootId, []);
    };
    const times = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => new Date(Date.UTC(2026, 9, 9, 0, 0, n)));
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", roots, {
      fetchStatus,
      now: () => times.shift()!
    });
    expect(peak).toBe(3);
    expect(new Set(overview.roots.map((r) => r.observedAt)).size).toBe(3);
  });

  it("caps the serialized response without truncating JSON", async () => {
    const fetchStatus: FetchStatus = async (_base, rootId) =>
      ok(
        rootId,
        Array.from({ length: 100 }, (_, n) => leaf(n, "ready", { name: "n".repeat(200) }))
      );
    const overview = await collectExecutiveOverview("http://127.0.0.1:1", roots, {
      fetchStatus,
      maxResponseBytes: 50_000
    });
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(50_000);
    expect(overview.roots.every((r) => r.tasks.length + r.tasksOmitted === 100)).toBe(true);
  });
});

describe("executive inventory configuration", () => {
  const valid = [
    { rootId: ROOT_A, label: "Application delivery", goal: "Ship it" },
    { rootId: ROOT_B, label: "Reliability backlog" }
  ];
  it("accepts 1..8 strict entries and returns detached copies", () => {
    const parsed = parseExecutiveRoots(valid);
    expect(parsed).toEqual(valid);
    expect(parsed[0]).not.toBe(valid[0]);
    expect(
      parseExecutiveRoots(Array.from({ length: 8 }, (_, i) => ({ rootId: guid(i), label: "x" })))
    ).toHaveLength(8);
  });
  it.each([
    ["empty", []],
    ["nine", Array.from({ length: 9 }, (_, i) => ({ rootId: guid(i), label: "x" }))],
    ["duplicate", [valid[0], { ...valid[1], rootId: ROOT_A }]],
    ["uppercase guid", [{ rootId: guid(0xab).toUpperCase(), label: "x" }]],
    ["extra key", [{ ...valid[0], url: "http://127.0.0.1:1" }]],
    ["long label", [{ rootId: ROOT_A, label: "x".repeat(61) }]],
    ["empty label", [{ rootId: ROOT_A, label: "" }]],
    ["long goal", [{ rootId: ROOT_A, label: "x", goal: "g".repeat(201) }]],
    ["control in label", [{ rootId: ROOT_A, label: "a\nb" }]],
    ["control in goal", [{ rootId: ROOT_A, label: "a", goal: "a‮b" }]],
    ["not an array", { rootId: ROOT_A, label: "x" }],
    ["missing label", [{ rootId: ROOT_A }]]
  ])("refuses %s with a stable code that does not echo the value", (_name, value) => {
    expect.assertions(2);
    try {
      parseExecutiveRoots(value);
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutiveConfigError);
      expect((error as ExecutiveConfigError).message).toBe("INVALID_EXECUTIVE_ROOTS");
    }
  });

  const env = (over: Record<string, string | undefined>) =>
    ({
      HEKATE_EXECUTIVE_OVERVIEW: "1",
      HEKATE_PLAN_API_URL: "http://127.0.0.1:5111",
      HEKATE_EXECUTIVE_ROOTS_JSON: JSON.stringify(valid),
      ...over
    }) as NodeJS.ProcessEnv;
  it("stays off unless explicitly enabled", () => {
    expect(loadExecutiveOverviewConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      loadExecutiveOverviewConfig(env({ HEKATE_EXECUTIVE_OVERVIEW: undefined }))
    ).toBeUndefined();
    expect(loadExecutiveOverviewConfig(env({}))).toEqual({ roots: valid });
  });
  it.each([
    ["malformed JSON", { HEKATE_EXECUTIVE_ROOTS_JSON: "{SECRET-not-json" }],
    ["no roots", { HEKATE_EXECUTIVE_ROOTS_JSON: undefined }],
    ["no plan url", { HEKATE_PLAN_API_URL: undefined }],
    ["enable not 1", { HEKATE_EXECUTIVE_OVERVIEW: "true" }],
    ["empty array", { HEKATE_EXECUTIVE_ROOTS_JSON: "[]" }]
  ])("refuses %s at startup without echoing input", (_name, over) => {
    expect.assertions(2);
    try {
      loadExecutiveOverviewConfig(env(over));
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutiveConfigError);
      expect(String((error as Error).message)).not.toContain("SECRET");
    }
  });
});
