import { describe, expect, it } from "vitest";
import {
  assessRecovery,
  extractAssessmentInput,
  extractHostInput,
  ASSESSMENT_INPUT_SCHEMA
} from "../../src/integrations/hekate/recoveryAssessment";
const ROOT = "b556d4ce-b813-50fa-8ac5-3633297518a6",
  NODE = "21dcea12-cb65-54cf-8581-e2f896490139",
  ATTEMPT = "pilot-11c9f94a6bef-r1",
  ARTIFACT = "0d1852940975241dd3367cef4299acf2911e5b86";
function input() {
  return {
    schema: ASSESSMENT_INPUT_SCHEMA,
    expected: {
      rootId: ROOT,
      nodeId: NODE,
      attemptId: ATTEMPT,
      attemptEpoch: 4,
      contentRevision: 3
    },
    observation: {
      status: "observed",
      rootId: ROOT,
      nodeId: NODE,
      observedAt: "2026-10-09T06:10:23.000Z",
      consistency: "current",
      reasons: [],
      task: {
        work: "done",
        stateRevision: 16,
        contentRevision: 3,
        attemptId: ATTEMPT,
        attemptEpoch: 4,
        attemptContentRevision: 3,
        effectiveAcceptance: "accepted"
      },
      selectedAttempt: {
        attemptId: ATTEMPT,
        attemptEpoch: 4,
        scope: "current",
        attemptContentRevision: 3,
        contentPins: "current"
      },
      trace: {
        status: "exited",
        integrity: "verified",
        claimLinkage: "matched",
        capped: false,
        truncated: false,
        metadataStable: true,
        exitCode: 0,
        recordCount: 52
      },
      acceptance: {
        decision: "accepted",
        contentRevision: 3,
        attemptEpoch: 4,
        attemptId: ATTEMPT,
        taskArtifact: { state: "shown", ref: ARTIFACT },
        decisionArtifact: { state: "shown", ref: ARTIFACT }
      },
      evidence: [
        { ref: 0, endpoint: `/api/plan-contract/v1/plans/${ROOT}`, sha256: "a".repeat(64) }
      ]
    }
  };
}
describe("independent recovery contract review", () => {
  it("retains the exact observed state and artifact linkage for human or AI citation", () => {
    const r = assessRecovery(input());
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error("valid recorded state refused");
    expect(r.value.recorded).toMatchObject({
      stateRevision: 16,
      attemptId: ATTEMPT,
      attemptEpoch: 4,
      contentRevision: 3,
      taskArtifact: { state: "shown", ref: ARTIFACT },
      decisionArtifact: { state: "shown", ref: ARTIFACT }
    });
    expect(r.value.recommendation.action).toBe("none");
  });
  it("supports a signed native exit code without attributing an accepted decision to that code", () => {
    const i = input();
    i.observation.trace.exitCode = -9;
    const r = assessRecovery(i);
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error("valid signed native exit refused");
    expect(r.value.attempt.workerSource).toBe("accepted_current");
    expect(r.value.trust.workerLiveness).toBe("unknown");
  });
  it("refuses a citation naming an unrelated attempt even on the same task", () => {
    const i = input();
    i.observation.evidence = [
      {
        ref: 1,
        endpoint: `/api/plan-contract/v1/nodes/${NODE}/attempts/unrelated-secret-sentinel/trace`,
        sha256: "b".repeat(64)
      }
    ];
    const r = assessRecovery(i);
    expect(r).toEqual({ ok: false, error: "input_invalid" });
    expect(JSON.stringify(r)).not.toContain("unrelated-secret-sentinel");
  });
  it("labels a replay timestamp with its original observer clock domain", () => {
    const r = assessRecovery(input());
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error("valid replay refused");
    expect(r.value.observation.clockDomain).toBe("observer_process_wall_clock_at_observation_end");
    expect(r.value.observation.observedAt).toBe("2026-10-09T06:10:23.000Z");
  });
  it("preserves a pending-review candidate artifact even when there is no decision", () => {
    const i = input();
    const response = {
      status: 200,
      body: {
        ...i.observation,
        schema: "attempt-progress/v1",
        task: { ...i.observation.task, effectiveAcceptance: "none" },
        acceptance: {
          decision: null,
          taskArtifact: { state: "shown", ref: ARTIFACT },
          decisionArtifact: { state: "none" }
        }
      }
    };
    const extracted = extractAssessmentInput({ expected: i.expected, response: response as never });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw Error("candidate projection refused");
    const r = assessRecovery(extracted.value);
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error("review pending refused");
    expect(r.value.attempt.workerSource).toBe("awaiting_review");
    expect(r.value.recorded?.taskArtifact).toEqual({ state: "shown", ref: ARTIFACT });
    expect(r.value.recorded?.decisionArtifact).toEqual({ state: "none" });
  });
  it("does not wait on an owner whose root or launch identity is missing", () => {
    const i = input();
    for (const missing of ["rootId", "launchId"]) {
      const raw = {
        rootId: ROOT,
        lifecycle: "dispatching",
        launchId: "a".repeat(32),
        current: { nodeId: NODE },
        journal: null
      };
      Object.assign(raw, { [missing]: null });
      const host = extractHostInput(raw);
      expect(host.ok).toBe(true);
      if (!host.ok) throw Error("host metadata refused");
      const r = assessRecovery({
        ...i,
        observation: {
          ...i.observation,
          task: { ...i.observation.task, work: "in_progress", effectiveAcceptance: "none" },
          acceptance: null
        },
        host: host.value
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw Error("unverified owner refused");
      expect(r.value.host.owner).toBe("owner_unverified");
      expect(r.value.recommendation.action).toBe("escalate_operator");
    }
  });
  it("refuses untyped fault packets instead of manufacturing a typed observation", () => {
    const expected = input().expected;
    for (const response of [
      { status: 404, body: { code: "OTHER" } },
      { status: 503, body: { code: "OTHER", reason: "TIMEOUT" } },
      { status: 503, body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE" } }
    ])
      expect(extractAssessmentInput({ expected, response: response as never })).toEqual({
        ok: false,
        error: "input_invalid"
      });
  });
  it("refuses oversized metadata lists instead of labelling truncated evidence complete", () => {
    const i = input();
    const body = { ...i.observation, schema: "attempt-progress/v1" };
    for (const extra of [
      { reasons: Array.from({ length: 33 }, () => "trace_capped") },
      { evidence: Array.from({ length: 17 }, () => i.observation.evidence[0]) }
    ])
      expect(
        extractAssessmentInput({
          expected: i.expected,
          response: { status: 200, body: { ...body, ...extra } } as never
        })
      ).toEqual({ ok: false, error: "input_invalid" });
  });
});
