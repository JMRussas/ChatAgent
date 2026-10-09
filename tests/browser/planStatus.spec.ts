import type { Page } from "@playwright/test";
import { test, expect } from "./fixture";

const ROOT = "11111111-2222-4333-8444-555555555555";
const OTHER_ROOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HOSTILE = '<img src=x onerror="window.__pwned=1"><b>bold</b>';

function leaf(over: Record<string, unknown> = {}) {
  return {
    nodeId: "n1",
    name: "Leaf one",
    state: "ready",
    executionAcknowledged: "unknown",
    gatesHold: true,
    upstreamChanged: false,
    attemptPins: "none",
    scope: "src/a.ts",
    contentRevision: 3,
    stateRevision: 4,
    attemptId: null,
    attemptEpoch: 0,
    executorRef: null,
    artifactRef: null,
    acceptance: null,
    blockers: [],
    ...over
  };
}

function plan(leaves: unknown[], state = "ready", root = ROOT) {
  return {
    status: "ok",
    rootId: root,
    progress: { state, rootCompletion: "incomplete", rootAcceptance: "none", leafCounts: {} },
    leaves
  };
}

interface Stubbed {
  status: number;
  body: unknown;
}

/** Answers the browser's plan requests locally; nothing reaches a server or Hekate. */
async function stubPlans(page: Page, initial: Stubbed) {
  const seen: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const state = { next: initial };
  await page.route("**/development/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.push({
      method: request.method(),
      path: url.pathname + url.search,
      headers: request.headers()
    });
    const { status, body } = state.next;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
  });
  return { seen, answer: (next: Stubbed) => void (state.next = next) };
}

async function load(page: Page, root = ROOT) {
  await page.locator("#planStatusPanel").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.locator("#planRoot").fill(root);
  await page.locator("#planRefresh").click();
}

test.describe("plan status disabled", () => {
  test("is absent and the route is closed when no plan API is configured", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await expect(page.locator("#planStatusPanel")).toHaveCount(0);
    await expect(page.locator("#planRoot")).toHaveCount(0);
    const res = await fetch(`${app.url}/development/plans/${ROOT}/status`, {
      headers: app.bearer("operator")
    });
    expect(res.status).toBe(404);
  });
});

test.describe("plan status enabled", () => {
  test.use({ planStatus: true });

  test("the real route refuses missing and client-only credentials before any upstream read", async ({
    app
  }) => {
    const url = `${app.url}/development/plans/${ROOT}/status`;
    expect((await fetch(url)).status).toBe(401);
    const client = await fetch(url, { headers: app.bearer("client") });
    expect(client.status).toBe(403);
    expect(await client.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
  });

  test("a paired browser session reaches the route with its cookie alone", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/development/"))
        requests.push(`${req.method()} ${req.headers().authorization ?? ""}`);
    });
    await load(page);
    // The unreachable fixture upstream yields 503, which proves the operator role was
    // accepted (a 403 would read "Operator access required").
    await expect(page.locator("#planStatusNote")).toContainText(
      "Plan status unavailable (reason: "
    );
    await expect(page.locator("#planStatusNote")).not.toContainText("Operator access required");
    expect(requests).toEqual(["GET "]);
  });

  test("renders a plan and only issues GET requests for the exact status path", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const stub = await stubPlans(page, {
      status: 200,
      body: plan(
        [
          leaf({ nodeId: "n1", name: "Build core", state: "ready" }),
          leaf({
            nodeId: "n2",
            name: "Wire UI",
            state: "blocked",
            blockers: [
              {
                ownerId: "n2",
                predecessorId: "n1",
                gate: "accepted",
                reason: "not accepted",
                predecessorName: "Build core"
              }
            ]
          }),
          leaf({
            nodeId: "n3",
            state: "in_progress",
            attemptPins: "current",
            attemptId: "attempt-7",
            attemptEpoch: 2,
            executorRef: "exec-1"
          })
        ],
        "active"
      )
    });
    await load(page);
    const view = page.locator("#planStatusView");
    await expect(view).toContainText("Build core");
    await expect(view).toContainText("waits on Build core (not accepted)");
    await expect(view).toContainText("Allocated/in progress (recorded state)");
    await expect(view).toContainText("Worker start: unknown");
    await expect(view).toContainText("Liveness and useful progress: not reported");
    await expect(view).toContainText("attempt-7");
    await expect(view).not.toContainText(/alive|running|healthy/i);
    await expect(view.locator("a, button, input, form")).toHaveCount(0);
    await page.locator("#planRefresh").click();
    await expect.poll(() => stub.seen.length).toBe(2);
    for (const request of stub.seen) {
      expect(request.method).toBe("GET");
      expect(request.path).toBe(`/development/plans/${ROOT}/status`);
      expect(request.headers.authorization).toBeUndefined();
    }
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  test("renders hostile response fields as inert text", async ({ page, app }) => {
    await app.pair(page);
    await stubPlans(page, {
      status: 200,
      body: plan([
        leaf({
          name: HOSTILE,
          scope: HOSTILE,
          executorRef: HOSTILE,
          artifactRef: HOSTILE,
          state: "blocked",
          blockers: [
            {
              ownerId: "n1",
              predecessorId: "n0",
              gate: "g",
              reason: HOSTILE,
              predecessorName: HOSTILE
            }
          ]
        })
      ])
    });
    await load(page);
    const view = page.locator("#planStatusView");
    await expect(view).toContainText(HOSTILE.slice(0, 40));
    await expect(view.locator("img, b, script")).toHaveCount(0);
    await expect(view.locator("[href], [src], [onerror]")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
  });

  test("does not call an older attempt's decision acceptance", async ({ page, app }) => {
    await app.pair(page);
    await stubPlans(page, {
      status: 200,
      body: plan(
        [
          leaf({
            state: "review_pending",
            acceptanceHistorical: true,
            acceptance: { decision: "accepted" }
          })
        ],
        "awaiting_review"
      )
    });
    await load(page);
    const view = page.locator("#planStatusView");
    await expect(view).toContainText(
      "Awaiting review — prior decision from an older attempt (historical)"
    );
    await expect(view).not.toContainText(/accepted/i);
  });

  test("refusals are explained and never echo response text", async ({ page, app }) => {
    await app.pair(page);
    const stub = await stubPlans(page, {
      status: 403,
      body: { code: "OPERATOR_REQUIRED", error: HOSTILE }
    });
    const note = page.locator("#planStatusNote");
    await load(page);
    await expect(note).toHaveText("Operator access required to view plan status.");
    stub.answer({ status: 503, body: { code: "PLAN_STATUS_UNAVAILABLE", reason: HOSTILE } });
    await page.locator("#planRefresh").click();
    await expect(note).toHaveText("Plan status unavailable (reason: unrecognized).");
    stub.answer({ status: 503, body: { code: "PLAN_STATUS_UNAVAILABLE", reason: "TIMEOUT" } });
    await page.locator("#planRefresh").click();
    await expect(note).toHaveText("Plan status unavailable (reason: TIMEOUT).");
    stub.answer({ status: 404, body: { code: "PLAN_STATUS_DISABLED" } });
    await page.locator("#planRefresh").click();
    await expect(note).toHaveText("Plan status is not configured.");
    await expect(page.locator("#planStatusView")).toBeEmpty();
    await page.locator("#planRoot").fill("NOT-A-GUID");
    const before = stub.seen.length;
    await page.locator("#planRefresh").click();
    await expect(note).toHaveText("Invalid plan root.");
    expect(stub.seen.length).toBe(before);
  });

  test("keeps the last good view under a stale banner when a refresh fails", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const stub = await stubPlans(page, { status: 200, body: plan([leaf({ name: "Kept leaf" })]) });
    await load(page);
    const view = page.locator("#planStatusView");
    const banner = page.locator("#planStatusStale");
    await expect(view).toContainText("Kept leaf");
    await expect(banner).toBeHidden();
    stub.answer({ status: 503, body: { code: "PLAN_STATUS_UNAVAILABLE", reason: "UNAVAILABLE" } });
    await page.locator("#planRefresh").click();
    await expect(banner).toContainText("Last successful read at ");
    await expect(banner).toContainText("browser clock, not Hekate's");
    await expect(banner).toContainText("now unavailable");
    await expect(view).toContainText("Kept leaf");
    stub.answer({ status: 200, body: plan([leaf({ name: "Fresh leaf" })]) });
    await page.locator("#planRefresh").click();
    await expect(view).toContainText("Fresh leaf");
    await expect(banner).toBeHidden();
  });

  test("scopes the view and the stored root to the conversation, across reload", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const stub = await stubPlans(page, { status: 200, body: plan([leaf({ name: "Scope A" })]) });
    await load(page);
    await expect(page.locator("#planStatusView")).toContainText("Scope A");
    await page.locator("#conversationId").fill("conv-b");
    await page.locator("#conversationId").dispatchEvent("change");
    await expect(page.locator("#planStatusView")).toBeEmpty();
    await expect(page.locator("#planRoot")).toHaveValue("");
    stub.answer({ status: 200, body: plan([leaf({ name: "Scope B" })], "ready", OTHER_ROOT) });
    await load(page, OTHER_ROOT);
    await expect(page.locator("#planStatusView")).toContainText("Scope B");
    const requests = stub.seen.length;
    await page.reload();
    await expect(page.locator("#conversationId")).toHaveValue("conv-b");
    await expect(page.locator("#planRoot")).toHaveValue(OTHER_ROOT);
    await expect(page.locator("#planStatusView")).toBeEmpty();
    await page.locator("#conversationId").fill("conv-ui-demo");
    await page.locator("#conversationId").dispatchEvent("change");
    await expect(page.locator("#planRoot")).toHaveValue(ROOT);
    expect(stub.seen.length).toBe(requests);
    const stored = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith("chatagent-plan-root:"))
    );
    expect(stored.map(([, value]) => value).sort()).toEqual([ROOT, OTHER_ROOT].sort());
  });

  test("discards a read that finishes after the conversation changed", async ({ page, app }) => {
    await app.pair(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/development/**", async (route) => {
      await gate;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(plan([leaf({ name: "Late old scope" })]))
        })
        .catch(() => undefined);
    });
    await load(page);
    await expect(page.locator("#planRefresh")).toBeDisabled();
    await page.locator("#conversationId").fill("conv-elsewhere");
    await page.locator("#conversationId").dispatchEvent("change");
    await expect(page.locator("#planRefresh")).toBeEnabled();
    release();
    await page.waitForTimeout(200);
    await expect(page.locator("#planStatusView")).toBeEmpty();
  });

  test("caps rendered leaves and refuses an oversized response", async ({ page, app }) => {
    await app.pair(page);
    const many = Array.from({ length: 250 }, (_, i) =>
      leaf({ nodeId: `n${i}`, name: `Leaf ${i}` })
    );
    const stub = await stubPlans(page, { status: 200, body: plan(many) });
    await load(page);
    const view = page.locator("#planStatusView");
    await expect(view).toContainText("50 more not shown");
    await expect(view.locator("article")).toHaveCount(200);
    stub.answer({
      status: 200,
      body: JSON.stringify(plan([leaf({ name: "z".repeat(1024 * 1024) })]))
    });
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusNote")).toHaveText(
      "Plan status response is too large to display."
    );
    await expect(page.locator("#planStatusStale")).toContainText("now unavailable");
  });

  test("aborts a read that exceeds the client deadline", async ({ page, app }) => {
    await app.pair(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/development/**", async (route) => {
      await gate;
      await route.abort().catch(() => undefined);
    });
    await page.clock.install();
    await load(page);
    await expect(page.locator("#planRefresh")).toBeDisabled();
    await page.clock.fastForward(10_000);
    await expect(page.locator("#planStatusNote")).toHaveText("Plan status request timed out.");
    await expect(page.locator("#planRefresh")).toBeEnabled();
    release();
  });
});
