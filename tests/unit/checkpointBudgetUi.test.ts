import { describe, expect, it } from "vitest";
import { executiveOverviewHtml, executiveOverviewScript } from "../../src/ui/executiveOverview";
import type { ExecutiveOverview } from "../../src/integrations/hekate/executiveOverview";
import type { CheckpointBudgetView } from "../../src/integrations/hekate/checkpointBudget";
import { FakeDoc, controlledFetch, settle } from "../helpers/fakeDom";
import { ROOT_A, leaf, overviewOf, rootView } from "../helpers/executiveFixtures";
import { makeGate, makeRecord } from "../helpers/checkpointFixtures";

function mount() {
  const doc = new FakeDoc({
    userId: { value: "user-demo", tag: "input" },
    conversationId: { value: "conv-ui-demo", tag: "input" },
    execRefresh: { tag: "button" },
    execNote: {
      tag: "p",
      textContent: executiveOverviewHtml().match(/<p id="execNote"[^>]*>([^<]*)<\/p>/)![1]
    },
    execStale: { hidden: true },
    execView: {}
  });
  const net = controlledFetch();
  const body = executiveOverviewScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  new Function("document", "window", "fetch", body)(
    doc,
    { addEventListener: () => undefined },
    net.fetch
  );
  const refresh = async (payload: unknown) => {
    doc.el("execRefresh").dispatch("click");
    await settle();
    net.calls.at(-1)!.respond(payload, 200);
    await settle();
  };
  return { doc, net, refresh, view: doc.el("execView") };
}

const withBudget = (budget: CheckpointBudgetView | undefined, state = "in_progress" as const) => {
  const overview: ExecutiveOverview = overviewOf(
    rootView(ROOT_A, "Delivery", [
      leaf(1, state, { attemptId: "at-1", attemptEpoch: 2 }),
      leaf(2, "ready")
    ])
  );
  if (budget) {
    overview.schema = "executive-overview/v2";
    const task = overview.roots[0].tasks.find((t) => t.state === state)!;
    task.checkpointBudget = budget;
    task.budgetEvidence = budget.state === "reported" ? "reported" : "unavailable";
  }
  return overview;
};
const reported = (over = {}): CheckpointBudgetView => ({
  state: "reported",
  record: makeRecord(),
  gate: { state: "current", gate: makeGate() },
  overdueUnreported: false,
  ...over
});

describe("checkpoint budget in the executive overview UI", () => {
  it("issues nothing on load and only GETs on refresh, rendering a v2 record as text", async () => {
    const { net, refresh, view, doc } = mount();
    await settle();
    expect(net.calls).toHaveLength(0);
    await refresh(withBudget(reported()));
    expect(net.calls.map((c) => c.method)).toEqual(["GET"]);
    // Record fields only ever become text in fixed structural elements.
    const allowed = new Set([
      "div",
      "p",
      "span",
      "code",
      "strong",
      "em",
      "details",
      "summary",
      "ul",
      "li"
    ]);
    expect(doc.createdTags.every((tag) => allowed.has(tag))).toBe(true);
    const text = view.textContent;
    expect(text).toContain("Budget evidence: reported");
    expect(text).toContain(
      "distinct assistant message IDs seen (assistant_message_ids_distinct/v1)"
    );
    expect(text).toContain("supplied runner record, not authenticated; owner liveness unknown");
    expect(text).toContain("Expected (provisional heuristic, not an SLO): 30");
    expect(text).toContain("Provider reported (unverified): num_turns 9, cost USD 0.0123");
    expect(text).toContain("Stop: exited / exited");
    expect(text).toContain("current; supplied by the lead, not verified by ChatAgent");
    expect(text).toContain("Budget evidence: not_reported");
  });

  it("labels history gate evidence, a lower bound, overdue and unavailable reasons", async () => {
    const { refresh, view } = mount();
    const record = makeRecord({
      state: "running",
      stop: { kind: "none", code: "none" },
      exit: null,
      endedAt: null,
      consumed: { units: 3, wallMs: 5, outputBytes: 9, counterState: "lower_bound" }
    });
    await refresh(
      withBudget(
        reported({ record, overdueUnreported: true, gate: { state: "history", gate: makeGate() } })
      )
    );
    expect(view.textContent).toContain("Consumed at last write (lower bound)");
    expect(view.textContent).toContain("running as last recorded");
    expect(view.textContent).toContain("overdue_unreported");
    expect(view.textContent).toContain("history, not for the current artifact");
    await refresh(withBudget({ state: "unavailable", reason: "stale_identity" }));
    expect(view.textContent).toContain("reason: stale_identity");
    expect(view.textContent).toContain("its numbers are not shown");
    expect(view.textContent).not.toContain("987654321");
    await refresh(withBudget(reported({ gate: { state: "unavailable", reason: "missing" } })));
    expect(view.textContent).toContain("Gate evidence unavailable (reason: missing)");
  });

  it("states a cleanup failure without granting any kill or restart authority", async () => {
    const { refresh, view } = mount();
    const record = makeRecord({
      stop: { kind: "failed", code: "cleanup_failed" },
      rootPid: 4242
    });
    await refresh(withBudget(reported({ record })));
    expect(view.textContent).toContain("clean stop is not asserted");
    expect(view.textContent).toContain("not authority to stop or restart anything");
  });

  it("accepts v1 without budget fields and v2 without a registry match, and refuses mixtures", async () => {
    const { refresh, view, doc } = mount();
    await refresh(withBudget(undefined));
    expect(view.textContent).toContain("Budget evidence: not_reported");
    const v2 = withBudget(undefined);
    v2.schema = "executive-overview/v2";
    await refresh(v2);
    expect(view.textContent).toContain("Delivery");
    // A v1 body must not carry v2 budget fields.
    const mixed = withBudget(reported());
    mixed.schema = "executive-overview/v1";
    await refresh(mixed);
    expect(doc.el("execNote").textContent).toContain("not recognized");
    expect(view.kids).toHaveLength(0);
  });

  it("refuses closed-schema violations in a v2 budget record", async () => {
    const { refresh, doc, view } = mount();
    const broken: unknown[] = [
      reported({ record: { ...makeRecord(), extra: 1 } }),
      reported({ record: makeRecord({ consumed: { ...makeRecord().consumed, units: 1.5 } }) }),
      reported({ record: makeRecord({ writerLiveness: "alive" as never }) }),
      reported({ record: makeRecord({ stop: { kind: "tripwire", code: "exited" as never } }) }),
      reported({ gate: { state: "current", gate: { ...makeGate(), suppliedBy: "bot" } } }),
      reported({ gate: { state: "bogus" } }),
      { state: "unavailable", reason: "<b>x</b>" },
      { state: "reported" }
    ];
    for (const budget of broken) {
      await refresh(withBudget(budget as CheckpointBudgetView));
      expect(doc.el("execNote").textContent).toContain("not recognized");
      expect(view.kids).toHaveLength(0);
    }
    // budgetEvidence must agree with the nested state.
    const lying = withBudget({ state: "unavailable", reason: "missing" });
    lying.roots[0].tasks.find((t) => t.checkpointBudget)!.budgetEvidence = "reported";
    await refresh(lying);
    expect(view.kids).toHaveLength(0);
  });
});
