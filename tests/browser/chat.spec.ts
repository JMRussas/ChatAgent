import { test, expect } from "./fixture";
import type { Page } from "@playwright/test";
async function send(page: Page, prompt: string) { await page.locator("#prompt").fill(prompt); await page.getByRole("button", { name: "Send", exact: true }).click(); }

test.beforeEach(async ({ page, app }) => { await page.goto(app.url); });
test("direct draft streams with progress, then completes without a spinner", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await send(page, "Explain event loops");
  const turn = page.locator(".turn").first();
  await expect(turn.locator(".answer-content")).toHaveText("Draft: Explain event loops");
  await expect(turn.locator(".assistant")).toHaveAttribute("aria-busy", "true");
  await expect(turn.locator(".activity-spinner")).toBeVisible();
  app.pending.get("fast:Explain event loops")!.finish();
  await expect(turn.locator(".answer-content")).toHaveText("Final: Explain event loops");
  await expect(turn.locator(".assistant")).toHaveAttribute("aria-busy", "false");
  await expect(turn.locator("summary")).toContainText("Simulation complete — facts not verified");
  await expect(turn.locator(".activity-spinner")).toBeHidden(); expect(errors).toEqual([]);
});
test("deep queue, selected model and late chunks stay with their own overlapping turn", async ({ page, app }) => {
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
  await expect(first.locator(".answer-content").last()).toHaveText("Refined: Please cite sources for alpha");
  await expect(second.locator(".answer-content")).toHaveText("Final: Explain beta event loops");
  await expect(page.locator('.assistant[aria-busy="true"]')).toHaveCount(0);
});
for (const [prompt, status] of [["Test auth failure", "Failed"], ["Test quota failure", "Failed"], ["Test provider failure", "Failed"], ["Test length limit", "Incomplete"]]) {
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
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#prompt").fill("Explain keyboard cancellation");
  await page.getByRole("button", { name: "Send", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".answer-content")).toContainText("Draft:");
  await expect(page.locator(".activity-spinner")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".reply-activity summary")).toHaveAttribute("aria-live", "polite");
  await page.getByRole("button", { name: "Stop", exact: true }).focus(); await page.keyboard.press("Enter");
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
  await expect(page.locator(".answer-content")).toHaveText("Draft: Explain reconnect behavior plus late text");
  await expect(page.getByText("Live updates reconnecting", { exact: true })).toHaveCount(0);
  app.pending.get("fast:Explain reconnect behavior")!.finish();
  await expect(page.locator(".answer-content")).toHaveText("Final: Explain reconnect behavior");
});

test("model-planned missing capability stays in the conversation without fabricated completion", async ({ page, app }) => {
  app.controls.plan = { action: "unsupported", message: "No baseball evidence tool is available.", missingCapability: "baseball results" };
  await send(page, "What happened in the Red Sox game last night?");
  const turn = page.locator(".turn").first();
  await expect(turn.locator(".answer-content")).toHaveText("No baseball evidence tool is available.");
  await expect(turn.locator("summary")).toContainText("Capability unavailable");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});


test("direct team browsing renders a table without invoking a model", async ({page, app}) => {
  await page.locator("#directoryLeague").selectOption("NBA");
  await page.getByRole("button", {name:"Show teams",exact:true}).click();
  await expect(page.locator("#directoryPayload table")).toContainText("Harbor <Comets>");
  await expect(page.locator("#directoryStatus")).toContainText("Rows were not sent to a model");
  expect(app.pending.size).toBe(0);
  await expect(page.locator(".turn")).toHaveCount(0);
  await page.locator("#userId").fill("another-user"); await page.locator("#userId").blur();
  await expect(page.locator("#directoryPayload table")).toHaveCount(0);
});

test("tool payload survives timeline replay and is rendered outside answer text", async ({page,app}) => {
  app.controls.plan = {action:"retrieve",calls:[{tool:"sports:list-teams",arguments:{league:"NBA"}}]};
  await send(page,"Show the NBA directory");
  await expect(page.locator(".turn table")).toContainText("Harbor <Comets>");
  await expect(page.locator(".turn .answer-content")).not.toContainText("Harbor");
  await page.reload();
  await expect(page.locator(".turn table")).toContainText("Harbor <Comets>");
});
