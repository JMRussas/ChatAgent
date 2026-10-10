import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const PLAN = "22222222-3333-4444-8555-666666666666";
const THREAD = "saved-report-discussion";
const definition = {
  version: 1,
  name: "Report review",
  description: "Read the report and review its result.",
  steps: [
    { id: "read", name: "Read report", inputs: {}, action: { type: "tool", tool: "fetch_report" } },
    {
      id: "review",
      name: "Review report result",
      inputs: {},
      action: { type: "human", instructions: "Review the three reported items." }
    }
  ]
};

/** Controlled executor responses; the actual home, shared controls and browser auth are real. */
async function homeData(page: Page, expireThread = false) {
  const seen: Array<{ name: string; input: Record<string, unknown>; conversation?: string }> = [];
  const project = {
    id: PROJECT,
    name: "Report project",
    revision: 1,
    archived: false,
    hekateProjectId: PROJECT,
    preparedPlanRoots: []
  };
  const plan = {
    id: PLAN,
    definition,
    revision: 1,
    work: "todo",
    attemptId: null as string | null
  };
  const state = { fail: "", status: "todo", run: null as any };
  const conversations = [
    {
      id: THREAD,
      title: "Report discussion",
      projectId: PROJECT,
      archived: false,
      status: "ready",
      reopenable: true,
      lastActivityAt: "2026-10-10T20:00:00Z",
      preview: "Review the report"
    }
  ];
  await page.route("**/workspace/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    seen.push({ name, input });
    if (name === "create_conversation" && expireThread) {
      const created = {
        ...conversations[0],
        id: "new-report-discussion",
        title: String(input.title || "New conversation"),
        status: "ready",
        reopenable: true
      };
      conversations.push(created);
      return route.fulfill({ json: created });
    }
    if (name !== "get_workspace") throw Error("Unexpected workspace mutation " + name);
    if (state.fail)
      return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", error: state.fail } });
    return route.fulfill({
      json: {
        projects: [project],
        conversations,
        work: [
          {
            id: PLAN,
            projectId: PROJECT,
            name: definition.name,
            kind: "workflow",
            status: state.status,
            nextStep: "Review report result",
            conversationId: THREAD,
            latestRunId: state.run?.id ?? null
          }
        ],
        errors: [],
        truncated: false,
        persistenceEnabled: true
      }
    });
  });
  await page.route("**/workflows/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    seen.push({
      name,
      input,
      conversation: route.request().headers()["x-workspace-conversation-id"]
    });
    let result: unknown;
    if (name === "list_actions")
      result = {
        actions: [{ name: "fetch_report", description: "Read a report", inputSchema: {} }],
        executors: [],
        modelAvailable: false
      };
    else if (name === "list_plans") result = { plans: [plan] };
    else if (name === "get_plan") result = plan;
    else if (name === "run_plan") {
      state.status = "waiting_input";
      plan.work = "in_progress";
      state.run = {
        version: 1,
        id: randomUUID(),
        planId: PLAN,
        definition,
        revision: 1,
        status: "waiting_input",
        steps: [
          { id: "read", name: "Read report", status: "completed", output: { items: 3 } },
          {
            id: "review",
            name: "Review report result",
            status: "waiting_input",
            inputs: { items: 3 }
          }
        ],
        startedAt: "2026-10-10T20:00:00Z",
        updatedAt: "2026-10-10T20:00:01Z"
      };
      plan.attemptId = state.run.id;
      result = state.run;
    } else if (name === "get_run") result = state.run;
    else if (name === "submit_step_result") {
      state.status = "completed";
      plan.work = "done";
      state.run.status = "completed";
      state.run.steps[1] = { ...state.run.steps[1], status: "completed", output: input.output };
      result = state.run;
    } else if (name === "stop_run") {
      state.status = "stopped";
      plan.work = "todo";
      state.run.status = "stopped";
      state.run.steps[1].status = "stopped";
      result = state.run;
    } else throw Error("Unexpected workflow tool " + name);
    return route.fulfill({ json: result });
  });
  await page.route("**/workspace/conversations/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/context") && route.request().method() === "POST")
      return route.fulfill({ json: { context: null } });
    if (route.request().method() !== "GET")
      throw Error("Unexpected model call while observing work");
    if (path.endsWith("/events/stream")) {
      const expired = expireThread && path.includes("/" + THREAD + "/");
      if (expired) {
        conversations[0].status = "expired";
        conversations[0].reopenable = false;
      }
      return route.fulfill({
        contentType: "text/event-stream",
        body:
          "event: timeline\ndata: " +
          JSON.stringify({
            events: [
              {
                type: "user",
                messageId: "saved",
                eventId: "saved-user",
                text: "Review the report",
                createdAtIso: "2026-10-10T20:00:00Z"
              }
            ]
          }) +
          "\n\n" +
          (expired ? "event: conversation-expired\ndata: {}\n\n" : "")
      });
    }
    return route.fulfill({ json: { events: [] } });
  });
  return { state, seen };
}

test.use({ workspace: true, workflows: true });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("Workspace home script failed:", error.message));
});

test("executor discovery remains available after an unconfigured default project refuses plan listing", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  const discovery: string[] = [];
  await page.route("**/workflows/tools/list_actions", (route) => {
    discovery.push("list_actions");
    return route.fulfill({ json: { actions: [], modelAvailable: false, executors: ["claude"] } });
  });
  await page.route("**/workflows/tools/list_plans", (route) => {
    const input = route.request().postDataJSON();
    discovery.push(input.projectId ? "project_list" : "default_refused");
    return input.projectId
      ? route.fulfill({ json: { plans: [] } })
      : route.fulfill({
          status: 409,
          json: {
            code: "DEFAULT_PROJECT_REQUIRED",
            error: "Select a project before listing plans."
          }
        });
  });
  await app.pair(page);
  await expect.poll(() => discovery.includes("default_refused")).toBe(true);
  await page.locator('#projects [data-project="' + PROJECT + '"]').click();
  await page.locator("#shellNewAgentTask").click();
  await expect(page.locator("#workflowAgentCreateForm")).toBeVisible();
  await expect(page.locator("#workflowAgentExecutor")).toHaveValue("claude");
  await expect(page.locator("#workflowAgentCreate")).toBeEnabled();
  expect(seen.some((entry) => ["create_plan", "run_plan"].includes(entry.name))).toBe(false);
  expect(app.pending.size).toBe(0);
});

test("an expired thread with no draft can create a fresh conversation and resume composing", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page, true);
  await app.pair(page);
  await page.locator("#conversationsTab").click();
  await page.locator("#conversationList").getByText("Report discussion", { exact: true }).click();
  await page.locator("#continueConversation").click();
  await expect(page.locator("#conversationNotice")).toBeVisible();
  await expect(page.locator("#sendButton")).toBeDisabled();
  await expect(page.locator("#prompt")).toHaveValue("");
  await page.locator("#shellNewConversation").click();
  if (await page.locator("#workspaceActionDialog").isVisible()) {
    await page.locator("#workspaceConversationTitle").fill("Fresh report discussion");
    await page.locator("#workspaceNewConversation").click();
  }
  await expect
    .poll(() => seen.filter((entry) => entry.name === "create_conversation").length)
    .toBe(1);
  await expect(page.locator("#conversationId")).toHaveValue("new-report-discussion");
  await expect(page.locator("#conversationNotice")).toBeHidden();
  await expect(page.locator("#sendButton")).toBeEnabled();
  await expect(page.locator("#prompt")).toBeVisible();
  expect(app.pending.size).toBe(0);
});

test("an unsent conversation draft blocks creation of another thread before any metadata write", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await app.pair(page);
  await page.locator("#conversationsTab").click();
  await page.locator("#conversationList").getByText("Report discussion", { exact: true }).click();
  await page.locator("#continueConversation").click();
  await expect(page.locator("#prompt")).toBeVisible();
  await page.locator("#prompt").fill("Keep this unsent report question");
  await page.locator("#shellNewConversation").click();
  if (await page.locator("#workspaceActionDialog").isVisible()) {
    await page.locator("#workspaceConversationTitle").fill("Another discussion");
    await page.locator("#workspaceNewConversation").click();
  }
  await expect(page.locator("#workspaceActionStatus")).toBeVisible();
  await expect(page.locator("#workspaceActionStatus")).toContainText(
    "Send or clear the current message"
  );
  expect(seen.some((entry) => entry.name === "create_conversation")).toBe(false);
  await expect(page.locator("#prompt")).toHaveValue("Keep this unsent report question");
  expect(app.pending.size).toBe(0);
});

test("home selection and refresh observe work without starting it or calling a model", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await app.pair(page);
  await expect(page.locator("#projects")).toContainText("Report project");
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  await expect(page.locator("#detail")).toContainText("Report review");
  await page.locator("#openCurrent").click();
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  await expect(page.locator("#workflowPlanSteps")).toContainText("Read report");
  await expect(page.locator("#workflowRun")).toBeEnabled();
  await page.locator("#workspaceActionClose").click();
  await page.reload();
  await expect(page.locator("#workList")).toContainText("Report review");
  expect(
    seen.every((entry) =>
      ["get_workspace", "list_plans", "list_actions", "get_plan", "get_run"].includes(entry.name)
    )
  ).toBe(true);
  expect(app.controls.inputs).toEqual([]);
  expect(app.pending.size).toBe(0);
});

test("explicit execution opens the selected project controls and human review records the supplied result", async ({
  page,
  app
}) => {
  const { seen, state } = await homeData(page);
  await app.pair(page);
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  expect(seen.some((entry) => entry.name === "run_plan")).toBe(false);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "waiting_input");
  await expect(page.locator("#workflowHumanInstructions")).toContainText("three reported items");
  expect(seen.find((entry) => entry.name === "run_plan")).toMatchObject({
    input: { id: PLAN, revision: 1, projectId: PROJECT },
    conversation: THREAD
  });
  const review = { approved: true, comment: "Reviewed the three reported items" };
  await page.locator("#workflowHumanOutput").fill(JSON.stringify(review));
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "completed");
  expect(seen.find((entry) => entry.name === "submit_step_result")).toMatchObject({
    input: { id: state.run.id, projectId: PROJECT, stepId: "review", output: review }
  });
  expect(state.run.steps[0].output).toEqual({ items: 3 });
  expect(state.run.steps[1].output).toEqual(review);
  await expect(page.locator("#workflowStop")).toBeDisabled();
});

test("a narrow home can stop waiting work and reports unavailable refresh state without overflowing", async ({
  page,
  app
}) => {
  const { seen, state } = await homeData(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await app.pair(page);
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true);
  await page.locator("#workflowStop").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "stopped");
  expect(seen.filter((entry) => entry.name === "stop_run")).toHaveLength(1);
  expect(state.run.steps[0].output).toEqual({ items: 3 });
  expect(seen.some((entry) => entry.name === "submit_step_result")).toBe(false);
  await page.locator("#workspaceActionClose").click();
  state.fail = "Report project state is temporarily unavailable.";
  await page.reload();
  await expect(page.locator("#loadErrors")).toBeVisible();
  await expect(page.locator("#loadErrors")).toContainText(state.fail);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true);
  expect(app.pending.size).toBe(0);
});
