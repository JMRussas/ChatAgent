import { randomUUID } from "node:crypto";
import type { CodingWorkItem } from "../../src/workspace/codingProjects";
import { describe, expect, it } from "vitest";
import {
  codingDigest,
  compactDigest,
  digestReturnedRun,
  formatWorkDigest,
  workflowDigest
} from "../../src/workspace/workDigest";
import {
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowRun
} from "../../src/workflows/types";

const at = "2026-10-10T20:00:00.000Z";
function records() {
  const definition = workflowDefinitionSchema.parse({
    version: 1,
    name: "Report review",
    description: "Read the report and review its actual result.",
    steps: [
      { id: "report", name: "Read report", action: { type: "tool", tool: "fetch_report" } },
      {
        id: "review",
        name: "Review result",
        action: { type: "human", instructions: "Is this report acceptable?" }
      }
    ]
  });
  const plan: StoredWorkflowPlan = {
    id: randomUUID(),
    ownerId: "owner",
    definition,
    revision: 1,
    stateRevision: 1,
    taskId: randomUUID(),
    work: "todo",
    attemptId: null,
    attemptEpoch: 0,
    artifactRef: null
  };
  const run: WorkflowRun = {
    version: 1,
    id: randomUUID(),
    planId: plan.id,
    ownerId: plan.ownerId,
    definition,
    revision: 1,
    attemptEpoch: 1,
    status: "waiting_input",
    startedAt: at,
    updatedAt: at,
    steps: [
      {
        id: "report",
        name: "Read report",
        status: "completed",
        endedAt: at,
        output: { status: 200, secret: "REPORT_BODY_MUST_NOT_APPEAR" }
      },
      { id: "review", name: "Review result", status: "waiting_input" }
    ]
  };
  return { plan, run };
}

describe("shared factual work digest", () => {
  it("distinguishes a recorded gated decline from a system failure, with a step reference and no note contents", () => {
    const { plan, run } = records();
    run.definition.steps[1].success = { path: "approved", equals: true };
    run.status = "failed";
    run.error = "Step not approved.";
    run.steps[1] = {
      ...run.steps[1],
      status: "failed",
      output: { approved: false, note: "PRIVATE_REVIEW_NOTE" },
      error: "Step not approved.",
      endedAt: at
    };
    const declined = workflowDigest(plan, run);
    expect(declined).toMatchObject({
      state: "needs_attention",
      approval: null,
      errors: [],
      decision: null,
      lastOutcome: {
        stepId: "review",
        summary: "Step not approved.",
        ref: `run:${run.id}:step:review`
      }
    });
    expect(declined.stateText).toContain("Not approved.");
    expect(declined.stateText).toContain("new run from step one");
    expect(JSON.stringify(declined)).not.toContain("PRIVATE_REVIEW_NOTE");
    expect(formatWorkDigest(declined)).toContain("Step not approved.");
    const unknown = workflowDigest(undefined, run);
    expect(unknown.stateText).toContain("Plan readiness is not confirmed.");
    expect(unknown.stateText).toContain("Current plan revision is unknown.");
    const held = workflowDigest({ ...plan, work: "in_progress", attemptId: run.id }, run);
    expect(held.stateText).toContain("Plan readiness is not confirmed.");
    expect(held.stateText).not.toContain("ready for a new run");
    const historical = workflowDigest({ ...plan, revision: 2 }, run);
    expect(historical).toMatchObject({
      state: "ready",
      stateText: "Edited since the last run.",
      run: { current: false },
      lastOutcome: { ref: `run:${run.id}:step:review` }
    });
    expect(formatWorkDigest(historical)).toContain("Historical revision outcome");
    for (const change of [
      { status: "uncertain" as const, error: "Terminal decision state could not be persisted." },
      { status: "failed" as const, error: "Step action failed" }
    ]) {
      const problem = workflowDigest(plan, { ...run, ...change });
      expect(problem.errors).toEqual([change.error]);
      expect(problem.stateText).not.toContain("Not approved.");
      expect(problem.lastOutcome?.stepId).toBe("report");
    }
  });

  it("does not infer a deliberate decline from malformed flags, another rule, a tool or mismatched recorded errors", () => {
    const { plan, run } = records();
    run.definition.steps[1].success = { path: "approved", equals: true };
    run.status = "failed";
    run.error = "Step not approved.";
    run.steps[1] = {
      ...run.steps[1],
      status: "failed",
      output: { approved: false },
      error: "Step not approved."
    };
    const alternatives = [
      (copy: WorkflowRun) => {
        copy.definition.steps[1].success = undefined;
      },
      (copy: WorkflowRun) => {
        copy.definition.steps[1].success = { path: "accepted", equals: true };
      },
      (copy: WorkflowRun) => {
        copy.definition.steps[1].action = { type: "tool", tool: "fetch_report" };
      },
      (copy: WorkflowRun) => {
        copy.steps[1].output = { approved: "false" };
      },
      (copy: WorkflowRun) => {
        copy.steps[1].output = { note: "No approval flag" };
      },
      (copy: WorkflowRun) => {
        copy.steps[1].error = "Step action failed";
      }
    ];
    for (const modify of alternatives) {
      const changed = structuredClone(run);
      modify(changed);
      const digest = workflowDigest({ ...plan, definition: changed.definition }, changed);
      expect(digest.errors).toEqual(["Step not approved."]);
      expect(digest.stateText).not.toContain("Not approved.");
      expect(digest.lastOutcome?.stepId).toBe("report");
    }
    const outOfOrder = structuredClone(run);
    outOfOrder.steps[0].status = "pending";
    expect(workflowDigest(plan, outOfOrder)).toMatchObject({
      state: "needs_attention",
      errors: ["Step not approved."],
      lastOutcome: null
    });
    const completed = structuredClone(run);
    completed.status = "completed";
    delete completed.error;
    completed.steps[1].status = "completed";
    delete completed.steps[1].error;
    completed.definition.steps[1].success = undefined;
    expect(workflowDigest({ ...plan, definition: completed.definition }, completed)).toMatchObject({
      state: "completed",
      errors: [],
      approval: null
    });
  });

  it("distinguishes readiness, allocation and a recorded running run without assuming tool type", () => {
    const { plan, run } = records();
    expect(workflowDigest(plan, undefined)).toMatchObject({
      state: "ready",
      next: { actor: "Tool fetch_report" },
      progress: { done: 0, total: 2 }
    });
    expect(workflowDigest({ ...plan, attemptId: run.id }, undefined)).toMatchObject({
      state: "allocated",
      stateText: "Allocated; running is not confirmed."
    });
    expect(workflowDigest(plan, { ...run, status: "running" }).state).toBe("running");
    for (const status of ["failed", "stopped", "uncertain"] as const)
      expect(workflowDigest(plan, { ...run, status }).state).toBe("needs_attention");
    expect(workflowDigest({ ...plan, work: "done" }, undefined).state).toBe("needs_attention");
    expect(workflowDigest({ ...plan, work: "cancelled" }, run)).toMatchObject({
      state: "cancelled",
      next: null,
      verification: null
    });
    expect(
      workflowDigest(plan, undefined, null, ["The recorded run could not be read."])
    ).toMatchObject({ state: "needs_attention", errors: ["The recorded run could not be read."] });
  });

  it("requires an actual waiting human decision and exposes factual outcomes without outputs", () => {
    const { plan, run } = records();
    const digest = workflowDigest(plan, run);
    expect(digest).toMatchObject({
      state: "needs_decision",
      next: { actor: "You" },
      decision: { kind: "result", prompt: "Is this report acceptable?" },
      progress: { done: 1, total: 2 },
      lastOutcome: { summary: "Tool returned status 200.", at, ref: `run:${run.id}:step:report` },
      verification: null
    });
    expect(JSON.stringify(digest)).not.toContain("REPORT_BODY_MUST_NOT_APPEAR");
    const broken = structuredClone(run);
    broken.definition.steps[1].action = { type: "model", prompt: "Review it" };
    expect(workflowDigest({ ...plan, definition: broken.definition }, broken)).toMatchObject({
      state: "needs_attention",
      decision: null
    });
  });

  it.each([
    ["failed", "Review the failure and any recorded results."],
    ["stopped", "Review the stopped run and its partial results."],
    [
      "uncertain",
      "Inspect the recorded outcome and any external effects before starting a new run."
    ]
  ] as const)(
    "presents %s as human inspection while retaining recorded agent metadata and evidence",
    (status, instruction) => {
      const { plan, run } = records();
      run.status = status;
      run.definition.steps[1].name = "Inspect report with agent";
      run.definition.steps[1].action = {
        type: "agent",
        executor: "claude",
        task: {
          objective: "Inspect report",
          context: "",
          references: [],
          tools: [],
          completionCriteria: ["Use actual report"],
          limits: { maxTurns: 8 }
        }
      };
      run.steps[1].name = "Inspect report with agent";
      run.steps[1].status = status;
      const digest = workflowDigest(plan, run);
      const before = structuredClone(digest);
      const formatted = formatWorkDigest(digest);
      expect(formatted).toContain(`Next: ${instruction}`);
      expect(formatted).toContain(
        "Recorded step: Inspect report with agent · Agent claude (step review)"
      );
      expect(formatted).not.toContain("Next: Inspect report with agent");
      expect(formatted).toContain(`run ${run.id}, revision ${run.revision}, current`);
      expect(digest.lastOutcome?.ref).toBe(`run:${run.id}:step:report`);
      expect(formatted).not.toContain("REPORT_BODY_MUST_NOT_APPEAR");
      expect(digest).toEqual(before);
    }
  );

  it("presents unread runs and coding problems as inspection rather than an automatic recorded step", () => {
    const { plan } = records();
    const unread = workflowDigest(plan, undefined, null, ["The recorded run could not be read."]);
    const formatted = formatWorkDigest(unread);
    expect(formatted).toContain(
      "Next: Review the recorded problem and available evidence before starting work."
    );
    expect(formatted).toContain("Recorded step: Read report · Tool fetch_report (step report)");
    expect(formatted).toContain(`Evidence: plan ${plan.id}, revision ${plan.revision}`);
    const coding = codingDigest(
      {
        id: randomUUID(),
        name: "Coding problem",
        kind: "coding",
        status: "unavailable",
        prepared: false,
        error: "CODING_UNAVAILABLE"
      },
      randomUUID()
    );
    const codingText = formatWorkDigest(coding);
    expect(codingText).toContain(
      "Next: Review the recorded problem and available evidence before starting work."
    );
    expect(codingText).toContain("revision unavailable");
    expect(codingText).not.toContain("Recorded step:");
    expect(coding.run).toBeNull();
  });

  it("uses only a pending recorded agent request as a decision, never its final prose", () => {
    const { plan, run } = records();
    run.definition.steps[1].action = {
      type: "agent",
      executor: "claude",
      task: {
        objective: "Inspect report",
        context: "",
        references: [],
        tools: [],
        completionCriteria: ["Use the report"],
        limits: { maxTurns: 8 }
      }
    };
    run.steps[1].agent = {
      executor: "claude",
      allowedTools: [],
      events: [],
      requests: [
        {
          id: randomUUID(),
          kind: "context",
          origin: "runtime",
          status: "pending",
          prompt: "The report could not be read. How should work continue?",
          requestedAt: at
        }
      ]
    };
    const digest = workflowDigest(plan, run);
    expect(digest).toMatchObject({
      state: "needs_decision",
      decision: {
        kind: "context",
        prompt: "The report could not be read. How should work continue?"
      },
      next: { actor: "You" }
    });
    run.steps[1].agent.requests[0].status = "answered";
    expect(workflowDigest(plan, run)).toMatchObject({ state: "needs_attention", decision: null });
  });

  it.each([true, false, undefined, "true"])(
    "only literal human approval %s records approval without actor provenance",
    (approved) => {
      const { plan, run } = records();
      run.status = "completed";
      run.steps[1] = {
        ...run.steps[1],
        status: "completed",
        endedAt: at,
        output: { approved, notes: "MODEL_VERIFIED_EVERYTHING" }
      };
      const digest = workflowDigest(plan, run);
      expect(digest.state).toBe("completed");
      expect(digest.approval).toEqual(
        approved === true
          ? {
              stepId: "review",
              at,
              ref: `run:${run.id}:step:review`
            }
          : null
      );
      expect(digest.verification).toBeNull();
      expect(digest.alsoAllocated).toBe(0);
      expect(JSON.stringify(digest)).not.toContain("MODEL_VERIFIED_EVERYTHING");
      expect(formatWorkDigest(digest)).not.toContain("by you");
      if (approved === true)
        expect(formatWorkDigest(digest)).toContain("Approval: recorded for step review");
      else expect(formatWorkDigest(digest)).not.toContain("Approval:");
      expect(formatWorkDigest(digest)).not.toContain("task verified");
    }
  );

  it("does not treat a model output approved flag as human-kind step approval", () => {
    const { plan, run } = records();
    run.status = "completed";
    run.definition.steps[1].action = { type: "model", prompt: "Review the report" };
    run.steps[1] = {
      ...run.steps[1],
      status: "completed",
      endedAt: at,
      output: { approved: true }
    };
    expect(workflowDigest(plan, run)).toMatchObject({ approval: null, verification: null });
  });

  it("keeps old result references explicitly historical after a definition changes", () => {
    const { plan, run } = records();
    run.status = "completed";
    run.steps[1] = {
      ...run.steps[1],
      status: "completed",
      endedAt: at,
      output: { approved: true }
    };
    const digest = workflowDigest({ ...plan, revision: 2 }, run);
    expect(digest).toMatchObject({
      state: "ready",
      stateText: "Edited since the last run.",
      approval: null,
      progress: { done: 0, total: 2 },
      verification: null,
      run: { current: false, revision: 1 },
      lastOutcome: { ref: `run:${run.id}:step:review` }
    });
    expect(formatWorkDigest(digest)).toContain("Historical revision outcome:");
    const runOnly = digestReturnedRun(run)!;
    expect(runOnly.run?.current).toBeNull();
    expect(runOnly.approval).toBeNull();
    expect(formatWorkDigest(runOnly)).toContain("current plan revision unknown");
    expect(
      digestReturnedRun({ ...run, steps: [{ ...run.steps[0], status: "pending" }, run.steps[1]] })
    ).toBeUndefined();
    expect(digestReturnedRun({ id: run.id, status: "completed" })).toBeUndefined();
  });

  it("keeps full decision text available while bounding the directory header", () => {
    const { plan, run } = records();
    plan.definition.description = "g".repeat(4000);
    plan.definition.steps[1].action = { type: "human", instructions: "p".repeat(4000) };
    const full = workflowDigest(plan, run);
    const header = compactDigest(full);
    expect(full.goal).toHaveLength(4000);
    expect(full.decision?.prompt).toHaveLength(4000);
    expect(header.goal).toHaveLength(240);
    expect(header.decision?.prompt).toHaveLength(160);
    expect(header.truncated).toBe(true);
    plan.definition.name = "𐐀".repeat(100);
    plan.definition.description = "𐐀".repeat(1000);
    plan.definition.steps[1].action = { type: "human", instructions: "𐐀".repeat(1000) };
    run.steps.forEach((step) => {
      step.name = "𐐀".repeat(100);
    });
    const multibyte = compactDigest(
      workflowDigest(plan, run, randomUUID(), ["𐐀".repeat(100), "𐐀".repeat(100)])
    );
    expect(Buffer.byteLength(JSON.stringify(multibyte))).toBeLessThanOrEqual(2048);
    expect(
      Buffer.byteLength(JSON.stringify(Array.from({ length: 500 }, () => header)))
    ).toBeLessThan(2 * 1024 * 1024);
  });

  it("uses coding acceptance references without invented revisions, timestamps or liveness", () => {
    const work: CodingWorkItem = {
      id: randomUUID(),
      name: "Existing coding plan",
      kind: "coding" as const,
      status: "active",
      prepared: false,
      alsoAllocated: 1,
      progress: { done: 1, total: 3 },
      nextStep: { id: randomUUID(), name: "Implement", status: "in_progress" },
      accepted: { id: randomUUID(), ref: "hekate:actual-root:node:accepted:revision:3" }
    };
    const digest = codingDigest(work, randomUUID());
    expect(digest).toMatchObject({
      state: "allocated",
      revision: null,
      run: null,
      lastOutcome: null,
      progress: { done: 1, total: 3 },
      verification: { scope: "step", by: "hekate_accepted", at: null, ref: work.accepted!.ref }
    });
    expect(formatWorkDigest(digest)).toContain("1 of 3 steps accepted");
    expect(formatWorkDigest(digest)).toContain("task not verified");
    expect(digest.approval).toBeNull();
    expect(
      codingDigest(
        { ...work, decision: { id: "review", name: "Review implementation" } },
        "project"
      )
    ).toMatchObject({
      state: "needs_decision",
      alsoAllocated: 1,
      stateText:
        "A recorded coding outcome needs review. Also allocated: 1 items; running is not confirmed.",
      decision: { stepId: "review" },
      next: { actor: "You" }
    });
    expect(codingDigest({ ...work, cancelled: true }, "project")).toMatchObject({
      state: "cancelled",
      next: null
    });
    expect(
      codingDigest({ ...work, status: "awaiting_review", nextStep: undefined }, "project")
    ).toMatchObject({
      state: "needs_attention",
      decision: null,
      errors: ["The coding review step could not be identified."]
    });
  });
});
