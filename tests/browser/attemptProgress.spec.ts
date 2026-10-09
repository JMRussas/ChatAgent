import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixture";

const ROOT = "11111111-2222-4333-8444-555555555555";
const OTHER_ROOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NODE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const NODE2 = "cccccccc-dddd-4eee-8fff-000000000000";
const HOSTILE = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
const SHA = "a1".repeat(32);

function leaf(nodeId: string, name: string) {
  return {
    nodeId,
    name,
    state: "in_progress",
    executionAcknowledged: "unknown",
    gatesHold: true,
    upstreamChanged: false,
    attemptPins: "current",
    scope: "src/a.ts",
    contentRevision: 3,
    stateRevision: 4,
    attemptId: "at-1",
    attemptEpoch: 2,
    executorRef: null,
    artifactRef: null,
    acceptance: null,
    blockers: []
  };
}

function plan(leaves: unknown[], root = ROOT) {
  return {
    status: "ok",
    rootId: root,
    progress: {
      state: "active",
      rootCompletion: "incomplete",
      rootAcceptance: "none",
      leafCounts: {}
    },
    leaves
  };
}

const textItem = (traceSeq: number, text: string, index = 0) => ({
  traceSeq,
  index,
  kind: "text",
  text,
  textClipped: false
});

function progress(over: Record<string, unknown> = {}, nodeId = NODE, root = ROOT) {
  return {
    schema: "attempt-progress/v1",
    observedAt: "2026-10-08T12:00:00.000Z",
    rootId: root,
    nodeId,
    projectId: "99999999-8888-4777-8666-555555555555",
    consistency: "current",
    reasons: [],
    task: {
      work: "in_progress",
      stateRevision: 4,
      contentRevision: 3,
      attemptId: "at-1",
      attemptEpoch: 2,
      attemptContentRevision: 3,
      attemptPrereqDigest: null,
      effectiveAcceptance: "none"
    },
    selectedAttempt: {
      attemptId: "at-1",
      attemptEpoch: 2,
      scope: "current",
      sourceEventSeq: null,
      attemptContentRevision: 3,
      contentPins: "current"
    },
    trace: {
      status: "running",
      integrity: "verified",
      claimLinkage: "matched",
      recordCount: 3,
      firstSeq: 0,
      lastSeq: 2,
      pages: 1,
      capped: false,
      truncated: false,
      metadataStable: true,
      streams: { stdout: 3, stderr: 0, hekate: 0 },
      exitCode: null
    },
    acceptance: {
      source: "plan_store_recorded_decision",
      decision: "rejected",
      contentRevision: 3,
      attemptEpoch: 1,
      attemptId: "at-0",
      taskArtifact: { state: "shown", ref: "git:" + "a".repeat(40) },
      decisionArtifact: { state: "none" },
      evidence: { state: "shown", ref: "sha256:" + SHA }
    },
    evidence: [{ ref: 0, endpoint: `/api/plan-contract/v1/plans/${root}`, sha256: SHA }],
    assessment: { workerLiveness: "unknown", usefulProgress: "unknown", basis: "x" },
    activity: {
      trust: "untrusted_inert_unverified_worker_claims",
      source: "complete_stdout_claude_stream_json_assistant_records",
      items: [
        textItem(1, "I will fix the parser."),
        { traceSeq: 2, index: 0, kind: "tool_use", tool: "Edit" }
      ],
      totalItems: 2,
      omittedItems: 0,
      counts: {
        stdoutRecords: 3,
        assistantRecords: 2,
        otherRecords: 1,
        unavailableRecords: 0,
        withheldItems: 0
      },
      complete: true
    },
    ...over
  };
}

interface Stubbed {
  status: number;
  body: unknown;
}
interface Seen {
  method: string;
  path: string;
  authorizationHeaderPresent: boolean;
}
type ProgressAnswer = Stubbed | ((seen: Seen, count: number) => Promise<Stubbed> | Stubbed);

/** Answers the browser's plan and progress requests locally; nothing reaches Hekate. */
async function stub(page: Page, initialLeaves: unknown[], answer: ProgressAnswer) {
  const state = { leaves: initialLeaves, answer, root: ROOT };
  const progressSeen: Seen[] = [];
  const statusSeen: Seen[] = [];
  const respond = (route: Route, out: Stubbed) =>
    route
      .fulfill({
        status: out.status,
        contentType: "application/json",
        body: typeof out.body === "string" ? out.body : JSON.stringify(out.body)
      })
      .catch(() => undefined);
  await page.route("**/development/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const seen = {
      method: request.method(),
      path: url.pathname + url.search,
      authorizationHeaderPresent: request.headers().authorization !== undefined
    };
    if (url.pathname.endsWith("/progress")) {
      progressSeen.push(seen);
      const a = state.answer;
      return respond(route, typeof a === "function" ? await a(seen, progressSeen.length) : a);
    }
    statusSeen.push(seen);
    return respond(route, { status: 200, body: plan(state.leaves, url.pathname.split("/")[3]) });
  });
  return {
    progressSeen,
    statusSeen,
    answer: (next: ProgressAnswer) => void (state.answer = next),
    setLeaves: (leaves: unknown[]) => void (state.leaves = leaves)
  };
}

async function showPlan(page: Page, root = ROOT) {
  await page.locator("#planStatusPanel").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.locator("#attemptProgress").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.locator("#planRoot").fill(root);
  await page.locator("#planRefresh").click();
  await expect(page.locator("#planStatusView article").first()).toBeVisible();
}

async function pick(page: Page, node: string) {
  // Focusing the list refreshes its options from the plan status shown above.
  await page.locator("#progressTask").focus();
  await page.locator("#progressTask").selectOption(node);
}

/** Installs a controllable clock so watch pauses and deadlines advance only on request. */
async function freezeClock(page: Page) {
  const frozen = new Date();
  await page.clock.install({ time: frozen });
  await page.clock.pauseAt(frozen.getTime() + 1);
}

const view = (page: Page) => page.locator("#progressView");
const note = (page: Page) => page.locator("#progressNote");
const read = (page: Page) => page.locator("#progressRead").click();

test.describe("attempt progress not opted in", () => {
  test.use({ planStatus: true });

  test("is absent and its route is closed", async ({ page, app }) => {
    await app.pair(page);
    await expect(page.locator("#planStatusPanel")).toHaveCount(1);
    await expect(page.locator("#attemptProgress")).toHaveCount(0);
    await expect(page.locator("#progressTask")).toHaveCount(0);
    const res = await fetch(`${app.url}/development/plans/${ROOT}/nodes/${NODE}/progress`, {
      headers: app.bearer("operator")
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_DISABLED" });
  });
});

test.describe("attempt progress enabled", () => {
  test.use({ planStatus: true, attemptProgress: true });

  test("the real route is operator-only and a paired session reaches it with its cookie", async ({
    page,
    app
  }) => {
    const url = `${app.url}/development/plans/${ROOT}/nodes/${NODE}/progress`;
    expect((await fetch(url)).status).toBe(401);
    const client = await fetch(url, { headers: app.bearer("client") });
    expect(client.status).toBe(403);
    expect(await client.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    // The operator passes policy; the discard-port fixture upstream is simply unavailable.
    const operator = await fetch(url, { headers: app.bearer("operator") });
    expect(operator.status).toBe(503);
    expect(await operator.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_UNAVAILABLE" });

    await app.pair(page);
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith("/progress"))
        requests.push(`${req.method()} ${req.headers().authorization ?? ""}`);
    });
    // Only the plan status is stubbed; the progress request reaches the real server.
    await page.route("**/development/plans/*/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(plan([leaf(NODE, "Leaf")]))
      })
    );
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect(note(page)).toContainText("Attempt progress unavailable (reason: ");
    await expect(note(page)).not.toContainText("Operator access required");
    expect(requests).toEqual(["GET "]);
  });

  test("sends nothing on load, selection, scope change or reload", async ({ page, app }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await expect(page.locator("#progressRead")).toHaveText("Read attempt progress");
    await expect(page.locator("#progressWatch")).toHaveText("Watch briefly");
    await expect(page.locator("#progressStop")).toHaveText("Stop watching");
    await expect(page.locator("#progressStop")).toBeDisabled();
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#conversationId").fill("conv-b");
    await page.locator("#conversationId").dispatchEvent("change");
    await page.locator("#conversationId").fill("conv-ui-demo");
    await page.locator("#conversationId").dispatchEvent("change");
    await page.reload();
    await expect(page.locator("#planRoot")).toHaveValue(ROOT);
    await page.waitForTimeout(300);
    expect(s.progressSeen).toEqual([]);
  });

  test("reads the selected task once with a plain GET and shows exact bindings, claims and review apart", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf"), leaf(NODE2, "Other")], {
      status: 200,
      body: progress()
    });
    await showPlan(page);
    await expect(page.locator("#progressTask option")).toHaveCount(3);
    await pick(page, NODE);
    await read(page);
    await expect(note(page)).toHaveText("Attempt progress read (read-only).");
    expect(s.progressSeen).toHaveLength(1);
    expect(s.progressSeen[0].method).toBe("GET");
    expect(s.progressSeen[0].path).toBe(`/development/plans/${ROOT}/nodes/${NODE}/progress`);
    expect(s.progressSeen[0].authorizationHeaderPresent).toBe(false);
    const v = view(page);
    await expect(v).toContainText("Observed at 2026-10-08T12:00:00.000Z (ChatAgent server clock)");
    await expect(v).toContainText(`Task: ${NODE}`);
    await expect(v).toContainText("Attempt: at-1");
    await expect(v).toContainText("Attempt epoch: 2");
    await expect(v).toContainText("This is the task's current attempt.");
    await expect(v).toContainText("Content pins: current");
    await expect(v).toContainText(
      "Claim linkage (cross-source correlation, not authentication): matched"
    );
    await expect(v).toContainText("Worker liveness: unknown. Useful progress: unknown.");
    await expect(v).toContainText("is not evidence of useful progress");
    // The recorded review decision is its own section, with its own attempt and epoch.
    const review = v.locator("h4", { hasText: "Recorded review decision" });
    await expect(review).toBeVisible();
    await expect(v).toContainText("Decision: rejected");
    await expect(v).toContainText("Decision attempt: at-0");
    await expect(v).toContainText("Task artifact: git:" + "a".repeat(40));
    await expect(v).toContainText("Evidence reference: sha256:" + SHA);
    await expect(v).toContainText("Verifier result: not reported by this view.");
    await expect(v).toContainText(`sha256 ${SHA}`);
    // Worker statements are claims in a separate section after the decision.
    const claims = v.locator("h4", { hasText: "Worker statements (untrusted, unverified claims)" });
    await expect(claims).toBeVisible();
    await expect(v).toContainText("Worker said (claim): I will fix the parser.");
    await expect(v).toContainText("Worker named tool: Edit (inputs and results not shown)");
    const order = await v.locator("h4").allTextContents();
    expect(order.findIndex((t) => t.includes("Recorded review decision"))).toBeLessThan(
      order.findIndex((t) => t.includes("Worker statements"))
    );
  });

  test("shows a historical attempt as such and incomplete activity without proof of absence", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await stub(page, [leaf(NODE, "Leaf")], {
      status: 200,
      body: progress({
        consistency: "partial",
        reasons: ["trace_truncated"],
        selectedAttempt: {
          attemptId: "at-old",
          attemptEpoch: 1,
          scope: "historical",
          sourceEventSeq: 9,
          attemptContentRevision: 2,
          contentPins: "stale"
        },
        activity: {
          trust: "untrusted_inert_unverified_worker_claims",
          source: "x",
          items: [],
          totalItems: 0,
          omittedItems: 0,
          counts: { unavailableRecords: 4 },
          complete: false
        }
      })
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    const v = view(page);
    await expect(v).toContainText("Historical attempt: the task has no current attempt");
    await expect(v).toContainText("Attempt: at-old");
    await expect(v).toContainText("Named by event: 9");
    await expect(v).toContainText("Content pins: stale");
    await expect(v).toContainText("This snapshot is partial");
    await expect(v).toContainText("Reasons: trace_truncated");
    await expect(v).toContainText("4 output records were unavailable");
    await expect(v).toContainText("absence of a statement proves nothing");
    await expect(v).toContainText("No public worker statements were found");
  });

  test("renders hostile server text inertly", async ({ page, app }) => {
    await app.pair(page);
    await stub(page, [leaf(NODE, "Leaf")], {
      status: 200,
      body: progress({
        task: { ...progress().task, attemptId: HOSTILE },
        acceptance: {
          ...progress().acceptance,
          taskArtifact: { state: "shown", ref: HOSTILE }
        },
        activity: {
          ...progress().activity,
          items: [textItem(1, HOSTILE), { traceSeq: 2, index: 0, kind: "tool_use", tool: HOSTILE }]
        }
      })
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    const v = view(page);
    await expect(v).toContainText(`Worker said (claim): ${HOSTILE}`);
    await expect(v).toContainText(`Task attempt: ${HOSTILE}`);
    await expect(v.locator("img, b, script")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
  });

  test("clips long text and bounds listed items", async ({ page, app }) => {
    await app.pair(page);
    const items = Array.from({ length: 60 }, (_, i) => textItem(i, `statement ${i}`));
    items[0] = textItem(0, "z".repeat(5000));
    await stub(page, [leaf(NODE, "Leaf")], {
      status: 200,
      body: progress({ activity: { ...progress().activity, items, totalItems: 60 } })
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    const rows = view(page).locator("p", { hasText: "Worker said (claim): " });
    await expect(rows).toHaveCount(20);
    const first = (await rows.first().textContent()) ?? "";
    expect(first.length).toBeLessThan(500);
  });

  test("marks items new only against the previous snapshot, which each read replaces", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect(view(page)).not.toContainText("new since the previous read");
    s.answer({
      status: 200,
      body: progress({
        activity: {
          ...progress().activity,
          items: [textItem(1, "I will fix the parser."), textItem(5, "Added a test.")]
        }
      })
    });
    await read(page);
    await expect(view(page)).toContainText(
      "(new since the previous read) Worker said (claim): Added a test."
    );
    await expect(view(page)).not.toContainText(
      "(new since the previous read) Worker said (claim): I will fix"
    );
    // A snapshot that no longer lists a statement does not keep the old one.
    s.answer({ status: 200, body: progress({ activity: { ...progress().activity, items: [] } }) });
    await read(page);
    await expect(view(page)).not.toContainText("Added a test.");
  });

  test("a failed refresh keeps the previous snapshot under a historical banner", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect(view(page)).toContainText("Worker said (claim): I will fix the parser.");
    const banner = page.locator("#progressStale");
    await expect(banner).toBeHidden();
    s.answer({
      status: 503,
      body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "UNAVAILABLE" }
    });
    await read(page);
    await expect(note(page)).toHaveText(
      "Attempt progress unavailable (reason: UNAVAILABLE). Nothing was restarted."
    );
    await expect(banner).toContainText("Last successful read at ");
    await expect(banner).toContainText("observation time 2026-10-08T12:00:00.000Z");
    await expect(banner).toContainText("historical, not current state");
    await expect(view(page)).toContainText("Worker said (claim): I will fix the parser.");
    s.answer({ status: 200, body: progress() });
    await read(page);
    await expect(banner).toBeHidden();
  });

  test("explains refusals without echoing response text and clears when there is no snapshot", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], {
      status: 403,
      body: { code: "OPERATOR_REQUIRED", error: HOSTILE }
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect(note(page)).toHaveText("Operator access required to read attempt progress.");
    s.answer({ status: 503, body: { code: "X", reason: HOSTILE } });
    await read(page);
    await expect(note(page)).toHaveText(
      "Attempt progress unavailable (reason: unrecognized). Nothing was restarted."
    );
    s.answer({ status: 404, body: { code: "NODE_NOT_FOUND" } });
    await read(page);
    await expect(note(page)).toContainText("not available");
    s.answer({ status: 200, body: progress({}, NODE2) });
    await read(page);
    await expect(note(page)).toHaveText("Attempt progress response was not recognized.");
    s.answer({ status: 200, body: progress({}, NODE, OTHER_ROOT) });
    await read(page);
    await expect(note(page)).toHaveText("Attempt progress response was not recognized.");
    await expect(view(page)).toBeEmpty();
    await expect(page.locator("#progressStale")).toBeHidden();
    expect(JSON.stringify(await page.locator("#progressNote").textContent())).not.toContain("img");
  });

  test("refuses an oversized response", async ({ page, app }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    s.answer({ status: 200, body: JSON.stringify(progress({ padding: "z".repeat(1024 * 1024) })) });
    await read(page);
    await expect(note(page)).toHaveText("Attempt progress response is too large to display.");
    await expect(page.locator("#progressStale")).toContainText("historical");
  });

  test("clears a selection whose task is no longer displayed and sends nothing", async ({
    page,
    app
  }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    s.setLeaves([leaf(NODE2, "Replacement")]);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("Replacement");
    await read(page);
    await expect(page.locator("#progressTask")).toHaveValue("");
    await expect(note(page)).toHaveText("Select a task shown in the plan status.");
    expect(s.progressSeen).toEqual([]);
  });

  test("needs the plan status for the same root before any read", async ({ page, app }) => {
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#planRoot").fill(OTHER_ROOT);
    await read(page);
    await expect(note(page)).toContainText("Load the plan status for this root first");
    await expect(page.locator("#progressTask")).toHaveValue("");
    expect(s.progressSeen).toEqual([]);
  });

  test("watches briefly: six reads at five second pauses, one at a time, then stops", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await freezeClock(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#progressWatch").click();
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await expect(note(page)).toHaveText("Attempt progress read (read-only).");
    await expect(page.locator("#progressRead")).toBeDisabled();
    await expect(page.locator("#progressWatch")).toBeDisabled();
    await expect(page.locator("#progressStop")).toBeEnabled();
    await page.waitForTimeout(100);
    await page.clock.fastForward(4_900);
    await page.waitForTimeout(100);
    expect(s.progressSeen).toHaveLength(1);
    for (let count = 2; count <= 6; count++) {
      await page.clock.fastForward(100);
      await expect.poll(() => s.progressSeen.length).toBe(count);
      await page.waitForTimeout(100);
      if (count < 6) await page.clock.fastForward(4_900);
    }
    await expect(note(page)).toHaveText("Watching finished after 6 reads.");
    await expect(page.locator("#progressRead")).toBeEnabled();
    await expect(page.locator("#progressWatch")).toBeEnabled();
    await expect(page.locator("#progressStop")).toBeDisabled();
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(100);
    expect(s.progressSeen).toHaveLength(6);
  });

  test("never overlaps reads: a slow read times out, stops the watch and is not retried", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await freezeClock(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = await stub(page, [leaf(NODE, "Leaf")], async () => {
      await gate;
      return { status: 200, body: progress() };
    });
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#progressWatch").click();
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await page.clock.fastForward(9_000);
    expect(s.progressSeen).toHaveLength(1);
    await page.clock.fastForward(1_500);
    await expect(note(page)).toContainText("Attempt progress request timed out.");
    await expect(note(page)).toContainText("Watching stopped; nothing is retried.");
    await page.clock.fastForward(60_000);
    release();
    await page.waitForTimeout(150);
    expect(s.progressSeen).toHaveLength(1);
    await expect(page.locator("#progressWatch")).toBeEnabled();
  });

  test("stops watching after an unavailable read and keeps the old snapshot marked historical", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await freezeClock(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], (_seen, count) =>
      count === 1
        ? { status: 200, body: progress() }
        : { status: 503, body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "HTTP_ERROR" } }
    );
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#progressWatch").click();
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await page.waitForTimeout(100);
    await page.clock.fastForward(5_000);
    await expect.poll(() => s.progressSeen.length).toBe(2);
    await expect(note(page)).toContainText("Attempt progress unavailable (reason: HTTP_ERROR)");
    await expect(note(page)).toContainText("Watching stopped; nothing is retried.");
    await expect(page.locator("#progressStale")).toContainText("historical");
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(100);
    expect(s.progressSeen).toHaveLength(2);
  });

  test("Stop watching cancels the pending cycle and an in-flight read", async ({ page, app }) => {
    await app.pair(page);
    await freezeClock(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], { status: 200, body: progress() });
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#progressWatch").click();
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await page.waitForTimeout(100);
    await page.locator("#progressStop").click();
    await expect(note(page)).toHaveText("Watching stopped.");
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(100);
    expect(s.progressSeen).toHaveLength(1);
    await expect(page.locator("#progressRead")).toBeEnabled();
    await expect(page.locator("#progressStop")).toBeDisabled();
  });

  const changes: Record<string, (page: Page) => Promise<void>> = {
    conversation: async (page) => {
      await page.locator("#conversationId").fill("conv-elsewhere");
      await page.locator("#conversationId").dispatchEvent("change");
    },
    user: async (page) => {
      await page.locator("#userId").fill("someone-else");
      await page.locator("#userId").dispatchEvent("change");
    },
    // fill() dispatches only `input`; the change event would come at blur.
    "conversation input (no change event)": async (page) => {
      await page.locator("#conversationId").fill("conv-typing");
    },
    "user input (no change event)": async (page) => {
      await page.locator("#userId").fill("someone-typing");
    },
    task: async (page) => {
      await page.locator("#progressTask").selectOption(NODE2);
    },
    root: async (page) => {
      await page.locator("#planRoot").fill(OTHER_ROOT);
    },
    pagehide: async (page) => {
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    }
  };
  for (const [name, change] of Object.entries(changes)) {
    test(`a ${name} change aborts the read and ignores its late response`, async ({
      page,
      app
    }) => {
      await app.pair(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const s = await stub(page, [leaf(NODE, "Leaf"), leaf(NODE2, "Other")], async () => {
        await gate;
        return { status: 200, body: progress() };
      });
      await showPlan(page);
      await pick(page, NODE);
      await read(page);
      await expect(page.locator("#progressRead")).toBeDisabled();
      await expect.poll(() => s.progressSeen.length).toBe(1);
      await change(page);
      await expect(page.locator("#progressRead")).toBeEnabled();
      release();
      await page.waitForTimeout(250);
      await expect(view(page)).toBeEmpty();
      await expect(note(page)).not.toHaveText("Attempt progress read (read-only).");
      expect(s.progressSeen).toHaveLength(1);
    });
  }

  test("shows a native Git SHA artifact and still withholds paths and secret-like refs", async ({
    page,
    app
  }) => {
    const NATIVE = "5c0ccb5a5190ffe323aa5ca7e593b6c549406092";
    await app.pair(page);
    const s = await stub(page, [leaf(NODE, "Leaf")], {
      status: 200,
      body: progress({
        acceptance: {
          ...progress().acceptance,
          taskArtifact: { state: "shown", ref: NATIVE },
          decisionArtifact: { state: "withheld" },
          evidence: { state: "withheld" }
        }
      })
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect(view(page)).toContainText(`Task artifact: ${NATIVE}`);
    await expect(view(page)).toContainText("Decision artifact: present but withheld");
    await expect(view(page)).toContainText("Evidence reference: present but withheld");
    expect(s.progressSeen).toHaveLength(1);
  });

  test("a status refresh to a new attempt epoch discards the held read; an explicit read shows the new attempt", async ({
    page,
    app
  }) => {
    await app.pair(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const next = {
      ...leaf(NODE, "Leaf"),
      attemptId: "at-2",
      attemptEpoch: 3
    };
    const s = await stub(page, [leaf(NODE, "Leaf")], async (_seen, count) => {
      if (count === 1) {
        await gate;
        return { status: 200, body: progress() };
      }
      return {
        status: 200,
        body: progress({
          task: { ...progress().task, attemptId: "at-2", attemptEpoch: 3 },
          selectedAttempt: { ...progress().selectedAttempt, attemptId: "at-2", attemptEpoch: 3 }
        })
      };
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect.poll(() => s.progressSeen.length).toBe(1);
    // Same task GUID, new attempt and epoch: the held response belongs to the old binding.
    s.setLeaves([next]);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planStatusView")).toContainText("Attempt: at-2");
    await expect(page.locator("#progressRead")).toBeEnabled();
    release();
    await page.waitForTimeout(250);
    await expect(view(page)).toBeEmpty();
    await expect(note(page)).not.toHaveText("Attempt progress read (read-only).");
    expect(s.progressSeen).toHaveLength(1);
    // Negative control: nothing is requested automatically, and an explicit read works.
    await pick(page, NODE);
    await read(page);
    await expect(view(page)).toContainText("Attempt: at-2");
    await expect(view(page)).toContainText("Attempt epoch: 3");
    expect(s.progressSeen).toHaveLength(2);
  });

  test("a status refresh that keeps the same attempt and epoch does not discard a held read", async ({
    page,
    app
  }) => {
    await app.pair(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = await stub(page, [leaf(NODE, "Leaf")], async () => {
      await gate;
      return { status: 200, body: progress() };
    });
    await showPlan(page);
    await pick(page, NODE);
    await read(page);
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await page.locator("#planRefresh").click();
    await expect(page.locator("#planRefresh")).toBeEnabled();
    release();
    await expect(note(page)).toHaveText("Attempt progress read (read-only).");
  });

  test("a task change during a watch stops it and clears the old snapshot", async ({
    page,
    app
  }) => {
    await app.pair(page);
    await freezeClock(page);
    const s = await stub(page, [leaf(NODE, "Leaf"), leaf(NODE2, "Other")], {
      status: 200,
      body: progress()
    });
    await showPlan(page);
    await pick(page, NODE);
    await page.locator("#progressWatch").click();
    await expect.poll(() => s.progressSeen.length).toBe(1);
    await expect(view(page)).toContainText("Observed at");
    await page.waitForTimeout(100);
    await page.locator("#progressTask").selectOption(NODE2);
    await expect(view(page)).toBeEmpty();
    await expect(page.locator("#progressStop")).toBeDisabled();
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(100);
    expect(s.progressSeen).toHaveLength(1);
  });
});
