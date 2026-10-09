import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixture";

const TASK = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ROOT = "11111111-2222-4333-8444-555555555555";
const OTHER_ROOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LID = "a".repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOSTILE = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
const OPEN_BOTH = () => {
  for (const id of ["planStatusPanel", "planRunControls"])
    (document.getElementById(id) as HTMLDetailsElement).open = true;
};

function host(over: Record<string, unknown> = {}, root = ROOT) {
  return {
    rootId: root,
    journal: {
      unresolvedIntent: false,
      uncertainLaunch: false,
      uncertainStop: false,
      malformedRecords: 0
    },
    host: "attached",
    lifecycle: "running",
    liveness: "running",
    phase: null,
    state: null,
    stopReason: null,
    launchId: LID,
    startedAt: null,
    heartbeatAt: "2026-10-08T10:00:00+00:00",
    exitedAt: null,
    current: null,
    counters: null,
    stopRequested: false,
    ...over
  };
}

function plan(leaves: unknown[], state = "active") {
  return {
    status: "ok",
    rootId: ROOT,
    progress: { state, rootCompletion: "incomplete", rootAcceptance: "none", leafCounts: {} },
    leaves
  };
}

function leaf(over: Record<string, unknown> = {}) {
  return {
    nodeId: TASK,
    name: "Leaf one",
    state: "in_progress",
    executionAcknowledged: "unknown",
    gatesHold: true,
    upstreamChanged: false,
    attemptPins: "current",
    scope: "src/a.ts",
    contentRevision: 3,
    stateRevision: 4,
    attemptId: "at-1",
    attemptEpoch: 1,
    executorRef: null,
    artifactRef: null,
    acceptance: null,
    blockers: [],
    ...over
  };
}

interface Seen {
  method: string;
  path: string;
  body: string | null;
}
type Handler = (seen: Seen, route: Route) => Promise<void> | void;

/** Answers every plan and dispatch request locally; nothing reaches a server or Hekate. */
async function stub(
  page: Page,
  handlers: { status?: Handler; check?: Handler; launch?: Handler; stop?: Handler }
) {
  const seen: Seen[] = [];
  await page.route("**/development/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const entry = {
      method: request.method(),
      path: url.pathname + url.search,
      body: request.postData()
    };
    seen.push(entry);
    const which = url.pathname.endsWith("/status")
      ? "status"
      : url.pathname.endsWith("/launch")
        ? "launch"
        : url.pathname.endsWith("/stop")
          ? "stop"
          : "check";
    const handler = handlers[which];
    if (!handler)
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    await handler(entry, route);
  });
  return seen;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const operationOf = (seen: Seen) =>
  (JSON.parse(seen.body ?? "{}") as { operationId: string }).operationId;
const posts = (seen: Seen[]) => seen.filter((s) => s.method === "POST");

async function open(page: Page, root = ROOT) {
  await page.evaluate(OPEN_BOTH);
  await page.locator("#planRoot").fill(root);
}
async function changeScope(page: Page, id: "userId" | "conversationId", value: string) {
  await page.evaluate(
    ([target, next]) => {
      const input = document.getElementById(target) as HTMLInputElement;
      input.value = next;
      input.dispatchEvent(new Event("change"));
    },
    [id, value]
  );
}

test.describe("plan run controls absent", () => {
  test("status alone, or a host without status, shows no controls and keeps the old page", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await expect(page.locator("#planRunControls")).toHaveCount(0);
    await expect(page.locator("#planHostStart")).toHaveCount(0);
  });

  test.describe("host without plan status", () => {
    test.use({ planRunControls: true });
    test("is not displayed", async ({ page, app }) => {
      await app.pair(page);
      await expect(page.locator("#planRunControls")).toHaveCount(0);
    });
  });

  test.describe("plan status only", () => {
    test.use({ planStatus: true });
    test("keeps the read-only panel and answers the dispatch route as disabled", async ({
      page,
      app
    }) => {
      await app.pair(page);
      await expect(page.locator("#planStatusPanel")).toHaveCount(1);
      await expect(page.locator("#planRunControls")).toHaveCount(0);
      const res = await fetch(`${app.url}/development/plans/${ROOT}/dispatch`, {
        headers: app.bearer("operator")
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("DISPATCH_HOST_DISABLED");
    });
  });
});

test.describe("plan run controls enabled", () => {
  test.use({ planStatus: true, planRunControls: true });

  test("the real boundary refuses missing and client credentials before the host is touched", async ({
    app
  }) => {
    const base = `${app.url}/development/plans/${ROOT}/dispatch`;
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: app.bearer("client") })).status).toBe(403);
    const body = JSON.stringify({ operationId: "11111111-1111-4111-8111-111111111111" });
    for (const action of ["launch", "stop"]) {
      const headers = { "content-type": "application/json" };
      expect((await fetch(`${base}/${action}`, { method: "POST", headers, body })).status).toBe(
        401
      );
      expect(
        (
          await fetch(`${base}/${action}`, {
            method: "POST",
            headers: { ...headers, ...app.bearer("client") },
            body
          })
        ).status
      ).toBe(403);
    }
    // The operator reaches the adapter; its pins fail on the absent files and nothing runs.
    const operator = await fetch(base, { headers: app.bearer("operator") });
    expect(operator.status).toBe(409);
    expect(await operator.json()).toMatchObject({ code: "PIN_MISMATCH" });
  });

  test("the paired page shows the controls and sends nothing on load", async ({ page, app }) => {
    const seen = await stub(page, { check: (_s, r) => json(r, 200, host()) });
    await app.pair(page);
    await page.evaluate(OPEN_BOTH);
    await expect(page.getByRole("button", { name: "Check host" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start prepared plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request stop" })).toBeVisible();
    await page.waitForTimeout(300);
    expect(seen).toEqual([]);
  });

  test("Check host sends one exact GET and shows the recorded state as text", async ({
    page,
    app
  }) => {
    const seen = await stub(page, {
      check: (_s, r) =>
        json(
          r,
          200,
          host({
            current: { node: "bounded-plan-launch", nodeId: TASK, workerLiveness: "unknown" }
          })
        )
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunView")).toContainText("Host running");
    await expect(page.locator("#planRunView")).toContainText(LID);
    await expect(page.locator("#planRunView")).toContainText("not worker progress");
    await expect(page.locator("#planRunView")).toContainText("Worker liveness: unknown");
    expect(seen).toEqual([
      { method: "GET", path: `/development/plans/${ROOT}/dispatch`, body: null }
    ]);
  });

  test("Start sends exactly one literal POST with only an operation ID", async ({ page, app }) => {
    const seen = await stub(page, {
      launch: (s, r) =>
        json(r, 200, {
          code: "LAUNCHED",
          launchId: LID,
          host: "attached",
          operationId: operationOf(s),
          outcome: "launched"
        })
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostStart").click();
    await expect(page.locator("#planRunView")).toContainText("Launched; the host is attached");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe(`/development/plans/${ROOT}/dispatch/launch`);
    const body = JSON.parse(seen[0].body ?? "") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["operationId"]);
    expect(String(body.operationId)).toMatch(UUID);
    await expect(page.locator("#planRunView")).toContainText(String(body.operationId));
    await expect(page.locator("#planRunView")).toContainText(LID);
    await expect(page.locator("#planRunView")).toContainText(ROOT);
  });

  test("Stop is a request: it is not shown as stopped", async ({ page, app }) => {
    const seen = await stub(page, {
      stop: (s, r) =>
        json(r, 202, {
          code: "STOP_REQUESTED",
          state: "stop_requested",
          exited: false,
          graceful: true,
          operationId: operationOf(s),
          outcome: "stop_requested"
        }),
      check: (_s, r) => json(r, 200, host({ lifecycle: "stop_requested", stopRequested: true }))
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostStop").click();
    await expect(page.locator("#planRunNote")).toContainText("not proof the host stopped");
    expect(seen[0].path).toBe(`/development/plans/${ROOT}/dispatch/stop`);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunView")).toContainText(
      "Stop requested; the host is still running and has not stopped"
    );
  });

  test("distinguishes exited, unverified and awaiting review", async ({ page, app }) => {
    let answer: unknown = host({ lifecycle: "stopped", launchId: null });
    await stub(page, {
      check: (_s, r) => json(r, 200, answer),
      status: (_s, r) => json(r, 200, plan([leaf({ state: "review_pending" })], "awaiting_review"))
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("awaiting review");
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunView")).toContainText("Host exited: stopped");
    await expect(page.locator("#planRunView")).toContainText(
      "Plan status panel: awaiting review (separate from host state)"
    );
    answer = host({ lifecycle: "unverified", liveness: "unresponsive" });
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunView")).toContainText("unverified or unavailable");
  });

  test("correlates the status panel task and attempt without inferring progress", async ({
    page,
    app
  }) => {
    await stub(page, {
      status: (_s, r) => json(r, 200, plan([leaf()])),
      check: (_s, r) =>
        json(
          r,
          200,
          host({
            lifecycle: "dispatching",
            current: { node: "bounded-plan-launch", nodeId: TASK, workerLiveness: "unknown" }
          })
        )
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("Leaf one");
    await page.locator("#planHostCheck").click();
    const view = page.locator("#planRunView");
    await expect(view).toContainText(
      `Status panel task ${TASK}, attempt at-1 (matches host current task ID; separate observations)`
    );
    await expect(view).toContainText("Worker liveness: unknown");
    await expect(view).not.toContainText("progress is");
  });

  test("a duplicate click sends once and the controls stay disabled while busy", async ({
    page,
    app
  }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen = await stub(page, {
      launch: async (s, r) => {
        await gate;
        await json(r, 200, {
          code: "LAUNCHED",
          launchId: LID,
          host: "attached",
          operationId: operationOf(s),
          outcome: "launched"
        });
      }
    });
    await app.pair(page);
    await open(page);
    await page.evaluate(() => {
      const button = document.getElementById("planHostStart") as HTMLButtonElement;
      button.click();
      button.click();
    });
    await expect(page.locator("#planHostStart")).toBeDisabled();
    await expect(page.locator("#planHostStop")).toBeDisabled();
    await expect(page.locator("#planHostCheck")).toBeDisabled();
    release();
    await expect(page.locator("#planRunView")).toContainText("Launched");
    expect(posts(seen)).toHaveLength(1);
  });

  test("reload restores the last operation and sends nothing", async ({ page, app }) => {
    const seen = await stub(page, {
      status: (_s, r) => json(r, 200, plan([leaf()])),
      launch: (s, r) =>
        json(r, 200, {
          code: "LAUNCHED",
          launchId: LID,
          host: "attached",
          operationId: operationOf(s),
          outcome: "launched"
        })
    });
    await app.pair(page);
    await open(page);
    // Loading the status panel stores the root, which the reload restores.
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("Leaf one");
    await page.locator("#planHostStart").click();
    await expect(page.locator("#planRunView")).toContainText("Launched");
    const operationId = operationOf(posts(seen)[0]);
    const before = seen.length;
    const stored = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith("chatagent-plan-run:"))
    );
    expect(stored).toHaveLength(1);
    expect(stored[0][1].length).toBeLessThan(600);
    expect(Object.keys(JSON.parse(stored[0][1]) as object).sort()).toEqual([
      "at",
      "code",
      "kind",
      "launchId",
      "operationId",
      "outcome",
      "root",
      "v"
    ]);
    await page.reload();
    await page.evaluate(OPEN_BOTH);
    await expect(page.locator("#planRunView")).toContainText(operationId);
    await page.waitForTimeout(300);
    expect(seen).toHaveLength(before);
    expect(posts(seen)).toHaveLength(1);
  });

  test("a response for an earlier user, conversation or root is ignored", async ({ page, app }) => {
    // Each check is held by the stub, then answered after the scope changed.
    const waiting: Array<() => Promise<void>> = [];
    const seen = await stub(page, {
      check: (_s, r) => {
        waiting.push(() => json(r, 200, host({ launchId: "c".repeat(32) })));
      }
    });
    await app.pair(page);
    await open(page);
    for (const change of [
      () => changeScope(page, "conversationId", "conv-other"),
      () => changeScope(page, "userId", "user-other"),
      () => page.locator("#planRoot").fill(OTHER_ROOT)
    ]) {
      await page.locator("#planRoot").fill(ROOT);
      await page.locator("#planHostCheck").click();
      await expect(page.locator("#planHostCheck")).toBeDisabled();
      await change();
      await expect(page.locator("#planHostCheck")).toBeEnabled();
      await waiting
        .pop()?.()
        .catch(() => undefined);
      await page.waitForTimeout(100);
      await expect(page.locator("#planRunView")).not.toContainText("c".repeat(32));
      await expect(page.locator("#planRunNote")).not.toContainText("Host checked");
    }
    expect(posts(seen)).toHaveLength(0);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  test("a failed or unrecognized POST is unknown, is not retried and needs a host check", async ({
    page,
    app
  }) => {
    let mode: "abort" | "garbled" = "abort";
    const seen = await stub(page, {
      launch: (_s, r) =>
        mode === "abort" ? r.abort("failed") : r.fulfill({ status: 200, body: "not json" }),
      check: (_s, r) => json(r, 200, host({ lifecycle: "no_host", launchId: null }))
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostStart").click();
    await expect(page.locator("#planRunNote")).toContainText(
      "outcome is unknown and is not retried"
    );
    await expect(page.locator("#planRunUnknown")).toBeVisible();
    await expect(page.locator("#planHostStart")).toBeDisabled();
    await expect(page.locator("#planHostStop")).toBeDisabled();
    await page.waitForTimeout(500);
    expect(posts(seen)).toHaveLength(1);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunNote")).toContainText("Host checked");
    await expect(page.locator("#planHostStart")).toBeEnabled();
    // A new explicit click allocates a new operation; nothing reuses the unknown one.
    mode = "garbled";
    await page.locator("#planHostStart").click();
    await expect(page.locator("#planRunUnknown")).toBeVisible();
    expect(posts(seen)).toHaveLength(2);
    expect(operationOf(posts(seen)[0])).not.toBe(operationOf(posts(seen)[1]));
  });

  test("a 10 second timeout leaves the outcome unknown without a retry", async ({ page, app }) => {
    const seen = await stub(page, { launch: () => new Promise<void>(() => undefined) });
    await app.pair(page);
    await open(page);
    await page.clock.install();
    await page.locator("#planHostStart").click();
    await expect(page.locator("#planHostStart")).toBeDisabled();
    await page.clock.fastForward(10_500);
    await expect(page.locator("#planRunNote")).toContainText("timed out");
    await expect(page.locator("#planRunUnknown")).toBeVisible();
    await page.clock.fastForward(30_000);
    expect(posts(seen)).toHaveLength(1);
  });

  test("a refusal such as a client credential is reported without marking the outcome unknown", async ({
    page,
    app
  }) => {
    await stub(page, { check: (_s, r) => json(r, 403, { code: "OPERATOR_REQUIRED" }) });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunNote")).toContainText("Operator access required");
    await expect(page.locator("#planRunUnknown")).toBeHidden();
  });

  test("an unsupported projection is refused rather than guessed", async ({ page, app }) => {
    await stub(page, { check: (_s, r) => json(r, 200, host({ lifecycle: "teleporting" })) });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunNote")).toContainText("not a supported projection");
    await expect(page.locator("#planRunView")).toContainText("Host not checked");
  });

  test("a projection for another root is refused", async ({ page, app }) => {
    await stub(page, { check: (_s, r) => json(r, 200, host({}, OTHER_ROOT)) });
    await app.pair(page);
    await open(page);
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunNote")).toContainText("not a supported projection");
  });

  test("hostile fields stay inert text", async ({ page, app }) => {
    await stub(page, {
      status: (_s, r) => json(r, 200, plan([leaf({ nodeId: HOSTILE, attemptId: HOSTILE })])),
      check: (_s, r) =>
        json(
          r,
          200,
          host({ stopReason: HOSTILE, current: { node: HOSTILE, workerLiveness: "unknown" } })
        )
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("Leaf one");
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunNote")).toContainText("not a supported projection");
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
    await expect(page.locator("#planRunView img, #planRunView b")).toHaveCount(0);
  });

  test("hostile status panel text is shown as text beside a valid host", async ({ page, app }) => {
    await stub(page, {
      status: (_s, r) => json(r, 200, plan([leaf({ nodeId: HOSTILE, attemptId: HOSTILE })])),
      check: (_s, r) =>
        json(
          r,
          200,
          host({
            current: { node: "bounded-plan-launch", nodeId: TASK, workerLiveness: "unknown" }
          })
        )
    });
    await app.pair(page);
    await open(page);
    await page.locator("#planRefresh").click();
    await page.locator("#planHostCheck").click();
    await expect(page.locator("#planRunView")).toContainText("onerror");
    await expect(page.locator("#planRunView img, #planRunView b")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
  });
});
