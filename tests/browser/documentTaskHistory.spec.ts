import { test, expect } from "./fixture";

test.use({ documentationTasks: true });

test("documentation questions, results and cancellations share ordered chat history", async ({
  page,
  app
}) => {
  await app.pair(page);
  await page.locator("#prompt").fill("First chat message");
  await page.locator("#sendButton").click();
  await expect(page.locator("#thread")).toContainText("Draft: First chat message");
  app.pending.get("fast:First chat message")!.finish();
  await page.locator("#prompt").fill("Read the documentation <script>literal</script>");
  await page.locator("#documentTaskStart").click();
  const task = page.locator("#thread .document-task");
  await expect(task).toContainText("Documentation task — running");
  await expect(task.locator(".user")).toHaveText("Read the documentation <script>literal</script>");
  await expect(task.locator("script")).toHaveCount(0);
  await expect(page.locator("#prompt")).toHaveValue("");
  await expect(page.locator("#sendButton")).toBeEnabled();
  await page.locator("#prompt").fill("Chat while the task runs");
  await page.locator("#sendButton").click();
  await expect(page.locator("#thread")).toContainText("Draft: Chat while the task runs");
  app.pending.get("fast:Chat while the task runs")!.finish();
  app.tasks[0].status = "completed";
  app.tasks[0].answer = {
    answer: "Documented answer <b>literal</b>",
    citations: [{ path: "docs/example.md", start_line: 4, end_line: 9 }]
  };
  await expect(task).toContainText("Documented answer <b>literal</b>");
  await expect(task).toContainText("docs/example.md:4–9");
  await expect(task.locator("b")).toHaveCount(0);
  const questions = [
    "First chat message",
    "Read the documentation <script>literal</script>",
    "Chat while the task runs"
  ];
  await expect(page.locator("#thread .user")).toHaveText(questions);
  await page.reload();
  await expect(page.locator("#thread .user")).toHaveText(questions);
  await page.locator("#prompt").fill("Cancel this task");
  await page.locator("#documentTaskStart").click();
  const cancelled = page.locator("#thread .document-task").filter({ hasText: "Cancel this task" });
  await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(cancelled).toContainText("Documentation task — cancelled");
  await expect(page.locator("#thread .user")).toHaveText([...questions, "Cancel this task"]);
  await page.locator("#conversationId").fill("another-conversation");
  await page.locator("#conversationId").dispatchEvent("change");
  await expect(page.locator("#thread .turn")).toHaveCount(0);
});

test("conversation and user ID fields align at desktop and mobile widths", async ({
  page,
  app
}) => {
  await app.pair(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const conversation = await page.locator("#conversationId").boundingBox();
    const user = await page.locator("#userId").boundingBox();
    expect(conversation).not.toBeNull();
    expect(user).not.toBeNull();
    expect(Math.abs(conversation!.height - user!.height)).toBeLessThan(1);
    if (width === 1280) expect(Math.abs(conversation!.y - user!.y)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  }
});
