import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptProgressResponse } from "../../src/integrations/hekate/attemptProgress";
import {
  ASSESSMENT_INPUT_SCHEMA,
  FORBIDDEN_ACTIONS,
  assessRecovery,
  assessmentExitCode,
  extractAssessmentInput,
  extractHostInput,
  parseAssessmentInput,
  renderAssessment,
  type AssessmentInput,
  type HostInput,
  type ObservedInput,
  type RecoveryAssessment
} from "../../src/integrations/hekate/recoveryAssessment";

const ROOT = "d6450921-6673-5535-b495-07cc165ada2d";
const NODE = "21dcea12-cb65-54cf-8581-e2f896490139";
const OTHER = "af690ee2-4e2e-5043-a71a-c0d126030971";
const ATTEMPT = "pilot-11c9f94a6bef-r1";
const LAUNCH = "a".repeat(32);
const REF = `git:${"a".repeat(40)}`;
const SENTINEL = "SENTINEL_f7d2_must_not_leak";
const INVALID = { ok: false, error: "input_invalid" };

afterEach(() => vi.restoreAllMocks());

/** An accepted, current, complete observation of the expected attempt. */
function base(): AssessmentInput {
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
      observedAt: "2026-10-09T12:00:00.000Z",
      rootId: ROOT,
      nodeId: NODE,
      consistency: "current",
      reasons: [],
      task: {
        stateRevision: 16,
        work: "done",
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
        recordCount: 12
      },
      acceptance: {
        decision: "accepted",
        contentRevision: 3,
        attemptEpoch: 4,
        attemptId: ATTEMPT,
        taskArtifact: { state: "shown", ref: REF },
        decisionArtifact: { state: "shown", ref: REF }
      },
      evidence: [
        { ref: 0, endpoint: `/api/plan-contract/v1/plans/${ROOT}`, sha256: "b".repeat(64) }
      ]
    }
  };
}

function observed(edit: (o: ObservedInput, i: AssessmentInput) => void): AssessmentInput {
  const input = base();
  edit(input.observation as ObservedInput, input);
  return input;
}

function host(edit: (h: HostInput) => void = () => undefined): HostInput {
  const h: HostInput = {
    rootId: ROOT,
    lifecycle: "dispatching",
    launchId: LAUNCH,
    currentNodeId: NODE,
    stopCode: null,
    journal: {
      unresolvedIntent: false,
      uncertainLaunch: false,
      uncertainStop: false,
      malformedRecords: 0
    }
  };
  edit(h);
  return h;
}

/** An in-progress node: allocated work, nothing more is recorded. */
const inProgress = (h?: HostInput) =>
  observed((o, i) => {
    o.task.work = "in_progress";
    o.task.effectiveAcceptance = "none";
    o.acceptance = null;
    o.trace = null;
    if (h) i.host = h;
  });

/** A released TODO: no attempt, but an older attempt's artifact and decision remain. */
const releasedTodo = () =>
  observed((o, i) => {
    i.expected.attemptId = null;
    i.expected.attemptEpoch = 2;
    o.task = {
      stateRevision: 16,
      work: "todo",
      contentRevision: 3,
      attemptId: null,
      attemptEpoch: 2,
      attemptContentRevision: null,
      effectiveAcceptance: "none"
    };
    o.selectedAttempt = null;
    o.trace = null;
    o.acceptance = { ...o.acceptance!, attemptEpoch: 1 };
  });

const WORDS = /\b(alive|idle|stalled|answered|healthy)\b/;

/** Holds for every assessment, whatever the finding. */
function assess(input: unknown): RecoveryAssessment {
  const result = assessRecovery(input);
  if (!result.ok) throw new Error(`assessment refused: ${result.error}`);
  const a = result.value;
  const text = JSON.stringify(a);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  expect(a.recommendation.automaticAllowed).toBe(false);
  expect(a.recommendation.forbidden).toEqual(FORBIDDEN_ACTIONS);
  expect(a.trust).toEqual({
    workerLiveness: "unknown",
    usefulProgress: "unknown",
    workerStatements: "not_read"
  });
  expect(text).not.toMatch(WORDS);
  expect(renderAssessment(a)).not.toMatch(WORDS);
  expect(a.recommendation.summary).toContain(`Node ${a.subject.nodeId}:`);
  expect(assessmentExitCode(a)).toBe(a.recommendation.action === "none" ? 0 : 4);
  return a;
}

const failed = (httpStatus: 404 | 503, reason: string): AssessmentInput => ({
  ...base(),
  observation: { status: "failed", httpStatus, reason }
});

describe("observation failure versus recorded outcome", () => {
  it.each(["TIMEOUT", "UNAVAILABLE", "HTTP_ERROR", "BUSY"])(
    "treats %s as an availability outage, never as a worker or source outcome",
    (reason) => {
      const a = assess(failed(503, reason));
      expect(a.observation).toMatchObject({ status: "failed", faultClass: "availability", reason });
      expect(a.attempt.workerSource).toBe("unobserved");
      expect(a.recommendation).toMatchObject({
        action: "reobserve_then_escalate",
        authority: "none_then_operator"
      });
      expect(a.attempt.decision.decision).toBeNull();
    }
  );

  it.each([
    ["bound_exceeded", ["RESPONSE_TOO_LARGE", "PAGE_LIMIT", "TOO_LARGE"]],
    [
      "contract",
      [
        "INVALID_RESPONSE",
        "INVALID_NUMBER",
        "DUPLICATE_KEY",
        "UNSAFE_KEY",
        "UNSUPPORTED_CONTRACT",
        "ROOT_MISMATCH",
        "IDENTITY_MISMATCH",
        "CURSOR_STALLED",
        "INVALID_SEQUENCE",
        "INVALID_ATTEMPT",
        "INVALID_NODE",
        "INVALID_OBSERVATION"
      ]
    ],
    ["config", ["INVALID_URL", "INVALID_ROOT", "INVALID_OPTIONS"]]
  ])("maps every %s reason to exactly that class", (faultClass, reasons) => {
    for (const reason of reasons) {
      const a = assess(failed(503, reason));
      expect(a.observation.faultClass).toBe(faultClass);
      expect(a.attempt.workerSource).toBe("unobserved");
      expect(a.recommendation.action).toBe(
        faultClass === "config" ? "escalate_operator" : "repair_observer_or_contract"
      );
    }
  });

  it("reports an invalid response as an unattributed contract fault", () => {
    const a = assess(failed(503, "INVALID_RESPONSE"));
    expect(a.observation).toMatchObject({ faultClass: "contract", faultSide: "unattributed" });
    expect(a.recommendation.authority).toBe("operator");
  });

  it("keeps a node that is not found separate from an outage", () => {
    const a = assess(failed(404, "NODE_NOT_FOUND"));
    expect(a.observation.faultClass).toBe("not_found");
    expect(a.recommendation.action).toBe("escalate_operator");
    expect(assessRecovery(failed(404, "TIMEOUT"))).toEqual(INVALID);
  });

  it("keeps a recorded rejection distinct from any outage and states its cause is untyped", () => {
    const a = assess(
      observed((o) => {
        o.task.effectiveAcceptance = "rejected";
        o.acceptance!.decision = "rejected";
      })
    );
    expect(a.attempt).toMatchObject({
      workerSource: "rejected_current",
      decision: { state: "current", decision: "rejected", causeTyping: "not_available" }
    });
    expect(a.observation.faultClass).toBe("none");
    expect(a.recommendation.action).toBe("operator_decides_new_attempt");
    expect(a.recommendation.codes).toContain("cause_typing_not_available");
  });

  it("replaces an unrecognized reason with a fixed sentinel and never echoes it", () => {
    const a = assess(failed(503, SENTINEL));
    expect(a.observation).toMatchObject({ faultClass: "unrecognized", reason: "UNRECOGNIZED" });
    expect(a.recommendation.action).toBe("repair_observer_or_contract");
    expect(JSON.stringify(a) + renderAssessment(a)).not.toContain(SENTINEL);
  });
});

describe("the expected fence", () => {
  it.each([
    ["rootId", (i: AssessmentInput) => (i.expected.rootId = OTHER)],
    ["nodeId", (i: AssessmentInput) => (i.expected.nodeId = OTHER)],
    ["attemptId", (i: AssessmentInput) => (i.expected.attemptId = "pilot-other-r2")],
    ["attemptId", (i: AssessmentInput) => (i.expected.attemptId = null)],
    ["attemptEpoch", (i: AssessmentInput) => (i.expected.attemptEpoch = 3)],
    ["attemptEpoch", (i: AssessmentInput) => (i.expected.attemptEpoch = 5)],
    ["contentRevision", (i: AssessmentInput) => (i.expected.contentRevision = 4)],
    ["owner", (i: AssessmentInput) => (i.expected.launchId = LAUNCH)],
    [
      "owner",
      (i: AssessmentInput) => {
        i.expected.launchId = LAUNCH;
        i.host = host((h) => (h.launchId = "b".repeat(32)));
      }
    ]
  ])("stops and re-reads authority when %s differs", (field, edit) => {
    const input = base();
    edit(input);
    const a = assess(input);
    expect(a.fence).toEqual({ status: "mismatch", mismatched: [field] });
    expect(a.recommendation.action).toBe("stop_and_reread_authority");
    expect(a.attempt.workerSource).toBe("not_assessed");
  });

  it("names every differing field and ignores a good-looking decision", () => {
    const input = base();
    input.expected.attemptEpoch = 9;
    input.expected.contentRevision = 9;
    expect(assess(input).fence.mismatched).toEqual(["attemptEpoch", "contentRevision"]);
  });

  it("matches the owner only on the exact launch id", () => {
    const input = base();
    input.expected.launchId = LAUNCH;
    input.host = host((h) => (h.lifecycle = "exited"));
    expect(assess(input).fence.status).toBe("match");
  });

  it("checks only the owner fence when the observation failed", () => {
    const input = failed(503, "TIMEOUT");
    input.expected.launchId = LAUNCH;
    const a = assess(input);
    expect(a.fence).toEqual({ status: "mismatch", mismatched: ["owner"] });
    expect(a.recommendation.action).toBe("stop_and_reread_authority");
    expect(assess(failed(503, "TIMEOUT")).fence.status).toBe("unchecked");
  });
});

describe("decision matching", () => {
  it("accepts only a current, fully bound decision", () => {
    const a = assess(base());
    expect(a.attempt).toMatchObject({
      workerSource: "accepted_current",
      claim: "claimed_trace_linked",
      decision: { state: "current", decision: "accepted" }
    });
    expect(a.recommendation).toMatchObject({ action: "none", authority: "none" });
    expect(a.evidence.completeness).toBe("complete");
  });

  it("treats an older epoch's acceptance as history, never as accepted", () => {
    const a = assess(
      observed((o) => {
        o.acceptance!.attemptEpoch = 3;
        o.task.effectiveAcceptance = "none";
      })
    );
    expect(a.attempt.workerSource).toBe("decision_historical");
    expect(a.attempt.decision).toMatchObject({ state: "historical", decision: null });
    expect(a.recommendation.action).toBe("lead_review_required");
  });

  it.each([
    ["a different attempt id", (o: ObservedInput) => (o.acceptance!.attemptId = "pilot-other-r1")],
    [
      "a different content revision",
      (o: ObservedInput) => {
        o.acceptance!.contentRevision = 2;
        o.task.effectiveAcceptance = "stale";
      }
    ],
    ["a stale effective acceptance", (o: ObservedInput) => (o.task.effectiveAcceptance = "stale")]
  ])("does not accept a decision with %s", (_, edit) => {
    const a = assess(observed(edit));
    expect(a.attempt.workerSource).toBe("decision_stale");
    expect(a.recommendation.action).toBe("lead_review_required");
  });

  it.each([
    ["a decision epoch above the node's", (o: ObservedInput) => (o.acceptance!.attemptEpoch = 5)],
    ["a done node without an attempt id", (o: ObservedInput) => (o.task.attemptId = null)],
    [
      "an effective acceptance that disagrees with the decision",
      (o: ObservedInput) => (o.task.effectiveAcceptance = "rejected")
    ],
    ["an effective acceptance without a decision", (o: ObservedInput) => (o.acceptance = null)]
  ])("reports %s as inconsistent", (_, edit) => {
    const input = observed(edit);
    // The fence is satisfied so the inconsistency itself is what is judged.
    input.expected.attemptId = (input.observation as ObservedInput).task.attemptId;
    const a = assess(input);
    expect(a.attempt.workerSource).toBe("inconsistent");
    expect(a.recommendation.action).toBe("escalate_operator");
  });

  it("does not accept when the attempt's content pin is stale", () => {
    const a = assess(observed((o) => (o.task.attemptContentRevision = 2)));
    expect(a.attempt.workerSource).toBe("pins_stale");
    expect(a.recommendation.action).toBe("operator_decides_new_attempt");
    const pins = assess(observed((o) => (o.selectedAttempt!.contentPins = "stale")));
    expect(pins.attempt.workerSource).toBe("pins_stale");
  });

  it.each([
    [
      "a withheld task artifact",
      (o: ObservedInput) => (o.acceptance!.taskArtifact = { state: "withheld" })
    ],
    [
      "a withheld decision artifact",
      (o: ObservedInput) => (o.acceptance!.decisionArtifact = { state: "withheld" })
    ],
    [
      "a missing decision artifact",
      (o: ObservedInput) => (o.acceptance!.decisionArtifact = { state: "none" })
    ],
    [
      "different artifacts",
      (o: ObservedInput) =>
        (o.acceptance!.decisionArtifact = { state: "shown", ref: `git:${"c".repeat(40)}` })
    ],
    [
      "a historical selected attempt",
      (o: ObservedInput) => (o.selectedAttempt!.scope = "historical")
    ],
    [
      "a selected attempt of another id",
      (o: ObservedInput) => (o.selectedAttempt!.attemptId = "pilot-x")
    ],
    [
      "a selected attempt of another epoch",
      (o: ObservedInput) => (o.selectedAttempt!.attemptEpoch = 3)
    ],
    ["no selected attempt", (o: ObservedInput) => (o.selectedAttempt = null)],
    ["unknown content pins", (o: ObservedInput) => (o.selectedAttempt!.contentPins = "unknown")]
  ])("never yields accepted for %s", (_, edit) => {
    const a = assess(observed(edit));
    expect(a.attempt.workerSource).not.toBe("accepted_current");
    expect(a.attempt.decision.state).not.toBe("current");
    expect(a.recommendation.action).not.toBe("none");
  });

  it("keeps an old artifact and decision on a released TODO historical only", () => {
    const input = releasedTodo();
    const a = assess(input);
    expect(a.attempt).toMatchObject({
      workerSource: "no_attempt",
      claim: "none_since_fence",
      decision: { state: "historical", decision: null }
    });
    expect(a.recommendation.action).toBe("none");
    expect(a.recommendation.codes).toContain("decision_historical_only");
    // A newer epoch than expected is a mismatch, not a new attempt to assess.
    input.expected.attemptEpoch = 1;
    expect(assess(input).recommendation.action).toBe("stop_and_reread_authority");
  });

  it("reports done work without a decision as awaiting review", () => {
    const a = assess(
      observed((o) => {
        o.acceptance = null;
        o.task.effectiveAcceptance = "none";
      })
    );
    expect(a.attempt.workerSource).toBe("awaiting_review");
    expect(a.recommendation).toMatchObject({ action: "lead_review_required", authority: "lead" });
  });

  it("reports cancelled work", () => {
    const a = assess(observed((o) => (o.task.work = "cancelled")));
    expect(a.attempt.workerSource).toBe("cancelled");
    expect(a.recommendation.action).toBe("operator_decides_new_attempt");
  });
});

describe("claim reconciliation", () => {
  it("decides pre-claim from the plan node, not from a host stop code", () => {
    const input = releasedTodo();
    input.host = host((h) => {
      h.lifecycle = "exited";
      h.currentNodeId = null;
      h.stopCode = "spec_pending";
    });
    const a = assess(input);
    expect(a.attempt.claim).toBe("none_since_fence");
    expect(a.host.stopCode).toBe("known_preclaim_code");
    expect(a.recommendation.codes).toContain("known_preclaim_code");
  });

  it("does not read a pre-claim host code over an actual attempt", () => {
    const a = assess(
      inProgress(
        host((h) => {
          h.stopCode = "spec_pending";
        })
      )
    );
    expect(a.attempt).toMatchObject({
      workerSource: "in_flight",
      claim: "claimed_trace_unavailable"
    });
    expect(a.recommendation.codes).toContain("preclaim_code_with_claimed_attempt");
    expect(a.recommendation.codes).not.toContain("known_preclaim_code");
  });

  it("calls an unknown host code unrecognized without reading it as a cause", () => {
    const a = assess(
      observed((o, i) => {
        o.task.work = "todo";
        o.task.attemptId = null;
        o.task.attemptEpoch = 4;
        o.task.effectiveAcceptance = "none";
        o.acceptance = null;
        o.selectedAttempt = null;
        o.trace = null;
        i.expected.attemptId = null;
        i.host = host((h) => (h.stopCode = "UNRECOGNIZED"));
      })
    );
    expect(a.host.stopCode).toBe("unrecognized_code");
    expect(a.attempt.workerSource).toBe("no_attempt");
  });

  it("splits a claimed attempt by trace linkage", () => {
    expect(assess(inProgress()).attempt.claim).toBe("claimed_trace_unavailable");
    const withTrace = (claimLinkage: "matched" | "unavailable") =>
      assess(
        observed((o) => {
          o.task.work = "in_progress";
          o.task.effectiveAcceptance = "none";
          o.acceptance = null;
          o.trace!.claimLinkage = claimLinkage;
        })
      ).attempt.claim;
    expect(withTrace("matched")).toBe("claimed_trace_linked");
    expect(withTrace("unavailable")).toBe("claimed_trace_unlinked");
  });

  it("treats in-progress as allocated work, never a started or live worker", () => {
    const a = assess(inProgress());
    expect(a.attempt.workerSource).toBe("in_flight");
    expect(a.recommendation.action).toBe("wait_and_reobserve");
    expect(a.recommendation.codes).toContain("host_not_supplied");
    expect(a.host.owner).toBe("not_supplied");
    expect(JSON.stringify(a) + renderAssessment(a)).not.toMatch(
      /\b(has started|is running|is live|worker_started)\b/i
    );
  });

  it("does not let a partial trace invent liveness", () => {
    const a = assess(
      observed((o) => {
        o.task.work = "in_progress";
        o.task.effectiveAcceptance = "none";
        o.acceptance = null;
        o.consistency = "partial";
        o.reasons = ["trace_capped", "trace_unfinished"];
        o.trace!.status = "unfinished";
        o.trace!.capped = true;
      })
    );
    expect(a.trust.workerLiveness).toBe("unknown");
    expect(a.evidence.completeness).toBe("partial");
    expect(a.observation.reasons).toEqual(["trace_capped", "trace_unfinished"]);
    expect(a.attempt.workerSource).toBe("in_flight");
  });
});

describe("host reconciliation", () => {
  const cases: [string, (h: HostInput) => void, string, string][] = [
    ["dispatching this node", () => undefined, "owner_dispatching_this_node", "wait_and_reobserve"],
    [
      "dispatching another node",
      (h) => (h.currentNodeId = OTHER),
      "owner_dispatching_other_node",
      "escalate_operator"
    ],
    [
      "dispatching an unknown node",
      (h) => (h.currentNodeId = null),
      "owner_unverified",
      "escalate_operator"
    ],
    [
      "between nodes",
      (h) => {
        h.lifecycle = "running";
        h.currentNodeId = null;
      },
      "owner_idle_between_nodes",
      "escalate_operator"
    ],
    ["unverified", (h) => (h.lifecycle = "unverified"), "owner_unverified", "escalate_operator"],
    [
      "unrecognized",
      (h) => (h.lifecycle = "unrecognized"),
      "owner_unverified",
      "escalate_operator"
    ],
    ["gone", (h) => (h.lifecycle = "owner_gone"), "owner_gone", "escalate_operator"],
    ["exited", (h) => (h.lifecycle = "exited"), "owner_exited", "escalate_operator"],
    ["stopped", (h) => (h.lifecycle = "stopped"), "owner_exited", "escalate_operator"],
    ["failed", (h) => (h.lifecycle = "failed"), "owner_exited", "escalate_operator"],
    [
      "stop requested",
      (h) => (h.lifecycle = "stop_requested"),
      "owner_stop_requested",
      "escalate_operator"
    ],
    ["absent", (h) => (h.lifecycle = "no_host"), "no_host", "escalate_operator"],
    ["another root's", (h) => (h.rootId = OTHER), "host_mismatch", "escalate_operator"],
    ["mismatched", (h) => (h.lifecycle = "host_mismatch"), "host_mismatch", "escalate_operator"]
  ];

  it.each(cases)("reads a host that is %s as %s for work in progress", (_, edit, owner, action) => {
    const a = assess(inProgress(host(edit)));
    expect(a.host).toMatchObject({ supplied: true, trust: "supplied_unauthenticated", owner });
    expect(a.recommendation.action).toBe(action);
  });

  it("reads a stop request as a request, not a stop", () => {
    const a = assess(inProgress(host((h) => (h.lifecycle = "stop_requested"))));
    expect(a.host.owner).toBe("owner_stop_requested");
    expect(a.host.owner).not.toBe("owner_exited");
    expect(a.recommendation.codes).toContain("owner_stop_requested");
  });

  it("does not call missing host input a failed owner", () => {
    const a = assess(inProgress());
    expect(a.host).toMatchObject({
      supplied: false,
      owner: "not_supplied",
      uncertainEffects: false
    });
    expect(a.recommendation.action).toBe("wait_and_reobserve");
  });

  it("waits when the owner dispatches a node the plan has not yet claimed", () => {
    const input = releasedTodo();
    input.host = host();
    expect(assess(input).recommendation.action).toBe("wait_and_reobserve");
  });
});

describe("unresolved effects", () => {
  const uncertain: [string, (j: NonNullable<HostInput["journal"]>) => void][] = [
    ["an unresolved intent", (j) => (j.unresolvedIntent = true)],
    ["an uncertain launch", (j) => (j.uncertainLaunch = true)],
    ["an uncertain stop", (j) => (j.uncertainStop = true)],
    ["a malformed record", (j) => (j.malformedRecords = 1)]
  ];

  it.each(uncertain)("requires reconciliation for %s beside any attempt state", (_, edit) => {
    for (const input of [base(), inProgress(host())]) {
      input.host = host((h) => edit(h.journal!));
      const a = assess(input);
      expect(a.host.uncertainEffects).toBe(true);
      expect(a.recommendation).toMatchObject({
        action: "reconcile_uncertain_effects",
        authority: "operator",
        forbidden: FORBIDDEN_ACTIONS
      });
      expect(a.recommendation.codes).toContain("uncertain_effects");
    }
  });

  it("is not cleared by an exited owner with the exact matching launch id", () => {
    const input = base();
    input.expected.launchId = LAUNCH;
    input.host = host((h) => {
      h.lifecycle = "exited";
      h.journal!.uncertainLaunch = true;
    });
    const a = assess(input);
    expect(a.fence.status).toBe("match");
    expect(a.host).toMatchObject({ owner: "owner_exited", uncertainEffects: true });
    expect(a.recommendation.action).toBe("reconcile_uncertain_effects");
  });

  it("yields to a fence mismatch, an observation failure and a stale observation", () => {
    const uncertainHost = host((h) => (h.journal!.uncertainStop = true));
    const mismatch = base();
    mismatch.expected.attemptEpoch = 3;
    mismatch.host = uncertainHost;
    expect(assess(mismatch).recommendation.action).toBe("stop_and_reread_authority");
    const outage = failed(503, "TIMEOUT");
    outage.host = uncertainHost;
    expect(assess(outage).recommendation.action).toBe("reobserve_then_escalate");
    const stale = observed((o) => (o.consistency = "stale"));
    stale.host = uncertainHost;
    expect(assess(stale).recommendation.action).toBe("reobserve_then_escalate");
    expect(assess(stale).host.uncertainEffects).toBe(true);
  });

  it("does not treat a journal that was not reported as uncertain", () => {
    const a = assess({ ...base(), host: host((h) => (h.journal = null)) });
    expect(a.host.uncertainEffects).toBe(false);
    expect(a.recommendation.codes).toContain("journal_not_reported");
  });
});

describe("observation consistency", () => {
  it("asks for a fresh read instead of classifying a stale observation", () => {
    const a = assess(observed((o) => (o.consistency = "stale")));
    expect(a.attempt.workerSource).toBe("not_assessed");
    expect(a.evidence.completeness).toBe("stale");
    expect(a.recommendation).toMatchObject({
      action: "reobserve_then_escalate",
      authority: "none_then_operator"
    });
  });

  it("still classifies a partial observation and records its reasons", () => {
    const a = assess(
      observed((o) => {
        o.consistency = "partial";
        o.reasons = ["trace_capped"];
      })
    );
    expect(a.attempt.workerSource).toBe("accepted_current");
    expect(a.evidence.completeness).toBe("partial");
    expect(a.observation.reasons).toEqual(["trace_capped"]);
    expect(a.recommendation.codes).toContain("observation_partial");
  });

  it("treats a null event history with no attempt as the normal untouched state", () => {
    const input = observed((o, i) => {
      i.expected.attemptId = null;
      i.expected.attemptEpoch = 0;
      o.task = {
        stateRevision: 16,
        work: "todo",
        contentRevision: 3,
        attemptId: null,
        attemptEpoch: 0,
        attemptContentRevision: null,
        effectiveAcceptance: "none"
      };
      o.selectedAttempt = null;
      o.trace = null;
      o.acceptance = null;
    });
    const a = assess(input);
    expect(a.attempt).toMatchObject({ workerSource: "no_attempt", claim: "none_since_fence" });
    expect(a.recommendation.action).toBe("none");
  });
});

describe("strict input", () => {
  const valid = () => JSON.stringify(base());

  it("round-trips a valid input byte-for-byte into the same assessment", () => {
    const parsed = parseAssessmentInput(valid());
    expect(parsed.ok).toBe(true);
    expect(parseAssessmentInput(new TextEncoder().encode(valid()))).toEqual(parsed);
    if (parsed.ok) expect(assess(parsed.value)).toEqual(assess(base()));
  });

  it.each([
    ["an oversized document", () => valid() + " ".repeat(64 * 1024)],
    ["a duplicate key", () => valid().replace('"nodeId"', '"rootId":"' + ROOT + '","nodeId"')],
    ["a float", () => valid().replace('"attemptEpoch":4', '"attemptEpoch":4.5')],
    ["an exponent", () => valid().replace('"attemptEpoch":4', '"attemptEpoch":4e0')],
    [
      "an unsafe integer",
      () => valid().replace('"attemptEpoch":4', '"attemptEpoch":9007199254740993')
    ],
    ["a __proto__ key", () => valid().replace('"schema"', '"__proto__":{},"schema"')],
    ["an unknown key", () => valid().replace('"schema"', `"extra":"${SENTINEL}","schema"`)],
    [
      "an unknown nested key",
      () => valid().replace('"status":"observed"', `"status":"observed","note":"${SENTINEL}"`)
    ],
    ["another schema", () => valid().replace("input/v1", "input/v2")],
    ["not JSON", () => `{"schema":"${SENTINEL}`]
  ])("refuses %s with a code that echoes nothing", (_, make) => {
    const result = parseAssessmentInput(make());
    expect(result).toEqual(INVALID);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("refuses a BOM, invalid UTF-8 and oversized bytes", () => {
    const bytes = new TextEncoder().encode(valid());
    expect(parseAssessmentInput(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toEqual(INVALID);
    expect(parseAssessmentInput(new Uint8Array([...bytes, 0xff]))).toEqual(INVALID);
    expect(parseAssessmentInput(new Uint8Array(64 * 1024 + 1).fill(0x20))).toEqual(INVALID);
  });

  it("bounds reasons and citations and accepts only canonical citation paths", () => {
    const reasons = observed((o) => (o.reasons = Array(33).fill("trace_capped")));
    expect(assessRecovery(reasons)).toEqual(INVALID);
    const citation = (endpoint: string) => ({ ref: 0, endpoint, sha256: "b".repeat(64) });
    const plan = citation(`/api/plan-contract/v1/plans/${ROOT}`);
    const many = observed((o) => (o.evidence = Array(17).fill(plan)));
    expect(assessRecovery(many)).toEqual(INVALID);
    for (const endpoint of [
      `http://127.0.0.1:5100/api/plan-contract/v1/plans/${ROOT}`,
      `/api/plan-contract/v1/plans/${OTHER}`,
      `/api/plan-contract/v1/nodes/${OTHER}/events?afterSeq=0`,
      `/api/plan-contract/v1/nodes/${NODE}/events?afterSeq=x`,
      `/api/plan-contract/v1/nodes/${NODE}/secret`,
      `C:\\secret\\${SENTINEL}`
    ])
      expect(assessRecovery(observed((o) => (o.evidence = [citation(endpoint)])))).toEqual(INVALID);
    const node = `/api/plan-contract/v1/nodes/${NODE}`;
    const trace = `${node}/attempts/${encodeURIComponent(ATTEMPT)}/trace?afterSeq=3`;
    const ok = assess(
      observed((o) => (o.evidence = [citation(`${node}/events?afterSeq=7`), citation(trace)]))
    );
    expect(ok.evidence.citations).toHaveLength(2);
  });

  it("refuses malformed identities and out-of-range counters", () => {
    for (const edit of [
      (i: AssessmentInput) => (i.expected.rootId = "not-a-guid"),
      (i: AssessmentInput) => (i.expected.contentRevision = 0),
      (i: AssessmentInput) => (i.expected.attemptEpoch = -1),
      (i: AssessmentInput) => (i.expected.launchId = "ABC"),
      (i: AssessmentInput) => (i.expected.attemptId = "has space")
    ]) {
      const input = base();
      edit(input);
      expect(assessRecovery(input)).toEqual(INVALID);
    }
    expect(assessRecovery(null)).toEqual(INVALID);
    expect(assessRecovery({})).toEqual(INVALID);
  });
});

describe("allowlisted extraction and privacy", () => {
  const hostile = () => ({
    status: 200,
    body: {
      schema: "attempt-progress/v1",
      observedAt: "2026-10-09T12:00:00.000Z",
      rootId: ROOT,
      nodeId: NODE,
      projectId: ROOT,
      consistency: "partial",
      reasons: ["trace_capped", SENTINEL, `drift_${SENTINEL}`, 7],
      task: {
        work: "done",
        stateRevision: 9,
        contentRevision: 3,
        attemptId: ATTEMPT,
        attemptEpoch: 4,
        attemptContentRevision: 3,
        attemptPrereqDigest: "c".repeat(64),
        effectiveAcceptance: "accepted",
        name: SENTINEL
      },
      bindings: { before: { note: SENTINEL }, after: null },
      selectedAttempt: {
        attemptId: ATTEMPT,
        attemptEpoch: 4,
        scope: "current",
        sourceEventSeq: 5,
        attemptContentRevision: 3,
        contentPins: "current",
        extra: SENTINEL
      },
      trace: {
        status: "exited",
        integrity: "verified",
        claimLinkage: "matched",
        recordCount: 2,
        capped: false,
        truncated: false,
        metadataStable: true,
        exitCode: 0,
        reason: SENTINEL,
        prompt: { text: SENTINEL }
      },
      acceptance: {
        source: "plan_store_recorded_decision",
        decision: "accepted",
        contentRevision: 3,
        attemptEpoch: 4,
        attemptId: ATTEMPT,
        taskArtifact: { state: "shown", ref: REF },
        decisionArtifact: { state: "shown", ref: REF },
        evidence: { state: "withheld", ref: SENTINEL }
      },
      evidence: [
        { ref: 0, endpoint: `/api/plan-contract/v1/plans/${ROOT}`, sha256: "b".repeat(64) },
        { ref: 1, endpoint: `http://evil.invalid/${SENTINEL}`, sha256: "b".repeat(64) },
        { ref: 2, endpoint: "withheld", sha256: "b".repeat(64) }
      ],
      activity: { items: [{ kind: "text", text: SENTINEL }] },
      aiSnapshot: { facts: { events: [{ payload: SENTINEL }] } },
      trust: { activity: SENTINEL }
    }
  });

  const respond = (value: unknown) => value as AttemptProgressResponse;
  const expected = base().expected;

  it("keeps only the allowlisted facts and drops every free field", () => {
    const result = extractAssessmentInput({ expected, response: respond(hostile()) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.value.observation as ObservedInput;
    expect(o.reasons).toEqual(["trace_capped", "UNRECOGNIZED", "UNRECOGNIZED", "UNRECOGNIZED"]);
    expect(o.evidence.map((c) => c.ref)).toEqual([0]);
    expect(JSON.stringify(result.value)).not.toContain(SENTINEL);
    expect(Object.keys(o).sort()).toEqual(
      [
        "acceptance",
        "consistency",
        "evidence",
        "nodeId",
        "observedAt",
        "reasons",
        "rootId",
        "selectedAttempt",
        "status",
        "task",
        "taskArtifact",
        "trace"
      ].sort()
    );
    const a = assess(result.value);
    expect(JSON.stringify(a) + renderAssessment(a)).not.toContain(SENTINEL);
    expect(a.attempt.workerSource).toBe("accepted_current");
  });

  it("keeps a withheld artifact withheld so it cannot yield accepted", () => {
    const response = hostile();
    Object.assign(response.body.acceptance, { decisionArtifact: { state: "withheld" } });
    const result = extractAssessmentInput({ expected, response: respond(response) });
    expect(result.ok && assess(result.value).attempt.workerSource).toBe("decision_stale");
  });

  it("extracts typed service failures and normalizes unknown reasons", () => {
    const outage = extractAssessmentInput({
      expected,
      response: { status: 503, body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "TIMEOUT" } }
    });
    expect(outage.ok && assess(outage.value).observation.faultClass).toBe("availability");
    const odd = extractAssessmentInput({
      expected,
      response: {
        status: 503,
        body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: SENTINEL }
      }
    });
    expect(odd.ok && JSON.stringify(odd.value)).not.toContain(SENTINEL);
    const missing = extractAssessmentInput({
      expected,
      response: { status: 404, body: { code: "NODE_NOT_FOUND" } }
    });
    expect(missing.ok && assess(missing.value).observation.faultClass).toBe("not_found");
    const unknown = { status: 500 } as never;
    expect(extractAssessmentInput({ expected, response: unknown })).toEqual(INVALID);
  });

  it("extracts host status through an allowlist and never keeps free text", () => {
    const extracted = extractHostInput({
      rootId: ROOT,
      journal: {
        unresolvedIntent: false,
        uncertainLaunch: true,
        uncertainStop: false,
        malformedRecords: 0,
        detail: SENTINEL
      },
      host: "attached",
      lifecycle: "dispatching",
      liveness: "running",
      phase: SENTINEL,
      state: SENTINEL,
      stopReason: SENTINEL,
      launchId: LAUNCH,
      startedAt: SENTINEL,
      current: { node: SENTINEL, nodeId: NODE, workerLiveness: "unknown" },
      counters: { [SENTINEL]: 1 },
      lastRun: { outcome: SENTINEL }
    });
    expect(extracted).toEqual({
      ok: true,
      value: {
        rootId: ROOT,
        lifecycle: "dispatching",
        launchId: LAUNCH,
        currentNodeId: NODE,
        stopCode: "UNRECOGNIZED",
        journal: {
          unresolvedIntent: false,
          uncertainLaunch: true,
          uncertainStop: false,
          malformedRecords: 0
        }
      }
    });
    const lifecycle = extractHostInput({ lifecycle: SENTINEL, journal: null });
    expect(lifecycle.ok && lifecycle.value.lifecycle).toBe("unrecognized");
    expect(JSON.stringify(lifecycle)).not.toContain(SENTINEL);
    for (const bad of [
      null,
      [],
      "x",
      { lifecycle: "running", journal: { unresolvedIntent: "no" } },
      {
        lifecycle: "running",
        journal: {
          unresolvedIntent: false,
          uncertainLaunch: false,
          uncertainStop: false,
          malformedRecords: -1
        }
      },
      { lifecycle: "running", journal: [] }
    ])
      expect(extractHostInput(bad)).toEqual(INVALID);
  });
});

describe("determinism and non-mutation", () => {
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) freeze(v);
      Object.freeze(value);
    }
    return value;
  };

  it("returns byte-identical output for the same frozen input without ambient effects", () => {
    const input = freeze(base());
    const trap = (name: string) => () => {
      throw new Error(`${name} must not be used`);
    };
    vi.spyOn(Date, "now").mockImplementation(trap("clock"));
    vi.spyOn(Math, "random").mockImplementation(trap("random"));
    vi.spyOn(globalThis, "fetch").mockImplementation(trap("network") as never);
    const first = JSON.stringify(assessRecovery(input));
    const second = JSON.stringify(assessRecovery(input));
    vi.restoreAllMocks();
    expect(first).toContain('"accepted_current"');
    expect(second).toBe(first);
    expect(JSON.stringify(input)).toBe(JSON.stringify(base()));
  });
});
