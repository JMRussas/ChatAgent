import { describe, expect, it } from "vitest";
import { executiveOverviewHtml, executiveOverviewScript } from "../../src/ui/executiveOverview";
import type { AttentionItem } from "../../src/integrations/hekate/checkpointAttention";
import type { ExecutiveOverview } from "../../src/integrations/hekate/executiveOverview";
import { FakeDoc, controlledFetch, settle, type FakeEl } from "../helpers/fakeDom";
import { ROOT_A, leaf, overviewOf, progressBody, rootView } from "../helpers/executiveFixtures";
import { makeGate, makeRecord } from "../helpers/checkpointFixtures";
import { attentionOf, item } from "../helpers/handoffFixtures";

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

const cleanupItem = (over: Partial<AttentionItem> = {}) =>
  item({
    kind: "cleanup_unconfirmed",
    stop: { kind: "failed", code: "cleanup_failed" },
    rootPid: 4242,
    action: "inspect_owned_process_manually",
    ...over
  });

function v3(items: AttentionItem[], tweak: (o: ExecutiveOverview) => void = () => undefined) {
  const view = rootView(ROOT_A, "Delivery", [
    leaf(1, "in_progress", { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3 }),
    leaf(2, "ready")
  ]);
  const task = view.tasks.find((t) => t.state === "in_progress")!;
  task.checkpointBudget = {
    state: "reported",
    record: makeRecord({ stop: { kind: "failed", code: "cleanup_failed" }, rootPid: 4242 }),
    gate: { state: "current", gate: makeGate() },
    overdueUnreported: false
  };
  task.budgetEvidence = "reported";
  const overview: ExecutiveOverview = {
    ...overviewOf(view),
    schema: "executive-overview/v3",
    attention: attentionOf(...items)
  };
  tweak(overview);
  return overview;
}

const buttons = (view: FakeEl) => view.findAll((el) => el.tag === "button");
const detailsOf = (view: FakeEl, attr: string) =>
  view.findAll((el) => el.tag === "details" && attr in el.attrs);

describe("attention panel in the executive overview", () => {
  it("renders from a v3 body with no request on load and a fixed-text row", async () => {
    const { net, refresh, view } = mount();
    await settle();
    expect(net.calls).toHaveLength(0);
    await refresh(v3([cleanupItem()]));
    expect(net.calls.map((c) => c.method)).toEqual(["GET"]);
    const text = view.textContent;
    expect(text).toContain(
      "Attention (derived from supplied, unauthenticated records; advice only)"
    );
    expect(text).toContain("Delivery — Cleanup not confirmed in the supplied record");
    expect(text).toContain("Inspect the owned process manually");
    expect(text).toContain("Registered records unavailable: 1. Items omitted: 0.");
    expect(buttons(view).map((b) => b.textContent)).toEqual(["Open detail"]);
    // Task detail text legitimately says a PID is not authority to restart; the panel offers no such control.
    const panel = view.findAll((el) => "data-attention" in el.attrs)[0].textContent;
    expect(panel).not.toMatch(
      /\b(kill|restart|retry|terminate|alive|healthy|delivered|notified)\b/i
    );
  });

  it("says nothing is a health statement when there are no items and still shows coverage", async () => {
    const { refresh, view } = mount();
    await refresh(v3([]));
    expect(view.textContent).toContain(
      "No attention items from registered records (not a health statement)."
    );
    expect(view.textContent).toContain("Registered records unavailable: 1.");
    expect(buttons(view)).toHaveLength(0);
  });

  it("Open detail opens the root and task in place and shows the existing evidence", async () => {
    const { net, refresh, view } = mount();
    const overview = v3([cleanupItem()]);
    await refresh(overview);
    expect(detailsOf(view, "data-root")[0].open).toBe(false);
    buttons(view)[0].click();
    await settle();
    expect(detailsOf(view, "data-root")[0].open).toBe(true);
    expect(
      detailsOf(view, "data-task").find((d) => d.attrs["data-state"] === "in_progress")!.open
    ).toBe(true);
    expect(view.textContent).toContain("Cleanup was not confirmed; clean stop is not asserted");
    // The only added request is the existing progress GET.
    expect(net.calls.map((c) => [c.method, c.url.includes("/progress")])).toEqual([
      ["GET", false],
      ["GET", true]
    ]);
    net.calls.at(-1)!.respond(
      progressBody(
        ROOT_A,
        overview.roots[0].tasks.find((t) => t.state === "in_progress")!
      ),
      200
    );
    await settle();
    expect(view.textContent).toContain("Evidence read at");
  });

  it("replaces a row whose fence no longer matches the task, and explains an omitted row", async () => {
    const { refresh, view } = mount();
    await refresh(
      v3([
        cleanupItem({ fence: { attemptId: "at-1", attemptEpoch: 9, contentRevision: 3 } }),
        cleanupItem({ taskListed: false, runId: "55555555-5555-4555-8555-555555555555" })
      ])
    );
    expect(view.textContent).toContain("changed, refresh");
    expect(view.textContent).toContain(
      "Task row omitted by the size cap; refresh or reduce scope."
    );
    expect(buttons(view)).toHaveLength(0);
    // A different run id for the same fence is also a changed item.
    await refresh(v3([cleanupItem({ runId: "66666666-6666-4666-8666-666666666666" })]));
    expect(view.textContent).toContain("changed, refresh");
    expect(buttons(view)).toHaveLength(0);
  });

  it("refuses closed-schema violations in attention", async () => {
    const { refresh, doc, view } = mount();
    const bad: ExecutiveOverview[] = [
      v3([cleanupItem()], (o) => delete o.attention),
      v3([cleanupItem({ note: "x" } as never)]),
      v3([cleanupItem({ kind: "mystery" as never })]),
      v3([cleanupItem({ attribution: "source" as never })]),
      v3([cleanupItem({ action: "decide_new_attempt_or_discard" })]),
      v3([cleanupItem({ rootId: "99999999-0000-4000-8000-000000000000" })]),
      v3([cleanupItem({ rootPid: null, kind: "verification_unavailable" })]),
      v3(Array.from({ length: 33 }, () => cleanupItem())),
      v3([cleanupItem()], (o) => ((o.attention as unknown as Record<string, unknown>).extra = 1)),
      v3([cleanupItem()], (o) => (o.schema = "executive-overview/v1")),
      v3(
        [cleanupItem()],
        (o) => ((o.attention as unknown as Record<string, unknown>).automaticAllowed = true)
      )
    ];
    for (const overview of bad) {
      await refresh(overview);
      expect(doc.el("execNote").textContent).toContain("not recognized");
      expect(view.kids).toHaveLength(0);
    }
  });

  it("still reads v1 and v2 bodies that have no attention", async () => {
    const { refresh, view } = mount();
    await refresh(overviewOf(rootView(ROOT_A, "Delivery", [leaf(1, "ready")])));
    expect(view.textContent).toContain("Delivery");
    expect(view.textContent).not.toContain("Attention (derived");
    const v2 = overviewOf(rootView(ROOT_A, "Delivery", [leaf(1, "ready")]));
    v2.schema = "executive-overview/v2";
    await refresh(v2);
    expect(view.textContent).toContain("Delivery");
  });
});
