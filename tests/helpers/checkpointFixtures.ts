import type { BudgetRecord, GateRecord } from "../../src/checkpoint/checkpointRecord";
import type { FencedTask } from "../../src/integrations/hekate/checkpointBudget";
import { guid } from "./executiveFixtures";

/** Shared builders for the checkpoint record, runner and overview tests. */
export const RUN_ID = "11111111-1111-4111-8111-111111111111";
export const BASE_REF = "b".repeat(40);
export const SOURCE_REF = "c".repeat(40);
export const OTHER_REF = "d".repeat(40);
export const FENCE = {
  rootId: guid(1),
  nodeId: guid(100, 1),
  attemptId: "at-1",
  attemptEpoch: 2,
  contentRevision: 3
};
export const TASK: FencedTask = {
  attemptId: "at-1",
  attemptEpoch: 2,
  contentRevision: 3,
  artifactRef: SOURCE_REF
};
export const STAMP = "2026-10-09T10:00:00.000Z";

export function makeRecord(over: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    schema: "checkpoint-budget/v1",
    runId: RUN_ID,
    identity: { ...FENCE, observedStateRevision: 4, executorRef: "exec-1" },
    baseRef: BASE_REF,
    profile: "readonly_smoke",
    state: "ended",
    unit: "assistant_message_ids_distinct/v1",
    expected: { units: 30, basis: "provisional_heuristic" },
    hard: { units: 60, wallMs: 900_000, outputBytes: 8 * 1024 * 1024 },
    consumed: { units: 7, wallMs: 1234, outputBytes: 987_654_321, counterState: "exact_observed" },
    expectedExceeded: false,
    providerReported: { numTurns: 9, costUsd: 0.0123, status: "unverified" },
    cost: { enforcement: "none" },
    stop: { kind: "exited", code: "exited" },
    exit: { code: 0, signal: null },
    rootPid: null,
    startedAt: STAMP,
    updatedAt: STAMP,
    endedAt: STAMP,
    writer: "runner_record",
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    artifactRef: null,
    ...over
  };
}

export function makeGate(over: Partial<GateRecord> = {}): GateRecord {
  return {
    schema: "checkpoint-gate/v1",
    runId: RUN_ID,
    identity: { ...FENCE },
    sourceRef: SOURCE_REF,
    suppliedBy: "lead",
    recordedAt: STAMP,
    evidenceRefs: ["ev-1"],
    checks: [
      { name: "unit tests", result: "pass" },
      { name: "lint", result: "pass" }
    ],
    outcome: "checks_passed",
    ...over
  };
}
