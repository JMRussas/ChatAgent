import { z } from "zod";
import { taskRequestSchema } from "../tasks/types";
import {
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowRun
} from "../workflows/types";
import type { CodingWorkItem } from "./codingProjects";

const text = (max: number) => z.string().max(max);
export const workDigestSchema = z
  .object({
    id: text(200),
    projectId: text(200).nullable(),
    kind: z.enum(["workflow", "coding"]),
    name: text(400),
    goal: text(16000),
    revision: z.number().int().positive().nullable(),
    state: z.enum([
      "needs_decision",
      "needs_attention",
      "running",
      "allocated",
      "ready",
      "completed",
      "cancelled"
    ]),
    stateText: text(400),
    next: z
      .object({ stepId: text(200), name: text(400), actor: text(240) })
      .strict()
      .nullable(),
    decision: z
      .object({
        stepId: text(200),
        prompt: text(4000),
        kind: z.enum(["result", "context", "tool"]),
        tool: text(200).optional()
      })
      .strict()
      .nullable(),
    progress: z
      .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    lastOutcome: z
      .object({
        stepId: text(200),
        name: text(400),
        at: text(100).nullable(),
        summary: text(240),
        ref: text(240)
      })
      .strict()
      .nullable(),
    approval: z
      .object({ stepId: text(200), at: text(100).nullable(), ref: text(240) })
      .strict()
      .nullable(),
    alsoAllocated: z.number().int().nonnegative(),
    verification: z
      .object({
        by: z.literal("hekate_accepted"),
        at: text(100).nullable(),
        ref: text(240),
        scope: z.literal("step"),
        stepId: text(200).nullable()
      })
      .strict()
      .nullable(),
    run: z
      .object({
        id: text(200),
        revision: z.number().int().positive(),
        status: text(40),
        updatedAt: text(100).nullable(),
        current: z.boolean().nullable()
      })
      .strict()
      .nullable(),
    errors: z.array(text(400)).max(4),
    truncated: z.boolean()
  })
  .strict();
export type WorkDigest = z.infer<typeof workDigestSchema>;

const bound = (value: string | undefined, max: number) => (value ?? "").trim().slice(0, max);
const timestamp = (value: string | undefined) =>
  value &&
  z.string().datetime({ offset: true }).safeParse(value).success &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;
const actor = (step: StoredWorkflowPlan["definition"]["steps"][number]) => {
  switch (step.action.type) {
    case "human":
      return "You";
    case "tool":
      return `Tool ${step.action.tool}`;
    case "model":
      return "Model";
    case "agent":
      return `Agent ${step.action.executor}`;
  }
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const ref = (run: WorkflowRun, stepId: string) => `run:${run.id}:step:${stepId}`;
function recordedDecline(run: WorkflowRun, index: number): boolean {
  const definition = run.definition.steps[index],
    result = run.steps[index];
  return (
    run.status === "failed" &&
    run.error === "Step not approved." &&
    definition?.action.type === "human" &&
    definition.success?.path === "approved" &&
    definition.success.equals === true &&
    result?.status === "failed" &&
    result.error === "Step not approved." &&
    object(result.output)?.approved === false
  );
}
function outcome(run: WorkflowRun, index: number): WorkDigest["lastOutcome"] {
  const step = run.steps[index],
    action = run.definition.steps[index]?.action;
  const output = object(step.output);
  const summary =
    action?.type === "human"
      ? output?.approved === true
        ? "Step approved."
        : output?.approved === false
          ? "Step not approved."
          : "Human step completed; no approval recorded."
      : action?.type === "tool" &&
          typeof output?.status === "number" &&
          Number.isInteger(output.status) &&
          output.status >= 100 &&
          output.status <= 599
        ? `Tool returned status ${output.status}.`
        : `${action?.type === "agent" ? "Agent" : action?.type === "model" ? "Model" : "Tool"} step completed; result recorded.`;
  return {
    stepId: step.id,
    name: bound(step.name, 400),
    at: timestamp(step.endedAt),
    summary,
    ref: ref(run, step.id)
  };
}

/** Pure projection: stored outcomes are referenced, never copied or interpreted as task certification. */
export function workflowDigest(
  plan: StoredWorkflowPlan | undefined,
  run: WorkflowRun | undefined,
  projectId: string | null = null,
  errors: string[] = []
): WorkDigest {
  if (!plan && !run) throw new Error("A recorded plan or run is required.");
  const definition = plan?.definition ?? run!.definition;
  const current = plan ? (run ? run.revision === plan.revision : null) : null;
  const usable = current === false ? undefined : run;
  const digest: WorkDigest = {
    id: plan?.id ?? run!.planId,
    projectId,
    kind: "workflow",
    name: bound(definition.name, 400),
    goal: bound(
      definition.description ||
        (definition.steps.length === 1 && definition.steps[0].action.type === "agent"
          ? definition.steps[0].action.task.objective
          : definition.name),
      16000
    ),
    revision: plan?.revision ?? run!.revision,
    state: "ready",
    stateText: "Ready to start.",
    next: null,
    decision: null,
    progress: {
      done: usable?.steps.filter((step) => step.status === "completed").length ?? 0,
      total: definition.steps.length
    },
    lastOutcome: null,
    approval: null,
    alsoAllocated: 0,
    verification: null,
    run: run
      ? {
          id: run.id,
          revision: run.revision,
          status: run.status,
          updatedAt: timestamp(run.updatedAt),
          current
        }
      : null,
    errors: errors.slice(0, 4).map((error) => bound(error, 400)),
    truncated: false
  };
  if (run) {
    const completed = run.steps
      .map((step, index) => (step.status === "completed" ? index : -1))
      .filter((index) => index >= 0);
    const declined = run.steps.findIndex((step) => step.status !== "completed");
    if (recordedDecline(run, declined)) digest.lastOutcome = outcome(run, declined);
    else if (completed.length) digest.lastOutcome = outcome(run, completed.at(-1)!);
  }
  const index = usable ? usable.steps.findIndex((step) => step.status !== "completed") : 0;
  const step = index >= 0 ? definition.steps[index] : undefined;
  if (step) digest.next = { stepId: step.id, name: bound(step.name, 400), actor: actor(step) };
  if (usable && current === true) {
    const approved = usable.steps
      .map((result, index) =>
        result.status === "completed" &&
        usable.definition.steps[index]?.action.type === "human" &&
        object(result.output)?.approved === true
          ? index
          : -1
      )
      .filter((index) => index >= 0)
      .at(-1);
    if (approved !== undefined)
      digest.approval = {
        at: timestamp(usable.steps[approved].endedAt),
        ref: ref(usable, usable.steps[approved].id),
        stepId: usable.steps[approved].id
      };
  }
  if (digest.errors.length) {
    digest.state = "needs_attention";
    digest.stateText = "The recorded run could not be read.";
  } else if (plan?.work === "cancelled") {
    digest.state = "cancelled";
    digest.stateText = "This work was cancelled.";
    digest.next = null;
    digest.approval = null;
    digest.verification = null;
  } else if (current === false) {
    digest.stateText = "Edited since the last run.";
  } else if (usable?.status === "waiting_input") {
    const request = usable.steps[index]?.agent?.requests.find(
      (request) => request.status === "pending"
    );
    if (step?.action.type === "human")
      digest.decision = { stepId: step.id, prompt: step.action.instructions, kind: "result" };
    else if (step?.action.type === "agent" && request)
      digest.decision = {
        stepId: step.id,
        prompt: request.prompt,
        kind: request.kind,
        ...(request.tool ? { tool: request.tool } : {})
      };
    digest.state = digest.decision ? "needs_decision" : "needs_attention";
    digest.stateText = digest.decision
      ? "Your decision is needed before work can continue."
      : "Waiting state has no recorded decision.";
    if (!digest.decision)
      digest.errors.push("The waiting step has no recorded human or agent request.");
    else if (digest.next) digest.next.actor = "You";
  } else if (usable?.status === "running") {
    digest.state = "running";
    digest.stateText = "The recorded run reports running.";
  } else if (usable?.status === "completed") {
    digest.state = "completed";
    digest.next = null;
    digest.stateText = digest.approval
      ? "Run completed. Step approval recorded; task not verified."
      : "Run completed; task not verified.";
  } else if (usable && ["failed", "stopped", "uncertain"].includes(usable.status)) {
    digest.state = "needs_attention";
    const declined = recordedDecline(usable, index);
    digest.stateText = declined
      ? "Not approved. The run ended at the recorded decision." +
        (plan?.work === "todo"
          ? " The plan is ready for a new run from step one."
          : " Plan readiness is not confirmed.")
      : usable.status === "uncertain"
        ? "The execution outcome is unknown."
        : usable.status === "stopped"
          ? "The run was stopped; partial results remain."
          : "The run failed and needs attention.";
    if (usable.error && !declined) digest.errors.push(bound(usable.error, 400));
  } else if (plan?.attemptId || plan?.work === "in_progress") {
    digest.state = "allocated";
    digest.stateText = "Allocated; running is not confirmed.";
  } else if (plan?.work === "done") {
    digest.state = "needs_attention";
    digest.stateText = "Work is recorded done, but no completed current run was read.";
  }
  if (!plan) digest.stateText += " Current plan revision is unknown.";
  return workDigestSchema.parse(digest);
}

export function codingDigest(work: CodingWorkItem, projectId: string): WorkDigest {
  const decision =
    work.decision ?? (work.nextStep?.status === "review_pending" ? work.nextStep : undefined);
  const state: WorkDigest["state"] =
    work.cancelled && !work.error
      ? "cancelled"
      : work.error || ["invalid", "unavailable", "inconsistent", "stuck"].includes(work.status)
        ? "needs_attention"
        : decision
          ? "needs_decision"
          : work.status === "active"
            ? "allocated"
            : work.status === "complete"
              ? "completed"
              : work.status === "awaiting_review"
                ? "needs_attention"
                : "ready";
  return workDigestSchema.parse({
    id: work.id,
    projectId,
    kind: "coding",
    name: work.name,
    goal: work.name,
    revision: null,
    state,
    stateText:
      (state === "cancelled"
        ? "This coding work was cancelled."
        : state === "allocated"
          ? "Allocated; running is not confirmed."
          : state === "needs_decision"
            ? "A recorded coding outcome needs review."
            : state === "needs_attention"
              ? "Coding state needs attention or could not be read."
              : state === "completed"
                ? "Leaf accepted in Hekate · task not verified"
                : "Ready for the configured coding host.") +
      (work.alsoAllocated
        ? ` Also allocated: ${work.alsoAllocated} items; running is not confirmed.`
        : ""),
    approval: null,
    alsoAllocated: work.alsoAllocated ?? 0,
    next:
      state === "cancelled" || state === "completed"
        ? null
        : decision
          ? { stepId: decision.id, name: decision.name, actor: "You" }
          : work.nextStep
            ? {
                stepId: work.nextStep.id,
                name: work.nextStep.name,
                actor: "Configured coding host"
              }
            : null,
    decision:
      state === "needs_decision" && decision
        ? {
            stepId: decision.id,
            prompt: `Review the recorded outcome of ${decision.name}.`,
            kind: "result"
          }
        : null,
    progress: work.progress ?? null,
    lastOutcome: null,
    verification: work.accepted
      ? {
          by: "hekate_accepted",
          at: null,
          ref: work.accepted.ref,
          scope: "step",
          stepId: work.accepted.id
        }
      : null,
    run: null,
    errors: work.error
      ? [work.error]
      : work.status === "awaiting_review" && !decision
        ? ["The coding review step could not be identified."]
        : [],
    truncated: false
  });
}

/** Snapshot text stays within the directory's 2 MiB budget; detail reads retain full prompts. */
export function compactDigest(digest: WorkDigest): WorkDigest {
  const compact: WorkDigest = {
    ...digest,
    name: bound(digest.name, 200),
    goal: bound(digest.goal, 240),
    next: digest.next ? { ...digest.next, name: bound(digest.next.name, 200) } : null,
    decision: digest.decision
      ? { ...digest.decision, prompt: bound(digest.decision.prompt, 160) }
      : null,
    lastOutcome: digest.lastOutcome
      ? {
          ...digest.lastOutcome,
          name: bound(digest.lastOutcome.name, 200),
          summary: bound(digest.lastOutcome.summary, 160)
        }
      : null,
    errors: digest.errors.slice(0, 2).map((error) => bound(error, 160)),
    truncated: false
  };
  // Character limits alone do not bound UTF-8 or escaped JSON. Keep 500 headers
  // within 1 MiB, leaving room for the surrounding directory rows.
  for (
    let limit = 120;
    new TextEncoder().encode(JSON.stringify(compact)).byteLength > 2048 && limit >= 1;
    limit = Math.floor(limit / 2)
  ) {
    compact.name = bound(compact.name, limit);
    compact.goal = bound(compact.goal, limit);
    compact.stateText = bound(compact.stateText, limit);
    if (compact.next) {
      compact.next.name = bound(compact.next.name, limit);
      compact.next.actor = bound(compact.next.actor, limit);
    }
    if (compact.decision) compact.decision.prompt = bound(compact.decision.prompt, limit);
    if (compact.lastOutcome) {
      compact.lastOutcome.name = bound(compact.lastOutcome.name, limit);
      compact.lastOutcome.summary = bound(compact.lastOutcome.summary, limit);
    }
    compact.errors = compact.errors.map((error) => bound(error, limit));
  }
  compact.truncated =
    digest.truncated ||
    JSON.stringify({ ...compact, truncated: false }) !==
      JSON.stringify({ ...digest, truncated: false });
  return compact;
}

export function formatWorkDigest(digest: WorkDigest): string {
  const labels = {
    needs_decision: "Needs your decision",
    needs_attention: "Needs attention",
    running: "Running",
    allocated: "Allocated, liveness unknown",
    ready: "Ready",
    completed: "Completed",
    cancelled: "Cancelled"
  };
  const progress = digest.progress
    ? ` (${digest.progress.done} of ${digest.progress.total} steps${digest.kind === "coding" ? " accepted" : " completed"})`
    : "";
  const last = digest.lastOutcome
    ? `${digest.run?.current === false ? "Historical revision outcome: " : ""}${digest.lastOutcome.name}: ${digest.lastOutcome.summary}${digest.lastOutcome.at ? ` at ${digest.lastOutcome.at}` : ""}`
    : "none recorded";
  const verification = digest.verification
    ? `leaf ${digest.verification.stepId ?? "with a recorded reference"} accepted in Hekate; task not verified`
    : "not verified";
  const approval = digest.approval
    ? `\nApproval: recorded for step ${digest.approval.stepId}${digest.approval.at ? ` at ${digest.approval.at}` : "; time unavailable"}.`
    : "";
  const next =
    digest.state === "needs_attention"
      ? digest.run?.status === "uncertain"
        ? "Inspect the recorded outcome and any external effects before starting a new run."
        : digest.run?.status === "stopped"
          ? "Review the stopped run and its partial results."
          : digest.run?.status === "failed"
            ? "Review the failure and any recorded results."
            : "Review the recorded problem and available evidence before starting work."
      : digest.decision
        ? digest.decision.prompt
        : digest.next
          ? `${digest.next.name} · ${digest.next.actor}`
          : "nothing";
  const recordedStep =
    digest.state === "needs_attention" && digest.next
      ? ` Recorded step: ${digest.next.name} · ${digest.next.actor} (step ${digest.next.stepId}).`
      : "";
  const punctuate = (value: string) => (/[.!?]$/.test(value) ? value : value + ".");
  return `${digest.name} — ${labels[digest.state]}${progress}. ${digest.stateText}\nNext: ${punctuate(next)}${recordedStep} Last outcome: ${punctuate(last)}\nVerification: ${verification}.${approval}\nEvidence: ${digest.run ? `run ${digest.run.id}, revision ${digest.run.revision}, ${digest.run.current === true ? "current" : digest.run.current === false ? "historical" : "current plan revision unknown"}` : `plan ${digest.id}${digest.revision === null ? "; revision unavailable" : `, revision ${digest.revision}`}`}.`;
}

const runSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  definition: workflowDefinitionSchema,
  status: z.enum(["running", "waiting_input", "completed", "failed", "stopped", "uncertain"]),
  updatedAt: text(100),
  steps: z
    .array(
      z.object({
        id: text(64),
        name: text(200),
        status: z.enum([
          "pending",
          "running",
          "waiting_input",
          "completed",
          "failed",
          "stopped",
          "uncertain"
        ]),
        endedAt: text(100).optional(),
        output: z.unknown().optional(),
        agent: z.object({ requests: z.array(taskRequestSchema).max(20) }).optional()
      })
    )
    .max(50)
});
export function digestReturnedRun(result: unknown): WorkDigest | undefined {
  const parsed = runSchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.steps.length !== parsed.data.definition.steps.length ||
    !parsed.data.steps.every((step, index) => step.id === parsed.data.definition.steps[index].id) ||
    (parsed.data.status === "completed" &&
      parsed.data.steps.some((step) => step.status !== "completed"))
  )
    return undefined;
  return workflowDigest(undefined, result as WorkflowRun);
}
