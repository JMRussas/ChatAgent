import { describe, expect, it } from "vitest";
import {
  buildLedger,
  classifyEntry,
  outcomeOf,
  parseLedger,
  parseManifest,
  serializeLedger,
  QueueError,
  type PlanFact,
  type QueueManifest,
  type RecordFact
} from "../../src/integrations/hekate/checkpointQueue";
import type { CheckpointGateView } from "../../src/integrations/hekate/checkpointBudget";
import { OTHER_REF, SOURCE_REF, STAMP, makeGate, makeRecord } from "../helpers/checkpointFixtures";
import { ROOT_A, guid, leaf } from "../helpers/executiveFixtures";

const EXPECTED = { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3 };
const claimed = (state: Parameters<typeof leaf>[1], over = {}) =>
  leaf(1, state, { ...EXPECTED, artifactRef: SOURCE_REF, ...over });
const plan = (l: ReturnType<typeof leaf> | null): PlanFact => ({ kind: "ok", leaf: l });
const classify = (p: PlanFact, r: RecordFact = { kind: "not_registered" }, expected = EXPECTED) =>
  classifyEntry({ expected }, p, r);

const reported = (
  record = makeRecord(),
  gate: CheckpointGateView = { state: "unavailable", reason: "missing" },
  overdueUnreported = false
): RecordFact => ({
  kind: "observed",
  view: { state: "reported", record, gate, overdueUnreported }
});
const running = (over = {}) =>
  makeRecord({
    state: "running",
    stop: { kind: "none", code: "none" },
    exit: null,
    endedAt: null,
    ...over
  });
const acceptance = (over = {}) => ({
  decision: "accepted" as const,
  contentRevision: 3,
  artifactRef: SOURCE_REF,
  attemptId: "at-1",
  attemptEpoch: 2,
  decidedBy: "lead",
  evidenceRef: null,
  ...over
});

describe("classifyEntry", () => {
  it("states unavailable plan and missing task without carried numbers", () => {
    expect(classify({ kind: "unavailable" })).toMatchObject({
      state: "unobservable",
      reason: "plan_unavailable",
      observed: null
    });
    expect(classify(plan(null))).toMatchObject({ state: "unobservable", reason: "task_missing" });
  });

  it("quarantines a moved fence, including every number from the prior record", () => {
    const moved = classify(plan(claimed("in_progress", { attemptEpoch: 3 })), reported());
    expect(moved).toMatchObject({ state: "needs_operator", reason: "fence_moved" });
    expect(moved.observed).toEqual({ attemptId: "at-1", attemptEpoch: 3, contentRevision: 3 });
    expect(moved.gate).toEqual({ state: "none" });
    expect(moved.runId).toBeNull();
    expect(JSON.stringify(moved)).not.toContain("987654321");
    for (const over of [{ contentRevision: 4 }, { attemptId: "at-2" }])
      expect(classify(plan(claimed("in_progress", over)), reported()).reason).toBe("fence_moved");
  });

  it("keeps a ready task with a null attempt and record path visible", () => {
    const fresh = { attemptId: null, attemptEpoch: 0, contentRevision: 1 };
    expect(classify(plan(leaf(1, "ready")), { kind: "not_registered" }, fresh)).toMatchObject({
      state: "ready_unclaimed",
      reason: "prepare_or_claim_outside_tool",
      action: "prepare_or_claim_outside_tool",
      observed: fresh
    });
  });

  it("accepts only an exact current decision", () => {
    const ok = claimed("accepted", { acceptance: acceptance() });
    expect(classify(plan(ok)).state).toBe("accepted");
    for (const bad of [
      acceptance({ attemptEpoch: 1 }),
      acceptance({ contentRevision: 2 }),
      acceptance({ attemptId: "at-0" }),
      acceptance({ artifactRef: OTHER_REF }),
      acceptance({ decision: "rejected" })
    ])
      expect(classify(plan(claimed("accepted", { acceptance: bad }))).reason).toBe(
        "plan_inconsistent"
      );
    const historical = claimed("accepted", {
      acceptance: acceptance(),
      acceptanceHistorical: true
    });
    expect(classify(plan(historical)).state).toBe("needs_operator");
    // A strictly older decision is surfaced by the reader as review_pending, never accepted.
    expect(
      classify(plan(claimed("review_pending", { acceptance: acceptance({ attemptEpoch: 1 }) })))
        .state
    ).toBe("review_pending");
  });

  it("names recorded rejected, stale, cancelled and blocked conditions", () => {
    expect(classify(plan(claimed("rejected"))).reason).toBe("plan_rejected");
    expect(classify(plan(claimed("stale"))).reason).toBe("plan_stale");
    expect(classify(plan(claimed("cancelled"))).reason).toBe("plan_cancelled");
    expect(classify(plan(claimed("blocked")))).toMatchObject({
      state: "blocked",
      reason: "blocked_by_dependency"
    });
  });

  it("maps typed stops of an ended record to the operator", () => {
    const failed = makeRecord({ stop: { kind: "failed", code: "cleanup_failed" }, exit: null });
    expect(classify(plan(claimed("in_progress")), reported(failed))).toMatchObject({
      state: "needs_operator",
      reason: "stop_failed",
      stop: { kind: "failed", code: "cleanup_failed" },
      recordState: "ended"
    });
    const tripped = makeRecord({ stop: { kind: "tripwire", code: "hard_wall" }, exit: null });
    expect(classify(plan(claimed("in_progress")), reported(tripped)).reason).toBe("stop_tripwire");
    const nonzero = makeRecord({ exit: { code: 2, signal: null } });
    expect(classify(plan(claimed("in_progress")), reported(nonzero)).reason).toBe("exit_nonzero");
  });

  it("classifies a current gate by outcome and never treats history as current", () => {
    const view = (gate: ReturnType<typeof makeGate>, state: "current" | "history" = "current") =>
      reported(makeRecord(), { state, gate });
    const task = plan(claimed("review_pending"));
    expect(classify(task, view(makeGate()))).toMatchObject({
      state: "gate_recorded",
      reason: "awaiting_lead_acceptance",
      action: "review_acceptance_outside_tool",
      gate: { state: "current", outcome: "checks_passed", sourceRef: SOURCE_REF }
    });
    const partial = makeGate({
      checks: [
        { name: "a", result: "pass" },
        { name: "b", result: "fail" }
      ],
      outcome: "partial"
    });
    expect(classify(task, view(partial)).reason).toBe("verification_incomplete");
    const unavailable = makeGate({
      checks: [{ name: "a", result: "unavailable" }],
      outcome: "verifier_unavailable"
    });
    expect(classify(task, view(unavailable)).reason).toBe("verification_unavailable");
    const source = makeGate({
      checks: [{ name: "a", result: "fail" }],
      failureAttribution: "source",
      outcome: "source_failed"
    });
    expect(classify(task, view(source)).reason).toBe("source_failure_reported");
    // The same fence with another artifact is history, so review is still pending.
    expect(classify(task, view(makeGate({ sourceRef: OTHER_REF }), "history"))).toMatchObject({
      state: "review_pending",
      reason: "awaiting_independent_review",
      action: "run_independent_review",
      gate: { state: "history", sourceRef: OTHER_REF }
    });
  });

  it("reviews an ended zero-exit record and treats a running one as unknown liveness", () => {
    expect(classify(plan(claimed("in_progress")), reported()).state).toBe("review_pending");
    expect(classify(plan(claimed("in_progress")), reported(running()))).toMatchObject({
      state: "running_recorded",
      reason: "liveness_unknown",
      recordState: "running"
    });
    expect(
      classify(plan(claimed("in_progress")), reported(running(), undefined, true))
    ).toMatchObject({
      state: "needs_operator",
      reason: "overdue_unreported"
    });
  });

  it("reports a claimed task without a readable record as unobserved", () => {
    expect(classify(plan(claimed("in_progress")))).toMatchObject({
      state: "claimed_unobserved",
      reason: "record_not_registered"
    });
    const missing: RecordFact = {
      kind: "observed",
      view: { state: "unavailable", reason: "missing" }
    };
    expect(classify(plan(claimed("in_progress")), missing).reason).toBe("record_missing");
    const stale: RecordFact = {
      kind: "observed",
      view: { state: "unavailable", reason: "stale_identity" }
    };
    expect(classify(plan(claimed("in_progress")), stale).reason).toBe("record_stale_identity");
  });

  it("withholds non-hex artifacts and unbounded attempt text", () => {
    const l = claimed("in_progress", {
      artifactRef: "https://example.invalid/x",
      attemptId: "a b"
    });
    const c = classify(plan(l), { kind: "not_registered" }, { ...EXPECTED, attemptId: "a b" });
    expect(c.observed?.attemptId).toBe("<withheld>");
    const ok = classify(plan(claimed("in_progress", { artifactRef: "https://example.invalid/x" })));
    expect(ok.artifactRef).toBe("withheld");
    expect(JSON.stringify(ok)).not.toContain("example.invalid");
  });
});

describe("outcomeOf", () => {
  it("applies the fixed priority and never reports accepted while work remains", () => {
    expect(outcomeOf(["accepted", "accepted"])).toBe("all_accepted");
    expect(outcomeOf(["accepted", "running_recorded"])).toBe("running_recorded");
    expect(outcomeOf(["running_recorded", "blocked"])).toBe("blocked");
    expect(outcomeOf(["blocked", "ready_unclaimed"])).toBe("ready_requires_claim");
    expect(outcomeOf(["ready_unclaimed", "gate_recorded"])).toBe("review_required");
    expect(outcomeOf(["review_pending", "needs_operator"])).toBe("operator_required");
    expect(outcomeOf(["needs_operator", "unobservable"])).toBe("unobservable");
    expect(outcomeOf(["accepted", "claimed_unobserved"])).toBe("unobservable");
  });
});

const entryA = {
  entryId: guid(10),
  rootId: ROOT_A,
  nodeId: guid(100, 1),
  label: "first task",
  expected: EXPECTED,
  recordPath: null
};
const manifestOf = (over: Record<string, unknown> = {}) => ({
  schema: "checkpoint-queue-manifest/v1",
  queueId: guid(9),
  planApiUrl: "http://127.0.0.1:5000",
  ledgerDir: process.platform === "win32" ? "C:\\ledger" : "/ledger",
  entries: [entryA],
  ...over
});
const parseText = (value: unknown) => parseManifest(Buffer.from(JSON.stringify(value)));
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof QueueError ? error.code : "other";
  }
  return "none";
};

describe("manifest and ledger schemas", () => {
  it("refuses unknown keys, duplicates, decimals and bad scope without echoing input", () => {
    expect(parseText(manifestOf()).entries).toHaveLength(1);
    expect(refusal(() => parseText(manifestOf({ extra: 1 })))).toBe("MANIFEST_INVALID");
    expect(refusal(() => parseText(manifestOf({ planApiUrl: "http://example.com" })))).toBe(
      "MANIFEST_INVALID"
    );
    expect(refusal(() => parseText(manifestOf({ entries: [] })))).toBe("MANIFEST_INVALID");
    expect(refusal(() => parseText(manifestOf({ entries: [entryA, entryA] })))).toBe(
      "MANIFEST_INVALID"
    );
    const other = { ...entryA, entryId: guid(11), nodeId: guid(100, 2) };
    const path = process.platform === "win32" ? "C:\\r\\a.json" : "/r/a.json";
    expect(
      refusal(() =>
        parseText(
          manifestOf({
            entries: [
              { ...entryA, recordPath: path },
              { ...other, recordPath: path }
            ]
          })
        )
      )
    ).toBe("MANIFEST_INVALID");
    expect(
      refusal(() => parseText(manifestOf({ entries: [{ ...entryA, label: "bad\nlabel" }] })))
    ).toBe("MANIFEST_INVALID");
    const dup = JSON.stringify(manifestOf()).replace('"schema"', '"queueId":"x","schema"');
    expect(refusal(() => parseManifest(Buffer.from(dup)))).toBe("MANIFEST_INVALID");
    const decimal = JSON.stringify(manifestOf()).replace('"attemptEpoch":2', '"attemptEpoch":2.0');
    expect(refusal(() => parseManifest(Buffer.from(decimal)))).toBe("MANIFEST_INVALID");
    expect(refusal(() => parseManifest(Buffer.alloc(33 * 1024, 32)))).toBe("MANIFEST_TOO_LARGE");
    expect(refusal(() => parseText(manifestOf({ schema: "checkpoint-queue-manifest/v2" })))).toBe(
      "MANIFEST_INVALID"
    );
  });

  const manifest = parseText(manifestOf()) as QueueManifest;
  const sha = "e".repeat(64);
  const build = (
    prior = null as ReturnType<typeof parseLedger> | null,
    at = STAMP,
    task = claimed("ready")
  ) =>
    buildLedger(
      manifest,
      sha,
      [classify(plan(task), { kind: "not_registered" }, EXPECTED)],
      prior,
      at
    );

  it("increments generation, keeps unchanged stateSince and resets a changed one", () => {
    const first = build(null, "2026-10-09T10:00:00.000Z", claimed("in_progress"));
    expect(first).toMatchObject({ generation: 1, outcome: "unobservable" });
    const again = build(
      parseLedger(Buffer.from(serializeLedger(first))),
      "2026-10-09T11:00:00.000Z",
      claimed("in_progress")
    );
    expect(again.generation).toBe(2);
    expect(again.entries[0]).toMatchObject({
      firstSeenAt: "2026-10-09T10:00:00.000Z",
      stateSince: "2026-10-09T10:00:00.000Z"
    });
    const changed = build(again, "2026-10-09T12:00:00.000Z", claimed("ready"));
    expect(changed.entries[0]).toMatchObject({
      state: "ready_unclaimed",
      firstSeenAt: "2026-10-09T10:00:00.000Z",
      stateSince: "2026-10-09T12:00:00.000Z"
    });
    expect(changed.outcome).toBe("ready_requires_claim");
  });

  it("rejects unsupported claims, schemas, unknown fields and contradictions", () => {
    const text = serializeLedger(build());
    expect(parseLedger(Buffer.from(text)).delivery).toBe("not_sent");
    const code = (s: string) => refusal(() => parseLedger(Buffer.from(s)));
    expect(code(text.replace('"not_sent"', '"sent"'))).toBe("LEDGER_INVALID");
    expect(code(text.replace('"taskMutationAllowed":false', '"taskMutationAllowed":true'))).toBe(
      "LEDGER_INVALID"
    );
    expect(code(text.replace("checkpoint-queue/v1", "checkpoint-queue/v2"))).toBe(
      "LEDGER_UNSUPPORTED_SCHEMA"
    );
    expect(code(text.replace('"generation":1', '"generation":1.0'))).toBe("LEDGER_INVALID");
    expect(code(text.replace('"generation":1', '"generation":1,"generation":2'))).toBe(
      "LEDGER_INVALID"
    );
    expect(code(text.replace('"ready_requires_claim"', '"all_accepted"'))).toBe("LEDGER_INVALID");
    expect(
      code(text.replace('"prepare_or_claim_outside_tool","action"', '"liveness_unknown","action"'))
    ).toBe("LEDGER_INVALID");
    expect(code(text.replace('"wake":"none"', '"wake":"none","extra":1'))).toBe("LEDGER_INVALID");
    expect(refusal(() => parseLedger(Buffer.alloc(65 * 1024, 32)))).toBe("LEDGER_TOO_LARGE");
  });
});
