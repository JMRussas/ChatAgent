import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coordinationStatus } from "../../src/integrations/hekate/devCoordination";

// Each projected blocker names its predecessor from the SAME plan view, so an operator can
// read why a leaf waits without resolving node ids by hand. The captured plan-run views
// (provenance: tests/fixtures/hekate/PROVENANCE.md) are read, never modified.
const DIR = "tests/fixtures/hekate/plan-run-v0";
const manifest = JSON.parse(readFileSync(join(DIR, "MANIFEST.json"), "utf8"));
const raw = (state: string) => readFileSync(join(DIR, `${state}.plan.raw.json`), "utf8");

function leaves(state: string, text = raw(state)) {
  const { root, nodes } = manifest.states[state] as {
    root: string;
    nodes: Record<"a" | "b" | "c", string>;
  };
  const status = coordinationStatus(text, root);
  if (status.status !== "ok") throw new Error(`expected an ok status for ${state}`);
  return Object.fromEntries(
    Object.entries(nodes).map(([key, id]) => [key, status.leaves.find((l) => l.nodeId === id)!])
  );
}

describe("blocker predecessor names", () => {
  it.each([
    ["S1", "c", "b", "B", "predecessor_not_completed"],
    ["S3", "b", "a", "A", "predecessor_rejected"],
    ["S6", "b", "a", "A", "predecessor_acceptance_stale"]
  ] as const)(
    "%s: %s is blocked by %s, named from the same view",
    (state, blocked, predecessor, name, reason) => {
      const byKey = leaves(state);
      expect(byKey[blocked].blockers).toEqual([
        {
          ownerId: byKey[blocked].nodeId,
          predecessorId: byKey[predecessor].nodeId,
          gate: "accepted",
          reason,
          predecessorName: name
        }
      ]);
    }
  );

  it("keeps every other blocker field and the blocker order unchanged", () => {
    const view = JSON.parse(raw("S1"));
    const c = manifest.states.S1.nodes.c as string;
    const fromView = view.readiness.leaves.find((l: { nodeId: string }) => l.nodeId === c).blockers;
    const projected = leaves("S1").c.blockers;
    expect(projected.map(({ predecessorName: _, ...rest }) => rest)).toEqual(fromView);
  });

  it("gives null when the predecessor node has no name", () => {
    const view = JSON.parse(raw("S1"));
    const b = manifest.states.S1.nodes.b as string;
    view.nodes.find((n: { id: string }) => n.id === b).name = null;
    const c = leaves("S1", JSON.stringify(view)).c;
    expect(c.blockers.map((x) => [x.predecessorId, x.predecessorName])).toEqual([[b, null]]);
  });

  it("leaves a leaf without blockers with no blockers", () => {
    const byKey = leaves("S1");
    expect(byKey.a.blockers).toEqual([]);
    expect(byKey.b.blockers).toEqual([]);
    expect(leaves("S5").c.blockers).toEqual([]);
  });
});
