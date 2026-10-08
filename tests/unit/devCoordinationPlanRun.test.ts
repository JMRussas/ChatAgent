import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coordinationStatus } from "../../src/integrations/hekate/devCoordination";

// Plan-run workflow states (Hekate plan-run v0), from raw plan views captured from the
// contract API for one A <- B <- C chain (provenance: tests/fixtures/hekate/PROVENANCE.md).
// Each fixture's claim attempt returned no_ready_work, yet only S5 is complete: plan
// progress comes from PlanStore's own root container and the leaf states, never from a
// claim outcome.
const DIR = "tests/fixtures/hekate/plan-run-v0";
const manifest = JSON.parse(readFileSync(join(DIR, "MANIFEST.json"), "utf8"));
const raw = (state: string) => readFileSync(join(DIR, `${state}.plan.raw.json`), "utf8");

function project(state: string, text = raw(state)) {
  const { root, nodes } = manifest.states[state] as {
    root: string;
    nodes: Record<"a" | "b" | "c", string>;
  };
  const status = coordinationStatus(text, root);
  if (status.status !== "ok") throw new Error(`expected an ok status for ${state}`);
  const byKey = Object.fromEntries(
    Object.entries(nodes).map(([key, id]) => [key, status.leaves.find((l) => l.nodeId === id)!])
  );
  return { status, byKey };
}

describe("plan-run workflow states from captured plan views", () => {
  it.each([
    ["S1", { a: "accepted", b: "in_progress", c: "blocked" }, "active", "incomplete", "pending"],
    [
      "S2",
      { a: "accepted", b: "review_pending", c: "blocked" },
      "awaiting_review",
      "incomplete",
      "pending"
    ],
    ["S3", { a: "rejected", b: "blocked", c: "blocked" }, "stuck", "incomplete", "rejected"],
    ["S5", { a: "accepted", b: "accepted", c: "accepted" }, "complete", "complete", "accepted"],
    ["S6", { a: "stale", b: "blocked", c: "blocked" }, "stuck", "incomplete", "pending"]
  ] as const)(
    "%s projects each leaf and the plan progress",
    (state, leaves, progress, completion, acceptance) => {
      const { status, byKey } = project(state);
      expect(Object.fromEntries(Object.entries(byKey).map(([k, l]) => [k, l.state]))).toEqual(
        leaves
      );
      expect(status.progress).toMatchObject({
        state: progress,
        rootCompletion: completion,
        rootAcceptance: acceptance
      });
    }
  );

  it("names why stuck work cannot proceed", () => {
    expect(project("S3").byKey.b.blockers.map((b) => b.reason)).toEqual(["predecessor_rejected"]);
    expect(project("S6").byKey.b.blockers.map((b) => b.reason)).toEqual([
      "predecessor_acceptance_stale"
    ]);
    expect(project("S1").byKey.c.blockers.map((b) => b.reason)).toEqual([
      "predecessor_not_completed"
    ]);
  });

  it("never treats no_ready_work as completion", () => {
    for (const state of ["S1", "S2", "S3", "S5", "S6"]) {
      const claim = JSON.parse(readFileSync(join(DIR, `${state}.claim.json`), "utf8"));
      expect(claim.outcome).toBe("no_ready_work");
      expect(project(state).status.progress.state === "complete").toBe(state === "S5");
    }
  });

  it("reports inconsistent, not complete, when the root container and leaves disagree", () => {
    // A synthetic edit of the captured S5 view: every leaf accepted, root container pending.
    const view = JSON.parse(raw("S5"));
    const root = manifest.states.S5.root as string;
    const container = view.readiness.containers.find((c: { nodeId: string }) => c.nodeId === root);
    container.acceptance = "pending";
    const { status } = project("S5", JSON.stringify(view));
    expect(status.progress.state).toBe("inconsistent");
    expect(status.progress.leafCounts).toEqual({ accepted: 3 });
  });
});
