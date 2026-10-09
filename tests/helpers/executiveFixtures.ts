import type { LeafState, LeafStatus } from "../../src/integrations/hekate/devCoordination";
import {
  projectRoot,
  type ExecutiveOverview,
  type ExecutiveRootView,
  type ExecutiveTask
} from "../../src/integrations/hekate/executiveOverview";

/** Shared builders for the executive overview UI, HTTP and browser tests. */
export const guid = (n: number, tail = 0) =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${tail.toString(16).padStart(12, "0")}`;
export const ROOT_A = guid(1);
export const ROOT_B = guid(2);
export const ROOT_C = guid(3);
export const NOW = "2026-10-09T10:00:00.000Z";
export const SHA = "a1".repeat(32);

export function leaf(n: number, state: LeafState, over: Partial<LeafStatus> = {}): LeafStatus {
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

export function rootView(
  rootId: string,
  label: string,
  leaves: LeafStatus[],
  goal = "Configured goal"
): ExecutiveRootView {
  const leafCounts: Partial<Record<LeafState, number>> = {};
  for (const l of leaves) leafCounts[l.state] = (leafCounts[l.state] ?? 0) + 1;
  return projectRoot(
    {
      status: "ok",
      rootId,
      progress: {
        state: "active",
        rootCompletion: "incomplete",
        rootAcceptance: "pending",
        leafCounts
      },
      leaves
    },
    { rootId, label, goal },
    NOW
  );
}

export const overviewOf = (...roots: ExecutiveRootView[]): ExecutiveOverview => ({
  schema: "executive-overview/v1",
  generatedAt: NOW,
  atomic: false,
  roots
});

/** An attempt-progress/v1 body whose task fence matches the overview task. */
export function progressBody(
  rootId: string,
  task: ExecutiveTask,
  over: Record<string, unknown> = {}
) {
  return {
    schema: "attempt-progress/v1",
    observedAt: NOW,
    rootId,
    nodeId: task.nodeId,
    projectId: guid(9),
    consistency: "current",
    reasons: [],
    task: {
      work: "in_progress",
      stateRevision: task.stateRevision,
      contentRevision: task.contentRevision,
      attemptId: task.attemptId,
      attemptEpoch: task.attemptEpoch,
      attemptContentRevision: task.contentRevision,
      attemptPrereqDigest: null,
      effectiveAcceptance: "none"
    },
    bindings: { before: null, after: null },
    selectedAttempt: task.attemptId
      ? {
          attemptId: task.attemptId,
          attemptEpoch: task.attemptEpoch,
          scope: "current",
          sourceEventSeq: null,
          attemptContentRevision: task.contentRevision,
          contentPins: "current"
        }
      : null,
    trace: task.attemptId
      ? {
          status: "running",
          integrity: "verified",
          claimLinkage: "matched",
          recordCount: 2,
          firstSeq: 0,
          lastSeq: 1,
          pages: 1,
          capped: false,
          truncated: false,
          metadataStable: true,
          streams: { stdout: 2, stderr: 0, hekate: 0 },
          exitCode: null
        }
      : null,
    acceptance: {
      source: "plan_store_recorded_decision",
      decision: null,
      contentRevision: null,
      attemptEpoch: null,
      attemptId: null,
      taskArtifact: { state: "none" },
      decisionArtifact: { state: "none" },
      evidence: { state: "none" }
    },
    evidence: [{ ref: 0, endpoint: `/api/plan-contract/v1/plans/${rootId}`, sha256: SHA }],
    assessment: { workerLiveness: "unknown", usefulProgress: "unknown", basis: "x" },
    activity: task.attemptId
      ? {
          trust: "untrusted_inert_unverified_worker_claims",
          source: "complete_stdout_claude_stream_json_assistant_records",
          items: [
            {
              traceSeq: 1,
              index: 0,
              kind: "text",
              text: "I will fix the parser.",
              textClipped: false
            },
            { traceSeq: 2, index: 0, kind: "tool_use", tool: "Edit" }
          ],
          totalItems: 2,
          omittedItems: 0,
          counts: {
            stdoutRecords: 2,
            assistantRecords: 2,
            otherRecords: 0,
            unavailableRecords: 0,
            withheldItems: 0
          },
          complete: true
        }
      : null,
    aiSnapshot: { facts: { trace: null, events: [] } },
    aiSnapshotEventsOmitted: 0,
    trust: {
      activity: "unverified_worker_claims",
      acceptance: "plan_store_recorded_decision",
      verifier: "not_reported"
    },
    ...over
  };
}
