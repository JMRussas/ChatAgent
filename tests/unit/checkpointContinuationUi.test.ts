import { describe, expect, it } from "vitest";
import { projectAttention } from "../../src/integrations/hekate/checkpointAttention";
import {
  projectContinuation,
  type ContinuationView
} from "../../src/integrations/hekate/checkpointContinuationView";
import type { ExecutiveOverview } from "../../src/integrations/hekate/executiveOverview";
import { executiveOverviewScript } from "../../src/ui/executiveOverview";
import { RUN_ID, SOURCE_REF, STAMP } from "../helpers/checkpointFixtures";
import { FakeDoc, controlledFetch, settle, type FakeEl } from "../helpers/fakeDom";
import {
  ROOT_A,
  guid,
  leaf,
  overviewOf,
  progressBody,
  rootView
} from "../helpers/executiveFixtures";

const OVERVIEW = "/development/executive/overview";
const HOSTILE = '<img src=x onerror="window.__pwned=1"></script><b>x</b>';

function mount() {
  const doc = new FakeDoc({
    userId: { value: "user-demo", tag: "input" },
    conversationId: { value: "conv-ui-demo", tag: "input" },
    execRefresh: { tag: "button" },
    execNote: { tag: "p" },
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
  const view = doc.el("execView");
  const refresh = async (payload: unknown) => {
    doc.el("execRefresh").dispatch("click");
    await settle();
    net.calls.at(-1)!.respond(payload);
    await settle();
  };
  const task = (node: string) =>
    view.findAll((e) => e.tag === "details" && e.attrs["data-task"] === node)[0] as FakeEl;
  const panel = () => view.findAll((e) => "data-phases" in e.attrs)[0] as FakeEl | undefined;
  return { doc, net, view, refresh, task, panel };
}

const check = (name: string, result: string) => ({
  name,
  result,
  ran: result !== "unavailable",
  exitCode: result === "pass" ? 0 : result === "fail" ? 1 : null,
  timedOut: false,
  outputLimited: false
});
const NAMES = ["prettier", "typescript", "vitest"];
const idle = {
  reason: "in_progress",
  endedAt: null,
  sourceRef: null,
  finish: "not_attempted",
  gate: "not_written",
  checks: [],
  attention: "none"
};
const finished = { endedAt: STAMP, sourceRef: SOURCE_REF, finish: "confirmed", gate: "written" };
const PHASE_VIEWS: Record<string, object> = {
  reserved: idle,
  running: idle,
  snapshotting: idle,
  verifying: {
    ...idle,
    sourceRef: SOURCE_REF,
    finish: "confirmed",
    checks: NAMES.map((n) => check(n, "unavailable"))
  },
  review_pending: {
    ...finished,
    reason: "checks_passed",
    checks: NAMES.map((n) => check(n, "pass")),
    attention: "review_pending"
  },
  needs_operator: {
    ...finished,
    reason: "check_failed",
    checks: [
      check("prettier", "pass"),
      check("typescript", "fail"),
      check("vitest", "unavailable")
    ],
    attention: "needs_operator"
  }
};
const reported = (phase: string, over: object = {}): ContinuationView =>
  ({
    state: "reported",
    runId: RUN_ID,
    phase,
    startedAt: STAMP,
    updatedAt: STAMP,
    worker: null,
    relevance: "open",
    trust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    semanticReview: "not_performed",
    ...PHASE_VIEWS[phase],
    ...over
  }) as unknown as ContinuationView;

const TASKS: { n: number; phase: string }[] = [
  { n: 1, phase: "reserved" },
  { n: 2, phase: "running" },
  { n: 3, phase: "snapshotting" },
  { n: 4, phase: "verifying" },
  { n: 5, phase: "review_pending" },
  { n: 6, phase: "needs_operator" }
];
const node = (n: number) => guid(100, n);
const fence = { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3, stateRevision: 4 };

/** A v4 overview built with the real projections, so the page validates what the server sends. */
function build(label = "Application delivery") {
  const leaves = [
    ...TASKS.map(({ n, phase }) =>
      phase === "reserved" || phase === "running" || phase === "snapshotting"
        ? leaf(n, "in_progress", fence)
        : leaf(n, "review_pending", { ...fence, artifactRef: SOURCE_REF })
    ),
    leaf(7, "accepted", { ...fence, artifactRef: SOURCE_REF }),
    leaf(8, "in_progress", fence)
  ];
  const root = rootView(ROOT_A, label, leaves);
  const registry = leaves.map((l) => ({
    rootId: ROOT_A,
    nodeId: l.nodeId,
    recordPath: `/r/${l.nodeId}.budget.json`,
    continuationRecordPath: `/r/${RUN_ID}.continuation.json`
  }));
  const views: Record<string, ContinuationView> = {
    [node(7)]: reported("review_pending", { relevance: "settled", attention: "none" }),
    [node(8)]: { state: "unavailable", reason: "stale_source" }
  };
  for (const { n, phase } of TASKS) views[node(n)] = reported(phase);
  for (const task of root.tasks) task.continuation = views[task.nodeId];
  const overview: ExecutiveOverview = {
    ...overviewOf(root),
    schema: "executive-overview/v4",
    attention: projectAttention([root], registry),
    continuation: projectContinuation([root], registry)
  };
  return overview;
}
const clone = (o: ExecutiveOverview) => JSON.parse(JSON.stringify(o));
const texts = (els: FakeEl[]) => els.map((e) => e.textContent);

describe("v4 checkpoint phases on the page", () => {
  it("shows every phase, counts and coverage, with attention first and settled apart", async () => {
    const { refresh, view, panel, task } = mount();
    await refresh(build());
    const text = panel()!.textContent;
    expect(text).toContain("Configured records: 8.");
    expect(text).toContain(
      "1 needs operator, 1 awaiting review, 1 checking, 1 snapshotting, 1 working, 1 reserved."
    );
    expect(text).toContain("Settled (task accepted or cancelled): 1. Unavailable coverage: 1.");
    const rows = panel()!.findAll((e) => "data-phase-item" in e.attrs);
    expect(rows.map((r) => r.attrs["data-phase-item"])).toEqual([
      "needs_operator",
      "review_pending",
      "verifying",
      "snapshotting",
      "running",
      "reserved"
    ]);
    expect(rows[0].textContent).toContain("(attention)");
    expect(rows[2].textContent).not.toContain("(attention)");
    // The panel precedes the roots, so the executive sees it before any expansion.
    const first = view.findAll((e) => "data-phases" in e.attrs || "data-root" in e.attrs)[0];
    expect(first.attrs).toHaveProperty("data-phases");

    const summaryOf = (n: number) =>
      task(node(n)).findAll((e) => e.tag === "summary")[0].textContent;
    expect(summaryOf(4)).toContain("checking (external format, type and test checks");
    expect(summaryOf(5)).toContain("awaiting review (external checks passed; not accepted)");
    expect(summaryOf(6)).toContain("needs operator");
    expect(summaryOf(2)).toContain("working");
    expect(summaryOf(8)).toContain("checkpoint phase unavailable (stale_source)");
  });

  it("does not present an accepted task's old terminal phase as a review to do", async () => {
    const { refresh, task, panel } = mount();
    await refresh(build());
    const accepted = task(node(7));
    expect(accepted.findAll((e) => "data-phase" in e.attrs)).toEqual([]);
    expect(accepted.textContent).toContain("Historical: the task is already settled in PlanStore");
    expect(accepted.textContent).not.toContain("Awaiting lead review");
    expect(panel()!.findAll((e) => e.attrs["data-phase-item"] !== undefined)).toHaveLength(6);
    // Passing checks and acceptance are separate lines in the same detail.
    const pending = task(node(5)).textContent;
    expect(pending).toContain("Check typescript: pass");
    expect(pending).toContain("Passing external checks are not acceptance");
    expect(pending).toContain("Semantic review: not performed");
    expect(pending).toContain("Recorded decision: none");
  });

  it("separates verifier failure from review pending and explains unavailable records", async () => {
    const { refresh, task } = mount();
    await refresh(build());
    const failed = task(node(6)).textContent;
    expect(failed).toContain("Check typescript: fail");
    expect(failed).toContain("Check vitest: unavailable (not run)");
    expect(failed).toContain("does not retry itself");
    expect(failed).not.toContain("Awaiting lead review");
    expect(task(node(5)).textContent).toContain("Awaiting lead review of the candidate source");
    const gone = task(node(8)).textContent;
    expect(gone).toContain("Checkpoint continuation record unavailable (reason: stale_source)");
    expect(gone).toContain("no phase is shown as current");
  });

  it("opens the existing in-place task detail without navigation or a mutation", async () => {
    const { refresh, view, net, task } = mount();
    const overview = build();
    await refresh(overview);
    const open = view.findAll(
      (e) => e.tag === "button" && e.textContent === "Open phase detail"
    )[0];
    const target = overview.roots[0].tasks.find((t) => t.nodeId === node(6))!;
    expect(task(node(6)).open).toBe(false);
    open.click();
    await settle();
    expect(net.calls.at(-1)!.url).toBe(`/development/plans/${ROOT_A}/nodes/${node(6)}/progress`);
    net.calls.at(-1)!.respond(progressBody(ROOT_A, target));
    await settle();
    expect(task(node(6)).open).toBe(true);
    const evidence = task(node(6)).findAll((e) => "data-evidence" in e.attrs)[0];
    expect(evidence.textContent).toContain("Worker said (claim): I will fix the parser.");
    expect(task(node(6)).textContent).toContain("Check typescript: fail");
    expect(net.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", OVERVIEW],
      ["GET", `/development/plans/${ROOT_A}/nodes/${node(6)}/progress`]
    ]);
  });

  it("refuses to open an item that disagrees with the task it names", async () => {
    const { refresh, panel } = mount();
    const skewed = clone(build());
    skewed.continuation.items[0].updatedAt = "2026-10-09T11:00:00.000Z";
    skewed.continuation.items[1].taskListed = false;
    await refresh(skewed);
    const rows = panel()!.findAll((e) => "data-phase-item" in e.attrs);
    expect(rows[0].textContent).toContain("This item changed (changed, refresh).");
    expect(rows[1].textContent).toContain("Task row omitted by the size cap");
    expect(texts(rows.slice(0, 2)).every((t) => !t.includes("Open phase detail"))).toBe(true);
    expect(rows[2].findAll((e) => e.tag === "button")).toHaveLength(1);
  });

  it("renders hostile configured text inertly beside the phases", async () => {
    const { refresh, view, doc, panel } = mount();
    await refresh(build(HOSTILE));
    expect(view.textContent).toContain(HOSTILE);
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
      "li",
      "button"
    ]);
    expect(doc.createdTags.every((tag) => allowed.has(tag))).toBe(true);
    expect(view.findAll((e) => e.tag === "img" || e.tag === "script" || e.tag === "b")).toEqual([]);
    expect(panel()!.textContent).toContain(HOSTILE);
  });

  it("keeps v1 free of phase markup", async () => {
    const { refresh, view } = mount();
    await refresh(overviewOf(rootView(ROOT_A, "Plain", [leaf(1, "ready")])));
    expect(view.findAll((e) => "data-phases" in e.attrs || "data-continuation" in e.attrs)).toEqual(
      []
    );
  });
});

describe("v4 validation rejects what it does not know", () => {
  type Mutation = [string, (o: any) => void];
  const task = (o: any, n: number) =>
    o.roots[0].tasks.find((t: { nodeId: string }) => t.nodeId === node(n));
  const mutations: Mutation[] = [
    ["an unknown summary field", (o) => (o.continuation.prompt = "secret")],
    ["an unknown view field", (o) => (task(o, 5).continuation.stdout = "raw output")],
    ["an unknown check field", (o) => (task(o, 5).continuation.checks[0].stdout = "raw")],
    ["an unknown worker field", (o) => (task(o, 5).continuation.worker = { path: "/x" })],
    ["markup in an enumerated reason", (o) => (task(o, 5).continuation.reason = "<img src=x>")],
    ["an unknown phase", (o) => (task(o, 5).continuation.phase = "done")],
    ["an unknown unavailable reason", (o) => (task(o, 8).continuation.reason = "<b>x</b>")],
    ["a private path as source", (o) => (task(o, 5).continuation.sourceRef = "/home/x")],
    ["a review that never wrote its gate", (o) => (task(o, 5).continuation.gate = "not_written")],
    [
      "attention on a settled record",
      (o) => (task(o, 7).continuation.attention = "review_pending")
    ],
    ["a changed attention class", (o) => (task(o, 6).continuation.attention = "none")],
    ["a wrong configured count", (o) => (o.continuation.configured = 9)],
    ["a missing summary", (o) => delete o.continuation],
    ["an item for an unknown root", (o) => (o.continuation.items[0].rootId = guid(9))],
    ["an item with an unknown field", (o) => (o.continuation.items[0].path = "/x")],
    [
      "more items than the bound",
      (o) => (o.continuation.items = Array(33).fill(o.continuation.items[0]))
    ],
    ["a phase in a v3 overview", (o) => (o.schema = "executive-overview/v3")],
    [
      "a summary in a v2 overview",
      (o) => {
        o.schema = "executive-overview/v2";
        delete o.attention;
      }
    ]
  ];
  it.each(mutations)("rejects %s", async (_name, mutate) => {
    const { refresh, doc, view } = mount();
    const bad = clone(build());
    mutate(bad);
    await refresh(bad);
    expect(doc.el("execNote").textContent).toBe("The overview response was not recognized.");
    expect(view.findAll((e) => e.tag === "details")).toEqual([]);
  });

  it("rejects a task phase on a v3 overview that has no phase contract", async () => {
    const { refresh, doc } = mount();
    const bad = clone(build());
    bad.schema = "executive-overview/v3";
    delete bad.continuation;
    await refresh(bad);
    expect(doc.el("execNote").textContent).toBe("The overview response was not recognized.");
  });

  it("accepts the unmodified overview", async () => {
    const { refresh, doc } = mount();
    await refresh(clone(build()));
    expect(doc.el("execNote").textContent).toBe("Overview read (read-only).");
  });
});
