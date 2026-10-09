import { describe, expect, it } from "vitest";
import { classifyRoute, decideAccess } from "../../src/auth/routePolicy";
import {
  EXECUTIVE_UI_LIMITS,
  executiveOverviewHtml,
  executiveOverviewScript
} from "../../src/ui/executiveOverview";
import { EXECUTIVE_LIMITS } from "../../src/integrations/hekate/executiveOverview";
import { renderHomePageHtml } from "../../src/ui/homePage";
import { FakeDoc, controlledFetch, settle, type FakeEl } from "../helpers/fakeDom";
import {
  NOW,
  ROOT_A,
  ROOT_B,
  guid,
  leaf,
  overviewOf,
  progressBody,
  rootView
} from "../helpers/executiveFixtures";

const mode = { mode: "mock" as const };
const OVERVIEW = "/development/executive/overview";
const progressUrl = (root: string, node: string) =>
  `/development/plans/${root}/nodes/${node}/progress`;

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
  const taskDetails = (node: string) =>
    view.findAll((e) => e.tag === "details" && e.attrs["data-task"] === node)[0] as FakeEl;
  const evidence = (node: string) =>
    taskDetails(node).findAll((e) => "data-evidence" in e.attrs)[0] as FakeEl;
  const expand = async (node: string) => {
    taskDetails(node)
      .findAll((e) => e.tag === "summary")[0]
      .click();
    await settle();
  };
  const refresh = async (body: unknown, status = 200) => {
    doc.el("execRefresh").dispatch("click");
    await settle();
    net.calls.at(-1)!.respond(body, status);
    await settle();
  };
  return { doc, net, view, taskDetails, evidence, expand, refresh };
}

const inProgress = (over = {}) =>
  leaf(1, "in_progress", { attemptId: "at-1", attemptEpoch: 2, stateRevision: 4, ...over });
const standard = () =>
  overviewOf(
    rootView(ROOT_A, "Application delivery", [inProgress(), leaf(2, "review_pending")]),
    rootView(ROOT_B, "Reliability", [leaf(3, "ready")])
  );
const taskOf = (overview: ReturnType<typeof standard>, node: string) =>
  overview.roots.flatMap((r) => r.tasks).find((t) => t.nodeId === node)!;

describe("home page integration", () => {
  it("is byte-identical when disabled and inserts exactly two fragments when enabled", () => {
    const base = renderHomePageHtml(mode, false, true, true, true);
    expect(renderHomePageHtml(mode, false, true, true, true, false)).toBe(base);
    expect(base).not.toContain("executiveOverview");
    const on = renderHomePageHtml(mode, false, true, true, true, true);
    expect(
      on
        .replace(`\n      ${executiveOverviewHtml()}`, "")
        .replace(`\n${executiveOverviewScript()}`, "")
    ).toBe(base);
    // It does not depend on the other panels, and the default signature is unchanged.
    const alone = renderHomePageHtml(mode, false, false, false, false, true);
    expect(alone).toContain('id="execRefresh"');
    expect(renderHomePageHtml(mode)).toBe(renderHomePageHtml(mode, false, false, false, false));
    // Rendered first in the chat shell, before the chat header.
    expect(on.indexOf('id="executiveOverview"')).toBeLessThan(on.indexOf('id="userId"'));
  });

  it("offers Refresh and no other control, with generated script that parses", () => {
    const html = executiveOverviewHtml();
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(">Refresh</button>");
    const script = executiveOverviewScript();
    expect(
      () => new Function(script.replace(/^<script>/, "").replace(/<\/script>$/, ""))
    ).not.toThrow();
    expect(script).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setInterval|localStorage|sessionStorage|document\.cookie|location\s*[.=]|window\.open|method:\s*'(?!GET)/
    );
  });

  it("shares its bounds with the collector", () => {
    expect(EXECUTIVE_UI_LIMITS).toMatchObject({
      maxRoots: EXECUTIVE_LIMITS.maxRoots,
      maxTasks: EXECUTIVE_LIMITS.maxTasks,
      maxBlockers: EXECUTIVE_LIMITS.maxBlockers,
      maxInvalidCodes: EXECUTIVE_LIMITS.maxInvalidCodes,
      maxTextChars: EXECUTIVE_LIMITS.maxTextChars,
      maxResponseBytes: EXECUTIVE_LIMITS.maxResponseBytes,
      maxConcurrentDrills: 3
    });
  });

  it("classifies the route as operator-only and denies other methods", () => {
    const rule = classifyRoute("GET", OVERVIEW);
    expect(rule?.access).toBe("operator");
    expect(classifyRoute("POST", OVERVIEW)).toBeUndefined();
    expect(classifyRoute("DELETE", OVERVIEW)).toBeUndefined();
    expect(classifyRoute("GET", OVERVIEW + "/")).toBeUndefined();
    expect(decideAccess(rule, undefined)).toMatchObject({ allow: false, status: 401 });
    expect(
      decideAccess(rule, { principalId: "c", roles: new Set<"client">(["client"]), via: "bearer" })
    ).toMatchObject({ allow: false, status: 403, code: "OPERATOR_REQUIRED" });
  });
});

describe("executive overview script behavior", () => {
  it("issues no request on load and exactly one GET per Refresh", async () => {
    const { net, doc, refresh } = mount();
    await settle();
    expect(net.calls).toHaveLength(0);
    expect(doc.el("execNote").textContent).toContain("Press Refresh");
    doc.el("execRefresh").dispatch("click");
    await settle();
    expect(net.calls.map((c) => [c.method, c.url])).toEqual([["GET", OVERVIEW]]);
    // Disabled while a read is pending: a second click cannot start another request.
    expect(doc.el("execRefresh").disabled).toBe(true);
    doc.el("execRefresh").dispatch("click");
    await settle();
    expect(net.calls).toHaveLength(1);
    net.calls[0].respond(standard());
    await settle();
    expect(doc.el("execRefresh").disabled).toBe(false);
    await refresh(standard());
    expect(net.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("shows state, count and attention first and keeps details collapsed", async () => {
    const { refresh, view } = mount();
    await refresh(standard());
    const roots = view.findAll((e) => e.tag === "details" && "data-root" in e.attrs);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.open === false)).toBe(true);
    const head = roots[0].findAll((e) => e.tag === "summary")[0].textContent;
    expect(head).toContain("Application delivery");
    expect(head).toContain("0 of 2 tasks accepted in PlanStore");
    expect(head).toContain("1 review needed");
    expect(head).toContain("worker liveness unknown");
    const ready = view.findAll((e) => e.attrs["data-state"] === "ready")[0];
    const label = ready.findAll((e) => e.tag === "summary")[0].textContent;
    expect(label).toContain("execution preparation unverified");
    expect(label).not.toMatch(/running|prepared and|executing/i);
    expect(view.textContent).toContain("Budget evidence: not_reported");
    expect(view.textContent).toContain("Checkpoint gate (current state): awaiting_review");
    expect(view.textContent).toContain("Goal (configured, not verified): Configured goal");
  });

  it("renders hostile names inertly as text", async () => {
    const { refresh, view, doc } = mount();
    const hostile = '<img src=x onerror="window.__pwned=1"></script><b>x</b>' + "z".repeat(400);
    const overview = overviewOf(
      rootView(
        ROOT_A,
        "<img onerror=1>",
        [leaf(1, "ready", { name: hostile, scope: "a\u0000b" })],
        "</script><script>alert(1)</script>"
      )
    );
    await refresh(overview);
    expect(view.textContent).toContain("<img onerror=1>");
    expect(view.textContent).toContain("</script><script>alert(1)</script>");
    // Elements are only the fixed structural tags; data never becomes an element.
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
    expect(view.findAll((e) => e.tag === "img" || e.tag === "script")).toEqual([]);
    expect(view.textContent).not.toContain("z".repeat(250));
  });

  it("withholds artifact references that are not plain digests", async () => {
    const { refresh, view } = mount();
    await refresh(
      overviewOf(
        rootView(ROOT_A, "A", [
          leaf(1, "accepted", { artifactRef: "javascript:alert(1)" }),
          leaf(2, "accepted", { artifactRef: "git:" + "a".repeat(40) })
        ])
      )
    );
    expect(view.textContent).toContain("Accepted in PlanStore; source integration not proven");
    expect(view.textContent).toContain("Task artifact: present but withheld");
    expect(view.textContent).not.toContain("javascript:");
    expect(view.textContent).toContain("Task artifact: git:" + "a".repeat(40));
  });

  it("rejects a response that only borrows the schema name", async () => {
    const { refresh, doc, view } = mount();
    await refresh({ schema: "executive-overview/v1" });
    expect(doc.el("execNote").textContent).toContain("not recognized");
    expect(view.kids).toHaveLength(0);
    const bad = standard() as unknown as { roots: { tasks: Record<string, unknown>[] }[] };
    bad.roots[0].tasks[0].state = "<b>unknown</b>";
    await refresh(bad);
    expect(doc.el("execNote").textContent).toContain("not recognized");
    expect(view.kids).toHaveLength(0);
    const sneaky = standard() as unknown as { atomic: boolean };
    sneaky.atomic = true;
    await refresh(sneaky);
    expect(view.kids).toHaveLength(0);
  });

  it("shows unavailable and invalid roots distinctly without hiding the others", async () => {
    const { refresh, view } = mount();
    const overview = overviewOf(
      rootView(ROOT_A, "Good", [leaf(1, "ready")]),
      {
        ...rootView(ROOT_B, "Bad", []),
        status: "invalid",
        invalidCodes: [{ code: "CYCLE", nodeId: null }],
        prods: [{ kind: "investigate_plan_state", count: 1 }]
      },
      {
        ...rootView(guid(3), "Down", []),
        status: "unavailable",
        reason: "TIMEOUT",
        acceptedCounts: null,
        planState: null
      }
    );
    await refresh(overview);
    const text = view.textContent;
    expect(text).toContain("plan invalid; cannot be evaluated");
    expect(text).toContain("Readiness error: CYCLE");
    expect(text).toContain("unavailable (TIMEOUT)");
    expect(text).toContain("Other plans are unaffected");
    expect(view.findAll((e) => e.attrs["data-state"] === "ready")).toHaveLength(1);
  });

  it("keeps the last good view under a stale banner on a failed refresh, then recovers", async () => {
    const { refresh, view, doc, net } = mount();
    await refresh(standard());
    const good = view.textContent;
    await refresh({ code: "X" }, 503);
    const banner = doc.el("execStale");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Refresh failed; showing data last read at");
    expect(banner.textContent).toContain(NOW);
    expect(view.textContent).toBe(good);
    expect(view.attrs["data-stale"]).toBe("true");
    await refresh(standard());
    expect(banner.hidden).toBe(true);
    expect(view.attrs["data-stale"]).toBeUndefined();
    // A failed first read has nothing to preserve and no banner.
    const fresh = mount();
    await fresh.refresh({ code: "X" }, 503);
    expect(fresh.doc.el("execStale").hidden).toBe(true);
    expect(fresh.view.kids).toHaveLength(0);
    expect(net.calls.every((c) => c.url === OVERVIEW)).toBe(true);
  });

  it("clears everything on a user or conversation change and drops late responses", async () => {
    const { refresh, view, doc, net, expand, taskDetails, evidence } = mount();
    const overview = standard();
    await refresh(overview);
    const node = guid(100, 1);
    await expand(node);
    expect(net.calls.at(-1)!.url).toBe(progressUrl(ROOT_A, node));
    net.calls.at(-1)!.respond(progressBody(ROOT_A, taskOf(overview, node)));
    await settle();
    expect(evidence(node).textContent).toContain("I will fix the parser.");
    doc.el("conversationId").value = "other";
    doc.el("conversationId").dispatch("input");
    expect(view.kids).toHaveLength(0);
    expect(doc.el("execStale").hidden).toBe(true);
    expect(taskDetails(node)).toBeUndefined();
    // A pending refresh from the old scope is aborted and its late answer is dropped.
    const before = net.calls.length;
    doc.el("execRefresh").dispatch("click");
    await settle();
    doc.el("userId").value = "someone-else";
    doc.el("userId").dispatch("change");
    expect(net.calls[before].signal?.aborted).toBe(true);
    net.calls[before].respond(overview);
    await settle();
    expect(view.kids).toHaveLength(0);
    expect(doc.el("execRefresh").disabled).toBe(false);
  });
});

describe("in-place task evidence", () => {
  it("expands with exactly one GET to the expected path and renders a compact subset", async () => {
    const { refresh, expand, net, evidence, taskDetails } = mount();
    const overview = standard();
    await refresh(overview);
    const node = guid(100, 1);
    const before = net.calls.length;
    await expand(node);
    expect(net.calls.slice(before).map((c) => [c.method, c.url])).toEqual([
      ["GET", progressUrl(ROOT_A, node)]
    ]);
    net.calls.at(-1)!.respond(progressBody(ROOT_A, taskOf(overview, node)));
    await settle();
    const text = evidence(node).textContent;
    expect(text).toContain("Snapshot consistency: current");
    expect(text).toContain("Trace status: running");
    expect(text).toContain("Worker liveness: unknown");
    expect(text).toContain("Worker said (claim): I will fix the parser.");
    expect(text).toContain("1 tool names not shown");
    expect(text).toContain(`[0] /api/plan-contract/v1/plans/${ROOT_A} sha256 `);
    // Collapse aborts and clears; nothing stays on screen as if current.
    taskDetails(node)
      .findAll((e) => e.tag === "summary")[0]
      .click();
    expect(evidence(node).textContent).toBe("");
    expect(taskDetails(node).open).toBe(false);
  });

  it("states a missing trace as a plain fact, not an error", async () => {
    const { refresh, expand, net, evidence } = mount();
    const overview = overviewOf(rootView(ROOT_A, "A", [leaf(1, "ready")]));
    await refresh(overview);
    const node = guid(100, 1);
    await expand(node);
    net.calls.at(-1)!.respond(progressBody(ROOT_A, taskOf(overview as never, node)));
    await settle();
    const text = evidence(node).textContent;
    expect(text).toContain("No worker trace recorded for this task (liveness unknown).");
    expect(text).toContain("No attempt is recorded for this task.");
    expect(text).not.toMatch(/unavailable|failed/i);
  });

  it("refuses a response for another root, node, attempt, epoch, revision or schema", async () => {
    const overview = standard();
    const node = guid(100, 1);
    const task = taskOf(overview, node);
    const cases: [string, unknown][] = [
      ["root", progressBody(ROOT_B, task)],
      ["node", progressBody(ROOT_A, { ...task, nodeId: guid(100, 2) })],
      ["attempt", progressBody(ROOT_A, { ...task, attemptId: "at-other" })],
      ["epoch", progressBody(ROOT_A, { ...task, attemptEpoch: 3 })],
      ["content", progressBody(ROOT_A, { ...task, contentRevision: 9 })],
      ["state", progressBody(ROOT_A, { ...task, stateRevision: 5 })],
      ["schema", { schema: "attempt-progress/v1", rootId: ROOT_A, nodeId: node }],
      ["bad enum", progressBody(ROOT_A, task, { consistency: "<b>" })],
      [
        "bad ref",
        progressBody(ROOT_A, task, {
          acceptance: {
            decision: null,
            taskArtifact: { state: "shown", ref: "javascript:1" },
            decisionArtifact: { state: "none" },
            evidence: { state: "none" }
          }
        })
      ]
    ];
    for (const [name, body] of cases) {
      const { refresh, expand, net, evidence } = mount();
      await refresh(overview);
      await expand(node);
      net.calls.at(-1)!.respond(body);
      await settle();
      const text = evidence(node).textContent;
      expect(text, name).toMatch(/Evidence (unavailable|changed)/);
      expect(text, name).not.toContain("I will fix the parser.");
    }
  });

  it("replaces evidence with a message on HTTP failure and never leaves old evidence", async () => {
    const { refresh, expand, net, evidence } = mount();
    const overview = standard();
    await refresh(overview);
    const node = guid(100, 1);
    await expand(node);
    net.calls.at(-1)!.respond({ code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "BUSY" }, 503);
    await settle();
    expect(evidence(node).textContent).toContain("Evidence unavailable (HTTP 503)");
    expect(evidence(node).textContent).not.toContain("BUSY");
  });

  it("drops open evidence when a refresh changes the task binding, keeps it when unchanged", async () => {
    for (const [name, change, kept] of [
      ["state revision", { stateRevision: 5 }, false],
      ["epoch", { attemptEpoch: 3 }, false],
      ["attempt", { attemptId: "at-2" }, false],
      ["content revision", { contentRevision: 2 }, false],
      ["unrelated field", { scope: "src/other.ts" }, true]
    ] as const) {
      const { refresh, expand, net, evidence } = mount();
      const first = standard();
      await refresh(first);
      const node = guid(100, 1);
      await expand(node);
      net.calls.at(-1)!.respond(progressBody(ROOT_A, taskOf(first, node)));
      await settle();
      expect(evidence(node).textContent, name).toContain("I will fix the parser.");
      const next = overviewOf(
        rootView(ROOT_A, "Application delivery", [inProgress(change), leaf(2, "review_pending")]),
        first.roots[1]
      );
      await refresh(next);
      const text = evidence(node).textContent;
      if (kept) expect(text, name).toContain("I will fix the parser.");
      else {
        expect(text, name).not.toContain("I will fix the parser.");
        expect(text, name).toContain("changed since it was expanded");
      }
    }
  });

  it("drops a superseded in-flight read when the binding changes", async () => {
    const { refresh, expand, net, evidence } = mount();
    const first = standard();
    await refresh(first);
    const node = guid(100, 1);
    await expand(node);
    const pending = net.calls.at(-1)!;
    await refresh(
      overviewOf(
        rootView(ROOT_A, "Application delivery", [inProgress({ stateRevision: 9 })]),
        first.roots[1]
      )
    );
    expect(pending.signal?.aborted).toBe(true);
    pending.respond(progressBody(ROOT_A, taskOf(first, node)));
    await settle();
    expect(evidence(node).textContent).not.toContain("I will fix the parser.");
  });

  it("keeps evidence under the stale banner when only the refresh fails", async () => {
    const { refresh, expand, net, evidence, doc } = mount();
    const overview = standard();
    await refresh(overview);
    const node = guid(100, 1);
    await expand(node);
    net.calls.at(-1)!.respond(progressBody(ROOT_A, taskOf(overview, node)));
    await settle();
    await refresh({}, 500);
    expect(doc.el("execStale").hidden).toBe(false);
    expect(evidence(node).textContent).toContain("I will fix the parser.");
  });

  it("allows at most three evidence reads in flight", async () => {
    const { refresh, expand, net, evidence } = mount();
    const leaves = [1, 2, 3, 4].map((n) =>
      leaf(n, "in_progress", { attemptId: "a", attemptEpoch: 1 })
    );
    await refresh(overviewOf(rootView(ROOT_A, "A", leaves)));
    const before = net.calls.length;
    for (const n of [1, 2, 3, 4]) await expand(guid(100, n));
    expect(net.calls.length - before).toBe(3);
    expect(evidence(guid(100, 4)).textContent).toContain("Too many evidence reads");
  });

  it("builds progress URLs only from GUIDs of the last overview", async () => {
    const { refresh, net, view, doc } = mount();
    const overview = overviewOf(rootView(ROOT_A, "A", [leaf(1, "ready")]));
    await refresh(overview);
    expect(view.textContent).not.toContain("..");
    // The only requests so far are the overview.
    expect(net.calls.map((c) => c.url)).toEqual([OVERVIEW]);
    // A task id that is not a GUID cannot pass overview validation, so it can never reach a URL.
    const bad = JSON.parse(JSON.stringify(overview));
    bad.roots[0].tasks[0].nodeId = "../../admin";
    await refresh(bad);
    expect(doc.el("execNote").textContent).toContain("not recognized");
    expect(net.calls.every((c) => c.url === OVERVIEW)).toBe(true);
  });
});
