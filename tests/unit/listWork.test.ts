import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatWorkflowResult } from "../../src/workflows/application";
import {
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowRun
} from "../../src/workflows/types";
import {
  formatWorkList,
  outstandingStates,
  projectWorkList,
  workStates,
  type WorkList
} from "../../src/workspace/listWork";
import { compactDigest, workDigestSchema, workflowDigest } from "../../src/workspace/workDigest";

const projectId = randomUUID();
function digest(
  index: number,
  status: "ready" | "allocated" | "waiting_input" | "completed" = "ready"
) {
  const definition = workflowDefinitionSchema.parse({
    version: 1,
    name: `Observed work ${index}`,
    steps: [
      {
        id: "review",
        name: "Review result",
        action: { type: "human", instructions: "Prompt " + "p".repeat(3900) }
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
    attemptId: status === "allocated" ? randomUUID() : null,
    attemptEpoch: 0,
    artifactRef: null
  };
  const run: WorkflowRun | undefined =
    status === "waiting_input" || status === "completed"
      ? {
          version: 1,
          id: randomUUID(),
          planId: plan.id,
          ownerId: plan.ownerId,
          definition,
          revision: 1,
          attemptEpoch: 1,
          status,
          startedAt: "2026-10-10T18:00:00Z",
          updatedAt: `2026-10-10T19:${String(index).padStart(2, "0")}:00Z`,
          steps: [
            {
              id: "review",
              name: "Review result",
              status,
              ...(status === "completed"
                ? { output: { approved: true }, endedAt: "2026-10-10T19:00:00Z" }
                : {})
            }
          ]
        }
      : undefined;
  return compactDigest(workflowDigest(plan, run, projectId));
}
const scope = (state: WorkList["scope"]["state"] = [...outstandingStates]): WorkList["scope"] => ({
  projectId,
  projectsRead: 1,
  source: "explicit",
  state
});

describe("compact observed work list", () => {
  it("counts every observed state before selection, preserves digests, and orders decisions before allocations and readiness", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      digest(index, index < 10 ? "waiting_input" : index < 20 ? "allocated" : "completed")
    );
    const result = projectWorkList(rows, scope(), [], false, 12);
    expect(result.counts).toMatchObject({
      read: 30,
      needs_decision: 10,
      allocated: 10,
      completed: 10
    });
    expect(result.selection).toEqual({ matched: 20, returned: 12, omitted: 8 });
    expect(result.items.slice(0, 10).every((item) => item.state === "needs_decision")).toBe(true);
    expect(result.items[0].id).toBe(rows[9].id);
    expect(result.items[0]).toEqual(rows[9]);
    expect(result.items[0].truncated).toBe(true);
    expect(result.source).toEqual({ truncated: false, errorCount: 0 });
    const completed = projectWorkList(rows, scope(["completed"]), [], false);
    expect(completed.counts).toEqual(result.counts);
    expect(completed.items[0].approval?.ref).toBe(rows[29].approval?.ref);
    expect(formatWorkflowResult("list_work", completed)).toContain(
      "Approval: recorded for step review"
    );
  });

  it("reports controlled source error totals separately from abridged text and selection omission", () => {
    const rows = Array.from({ length: 30 }, (_, index) => digest(index));
    const errors = rows.map((row) => ({
      projectId,
      workId: row.id,
      message: "Read failed " + "\0".repeat(200)
    }));
    const result = projectWorkList(rows, scope(), errors, true);
    expect(result.source).toEqual({ truncated: true, errorCount: 30 });
    expect(result.errors).toHaveLength(20);
    expect(result.errors[0].workId).toBe(rows[0].id);
    expect(result.errors.every((error) => error.message.length <= 200)).toBe(true);
    expect(result.errorsOmitted).toBe(10);
    expect(result.selection).toEqual({ matched: 30, returned: 25, omitted: 5 });
    const formatted = formatWorkList(result);
    expect(formatted).toContain("Counts are lower bounds");
    expect(formatted).toContain("Source truncated");
    expect(formatted).toContain("Source read errors: 30; 10 error details omitted");
    expect(formatted).toContain("Selection omitted: 5");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
  });

  it("measures escaped encoded bytes without assuming arbitrary valid digest fields fit 2 KiB", () => {
    const large = workDigestSchema.parse({
      ...digest(1, "waiting_input"),
      id: "\0".repeat(200),
      name: "𐐀".repeat(200),
      goal: "\0".repeat(16000),
      decision: { stepId: "review", prompt: "\0".repeat(4000), kind: "result" },
      truncated: true
    });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(2048);
    const result = projectWorkList(
      Array.from({ length: 25 }, () => large),
      scope([...workStates]),
      [],
      false
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.source.truncated).toBe(false);
    expect(result.counts.read).toBe(25);
    expect(result.selection.omitted).toBeGreaterThan(0);
    expect(result.items.every((item) => JSON.stringify(item) === JSON.stringify(large))).toBe(true);
  });

  it("formats whole maximal records under the chat cut while retaining the count and incompleteness notices", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      ...digest(index, "waiting_input"),
      decision: {
        stepId: "review",
        prompt: `START_${index}_ ` + "p".repeat(3900) + ` END_${index}_`,
        kind: "result" as const
      },
      truncated: false
    }));
    const result = projectWorkList(
      rows,
      scope(),
      [{ projectId, workId: null, message: "Project read failed" }],
      false
    );
    expect(result.items).toHaveLength(25);
    const formatted = formatWorkList(result);
    expect(formatted.length).toBeLessThanOrEqual(48000);
    expect(formatted).toContain("Observed work: 25");
    expect(formatted).toContain("Source read errors: 1");
    expect(formatted).toContain("further items not shown");
    for (let index = 0; index < 25; index++)
      expect(formatted.includes(`START_${index}_ `)).toBe(formatted.includes(` END_${index}_`));
    expect(formatWorkflowResult("list_work", result)).toBe(formatted);
    expect(formatWorkflowResult("list_work", { items: [], claimedSuccess: true })).toBeUndefined();
  });
});
