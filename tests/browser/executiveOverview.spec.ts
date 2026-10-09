import { projectAttention } from "../../src/integrations/hekate/checkpointAttention";
import { makeRecord } from "../helpers/checkpointFixtures";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixture";
import {
  ROOT_A,
  ROOT_B,
  ROOT_C,
  guid,
  leaf,
  overviewOf,
  progressBody,
  rootView
} from "../helpers/executiveFixtures";

const NODE = guid(100, 1);
const OVERVIEW = "/development/executive/overview";
const PROGRESS = `/development/plans/${ROOT_A}/nodes/${NODE}/progress`;
const HOSTILE = '<img src=x onerror="window.__pwned=1"></script><b>bold</b>';

const running = (over = {}) =>
  leaf(1, "in_progress", { attemptId: "at-1", attemptEpoch: 2, stateRevision: 4, ...over });
function standard(over = {}) {
  return overviewOf(
    rootView(ROOT_A, "Application delivery", [running(over), leaf(2, "review_pending")]),
    rootView(ROOT_B, "Reliability", [leaf(3, "ready")])
  );
}
const taskOf = (overview: ReturnType<typeof standard>, node = NODE) =>
  overview.roots.flatMap((r) => r.tasks).find((t) => t.nodeId === node)!;

interface Stubbed {
  status: number;
  body: unknown;
}
/** Answers the page's development requests locally and logs every one of them. */
async function stub(
  page: Page,
  state: { overview: Stubbed; progress: (path: string) => Stubbed | Promise<Stubbed> }
) {
  const seen: { method: string; path: string }[] = [];
  const respond = (route: Route, out: Stubbed) =>
    route
      .fulfill({
        status: out.status,
        contentType: "application/json",
        body: JSON.stringify(out.body)
      })
      .catch(() => undefined);
  await page.route("**/development/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push({ method: route.request().method(), path: url.pathname + url.search });
    if (url.pathname === OVERVIEW) return respond(route, state.overview);
    return respond(route, await state.progress(url.pathname));
  });
  return { seen, state };
}

const view = (page: Page) => page.locator("#execView");
const refresh = (page: Page) => page.locator("#execRefresh").click();
const root = (page: Page, id = ROOT_A) => page.locator(`details[data-root="${id}"]`);
const task = (page: Page, node = NODE) => page.locator(`details[data-task="${node}"]`);

test.describe("executive overview", () => {
  test.use({ executiveOverview: true });

  test("sends nothing on load or reload, and only GETs on Refresh and expansion", async ({
    page,
    app
  }) => {
    const dev: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/development/"))
        dev.push(`${req.method()} ${new URL(req.url()).pathname}`);
    });
    const overview = standard();
    await stub(page, {
      overview: { status: 200, body: overview },
      progress: () => ({ status: 200, body: progressBody(ROOT_A, taskOf(overview)) })
    });
    await app.pair(page);
    await expect(page.locator("#execNote")).toContainText("Press Refresh");
    await page.reload();
    await expect(page.locator("#execNote")).toContainText("Press Refresh");
    expect(dev).toEqual([]);

    const before = page.url();
    await refresh(page);
    await expect(root(page)).toBeVisible();
    // High-level state, counts and attention come first with details collapsed.
    await expect(root(page).locator("> summary")).toContainText("Application delivery");
    await expect(root(page).locator("> summary")).toContainText(
      "0 of 2 tasks accepted in PlanStore"
    );
    await expect(root(page).locator("> summary")).toContainText("review needed");
    await expect(task(page)).not.toHaveAttribute("open", "");

    await root(page).locator("> summary").click();
    await task(page).locator("> summary").click();
    const evidence = task(page).locator("[data-evidence]");
    await expect(evidence).toContainText("Worker said (claim): I will fix the parser.");
    // Ids, revisions, claim, pins and the typed decision sit beside the evidence, in place.
    await expect(task(page)).toContainText(`Task: ${NODE}`);
    await expect(task(page)).toContainText("Attempt epoch: 2");
    await expect(task(page)).toContainText("State revision: 4");
    await expect(task(page)).toContainText("Input pins: none");
    await expect(task(page)).toContainText("Recorded decision: none");
    await expect(task(page)).toContainText("Budget evidence: not_reported");
    expect(page.url()).toBe(before);

    expect(dev).toEqual([`GET ${OVERVIEW}`, `GET ${PROGRESS}`]);
    await page.reload();
    await expect(page.locator("#execNote")).toContainText("Press Refresh");
    expect(dev).toHaveLength(2);
  });

  test("opens a checkpoint exception from the top summary without changing views", async ({
    page,
    app
  }) => {
    const overview = standard({ contentRevision: 3 });
    const t = taskOf(overview);
    const record = makeRecord({
      stop: { kind: "tripwire", code: "hard_units" },
      expected: { units: 2, basis: "provisional_heuristic" },
      hard: { units: 3, wallMs: 20000, outputBytes: 1048576 },
      consumed: { units: 4, wallMs: 1234, outputBytes: 1024, counterState: "exact_observed" },
      providerReported: { numTurns: null, costUsd: null, status: "unverified" }
    });
    t.budgetEvidence = "reported";
    t.checkpointBudget = {
      state: "reported",
      record,
      gate: { state: "unavailable", reason: "missing" },
      overdueUnreported: false
    };
    overview.schema = "executive-overview/v3";
    overview.attention = projectAttention(overview.roots, [
      { rootId: ROOT_A, nodeId: NODE, recordPath: "/controlled-record.json" }
    ]);
    const { seen } = await stub(page, {
      overview: { status: 200, body: overview },
      progress: () => ({ status: 200, body: progressBody(ROOT_A, t) })
    });
    await app.pair(page);
    expect(seen).toEqual([]);
    const before = page.url();
    await refresh(page);
    const attention = view(page).locator("[data-attention]");
    await expect(attention).toContainText("Supplied record shows a tripwire stop");
    await expect(root(page)).not.toHaveAttribute("open", "");
    await attention.getByRole("button", { name: "Open detail", exact: true }).click();
    await expect(root(page)).toHaveAttribute("open", "");
    await expect(task(page)).toHaveAttribute("open", "");
    await expect(task(page)).toContainText("tripwire / hard_units");
    await expect(task(page).locator("[data-evidence]")).toContainText("Evidence read at");
    expect(page.url()).toBe(before);
    expect(seen.map((r) => r.method)).toEqual(["GET", "GET"]);
  });

  test("renders hostile configured and upstream text inertly", async ({ page, app }) => {
    const overview = overviewOf(
      rootView(
        ROOT_A,
        HOSTILE,
        [
          leaf(1, "ready", { name: HOSTILE + "z".repeat(400), scope: "a\u0000b" }),
          leaf(2, "blocked", {
            blockers: [
              {
                ownerId: guid(100, 2),
                predecessorId: guid(100, 1),
                gate: "accepted",
                reason: HOSTILE,
                predecessorName: HOSTILE
              }
            ]
          })
        ],
        HOSTILE
      )
    );
    await stub(page, {
      overview: { status: 200, body: overview },
      progress: () => ({
        status: 200,
        body: progressBody(ROOT_A, taskOf(overview), {
          activity: {
            trust: "untrusted_inert_unverified_worker_claims",
            source: "complete_stdout_claude_stream_json_assistant_records",
            items: [{ traceSeq: 1, index: 0, kind: "text", text: HOSTILE, textClipped: false }],
            totalItems: 1,
            omittedItems: 0,
            counts: {},
            complete: true
          }
        })
      })
    });
    await app.pair(page);
    await refresh(page);
    await expect(view(page).getByText(HOSTILE).first()).toBeAttached();
    await root(page).locator("> summary").click();
    await task(page, guid(100, 1)).locator("> summary").click();
    await expect(task(page, guid(100, 1)).locator("[data-evidence]")).toBeVisible();
    await expect(view(page).locator("img, script, b")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
    // Configured goal is shown as configuration, not as a verified result.
    await expect(root(page)).toContainText("Goal (configured, not verified)");
    await expect(view(page)).not.toContainText("z".repeat(250));
  });

  test("shows mixed root outcomes without hiding any root", async ({ page, app }) => {
    const down = {
      ...rootView(ROOT_C, "Down", []),
      status: "unavailable",
      reason: "RESPONSE_TOO_LARGE",
      planState: null,
      acceptedCounts: null
    };
    const bad = {
      ...rootView(ROOT_B, "Bad", []),
      status: "invalid",
      invalidCodes: [{ code: "CYCLE", nodeId: null }],
      prods: [{ kind: "investigate_plan_state", count: 1 }]
    };
    await stub(page, {
      overview: {
        status: 200,
        body: overviewOf(rootView(ROOT_A, "Good", [leaf(1, "ready")]), bad as never, down as never)
      },
      progress: () => ({ status: 404, body: {} })
    });
    await app.pair(page);
    await refresh(page);
    await expect(root(page, ROOT_A)).toContainText("Good");
    await expect(root(page, ROOT_B)).toContainText("plan invalid; cannot be evaluated");
    await expect(root(page, ROOT_C)).toContainText("unavailable (RESPONSE_TOO_LARGE)");
    await expect(page.locator("details[data-root]")).toHaveCount(3);
  });

  test("keeps the last good view under a stale banner, and a failing drill-down never looks current", async ({
    page,
    app
  }) => {
    const overview = standard();
    const s = await stub(page, {
      overview: { status: 200, body: overview },
      progress: () => ({ status: 200, body: progressBody(ROOT_A, taskOf(overview)) })
    });
    await app.pair(page);
    await refresh(page);
    await root(page).locator("> summary").click();
    await task(page).locator("> summary").click();
    const evidence = task(page).locator("[data-evidence]");
    await expect(evidence).toContainText("I will fix the parser.");

    s.state.overview = { status: 500, body: { code: "X" } };
    await refresh(page);
    await expect(page.locator("#execStale")).toBeVisible();
    await expect(page.locator("#execStale")).toContainText(
      "Refresh failed; showing data last read at"
    );
    await expect(root(page)).toContainText("Application delivery");

    s.state.overview = { status: 200, body: overview };
    await refresh(page);
    await expect(page.locator("#execStale")).toBeHidden();

    // Collapse and re-expand while the progress route fails: no earlier evidence remains.
    s.state.progress = () => ({ status: 503, body: { reason: "BUSY" } });
    await task(page).locator("> summary").click();
    await expect(evidence).toHaveText("");
    await task(page).locator("> summary").click();
    await expect(evidence).toContainText("Evidence unavailable (HTTP 503)");
    await expect(evidence).not.toContainText("I will fix the parser.");
  });

  test("drops open evidence when a refresh changes the task's binding", async ({ page, app }) => {
    const first = standard();
    const s = await stub(page, {
      overview: { status: 200, body: first },
      progress: () => ({ status: 200, body: progressBody(ROOT_A, taskOf(first)) })
    });
    await app.pair(page);
    await refresh(page);
    await root(page).locator("> summary").click();
    await task(page).locator("> summary").click();
    const evidence = task(page).locator("[data-evidence]");
    await expect(evidence).toContainText("I will fix the parser.");

    // An unrelated field change keeps the exact binding and its evidence.
    s.state.overview = { status: 200, body: standard({ scope: "src/other.ts" }) };
    await refresh(page);
    await expect(task(page)).toContainText("Scope: src/other.ts");
    await expect(evidence).toContainText("I will fix the parser.");

    s.state.overview = { status: 200, body: standard({ attemptEpoch: 3 }) };
    await refresh(page);
    await expect(task(page).locator("[data-evidence]")).toContainText(
      "changed since it was expanded"
    );
    await expect(task(page).locator("[data-evidence]")).not.toContainText("I will fix the parser.");
  });

  test("discards everything when the user or conversation changes and ignores late answers", async ({
    page,
    app
  }) => {
    const overview = standard();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = await stub(page, {
      overview: { status: 200, body: overview },
      progress: () => ({ status: 200, body: progressBody(ROOT_A, taskOf(overview)) })
    });
    await app.pair(page);
    await refresh(page);
    await expect(root(page)).toBeVisible();
    await page.locator("#conversationId").fill("another-conversation");
    await expect(view(page).locator("details")).toHaveCount(0);
    await expect(page.locator("#execNote")).toContainText("changed");

    // A slow refresh started under one scope cannot repopulate the page after a scope change.
    await page.unroute("**/development/**");
    await page.route("**/development/**", async (route) => {
      await gate;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overview)
        })
        .catch(() => undefined);
    });
    await refresh(page);
    await page.locator("#userId").fill("someone-else");
    release();
    await page.waitForTimeout(150);
    await expect(view(page).locator("details")).toHaveCount(0);
    await expect(page.locator("#execRefresh")).toBeEnabled();
    expect(s.seen.every((r) => r.method === "GET")).toBe(true);
  });

  test("the real route is operator-only; a paired session reaches it with its cookie", async ({
    page,
    app
  }) => {
    const url = `${app.url}${OVERVIEW}`;
    expect((await fetch(url)).status).toBe(401);
    const client = await fetch(url, { headers: app.bearer("client") });
    expect(client.status).toBe(403);
    expect(await client.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(
      (await fetch(url, { method: "POST", headers: app.bearer("operator"), body: "{}" })).status
    ).toBe(404);
    // The discard-port plan API is down: still a well-formed 200 with unavailable cards.
    const operator = await fetch(url, { headers: app.bearer("operator") });
    expect(operator.status).toBe(200);
    const body = await operator.json();
    expect(body.roots.map((r: { status: string }) => r.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable"
    ]);

    await app.pair(page);
    await refresh(page);
    await expect(page.locator("details[data-root]")).toHaveCount(3);
    await expect(page.locator("#execView")).toContainText("unavailable (");
    await expect(page.locator("#execStale")).toBeHidden();
  });
});

test.describe("executive overview not opted in", () => {
  test("is absent and its route is closed", async ({ page, app }) => {
    await app.pair(page);
    await expect(page.locator("#executiveOverview")).toHaveCount(0);
    const res = await fetch(`${app.url}${OVERVIEW}`, { headers: app.bearer("operator") });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "EXECUTIVE_OVERVIEW_DISABLED" });
  });
});
