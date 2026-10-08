import { evidenceCitationId } from "../../src/app/evidenceCitations";
import { test, expect } from "./fixture";
import type { Page } from "@playwright/test";
async function send(page: Page, prompt: string) {
  await page.locator("#prompt").fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

// Every test starts from a browser paired through the real /pair page.
test.beforeEach(async ({ page, app }) => {
  await app.pair(page);
});
test("direct draft streams with progress, then completes without a spinner", async ({
  page,
  app
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await send(page, "Explain event loops");
  const turn = page.locator(".turn").first();
  await expect(turn.locator(".answer-content")).toHaveText("Draft: Explain event loops");
  await expect(turn.locator(".assistant")).toHaveAttribute("aria-busy", "true");
  await expect(turn.locator(".activity-spinner")).toBeVisible();
  app.pending.get("fast:Explain event loops")!.finish();
  await expect(turn.locator(".answer-content")).toHaveText("Final: Explain event loops");
  await expect(turn.locator(".assistant")).toHaveAttribute("aria-busy", "false");
  await expect(turn.locator("summary")).toContainText("Simulation complete — facts not verified");
  await expect(turn.locator(".activity-spinner")).toBeHidden();
  expect(errors).toEqual([]);
});
test("deep queue, selected model and late chunks stay with their own overlapping turn", async ({
  page,
  app
}) => {
  app.controls.worker = false;
  await send(page, "Please cite sources for alpha");
  const first = page.locator(".turn").nth(0);
  await expect(first.locator("summary")).toContainText("Queued");
  app.controls.worker = true;
  await expect(first.locator("summary")).toContainText("browser-deep");
  await expect(page.locator("#sendButton")).toBeEnabled();
  await send(page, "Explain beta event loops");
  const second = page.locator(".turn").nth(1);
  await expect(second.locator(".answer-content")).toContainText("beta");
  await app.pending.get("deep:Please cite sources for alpha")!.emit("Alpha late chunk");
  await expect(first.locator(".answer-content").last()).toHaveText("Alpha late chunk");
  await expect(second).not.toContainText("Alpha late chunk");
  app.pending.get("fast:Explain beta event loops")!.finish();
  app.pending.get("deep:Please cite sources for alpha")!.finish();
  await expect(first.locator(".answer-content").last()).toHaveText(
    "Refined: Please cite sources for alpha"
  );
  await expect(second.locator(".answer-content")).toHaveText("Final: Explain beta event loops");
  await expect(page.locator('.assistant[aria-busy="true"]')).toHaveCount(0);
});
for (const [prompt, status] of [
  ["Test auth failure", "Failed"],
  ["Test quota failure", "Failed"],
  ["Test provider failure", "Failed"],
  ["Test length limit", "Incomplete"]
]) {
  test(`${prompt} terminates progress honestly`, async ({ page, app }) => {
    await send(page, prompt);
    await expect(page.locator(".answer-content")).toContainText("Draft:");
    app.pending.get(`fast:${prompt}`)!.finish();
    await expect(page.locator(".turn summary")).toContainText(status);
    await expect(page.locator(".assistant")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  });
}
test("keyboard submit/cancel, reduced motion and mobile layout", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#prompt").fill("Explain keyboard cancellation");
  await page.getByRole("button", { name: "Send", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".answer-content")).toContainText("Draft:");
  await expect(page.locator(".activity-spinner")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".reply-activity summary")).toHaveAttribute("aria-live", "polite");
  await page.getByRole("button", { name: "Stop", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".turn summary")).toContainText("Cancelled");
  await expect(page.locator(".assistant")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(app.pending.size).toBe(0);
});
test("SSE reconnect restores exact text and clears connection status", async ({ page, app }) => {
  await send(page, "Explain reconnect behavior");
  await expect(page.locator(".answer-content")).toHaveText("Draft: Explain reconnect behavior");
  app.disconnect();
  await expect(page.getByText("Live updates reconnecting", { exact: true })).toBeVisible();
  await app.pending.get("fast:Explain reconnect behavior")!.emit(" plus late text");
  await expect(page.locator(".answer-content")).toHaveText(
    "Draft: Explain reconnect behavior plus late text"
  );
  await expect(page.getByText("Live updates reconnecting", { exact: true })).toHaveCount(0);
  app.pending.get("fast:Explain reconnect behavior")!.finish();
  await expect(page.locator(".answer-content")).toHaveText("Final: Explain reconnect behavior");
});

test.describe("event stream capacity", () => {
  test.use({ streamCap: 1 });
  test("a stream refused at capacity is reopened by the page once a slot frees", async ({
    page,
    app
  }) => {
    await send(page, "Explain capacity");
    await expect(page.locator(".answer-content")).toHaveText("Draft: Explain capacity");
    // Server closes the page's stream; the holder takes the only slot before the
    // browser's own reconnect, which is then refused with 429 and closes for good.
    app.disconnect();
    const release = await app.holdStream();
    await expect(page.getByText("Live updates reconnecting", { exact: true })).toBeVisible();
    await app.pending.get("fast:Explain capacity")!.emit(" plus late text");
    // The browser's own reconnect was refused; a refused EventSource stays closed.
    await expect.poll(() => app.streamRefusals(), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(page.locator(".answer-content")).toHaveText("Draft: Explain capacity");
    release();
    await expect(page.locator(".answer-content")).toHaveText(
      "Draft: Explain capacity plus late text",
      { timeout: 10_000 }
    );
    await expect(page.getByText("Live updates reconnecting", { exact: true })).toHaveCount(0);
    expect(app.streamSlots()).toBe(1);
    app.pending.get("fast:Explain capacity")!.finish();
    await expect(page.locator(".answer-content")).toHaveText("Final: Explain capacity");
  });
});

test.describe("pairing and session loss", () => {
  test("pairing without script never puts the code in a URL", async ({ app, browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (r) => requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`));
    const code = app.issuePairingCode();
    await page.goto(app.url + "/pair");
    await page.locator("#pairCode").fill(code);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.waitForLoadState();
    expect(requests.some((r) => r.startsWith("POST ") && r.includes("/pair"))).toBe(true);
    // The unnamed input is never submitted: not in a URL, not in a body.
    expect(requests.join("\n")).not.toContain(code);
    expect(page.url()).not.toContain(code);
    await context.close();
  });

  test("an unpaired browser is sent to the pairing page", async ({ app, browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(app.url);
    await page.waitForURL(app.url + "/pair");
    await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible();
    await context.close();
  });

  test("a session that stops being valid sends the page to pairing and stops retrying", async ({
    page,
    app
  }) => {
    const streams: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/events/stream")) streams.push(r.url());
    });
    await send(page, "Explain session loss");
    await expect(page.locator(".answer-content")).toHaveText("Draft: Explain session loss");
    app.rotateCredentials();
    app.disconnect();
    await page.waitForURL(app.url + "/pair", { timeout: 15_000 });
    const after = streams.length;
    await page.waitForTimeout(4000);
    expect(streams.length).toBe(after);
    app.pending.get("fast:Explain session loss")!.finish();
  });

  test("a temporary failure of the session check does not force pairing", async ({ page, app }) => {
    // The page checks its session on load. A 503 (or a malformed answer) is not an
    // authoritative "not authenticated", so the page must stay and keep working.
    // (EventSource requests cannot be intercepted here, so the load check is used.)
    let checks = 0;
    await page.route("**/auth/session", (route) => {
      checks++;
      return route.fulfill({ status: 503, body: "" });
    });
    await page.reload();
    await expect.poll(() => checks).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    expect(page.url()).toBe(app.url + "/");
    await page.route("**/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.reload();
    await page.waitForTimeout(1000);
    expect(page.url()).toBe(app.url + "/");
    await page.unroute("**/auth/session");
    await send(page, "Explain a blip");
    await expect(page.locator(".answer-content")).toHaveText("Draft: Explain a blip");
    app.pending.get("fast:Explain a blip")!.finish();
  });
});

test("history expiry is explained, keeps the last copy read-only and offers a new conversation", async ({
  page,
  app
}) => {
  await send(page, "Explain expiry");
  await expect(page.locator(".answer-content")).toHaveText("Draft: Explain expiry");
  app.pending.get("fast:Explain expiry")!.finish();
  await expect(page.locator(".answer-content")).toHaveText("Final: Explain expiry");
  const notice = page.locator("#conversationNotice");
  await expect(notice).toBeHidden();
  const expiredId = await page.locator("#conversationId").inputValue();

  app.expireIdleConversations();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("expired on the server");
  await expect(page.locator("#sendButton")).toBeDisabled();
  await expect(page.locator(".answer-content")).toHaveText("Final: Explain expiry");
  await expect(page.getByText("Live updates reconnecting", { exact: true })).toHaveCount(0);

  // A reload has no stream event to rely on; the page asks the server why it closed.
  await page.reload();
  await expect(page.locator("#conversationId")).toHaveValue(expiredId);
  await expect(notice).toBeVisible();
  await expect(page.locator("#sendButton")).toBeDisabled();
  await expect(page.locator("#selectedConversationContext")).toHaveText("Conversation expired.");
  await expect(page.locator(".turn")).toHaveCount(0);

  await page.getByRole("button", { name: "Start a new conversation", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator("#conversationId")).not.toHaveValue(expiredId);
  await expect(page.locator("#conversationId")).toHaveValue(/^conv-[0-9a-f-]{36}$/);
  await expect(page.locator("#sendButton")).toBeEnabled();
  await send(page, "Explain renewal");
  await expect(page.locator(".answer-content")).toHaveText("Draft: Explain renewal");
  app.pending.get("fast:Explain renewal")!.finish();
  await expect(page.locator(".answer-content")).toHaveText("Final: Explain renewal");
});
test("send failures distinguish expiry, a full history and server conversation capacity", async ({
  page
}) => {
  let failure = { status: 503, code: "CONVERSATION_CAPACITY" };
  await page.route("**/messages", (route) =>
    route.fulfill({ status: failure.status, json: { error: failure.code, code: failure.code } })
  );
  const notice = page.locator("#conversationNotice");
  await send(page, "First");
  await expect(page.locator("#status")).toContainText("cannot start another conversation");
  await expect(notice).toBeHidden();
  await expect(page.locator("#sendButton")).toBeEnabled();

  failure = { status: 413, code: "CONVERSATION_HISTORY_CAPACITY" };
  await send(page, "Second");
  await expect(notice).toContainText("history is full");
  await expect(page.locator("#sendButton")).toBeEnabled();

  failure = { status: 410, code: "CONVERSATION_EXPIRED" };
  await send(page, "Third");
  await expect(notice).toContainText("expired on the server");
  await expect(page.locator("#sendButton")).toBeDisabled();
  await expect(page.locator("#status")).toContainText("Conversation expired");
});

test("model-planned missing capability stays in the conversation without fabricated completion", async ({
  page,
  app
}) => {
  app.controls.plan = {
    action: "unsupported",
    message: "No baseball evidence tool is available.",
    missingCapability: "baseball results"
  };
  await send(page, "What happened in the Red Sox game last night?");
  const turn = page.locator(".turn").first();
  await expect(turn.locator(".answer-content")).toHaveText(
    "No baseball evidence tool is available."
  );
  await expect(turn.locator("summary")).toContainText("Capability unavailable");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("direct team browsing renders a table without invoking a model", async ({ page, app }) => {
  await page.locator("#directoryLeague").selectOption("NBA");
  await page.getByRole("button", { name: "Show teams", exact: true }).click();
  await expect(page.locator("#directoryPayload table")).toContainText("Harbor <Comets>");
  await expect(page.locator("#directoryStatus")).toContainText("Rows were not sent to a model");
  expect(app.pending.size).toBe(0);
  await expect(page.locator(".turn")).toHaveCount(0);
  await page.locator("#userId").fill("another-user");
  await page.locator("#userId").blur();
  await expect(page.locator("#directoryPayload table")).toHaveCount(0);
});

test("tool payload survives timeline replay and is rendered outside answer text", async ({
  page,
  app
}) => {
  app.controls.plan = {
    action: "retrieve",
    calls: [{ tool: "sports:list-teams", arguments: { league: "NBA" } }]
  };
  await send(page, "Show the NBA directory");
  await expect(page.locator(".turn table")).toContainText("Harbor <Comets>");
  await expect(page.locator(".turn .answer-content")).not.toContainText("Harbor");
  await page.reload();
  await expect(page.locator(".turn table")).toContainText("Harbor <Comets>");
});

test("team topic scope survives browsing and attaches only the selected reference", async ({
  page,
  app
}) => {
  await page.getByRole("button", { name: "Show teams", exact: true }).click();
  await expect(page.locator("#directoryTeam option")).toHaveCount(2);
  await page.locator("#attachTeamReference").check();
  await page.locator("#openTeamConversation").click();
  await expect(page.locator("#selectedConversationContext")).toContainText("Harbor <Comets>");
  await expect(page.locator("#selectedConversationContext")).toContainText("attached");
  const conversation = await page.locator("#conversationId").inputValue();
  await page.locator("#directorySport").selectOption("football");
  await page.getByRole("button", { name: "Show teams", exact: true }).click();
  await expect(page.locator("#directoryPayload")).toContainText("NFL team directory");
  await expect(page.locator("#conversationId")).toHaveValue(conversation);
  await expect(page.locator("#selectedConversationContext")).toContainText("basketball");
  app.controls.plan = { action: "answer", message: "Your selected team is in scope." };
  await send(page, "Which team are we discussing?");
  await expect(page.locator(".answer-content")).toContainText("selected team");
  expect(JSON.stringify(app.controls.inputs)).toContain("Harbor <Comets>");
  expect(JSON.stringify(app.controls.inputs)).toContain("abbreviation");
  expect(JSON.stringify(app.controls.inputs)).not.toContain("PRIVATE_OTHER_ROW");
});

test("topic creation rejects foreign and invalid row references", async ({ app }) => {
  const post = async (path: string, body: unknown) =>
    fetch(app.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...app.bearer("client") },
      body: JSON.stringify(body)
    });
  const owner = { conversationId: "browse", userId: "owner" };
  const directory = await (await post("/sports/teams", { ...owner, league: "NBA" })).json();
  const choice = { ...owner, resultId: directory.context.resultId, row: 0, attachReference: false };
  expect(
    (await post("/sports/conversations", { ...choice, conversationId: "foreign" })).status
  ).toBe(409);
  expect((await post("/sports/conversations", { ...choice, row: 999 })).status).toBe(409);
  const opened = await (await post("/sports/conversations", choice)).json();
  expect(opened.context.referenceStatus).toBe("not_attached");
  expect(opened.context.reference).toBeNull();
  expect(
    (
      await post("/conversation-context", {
        conversationId: opened.conversationId,
        userId: "other"
      })
    ).ok
  ).toBe(false);
});

test("restores scoped conversation after refresh", async ({ page }) => {
  await page.getByRole("button", { name: "Show teams", exact: true }).click();
  await expect(page.locator("#directoryTeam option")).toHaveCount(2);
  await page.locator("#openTeamConversation").click();
  await expect(page.locator("#selectedConversationContext")).toContainText("Harbor");
  const id = await page.locator("#conversationId").inputValue();
  await page.reload();
  await expect(page.locator("#conversationId")).toHaveValue(id);
  await expect(page.locator("#selectedConversationContext")).toContainText("Harbor");
});

test("reference indicator refreshes when attached evidence expires", async ({ page }) => {
  const expiry = Date.now() + 1200;
  await page.route("**/conversation-context", async (route) => {
    const expired = Date.now() >= expiry;
    await route.fulfill({
      json: {
        context: {
          path: ["Sports", "Example"],
          referenceStatus: expired ? "expired" : "attached",
          reference: expired
            ? null
            : { sourceUrl: "https://example.invalid", expiresAt: new Date(expiry).toISOString() }
        }
      }
    });
  });
  await page.locator("#conversationId").fill("expiry-test");
  await page.locator("#conversationId").blur();
  await expect(page.locator("#selectedConversationContext")).toContainText("attached");
  await expect(page.locator("#selectedConversationContext")).toContainText("expired");
});

test("manual review targets a chosen answer and records requested controls", async ({
  page,
  app
}) => {
  app.controls.plan = { action: "answer", message: "Initial answer" };
  await send(page, "Give an answer");
  await expect(page.locator(".answer-content")).toContainText("Initial answer");
  await page.locator("#runModel").selectOption("fixed");
  await expect(page.locator("#thinkingStatus")).toContainText("Only configured");
  await page.locator("#runMode").selectOption("review");
  await page.locator("#reviewScope").selectOption("text-only");
  await page.locator("#runTarget").selectOption({ label: "Initial answer" });
  app.controls.plan = { action: "answer", message: "Review: needs additional evidence" };
  await send(page, "Check factual support");
  await expect(page.locator(".answer-content").last()).toContainText("Review:");
  expect(JSON.stringify(app.controls.inputs.at(-1))).toContain('"mode":"review"');
  expect(JSON.stringify(app.controls.inputs.at(-1))).toContain("Initial answer");
});

test("guards duplicate submits while context is refreshing", async ({ page, app }) => {
  app.controls.plan = { action: "answer", message: "One reply" };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/conversation-context", async (route) => {
    await gate;
    await route.fulfill({ json: { context: null } });
  });
  await page.locator("#prompt").fill("Once");
  await page.locator("#composer").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
  await expect(page.locator("#sendButton")).toBeDisabled();
  release();
  await expect(page.locator(".answer-content")).toContainText("One reply");
  expect(app.controls.inputs).toHaveLength(1);
});

test("selected payload rows enable a scoped review and can be detached", async ({ page, app }) => {
  app.controls.plan = {
    action: "retrieve",
    calls: [{ tool: "sports:list-teams", arguments: { league: "NBA" } }]
  };
  await send(page, "Show teams");
  await expect(page.locator(".turn table")).toContainText("PRIVATE_OTHER_ROW");
  await expect(page.locator("#referenceRows option")).toHaveCount(2);
  await page.locator("#referenceRows").selectOption("0");
  await page.locator("#attachRows").click();
  await page.locator("#runMode").selectOption("review");
  await page.locator("#runTarget").selectOption({ index: 1 });
  app.controls.plan = {
    action: "answer",
    message: "Selected rows reviewed; unselected rows were not reviewed."
  };
  await send(page, "Check the selected row");
  await expect(page.locator(".answer-content").last()).toContainText("Selected rows reviewed");
  const review = JSON.stringify(app.controls.inputs.at(-1));
  expect(review).toContain("Harbor <Comets>");
  expect(review).not.toContain("PRIVATE_OTHER_ROW");
  await page.locator("#detachRows").click();
  await page.locator("#runMode").selectOption("chat");
  app.controls.plan = { action: "answer", message: "Detached" };
  await send(page, "Continue");
  await expect(page.locator(".answer-content").last()).toContainText("Detached");
  const latest = app.controls.inputs.at(-1) as { context: { systemInstruction: string } };
  expect(latest.context.systemInstruction).not.toContain("Harbor <Comets>");
});

test("detaching team evidence preserves topic scope", async ({ page }) => {
  await page.getByRole("button", { name: "Show teams", exact: true }).click();
  await expect(page.locator("#directoryTeam option")).toHaveCount(2);
  await page.locator("#attachTeamReference").check();
  await page.locator("#openTeamConversation").click();
  await expect(page.locator("#selectedConversationContext")).toContainText("attached");
  await page.locator("#detachTeam").click();
  await expect(page.locator("#selectedConversationContext")).toContainText("not_attached");
  await expect(page.locator("#selectedConversationContext")).toContainText("Harbor");
});

test("game browsing and snapshot details require no model and clear on owner change", async ({
  page,
  app
}) => {
  await page.locator("#gamesLeague").selectOption("NBA");
  await page.locator("#gamesFrom").fill("2026-09-27T00:00:00Z");
  await page.locator("#gamesTo").fill("2026-09-30T00:00:00Z");
  await page.locator("#searchGames").click();
  await expect(page.locator("#gamesPayload table")).toContainText("Harbor <Comets>");
  await expect(page.locator("#gamesStatus")).toContainText("partial");
  await expect(page.locator("#selectedGame option")).toHaveCount(1);
  await page.locator("#showGameDetails").click();
  await expect(page.locator("#gamesStatus")).toContainText("No fresh lookup");
  await expect(page.locator("#gamesPayload table")).toContainText("101");
  expect(app.controls.inputs).toHaveLength(0);
  expect(app.pending.size).toBe(0);
  await page.locator("#userId").fill("another-owner");
  await page.locator("#userId").blur();
  await expect(page.locator("#gamesPayload table")).toHaveCount(0);
  await expect(page.locator("#selectedGame option")).toHaveCount(0);
});

test("game browser disables details for empty searches and explains unresolved names", async ({
  page
}) => {
  await expect(page.locator("#showGameDetails")).toBeDisabled();
  await page.locator("#gamesLeague").selectOption("NBA");
  await page.locator("#gamesFrom").fill("2026-01-01T00:00:00Z");
  await page.locator("#gamesTo").fill("2026-01-02T00:00:00Z");
  await page.locator("#searchGames").click();
  await expect(page.locator("#gamesStatus")).toContainText("0 NBA game records");
  await expect(page.locator("#showGameDetails")).toBeDisabled();
  await page.locator("#gamesTeam").fill("Unknown club");
  await page.locator("#searchGames").click();
  await expect(page.locator("#gamesStatus")).toHaveText(
    "No matching team found. Check the team name and league."
  );
  await expect(page.locator("#showGameDetails")).toBeDisabled();
});

test("manual roles expose permitted tools and show the admitted context estimate", async ({
  page,
  app
}) => {
  await page.locator("#runRole").selectOption("researcher");
  await page.locator("#roleDetails summary").click();
  await expect(page.locator("#roleDescription")).toContainText("tool-call limit: 2");
  await expect(page.locator("#runThinking")).toBeDisabled();
  await page.locator("#roleTools").selectOption(["sports:list-teams"]);
  app.controls.plan = {
    action: "retrieve",
    calls: [{ tool: "sports:list-teams", arguments: { league: "NBA" } }]
  };
  await send(page, "List the teams");
  await expect(page.locator(".turn table")).toContainText("Harbor");
  const input = JSON.stringify(app.controls.inputs.at(-1));
  expect(input).toContain("sports:list-teams");
  expect(input).not.toContain("sports:find-games");
  await page.getByText("Latest admitted model-call budget (estimated)", { exact: true }).click();
  await expect(page.locator("#contextBudgetStatus")).toContainText("role input limit 6000");
  const conversationId = await page.locator("#conversationId").inputValue();
  const response = await page.request.get(
    new URL(`/conversations/${encodeURIComponent(conversationId)}/events`, page.url()).href
  );
  expect(response.ok()).toBe(true);
  const { events } = await response.json();
  const budget = events.findLast(
    (event: { contextBudget?: unknown }) => event.contextBudget
  ).contextBudget;
  await expect(page.locator("#contextBudgetStatus")).toContainText(
    `Estimated input: ${budget.totalInputTokens} used of ${budget.availableInputTokens} capacity; ${budget.availableInputTokens - budget.totalInputTokens} remaining.`
  );
  await expect(page.locator("#contextBudgetStatus")).toContainText(
    `Full window ${budget.windowTokens}`
  );
  await expect(page.locator("#contextBudgetStatus")).toContainText(
    `Output reserve ${budget.outputReserve}, safety reserve ${budget.safetyReserve}`
  );
  await expect(page.locator("#contextBudgetStatus")).toContainText(
    "These are estimates, not provider token counts."
  );
  await page.locator("#runRole").selectOption("writer");
  await expect(page.locator("#roleTools option")).toHaveCount(0);
  app.controls.plan = { action: "answer", message: "No evidence selected yet." };
  await send(page, "Explain the evidence");
  await expect(page.locator(".answer-content").last()).toContainText("No evidence selected");
  expect(JSON.stringify(app.controls.inputs.at(-1))).toContain("Tools: []");
  await expect(page.locator("#contextBudgetStatus")).toContainText("tool definitions 2");
  await page.reload();
  await expect(page.locator("#runRole")).toHaveValue("");
});

test("manual evidence answer uses attached rows without a target answer", async ({ page, app }) => {
  app.controls.plan = {
    action: "retrieve",
    calls: [{ tool: "sports:list-teams", arguments: { league: "NBA" } }]
  };
  await send(page, "Show teams");
  await expect(page.locator("#referenceRows option")).toHaveCount(2);
  await page.locator("#referenceRows").selectOption("0");
  await page.locator("#attachRows").click();
  await page.locator("#runMode").selectOption("answer-evidence");
  app.controls.plan = {
    status: "insufficient_evidence",
    reason: "Team names alone cannot establish game scores."
  };
  await send(page, "What was their score?");
  await expect(page.locator(".answer-content").last()).toContainText(
    "Team names alone cannot establish game scores."
  );
  await expect(page.locator(".answer-content").last()).toContainText("Factual quality: ungraded");
  const input = JSON.stringify(app.controls.inputs.at(-1));
  expect(input).toContain("Harbor <Comets>");
  expect(input).not.toContain("PRIVATE_OTHER_ROW");
});

for (const [width, unsafe] of [
  [390, false],
  [1280, false],
  [390, true]
] as const)
  test(`evidence citations wrap at ${width}px (unsafe=${unsafe}) and survive replay`, async ({
    page,
    app
  }) => {
    await page.setViewportSize({ width, height: 900 });
    app.controls.referenceSourceUrl = unsafe
      ? "javascript:alert(1)"
      : "https://example.invalid/" + "x".repeat(11000);
    app.controls.referenceCell = "<img src=x onerror=alert(1)>" + "x".repeat(900);
    app.controls.plan = {
      action: "retrieve",
      calls: [{ tool: "sports:list-teams", arguments: { league: "NBA" } }]
    };
    await send(page, "Show teams");
    await expect(page.locator("#referenceRows option")).toHaveCount(2);
    const resultId = await page.locator("#referenceResult").inputValue();
    await page.locator("#referenceRows").selectOption("0");
    await page.locator("#attachRows").click();
    await page.locator("#runMode").selectOption("answer-evidence");
    app.controls.plan = {
      status: "answer",
      scope: "selected_rows",
      claims: [
        {
          text: "Here is a selected team field.",
          citations: [evidenceCitationId(resultId, 0, 0), evidenceCitationId(resultId, 0, 0)]
        }
      ],
      limitations: []
    };
    await send(page, "Show the selected field");
    await expect(page.locator(".answer-content").last()).toContainText(
      "Here is a selected team field. [1]"
    );
    const refs = page.locator(".answer-references").last();
    await refs.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(refs.locator("a")).toHaveCount(unsafe ? 0 : 1);
    if (!unsafe)
      await expect(refs.locator("a")).toHaveAttribute("href", app.controls.referenceSourceUrl);
    await expect(refs).toContainText(app.controls.referenceCell);
    await expect(refs.locator("img")).toHaveCount(0);
    const layout = await refs.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      scroll: el.scrollWidth,
      client: el.clientWidth,
      viewport: innerWidth
    }));
    expect(layout.width).toBeLessThanOrEqual(layout.viewport);
    expect(layout.scroll).toBeLessThanOrEqual(layout.client + 1);
    await expect(refs).toContainText("[1] Source 1, row 1");
    await refs.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(refs).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(refs).toHaveAttribute("open", "");
    await page.reload();
    await expect(page.locator(".answer-references").last().locator("summary")).toHaveText(
      "References (1)"
    );
  });

test("switching conversations during a pending send keeps submission locked and ignores stale errors", async ({
  page
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/messages", async (route) => {
    requests++;
    await blocked;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "CONVERSATION_HISTORY_CAPACITY",
        error: "old conversation full"
      })
    });
  });
  await send(page, "pending request");
  await expect.poll(() => requests).toBe(1);
  await page.locator("#conversationId").fill("replacement");
  await page.locator("#conversationId").dispatchEvent("change");
  await expect(page.locator("#sendButton")).toBeDisabled();
  await page
    .locator("#composer")
    .evaluate((form) =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
  expect(requests).toBe(1);
  release();
  await expect(page.locator("#sendButton")).toBeEnabled();
  await expect(page.locator("#conversationNotice")).toBeHidden();
  await expect(page.locator("body")).not.toContainText("old conversation full");
});
