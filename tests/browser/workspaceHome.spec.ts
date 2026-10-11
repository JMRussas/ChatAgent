import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture";
import { workflowDigest, compactDigest, type WorkDigest } from "../../src/workspace/workDigest";
import {
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowRun
} from "../../src/workflows/types";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const PLAN = "22222222-3333-4444-8555-666666666666";
const THREAD = "saved-report-discussion";
const definition = workflowDefinitionSchema.parse({
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
});

/** Controlled executor responses; the actual home, shared controls and browser auth are real. */
async function homeData(page: Page, expireThread = false, instructions?: string) {
  const seen: Array<{ name: string; input: Record<string, unknown>; conversation?: string }> = [];
  const project = {
    id: PROJECT,
    name: "Report project",
    revision: 1,
    archived: false,
    hekateProjectId: PROJECT,
    preparedPlanRoots: []
  };
  const plan: StoredWorkflowPlan & { latestRunId?: string } = {
    id: PLAN,
    definition: instructions
      ? workflowDefinitionSchema.parse({
          ...definition,
          steps: definition.steps.map((step) =>
            step.action.type === "human"
              ? { ...step, action: { ...step.action, instructions } }
              : step
          )
        })
      : definition,
    revision: 1,
    work: "todo",
    ownerId: "browser-proof",
    stateRevision: 1,
    taskId: PLAN,
    attemptEpoch: 0,
    artifactRef: null,
    attemptId: null
  };
  const state = {
    fail: "",
    responseError: "",
    modelAvailable: false,
    toolRunError: "",
    status: "todo",
    run: null as WorkflowRun | null,
    extraWork: [] as WorkDigest[],
    detailDigest: null as WorkDigest | null,
    taskResponse: null as ((input: Record<string, unknown>) => WorkflowRun) | null,
    summaryDigest: undefined as WorkDigest | undefined,
    omitDigest: false,
    rowNextStep: "Review report result",
    linkedConversationId: THREAD as string | null,
    extraLinks: {} as Record<string, string>
  };
  const currentDigest = () => workflowDigest(plan, state.run ?? undefined, PROJECT);
  const conversations = [
    {
      id: THREAD,
      title: "Report discussion",
      projectId: PROJECT as string | null,
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
    if (name === "get_work_digest") {
      const digest =
        input.id === PLAN
          ? (state.detailDigest ?? currentDigest())
          : state.extraWork.find((item) => item.id === input.id);
      if (!digest) throw Error("Unknown controlled work record");
      return route.fulfill({ json: digest });
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
            name: plan.definition.name,
            kind: "workflow",
            status: state.status,
            nextStep: state.rowNextStep,
            conversationId: state.linkedConversationId,
            latestRunId: state.run?.id ?? null,
            ...(state.omitDigest
              ? {}
              : { digest: compactDigest(state.summaryDigest ?? currentDigest()) })
          },
          ...state.extraWork.map((digest) => ({
            id: digest.id,
            projectId: digest.projectId,
            name: digest.name,
            kind: digest.kind,
            status: digest.state,
            conversationId: state.extraLinks[digest.id] ?? null,
            digest: compactDigest(digest)
          }))
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
        modelAvailable: state.modelAvailable
      };
    else if (name === "list_plans") result = { plans: [plan] };
    else if (name === "create_plan") {
      plan.definition = workflowDefinitionSchema.parse(input.definition);
      plan.work = "todo";
      plan.attemptId = null;
      plan.latestRunId = undefined;
      state.status = "todo";
      state.run = null;
      result = plan;
    } else if (name === "get_plan") {
      if (input.id !== PLAN)
        return route.fulfill({
          status: 503,
          json: { code: "UNAVAILABLE", error: "This work's plan could not be read." }
        });
      result = plan;
    } else if (name === "run_plan") {
      state.status = "waiting_input";
      plan.work = "in_progress";
      state.run = {
        version: 1,
        id: randomUUID(),
        planId: PLAN,
        ownerId: "browser-proof",
        attemptEpoch: 1,
        definition: plan.definition,
        revision: 1,
        status: "waiting_input",
        steps: [
          {
            id: "read",
            name: "Read report",
            status: "completed",
            output: { items: 3 },
            endedAt: "2026-10-10T20:00:01Z"
          },
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
      if (state.toolRunError) {
        state.status = "failed";
        plan.work = "todo";
        state.run.status = "failed";
        state.run.error = state.toolRunError;
        state.run.steps = [
          {
            id: plan.definition.steps[0].id,
            name: plan.definition.steps[0].name,
            status: "failed",
            error: state.toolRunError,
            endedAt: state.run.updatedAt
          }
        ];
      }
      plan.attemptId = state.run.status === "failed" ? null : state.run.id;
      plan.latestRunId = state.run.id;
      result = state.run;
    } else if (name === "get_run") result = state.run;
    else if (name === "submit_step_result") {
      if (state.responseError)
        return route.fulfill({
          status: 503,
          json: { code: "UNAVAILABLE", error: state.responseError }
        });
      if (!state.run) throw Error("No active controlled run");
      const index = state.run.steps.findIndex((step) => step.id === input.stepId);
      if (index < 0 || state.run.status !== "waiting_input")
        throw Error("No pending controlled step");
      const declared = plan.definition.steps.find((step) => step.id === input.stepId)!;
      const output = input.output;
      const object =
        output !== null && typeof output === "object" && !Array.isArray(output)
          ? (output as { approved?: unknown })
          : null;
      const declined =
        declared.action.type === "human" &&
        declared.success?.path === "approved" &&
        declared.success.equals === true &&
        object?.approved === false;
      // These controlled journeys declare only approval rules; reject before changing any stored result.
      if (
        declared.success?.path === "approved" &&
        !declined &&
        object?.approved !== declared.success.equals
      )
        return route.fulfill({
          status: 422,
          json: {
            code: "success_not_met",
            error: "Submitted output does not satisfy the step's success condition"
          }
        });
      state.status = declined ? "failed" : "completed";
      plan.work = declined ? "todo" : "done";
      plan.attemptId = null;
      state.run.status = declined ? "failed" : "completed";
      state.run.steps[index] = {
        ...state.run.steps[index],
        status: declined ? "failed" : "completed",
        output,
        ...(declined ? { error: "Step not approved." } : {}),
        endedAt: "2026-10-10T20:02:03Z"
      };
      if (declined) state.run.error = "Step not approved.";
      state.run.updatedAt = "2026-10-10T20:02:03Z";
      state.run.endedAt = state.run.updatedAt;
      result = state.run;
    } else if (name === "respond_to_task_request") {
      if (!state.taskResponse) throw Error("No controlled pending task request");
      result = state.taskResponse(input);
    } else if (name === "stop_run") {
      if (!state.run) throw Error("No active controlled run");
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
  return { state, seen, plan, currentDigest, conversations };
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
      [
        "get_workspace",
        "get_work_digest",
        "list_plans",
        "list_actions",
        "get_plan",
        "get_run"
      ].includes(entry.name)
    )
  ).toBe(true);
  expect(app.controls.inputs).toEqual([]);
  expect(app.pending.size).toBe(0);
});

test("explicit execution opens the selected project controls and human review records the supplied result", async ({
  page,
  app
}) => {
  const { seen, state, plan } = await homeData(page);
  plan.definition = workflowDefinitionSchema.parse({
    ...plan.definition,
    steps: plan.definition.steps.map((step) =>
      step.id === "review" ? { ...step, success: { path: "approved", equals: true } } : step
    )
  });
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
  await page.locator("#workspaceActionClose").click();
  await expect(page.locator("#needsCount")).toHaveText("1");
  await page.locator("#workTab").click();
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Pending decision" })).toContainText(
    "Review the three reported items."
  );
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  const review = { approved: true, note: "Reviewed the three reported items" };
  await expect(page.locator("#workflowHumanApproval")).toBeChecked();
  await expect(page.locator("#workflowHumanFormatHelp")).toHaveText(
    "Records an approval decision with an optional note."
  );
  await expect(page.locator("#detail #respondCurrent")).toHaveCount(0);
  await expect(page.locator("#workflowHumanRule")).toContainText("approved equals true");
  await expect(page.locator("#workflowHumanRule")).toContainText("ends this run");
  await page.locator("#workflowHumanNote").fill(review.note);
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "completed");
  if (!state.run) throw Error("The controlled run did not start");
  expect(seen.find((entry) => entry.name === "submit_step_result")).toMatchObject({
    input: { id: state.run.id, projectId: PROJECT, stepId: "review", output: review }
  });
  expect(state.run.steps[0].output).toEqual({ items: 3 });
  expect(state.run.steps[1].output).toEqual(review);
  await expect(page.locator("#workflowStop")).toBeDisabled();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  await expect(page.locator("#needsCount")).toHaveText("0");
  await page.locator('#workView .filter[data-status="completed"]').click();
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Current work summary" })).toContainText(
    "Approval recorded"
  );
  await expect(page.getByRole("region", { name: "Current work summary" })).toContainText(
    "task not verified"
  );
  const decisions = page.getByRole("region", { name: "Recorded decisions" });
  await expect(decisions).toContainText("Approved");
  await expect(decisions).toContainText(review.note);
  await expect(page.getByRole("region", { name: "Current work summary" })).not.toContainText(
    "by you"
  );
  await expect(decisions).not.toContainText("by you");
  await expect(decisions.locator("time")).toHaveAttribute("datetime", "2026-10-10T20:02:03Z");
  await expect(page.locator("#openCurrent")).toHaveText("Open controls");
  await page.locator('[data-detail-tab="activity"]').click();
  await expect(
    page.locator(".activity-item").filter({ hasText: "Review report result" }).locator("time")
  ).toHaveAttribute("datetime", "2026-10-10T20:02:03Z");
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
  if (!state.run) throw Error("The controlled run did not start");
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

test("digest cards reconcile decisions, confirmed activity, allocations and read failures", async ({
  page,
  app
}) => {
  const { state, seen, currentDigest } = await homeData(page);
  const base = currentDigest();
  state.rowNextStep = "Old directory next step";
  state.extraWork = [
    {
      ...base,
      id: randomUUID(),
      name: "Approve report",
      state: "needs_decision",
      stateText: "Your decision is needed.",
      next: { stepId: "review", name: "Approve report", actor: "You" },
      decision: {
        stepId: "review",
        kind: "result",
        prompt: "Review the report before approving the recorded outcome."
      }
    },
    {
      ...base,
      id: randomUUID(),
      name: "Report executing",
      state: "running",
      stateText: "The recorded run reports running.",
      run: {
        id: randomUUID(),
        revision: 1,
        status: "running",
        updatedAt: "2026-10-10T20:00:00Z",
        current: true
      }
    },
    {
      ...base,
      id: randomUUID(),
      name: "Coding allocation",
      kind: "coding",
      revision: null,
      state: "allocated",
      stateText: "Allocated; running is not confirmed.",
      progress: null,
      next: { stepId: "coding", name: "Inspect saved code", actor: "Configured coding host" }
    },
    {
      ...base,
      id: randomUUID(),
      name: "Unreadable report",
      state: "needs_attention",
      stateText: "The recorded run could not be read.",
      errors: ["Saved run data is unavailable."]
    },
    {
      ...base,
      id: randomUUID(),
      name: "Finished report",
      state: "completed",
      stateText: "Run completed; task not independently verified.",
      next: null
    },
    {
      ...base,
      id: randomUUID(),
      name: "Cancelled report",
      state: "cancelled",
      stateText: "This work was cancelled.",
      next: null
    }
  ];
  await app.pair(page);
  await expect(page.locator("#needsCount")).toHaveText("1");
  await expect(page.locator("#inProgressCount")).toHaveText("2");
  await expect(page.locator("#progressBreakdown")).toHaveText(
    "1 recorded running · allocation unconfirmed"
  );
  await expect(page.locator("#readyCount")).toHaveText("1");
  await expect(page.locator("#attentionCount")).toHaveText("1");
  await expect(page.locator("#visibleCount")).toHaveText("5 items");
  await expect(page.locator("#outstandingCount")).toHaveText("5");
  await expect(
    page.locator('#workList [data-work="' + state.extraWork[0].id + '"]')
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator('#workView .filter[data-status="needs"]').click();
  await expect(page.locator("#workList")).toContainText("Review the report before approving");
  await expect(page.locator("#workList")).not.toContainText("Unreadable report");
  await page.locator('#workView .filter[data-status="attention"]').click();
  await expect(page.locator("#workList")).toContainText("Saved run data is unavailable.");
  await expect(page.locator("#workList [data-work]")).toHaveCount(1);
  await page.locator('#workView .filter[data-status="in_progress"]').click();
  await expect(page.locator("#workList")).toContainText("Allocated, not confirmed running");
  await expect(page.locator("#workList")).toContainText(
    "Next: Inspect saved code · Configured coding host"
  );
  await page.locator('#workView .filter[data-status="outstanding"]').click();
  await page.locator("#search").fill("Inspect saved code");
  await expect(page.locator("#workList")).toContainText("Coding allocation");
  await page.locator("#search").fill("Old directory next step");
  await expect(page.locator("#workList [data-work]")).toHaveCount(0);
  await page.locator("#search").fill("");
  await page.locator('#workView .filter[data-status="completed"]').click();
  await expect(page.locator("#workList")).toContainText("Finished report");
  await expect(page.locator("#workList")).not.toContainText("Cancelled report");
  expect(seen.some((entry) => entry.name === "run_plan")).toBe(false);
  expect(app.controls.inputs).toEqual([]);
});

test("an edited plan keeps prior approval and completion in history", async ({ page, app }) => {
  const { plan, state } = await homeData(page);
  plan.revision = 2;
  const olderRunId = randomUUID();
  plan.latestRunId = olderRunId;
  state.run = {
    version: 1,
    id: olderRunId,
    ownerId: "browser-proof",
    planId: PLAN,
    revision: 1,
    attemptEpoch: 1,
    definition,
    status: "completed",
    startedAt: "2026-10-10T19:00:00Z",
    updatedAt: "2026-10-10T19:05:00Z",
    steps: [
      {
        id: "read",
        name: "Read report",
        status: "completed",
        output: { status: 200, data: { verification: "Report writer's claim" } },
        endedAt: "2026-10-10T19:01:00Z"
      },
      {
        id: "review",
        name: "Review report result",
        status: "completed",
        output: { approved: true, note: "Earlier approval" },
        endedAt: "2026-10-10T19:05:00Z"
      }
    ]
  };
  await app.pair(page);
  await expect(page.locator("#workList")).toContainText("Edited since the last run.");
  const recordedTime = page.locator('#workList [data-work="' + PLAN + '"] time');
  await expect(recordedTime).toContainText("Last run (historical):");
  await expect(recordedTime).toHaveAttribute("title", "2026-10-10T19:05:00Z");
  await expect(recordedTime).not.toContainText("Edited");
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  const summary = page.getByRole("region", { name: "Current work summary" });
  await expect(summary).toContainText("Edited since the last run.");
  await expect(summary).toContainText("Not verified");
  await expect(summary).not.toContainText("Approval recorded");
  await expect(summary).toContainText("revision 1 · historical");
  await expect(page.locator("#runCurrent")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded decisions" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const rowWidth = await recordedTime.evaluate((element) => {
    const time = element.getBoundingClientRect(),
      row = element.closest("button")!.getBoundingClientRect();
    return { right: time.right, rowRight: row.right, width: innerWidth };
  });
  expect(rowWidth.right).toBeLessThanOrEqual(rowWidth.rowRight + 1);
  expect(rowWidth.rowRight).toBeLessThanOrEqual(rowWidth.width + 1);
  await page.locator('[data-detail-tab="activity"]').click();
  await expect(page.locator("#detail")).toContainText("Historical execution · revision 1");
});

test("desktop selection stays visible after resizing to mobile and active history remains legible with linked work", async ({
  page,
  app
}) => {
  const { state, currentDigest } = await homeData(page);
  const base = currentDigest();
  state.extraWork = Array.from({ length: 16 }, (_, index) => ({
    ...base,
    id: randomUUID(),
    name: "Prepared review " + index
  }));
  state.extraWork[15] = {
    ...state.extraWork[15],
    state: "allocated",
    name: "Inspect the saved repository outcome and recorded evidence before continuing this allocated preparation task",
    stateText: "Allocated; running is not confirmed."
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await app.pair(page);
  await page.locator("#workList").getByText(state.extraWork[15].name, { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.locator("#workList").evaluate((list) => {
        const row = list.querySelector('[aria-pressed="true"]')!,
          title = row.querySelector(".row-title")!;
        const box = list.getBoundingClientRect(),
          bounds = title.getBoundingClientRect();
        return (
          bounds.top >= box.top + list.clientTop - 1 &&
          bounds.bottom <= box.top + list.clientTop + list.clientHeight + 1
        );
      })
    )
    .toBe(true);
  const bounds = await page.locator("#workList").evaluate((list) => {
    const row = list.querySelector('[aria-pressed="true"]')!;
    const a = list.getBoundingClientRect(),
      b = row.getBoundingClientRect();
    return {
      top: b.top - a.top,
      bottom: a.bottom - b.bottom,
      height: a.height,
      limit: innerHeight * 0.6,
      viewportTop: b.top,
      viewportBottom: b.bottom,
      viewportHeight: innerHeight
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom).toBeGreaterThanOrEqual(-1);
  expect(bounds.height).toBeLessThanOrEqual(bounds.limit + 1);
  expect(bounds.viewportTop).toBeGreaterThanOrEqual(-1);
  expect(bounds.viewportBottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
  const expectedBadge = await page.locator('[data-work="' + PLAN + '"] .badge').textContent();
  await page.locator("#conversationsTab").click();
  await expect(page.locator("#conversationDetail .plan-chip small").first()).toHaveText(
    expectedBadge!
  );
  await expect(page.locator("#conversationList")).toContainText("Idle");
  await expect(page.locator("#conversationList .conversation-row > span")).toContainText("Idle");
  await expect(page.locator("#conversationList .conversation-row > span")).not.toContainText(
    "Ready to start"
  );
  await page.locator("#continueConversation").click();
  await expect(page.locator("#thread .bubble.user")).toContainText("Review the report");
  const appearance = await page.locator("#thread .bubble.user").evaluate((node) => ({
    opacity: getComputedStyle(node).opacity,
    animation: getComputedStyle(node).animationName
  }));
  expect(appearance.opacity).toBe("1");
  expect(appearance.animation).toBe("none");
  await expect(page.locator("#conversationLinkedWork")).toContainText("Report review");
  await expect(page.locator("#conversationLinkedWork .badge").first()).toHaveText(expectedBadge!);
  const chip = page.locator("#conversationLinkedWork .plan-chip").first();
  const separation = await chip.evaluate((node) => {
    const name = node.querySelector("strong")!.getBoundingClientRect(),
      status = node.querySelector("small")!.getBoundingClientRect();
    return status.top >= name.bottom;
  });
  expect(separation).toBe(true);
  await page.locator("#conversationLinkedWork").getByRole("button", { name: "Open plan" }).click();
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
});

test("the decision detail reads the full prompt and opens the existing response form", async ({
  page,
  app
}) => {
  const prompt =
    "Review the reported repository, paths, and verification source. ".repeat(8) +
    "Confirm the actual recorded evidence before responding.";
  const { seen } = await homeData(page, false, prompt);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  await expect(page.getByRole("region", { name: "Pending decision" })).toContainText(prompt);
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowHumanInstructions")).toHaveText(prompt);
  expect(seen.some((entry) => entry.name === "get_work_digest")).toBe(true);
  expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(1);
});

test.describe("coding decision inspection", () => {
  test.use({ planStatus: true });
  test("coding review shows where approval happens without advertising a working Respond action", async ({
    page,
    app
  }) => {
    const { state, currentDigest, seen } = await homeData(page);
    const codingId = randomUUID();
    state.extraWork = [
      {
        ...currentDigest(),
        id: codingId,
        kind: "coding",
        name: "Review saved patch",
        revision: null,
        state: "needs_decision",
        stateText: "A recorded coding outcome needs review.",
        next: { stepId: "leaf-review", name: "Review saved patch", actor: "You" },
        decision: {
          stepId: "leaf-review",
          kind: "result",
          prompt: "Review the recorded patch outcome."
        },
        progress: { done: 1, total: 3 },
        alsoAllocated: 1,
        verification: {
          by: "hekate_accepted",
          at: null,
          ref: "leaf:leaf-accepted",
          scope: "step",
          stepId: "leaf-accepted"
        }
      }
    ];
    await page.route("**/development/plans/*/status", (route) =>
      route.fulfill({
        json: {
          status: "ok",
          rootId: codingId,
          progress: { totalLeaves: 3, accepted: 1 },
          leaves: [
            { nodeId: "leaf-review", name: "Review saved patch", state: "review_pending" },
            { nodeId: "leaf-allocated", name: "In-flight saved patch", state: "in_progress" },
            { nodeId: "leaf-accepted", name: "Accepted saved patch", state: "accepted" }
          ]
        }
      })
    );
    state.extraLinks[codingId] = THREAD;
    await app.pair(page);
    await expect(page.locator("#needsCount")).toHaveText("1");
    await expect(page.locator("#inProgressCount")).toHaveText("0");
    await expect(page.locator("#progressBreakdown")).toHaveText(
      "0 recorded running · allocation unconfirmed"
    );
    await expect(page.locator("#progressBreakdown")).not.toContainText("0 allocated");
    await expect(page.locator("#workList .row-allocation")).toHaveText(
      "Also allocated: 1 item · running is not confirmed"
    );
    await page.locator("#workList").getByText("Review saved patch", { exact: true }).click();
    await expect(page.getByRole("region", { name: "Current work summary" })).toContainText(
      "Leaf accepted in Hekate · task not verified"
    );
    await expect(page.getByRole("region", { name: "Current work summary" })).toContainText(
      "1 of 3 items accepted"
    );
    const allocatedLeaf = page
      .locator("#detail .step")
      .filter({ hasText: "In-flight saved patch" });
    await expect(allocatedLeaf).toContainText("Allocated, running unknown");
    await expect(allocatedLeaf).not.toContainText(/\bRunning\b/);
    const decision = page.getByRole("region", { name: "Pending decision" });
    await expect(decision).toContainText("Submit approval in the coding coordinator");
    await expect(decision.getByRole("button", { name: "Respond", exact: true })).toHaveCount(0);
    await decision.getByRole("button", { name: "Review details", exact: true }).click();
    await expect(page.locator("#workspaceActionDialog")).toBeVisible();
    await expect(page.locator("#planRoot")).toHaveValue(codingId);
    await expect(page.locator("#workspaceActionDialogStatus")).toContainText(
      "Execution is unavailable"
    );
    await page.locator("#workspaceActionClose").click();
    await page.locator("#conversationsTab").click();
    await page.locator("#continueConversation").click();
    const linked = page.getByRole("region", { name: "Linked work" });
    const coding = linked.locator(".plan-chip").filter({ hasText: "Review saved patch" });
    await expect(coding.getByRole("button", { name: "Respond", exact: true })).toHaveCount(0);
    await coding.getByRole("button", { name: "Review details", exact: true }).click();
    await expect(page.locator("#planRoot")).toHaveValue(codingId);
    expect(seen.some((entry) => entry.name === "run_plan")).toBe(false);
  });
});

test("a summary that changed while reading cannot advertise a current decision or completed outcome", async ({
  page,
  app
}) => {
  const { state, currentDigest } = await homeData(page);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  const digest = currentDigest();
  if (!digest.run) throw Error("No controlled run started");
  state.detailDigest = {
    ...digest,
    state: "completed",
    stateText: "Run completed.",
    decision: null,
    next: null,
    run: { ...digest.run, status: "completed" }
  };
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  await page.locator("#workList").getByText("Report review", { exact: true }).click();
  const now = page.getByRole("region", { name: "Current work summary" });
  await expect(now).toContainText("changed during this read");
  await expect(now).toContainText("Needs attention");
  await expect(now).not.toContainText("Run completed.");
  await expect(page.locator("#respondDecision")).toHaveCount(0);
  await expect(page.locator("#respondCurrent")).toHaveCount(0);
  await expect(page.locator("#openCurrent")).toBeEnabled();
});

async function startResponse(page: Page) {
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "waiting_input");
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowRespond")).toBeVisible();
}

async function continueConversationIfPreview(page: Page) {
  if (await page.locator("#continueConversation").isVisible())
    await page.locator("#continueConversation").click();
  await expect(page.locator("#conversationDetail .chat-shell")).toBeVisible();
}

test("linked waiting work can be answered from its original conversation without another run", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  await page.locator("#conversationsTab").click();
  await expect(
    page.locator('#conversationList [data-conversation="' + THREAD + '"]')
  ).toContainText("Linked: Report review");
  await expect(
    page.locator('#conversationList [data-conversation="' + THREAD + '"]')
  ).toContainText("Idle");
  await continueConversationIfPreview(page);
  await expect(page.locator("#conversationDetail .panel-header .sub")).toContainText(
    "Report project"
  );
  await expect(page.locator("#conversationDetail .panel-header .sub")).toContainText(
    "1 linked work item"
  );
  const linked = page.getByRole("region", { name: "Linked work" });
  await expect(linked).toContainText("Review the three reported items.");
  await expect(linked.locator(".badge")).toHaveText("Needs your decision");
  await linked.getByRole("button", { name: "Respond", exact: true }).scrollIntoViewIfNeeded();
  const geometry = await linked.evaluate((element) => {
    const box = element.getBoundingClientRect(),
      thread = document.getElementById("thread")!.getBoundingClientRect();
    const button = element.querySelector("button")!.getBoundingClientRect();
    return {
      beforeThread: box.bottom <= thread.top,
      buttonLeft: button.left,
      buttonRight: button.right,
      width: innerWidth,
      overflow: document.documentElement.scrollWidth
    };
  });
  expect(geometry.beforeThread).toBe(true);
  expect(geometry.buttonLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.width);
  expect(geometry.overflow).toBeLessThanOrEqual(geometry.width + 1);
  await linked.getByRole("button", { name: "Respond", exact: true }).click();
  await expect(page.locator("#workspaceActionTitle")).toContainText("Review report result");
  await page.locator("#workflowHumanText").fill("The recorded values are consistent.");
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  await expect(linked.locator(".badge")).toHaveText("Completed");
  await expect(page.locator("#needsCount")).toHaveText("0");
  expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(1);
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toEqual([
    expect.objectContaining({
      input: {
        id: state.run!.id,
        stepId: "review",
        projectId: PROJECT,
        output: { text: "The recorded values are consistent." }
      },
      conversation: THREAD
    })
  ]);
});

test("linked response actions fail closed for missing, historical, unreadable and stale summaries", async ({
  page,
  app
}) => {
  const { state, currentDigest, seen } = await homeData(page);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  await page.locator("#conversationsTab").click();
  await continueConversationIfPreview(page);
  const linked = page.getByRole("region", { name: "Linked work" });
  const waiting = currentDigest();
  for (const override of [
    { ...waiting, run: null },
    { ...waiting, run: { ...waiting.run!, current: false } },
    { ...waiting, errors: ["Current run data could not be read."] }
  ]) {
    state.summaryDigest = override;
    await page.locator("#refresh").click();
    await expect(linked.getByRole("button", { name: "Respond", exact: true })).toHaveCount(0);
    await expect(linked.getByRole("button", { name: "Open plan", exact: true })).toBeVisible();
  }
  state.omitDigest = true;
  await page.locator("#refresh").click();
  await expect(linked).toContainText("Work summary could not be read.");
  await expect(linked.locator(".badge")).toHaveText("Needs attention");
  await expect(linked.getByRole("button", { name: "Respond", exact: true })).toHaveCount(0);
  state.omitDigest = false;
  state.summaryDigest = waiting;
  await page.locator("#refresh").click();
  await expect(linked.getByRole("button", { name: "Respond", exact: true })).toBeVisible();
  state.run!.status = "completed";
  state.run!.steps[1].status = "completed";
  state.run!.steps[1].output = { text: "Already answered elsewhere." };
  await linked.getByRole("button", { name: "Respond", exact: true }).click();
  await expect(page.locator("#workspaceActionStatus")).toContainText("no longer waiting");
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(0);
  expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(1);
});

test("terminal linked work opens recorded controls without executing again", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  await page.locator("#conversationsTab").click();
  await continueConversationIfPreview(page);
  const linked = page.getByRole("region", { name: "Linked work" });
  for (const status of ["completed", "failed", "stopped"] as const) {
    state.run!.status = status;
    state.run!.steps[1].status = status;
    state.run!.steps[1].endedAt = "2026-10-10T20:03:00Z";
    if (status === "failed") {
      state.run!.error = "Step action failed";
      state.run!.steps[1].error = state.run!.error;
    } else {
      delete state.run!.error;
      delete state.run!.steps[1].error;
    }
    await page.locator("#refresh").click();
    await expect(linked.locator(".badge")).toHaveText(
      status === "completed" ? "Completed" : "Needs attention"
    );
    if (status === "failed") await expect(linked).toContainText("Step action failed");
    await linked.getByRole("button").click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", status);
    await expect(page.locator("#workflowHumanForm")).toBeHidden();
    expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(1);
    await page.locator("#workspaceActionClose").click();
  }
});

test("an unassigned conversation keeps general scope and omits unrelated project conversation metadata", async ({
  page,
  app
}) => {
  const { state, conversations, seen } = await homeData(page);
  conversations[0].projectId = null;
  state.linkedConversationId = null;
  await app.pair(page);
  await page.locator("#conversationsTab").click();
  await continueConversationIfPreview(page);
  await expect(page.locator("#conversationDetail .panel-header .sub")).toContainText("General");
  await expect(page.locator("#conversationDetail .panel-header .sub")).not.toContainText(
    "linked work"
  );
  await expect(page.locator("#conversationLinkedWork")).toBeHidden();
  const context = page.locator("#selectedConversationContext");
  await expect(context).not.toBeVisible();
  const text = await context.textContent();
  await page.locator("#conversationOptions > summary").click();
  await expect(context).toBeVisible();
  await expect(context).toHaveText(text!);
  expect(app.pending.size).toBe(0);
  const reads = [
    "get_workspace",
    "get_work_digest",
    "get_plan",
    "get_run",
    "list_plans",
    "list_actions"
  ];
  expect(seen.every((entry) => reads.includes(entry.name))).toBe(true);
  await page.locator("#workTab").click();
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workflowHumanText").fill("Explicit response in the plan's project.");
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  const calls = seen.filter((entry) => ["run_plan", "submit_step_result"].includes(entry.name));
  expect(calls).toHaveLength(2);
  expect(
    calls.every((entry) => entry.input.projectId === PROJECT && entry.conversation === undefined)
  ).toBe(true);
});

/** Check actual controls after scrolling the fields, including pointer clearance. */
async function expectResponseControlsClear(page: Page, selectors: string[]) {
  const geometry = await page.locator("#workspaceActionDialog").evaluate((dialog, selectors) => {
    const modal = dialog.getBoundingClientRect();
    const header = dialog.querySelector("header")!.getBoundingClientRect();
    const submit = dialog.querySelector("#workflowHumanSubmit")!.getBoundingClientRect();
    return selectors.map((selector) => {
      const element = dialog.querySelector(selector)!;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        selector,
        top: box.top,
        bottom: box.bottom,
        visibleTop: Math.max(0, modal.top, header.bottom),
        visibleBottom: Math.min(innerHeight, modal.bottom),
        unobscured: !!hit && (hit === element || element.contains(hit)),
        overlapsSubmit:
          selector !== "#workflowHumanSubmit" && box.top < submit.bottom && box.bottom > submit.top
      };
    });
  }, selectors);
  for (const control of geometry) {
    expect(control.top, control.selector).toBeGreaterThanOrEqual(control.visibleTop);
    expect(control.bottom, control.selector).toBeLessThanOrEqual(control.visibleBottom);
    expect(control.unobscured, control.selector).toBe(true);
    expect(control.overlapsSubmit, control.selector).toBe(false);
  }
}

test("Respond at 390px shows the question and plain answer without developer controls", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await app.pair(page);
  await startResponse(page);
  const dialog = page.locator("#workspaceActionDialog");
  await expect(dialog.locator("#workspaceActionTitle")).toHaveText(
    "Respond · Review report result"
  );
  await expect(dialog.locator("#workflowHumanInstructions")).toHaveText(
    "Review the three reported items."
  );
  await expect(dialog.locator("#workflowRun")).toHaveCount(0);
  await expect(dialog.locator("#workflowStop")).toHaveCount(0);
  await expect(page.locator("#workflowHumanPlain")).toBeChecked();
  await expect(page.locator("#workflowHumanFormatHelp")).toHaveText(
    "Records your written answer as text. No result rule is declared."
  );
  await expect(page.locator("#workflowHumanRaw")).not.toBeVisible();
  await expect(page.locator("#workflowRespondStatus")).toBeEmpty();
  const hierarchy = await page.locator("#workflowRespondAdvanced").evaluate((element) => ({
    advanced: getComputedStyle(element).backgroundColor,
    submit: getComputedStyle(document.getElementById("workflowHumanSubmit")!).backgroundColor,
    decoration: getComputedStyle(element).textDecorationLine
  }));
  expect(hierarchy.advanced).toBe("rgba(0, 0, 0, 0)");
  expect(hierarchy.submit).not.toBe(hierarchy.advanced);
  expect(hierarchy.decoration).toContain("underline");
  await page
    .locator("#workflowHumanText")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expectResponseControlsClear(page, [
    "#workflowHumanText",
    "#workflowHumanAdvanced > summary",
    "#workflowHumanSubmit"
  ]);
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRespondStatus")).toHaveText("Write your answer first.");
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(0);
  await page.locator("#workflowHumanText").fill("  The reported items match the source.  ");
  await page.locator("#workflowHumanSubmit").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#needsCount")).toHaveText("0");
  expect(state.run?.steps[1].output).toEqual({ text: "The reported items match the source." });
});

test("raw response errors stay visible and preserve arbitrary JSON until confirmed saved", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  await app.pair(page);
  await startResponse(page);
  await page.locator("#workflowHumanAdvanced > summary").click();
  await page.locator("#workflowHumanRaw").check();
  await page.locator("#workflowHumanOutput").fill("{invalid}");
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRespondStatus")).toHaveText(
    "Step result must be valid JSON."
  );
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(0);
  state.responseError = "The result could not be persisted.";
  await page.locator("#workflowHumanOutput").fill('{"score":3,"tags":["reviewed"]}');
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRespondStatus")).toHaveText(state.responseError);
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  await expect(page.locator("#workflowHumanOutput")).toHaveValue('{"score":3,"tags":["reviewed"]}');
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workspaceActionReopen").click();
  await expect(page.locator("#workflowHumanRaw")).toBeChecked();
  await expect(page.locator("#workflowHumanOutput")).toHaveValue('{"score":3,"tags":["reviewed"]}');
  await expect(page.locator("#workflowHumanAdvanced")).toHaveJSProperty("open", true);
  expect(state.run?.status).toBe("waiting_input");
  state.responseError = "";
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  expect(state.run?.steps[1].output).toEqual({ score: 3, tags: ["reviewed"] });
});

test("closing Respond stops hidden polling and reopens one preserved form in full controls", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await app.pair(page);
  await startResponse(page);
  await page.clock.install();
  await page.locator("#workflowHumanText").fill("Keep this draft while reviewing the evidence.");
  await page.locator("#workflowRespondEvidence > summary").click();
  await expect(page.locator("#workflowRespondEvidence #workflowSteps")).toContainText(
    "Read report"
  );
  await page.locator("#workspaceActionClose").click();
  await expect(page.locator("#workflowPanel")).toHaveJSProperty("open", false);
  await expect(page.locator("#workView")).toBeVisible();
  // Directory refresh may read the run once; finish it before measuring the closed interval.
  await expect(page.locator("#detail")).toContainText("Needs you");
  await page.clock.fastForward(500);
  const reads = seen.filter((entry) => entry.name === "get_run").length;
  await page.clock.fastForward(5000);
  expect(seen.filter((entry) => entry.name === "get_run")).toHaveLength(reads);
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(0);
  await page.locator("#workspaceActionReopen").click();
  await expect(page.locator("#workflowHumanText")).toHaveValue(
    "Keep this draft while reviewing the evidence."
  );
  await page.locator("#workflowRespondAdvanced").click();
  await expect(page.locator("#workspaceActionBody > #workflowPanel")).toBeVisible();
  await expect(page.locator("#workflowRunView > #workflowRespond")).toBeVisible();
  await expect(page.locator("#workflowHumanText")).toHaveValue(
    "Keep this draft while reviewing the evidence."
  );
  await expect(page.locator("#workflowHumanForm")).toHaveCount(1);
  await expect(page.locator("#workflowSteps")).toHaveCount(1);
  await page.locator("#workspaceActionClose").click();
  await expect(page.locator("#workflowPanel")).toHaveJSProperty("open", false);
});

test("agent Respond uses actual context and tool request shapes in focused forms", async ({
  page,
  app
}) => {
  const { state, seen, plan } = await homeData(page);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  if (!state.run) throw Error("No controlled run");
  plan.definition = workflowDefinitionSchema.parse({
    version: 1,
    name: "Report review",
    steps: [
      {
        id: "task",
        name: "Find reporting context",
        inputs: {},
        action: {
          type: "agent",
          executor: "claude",
          task: {
            objective: "Use the actual report",
            tools: ["fetch_report"],
            completionCriteria: ["Describe its period"]
          }
        }
      }
    ]
  });
  state.run.definition = plan.definition;
  const contextId = randomUUID(),
    toolId = randomUUID();
  const agent = {
    executor: "claude",
    allowedTools: ["fetch_report"],
    requests: [
      {
        id: contextId,
        kind: "context" as const,
        prompt: "Which reporting period should I use?",
        status: "pending" as "pending" | "answered",
        requestedAt: "2026-10-10T20:00:01Z",
        response: undefined as unknown
      }
    ],
    events: [],
    checkpoint: { private: "NEVER_RENDER_PRIVATE_CHECKPOINT" }
  };
  state.run.steps = [
    { id: "task", name: "Find reporting context", status: "waiting_input", agent }
  ];
  state.taskResponse = (input) => {
    if (!state.run) throw Error("No controlled run");
    const request = state.run.steps[0].agent!.requests.find((item) => item.id === input.requestId)!;
    request.status = "answered";
    request.response = input.response;
    if (input.requestId === contextId) {
      state.run.steps[0].agent!.requests.push({
        id: toolId,
        kind: "tool",
        tool: "fetch_report",
        prompt: "May I read the report?",
        status: "pending",
        requestedAt: "2026-10-10T20:01:00Z"
      });
    } else {
      state.run.status = "completed";
      state.run.steps[0].status = "completed";
      state.run.steps[0].output = { text: "The requested report was read." };
      state.status = "completed";
      plan.work = "done";
    }
    return state.run;
  };
  await page.locator("#workTab").click();
  await page.locator("#refresh").click();
  await expect(page.getByRole("region", { name: "Pending decision" })).toContainText(
    "Which reporting period"
  );
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowAgentRequestHeading")).toHaveText("The agent asks:");
  await page.locator("#workflowAgentResponse").fill("October 2026");
  await page.locator("#workflowAgentRespond").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Pending decision" })).toContainText(
    "May I read the report?"
  );
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowAgentRequestHeading")).toHaveText(
    "The agent wants to use a tool:"
  );
  await expect(page.locator("#workflowAgentToolDescription")).toHaveText(
    "fetch_report — Read a report"
  );
  await page.locator("#workflowAgentAllow").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  expect(
    seen.filter((entry) => entry.name === "respond_to_task_request").map((entry) => entry.input)
  ).toEqual([
    {
      id: state.run.id,
      projectId: PROJECT,
      stepId: "task",
      requestId: contextId,
      response: "October 2026"
    },
    {
      id: state.run.id,
      projectId: PROJECT,
      stepId: "task",
      requestId: toolId,
      response: { approved: true }
    }
  ]);
  await expect(page.locator("body")).not.toContainText("NEVER_RENDER_PRIVATE_CHECKPOINT");
});

test("a negative approval records its output and keeps failed execution evidence visible", async ({
  page,
  app
}) => {
  const { state, plan, seen, currentDigest } = await homeData(page);
  plan.definition = workflowDefinitionSchema.parse({
    ...plan.definition,
    steps: plan.definition.steps.map((step) =>
      step.id === "review" ? { ...step, success: { path: "approved", equals: true } } : step
    )
  });
  await app.pair(page);
  await startResponse(page);
  await page.locator("#workflowHumanDoNotApprove").check();
  await page.locator("#workflowHumanNote").fill("The source is incomplete.");
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workspaceActionDialog")).toBeVisible();
  await expect(page.locator("#workflowRespondStatus")).toContainText("Step not approved.");
  await expect(page.locator("#workflowRespondContext")).toHaveText(
    "Report review · Failed · no pending response"
  );
  await expect(page.locator("#workflowHumanForm")).toBeHidden();
  await expect(page.locator("#needsCount")).toHaveText("0");
  await expect(page.locator("#attentionCount")).toHaveText("1");
  expect(state.run?.steps[1].output).toEqual({
    approved: false,
    note: "The source is incomplete."
  });
  await page.locator("#workflowRespondEvidence > summary").click();
  await expect(page.locator("#workflowSteps")).toContainText("The source is incomplete.");
  expect(currentDigest().errors).toEqual([]);
  expect(currentDigest().approval).toBeNull();
  expect(currentDigest().lastOutcome?.summary).toBe("Step not approved.");
  await page.locator("#workflowRespondAdvanced").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "failed");
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  const now = page.getByRole("region", { name: "Current work summary" });
  await expect(now).toContainText("Not approved");
  await expect(now).toContainText("start a new run from step one");
  await expect(now.getByRole("button", { name: /Approval evidence/ })).toHaveCount(0);
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(1);
  expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(1);
});

test("plain answers on an approval-gated step stay waiting while a ruleless decline completes", async ({
  page,
  app
}) => {
  const { state, plan, seen } = await homeData(page);
  plan.definition = workflowDefinitionSchema.parse({
    ...plan.definition,
    steps: plan.definition.steps.map((step) =>
      step.id === "review" ? { ...step, success: { path: "approved", equals: true } } : step
    )
  });
  await app.pair(page);
  await startResponse(page);
  await page.locator("#workflowHumanPlain").check();
  await expect(page.locator("#workflowHumanFormatHelp")).toContainText(
    "plain answer is not accepted"
  );
  await page.locator("#workflowHumanText").fill("This is a written answer, not an approval.");
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workflowRespondStatus")).toContainText("does not satisfy");
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await expect(page.locator("#workflowHumanText")).toHaveValue(
    "This is a written answer, not an approval."
  );
  expect(state.run?.status).toBe("waiting_input");
  expect(state.run?.steps[1].output).toBeUndefined();
  await page.locator("#workflowRespondAdvanced").click();
  await page.locator("#workflowStop").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "stopped");
  await page.locator("#workspaceActionClose").click();
  plan.definition = definition;
  await page.locator("#refresh").click();
  await page.locator("#openCurrent").click();
  await page.locator("#workflowRun").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workflowHumanApproval").check();
  await page.locator("#workflowHumanDoNotApprove").check();
  await page.locator("#workflowHumanSubmit").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  expect(state.run?.status).toBe("completed");
  expect(state.run?.steps[1].output).toEqual({ approved: false });
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(2);
});

test("the step builder saves a mixed workflow with exact whole-result bindings and selects it without running", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  state.modelAvailable = true;
  await app.pair(page);
  await page.locator('#projects [data-project="' + PROJECT + '"]').click();
  await page.locator("#search").fill("Report review");
  await page.locator("#shellNewWorkflow").click();
  await expect(page.locator("#workflowBuilder")).toBeVisible();
  const creation = page.locator("#workspaceActionBody");
  await expect(creation.locator("#workflowBuilder")).toBeVisible();
  await expect(creation.locator("#workflowList")).toHaveCount(0);
  await expect(creation.locator("#workflowListRefresh")).toHaveCount(0);
  await expect(creation.locator("#workflowActions")).toHaveCount(0);
  await expect(creation.locator("#workflowPanel")).toHaveCount(0);
  const createStyle = await page.locator("#workflowBuilderAdvanced").evaluate((element) => ({
    advanced: getComputedStyle(element).backgroundColor,
    save: getComputedStyle(document.getElementById("workflowBuilderSave")!).backgroundColor
  }));
  expect(createStyle.advanced).toBe("rgba(0, 0, 0, 0)");
  expect(createStyle.save).not.toBe(createStyle.advanced);

  await page.locator("#workflowBuilderName").fill("Retrieve, summarize, review");
  await page.locator("#workflowBuilderGoal").fill("Read the report and review the summary.");
  const rows = page.locator(".workflow-builder-step");
  await rows.nth(0).getByLabel("Step name", { exact: true }).fill("Retrieve report");
  await rows.nth(0).getByLabel("Who does it", { exact: true }).selectOption("tool:fetch_report");
  await expect(
    rows.nth(0).getByText("Use the previous step's result", { exact: true })
  ).not.toBeVisible();
  await rows.nth(0).getByText("Done when (optional)", { exact: true }).click();
  await rows.nth(0).getByLabel("Result path", { exact: true }).fill("status");
  await rows.nth(0).getByLabel("Equals (JSON)", { exact: true }).fill("200");
  await page.locator("#workflowBuilderAdd").click();
  await rows.nth(1).getByLabel("Step name", { exact: true }).fill("Summarize");
  await rows.nth(1).getByLabel("Who does it", { exact: true }).selectOption("model");
  await rows.nth(1).getByLabel("Prompt", { exact: true }).fill("Summarize the actual report.");
  await page.locator("#workflowBuilderAdd").click();
  await rows.nth(2).getByLabel("Step name", { exact: true }).fill("Review");
  await rows
    .nth(2)
    .getByLabel("Instructions", { exact: true })
    .fill("Review the summary against the returned report.");
  await rows.nth(2).getByText("Done when (optional)", { exact: true }).click();
  await rows.nth(2).getByLabel("Requires approval", { exact: true }).check();
  const expected = {
    version: 1,
    name: "Retrieve, summarize, review",
    description: "Read the report and review the summary.",
    steps: [
      {
        id: "retrieve-report",
        name: "Retrieve report",
        inputs: {},
        timeoutMs: 120000,
        action: { type: "tool", tool: "fetch_report" },
        success: { path: "status", equals: 200 }
      },
      {
        id: "summarize",
        name: "Summarize",
        inputs: { "retrieve-report": { $step: "retrieve-report" } },
        timeoutMs: 120000,
        action: { type: "model", prompt: "Summarize the actual report." }
      },
      {
        id: "review",
        name: "Review",
        inputs: { summarize: { $step: "summarize" } },
        timeoutMs: 120000,
        action: { type: "human", instructions: "Review the summary against the returned report." },
        success: { path: "approved", equals: true }
      }
    ]
  };
  await expect
    .poll(async () =>
      JSON.parse((await page.locator("#workflowBuilderPreview").textContent()) || "null")
    )
    .toEqual(expected);
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  await expect(page.locator("#detail")).toContainText("Retrieve, summarize, review");
  await expect(page.getByRole("region", { name: "Current work summary" })).toContainText(
    "Tool fetch_report · Retrieve report"
  );
  expect(seen.find((entry) => entry.name === "create_plan")?.input).toEqual({
    definition: expected,
    projectId: PROJECT
  });
  expect(seen.some((entry) => entry.name === "run_plan")).toBe(false);
  await page.locator("#openCurrent").click();
  await expect
    .poll(async () => JSON.parse(await page.locator("#workflowDefinition").inputValue()))
    .toEqual(expected);
});

test("builder bindings reject unknown, forward, renamed, and empty-path references before Save", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await app.pair(page);
  await page.locator("#shellNewWorkflow").click();
  await page.locator("#workflowBuilderName").fill("Bound tools");
  const rows = page.locator(".workflow-builder-step");
  await rows.nth(0).getByLabel("Step name", { exact: true }).fill("Retrieve");
  await rows.nth(0).getByLabel("Who does it", { exact: true }).selectOption("tool:fetch_report");
  await page.locator("#workflowBuilderAdd").click();
  await rows.nth(1).getByLabel("Step name", { exact: true }).fill("Inspect");
  await rows.nth(1).getByLabel("Who does it", { exact: true }).selectOption("tool:fetch_report");
  const inputs = rows.nth(1).getByLabel("Inputs (JSON object)", { exact: true });
  await inputs.fill('{"query":{"$step":"unknown"}}');
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workflowBuilderStatus")).toBeVisible();
  await expect(page.locator("#workflowBuilderStatus")).toContainText(
    "references unknown which is not an earlier step"
  );
  await rows
    .nth(0)
    .getByLabel("Inputs (JSON object)", { exact: true })
    .fill('{"query":{"$step":"inspect"}}');
  await inputs.fill("{}");
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workflowBuilderStatus")).toContainText(
    "references inspect which is not an earlier step"
  );
  await rows.nth(0).getByLabel("Inputs (JSON object)", { exact: true }).fill("{}");
  await inputs.fill('{"query":{"$step":"retrieve","path":"a..b"}}');
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workflowBuilderStatus")).toContainText("no empty segments");
  await inputs.fill('{"query":{"$step":"retrieve"}}');
  await rows.nth(0).getByLabel("Step name", { exact: true }).fill("Renamed retrieve");
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workflowBuilderStatus")).toContainText(
    "references retrieve which is not an earlier step"
  );
  expect(seen.filter((entry) => entry.name === "create_plan")).toHaveLength(0);
});

test("tool inputs save without a schema-engine claim and actual run failure is Attention", async ({
  page,
  app
}) => {
  const { state, seen } = await homeData(page);
  state.toolRunError = "Step action failed";
  await app.pair(page);
  await page.locator("#shellNewWorkflow").click();
  await page.locator("#workflowBuilderName").fill("Inspect invalid tool input");
  const row = page.locator(".workflow-builder-step");
  await row.getByLabel("Step name", { exact: true }).fill("Retrieve");
  await row.getByLabel("Who does it", { exact: true }).selectOption("tool:fetch_report");
  await row.getByLabel("Inputs (JSON object)", { exact: true }).fill('{"extra":"x"}');
  await expect(row).toContainText("checked when the step runs, not when the plan is saved");
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  expect(seen.find((entry) => entry.name === "create_plan")?.input.definition).toMatchObject({
    steps: [{ inputs: { extra: "x" } }]
  });
  await expect(page.locator("#runCurrent")).toBeEnabled();
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "failed");
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  await expect(page.locator("#attentionCount")).toHaveText("1");
  await expect(page.locator("#needsCount")).toHaveText("0");
  await page.locator('[data-detail-tab="activity"]').click();
  await expect(page.locator("#detail")).toContainText("Step action failed");
});

test("a narrow builder exposes an unavailable model honestly and saves a You-only plan", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await app.pair(page);
  await page.locator("#shellNewWorkflow").click();
  const row = page.locator(".workflow-builder-step");
  await expect(row.getByRole("option", { name: "Model · No model is configured" })).toBeDisabled();
  await expect(row.getByRole("option", { name: /^Agent/ })).toHaveCount(0);
  await page.locator("#workflowBuilderName").fill("Human review");
  await row.getByLabel("Step name", { exact: true }).fill("Review");
  await row
    .getByLabel("Instructions", { exact: true })
    .fill("Read the supplied material and record your findings.");
  await page.locator("#workflowBuilderSave").scrollIntoViewIfNeeded();
  const geometry = await page.locator("#workflowBuilderSave").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const dialog = element.closest("dialog")!;
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
      scroll: dialog.scrollWidth,
      box: dialog.clientWidth
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.box + 1);
  await page.locator("#workflowBuilderSave").click();
  await expect(page.locator("#workspaceActionDialog")).not.toBeVisible();
  await expect(page.locator("#detail")).toContainText("Human review");
  expect(seen.find((entry) => entry.name === "create_plan")?.input.definition).toMatchObject({
    steps: [
      {
        id: "review",
        inputs: {},
        action: {
          type: "human",
          instructions: "Read the supplied material and record your findings."
        }
      }
    ]
  });
  expect(seen.some((entry) => entry.name === "run_plan")).toBe(false);
});

test("failed, stopped, and uncertain work ask for human inspection without starting a new run", async ({
  page,
  app
}) => {
  const { state, seen, plan } = await homeData(page);
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  if (!state.run) throw Error("No controlled run");
  for (const scenario of [
    {
      status: "failed" as const,
      action: "Review recorded result",
      prompt:
        "Review the recorded result and any error, then edit the plan or start a new run from step one."
    },
    {
      status: "stopped" as const,
      action: "Review partial results",
      prompt: "Review the stopped run and its partial results."
    },
    {
      status: "uncertain" as const,
      action: "Review uncertain outcome",
      prompt: "Inspect the recorded outcome and any external effects before starting a new run."
    }
  ]) {
    state.run.status = scenario.status;
    state.run.steps[1].status = scenario.status === "uncertain" ? "failed" : scenario.status;
    state.status = scenario.status;
    plan.work = "todo";
    await page.locator("#refresh").click();
    const now = page.getByRole("region", { name: "Current work summary" });
    await expect(now).toContainText(scenario.prompt);
    await expect(page.locator("#openCurrent")).toHaveText(scenario.action);
    await expect(page.locator("#detail .detail-footer")).toContainText(
      "New runs start from the first step."
    );
    await expect(page.locator("#respondDecision")).toHaveCount(0);
    await expect(page.locator("#runCurrent")).toHaveCount(0);
    const runs = seen.filter((entry) => entry.name === "run_plan").length;
    await page.locator("#openCurrent").click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute(
      "data-status",
      scenario.status
    );
    expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(runs);
    await page.locator("#workspaceActionClose").click();
  }
});

test("a pending decision shows the recorded model text and earlier tool result before any response", async ({
  page,
  app
}) => {
  const { state, plan, seen } = await homeData(page);
  state.modelAvailable = true;
  plan.definition = workflowDefinitionSchema.parse({
    ...plan.definition,
    steps: [
      plan.definition.steps[0],
      {
        id: "summarize",
        name: "Summarize the source",
        inputs: { source: { $step: "read" } },
        action: { type: "model", prompt: "Summarize the actual source" }
      },
      {
        ...plan.definition.steps[1],
        inputs: { summary: { $step: "summarize" } },
        success: { path: "approved", equals: true }
      }
    ]
  });
  await app.pair(page);
  await page.locator("#runCurrent").click();
  await expect(page.locator("#workflowHumanForm")).toBeVisible();
  if (!state.run) throw Error("No controlled run");
  const actualText =
    'The report describes workflow tools. Its verification field is a claim in the returned data. <img src=x onerror="window.__reviewEvidenceInjected=1">';
  state.run.steps[0].output = {
    status: 200,
    repository: "ChatAgent",
    verification: "Report writer's claim"
  };
  state.run.steps.splice(1, 0, {
    id: "summarize",
    name: "Summarize the source",
    status: "completed",
    output: { text: actualText },
    endedAt: "2026-10-10T20:01:00Z"
  });
  state.run.steps[2].inputs = {
    summary: { text: actualText },
    longContext: "Useful recorded context. ".repeat(250)
  };
  await page.locator("#workspaceActionClose").click();
  await page.locator("#workTab").click();
  const decision = page.getByRole("region", { name: "Pending decision" });
  await expect(decision.locator(".recorded-review-values")).toContainText(actualText);
  await expect(decision.locator(".recorded-review-values")).toContainText("200");
  await expect(decision.locator(".recorded-review-values")).toContainText("Report writer's claim");
  await expect(decision.locator(".recorded-review")).toContainText("preview is shortened");
  await expect(decision.locator("details[open]")).toHaveCount(0);
  expect(seen.filter((entry) => entry.name === "submit_step_result")).toHaveLength(0);
  await page.locator("#respondDecision").click();
  await expect(page.locator("#workflowHumanEvidence .recorded-review-values")).toContainText(
    actualText
  );
  await expect(page.locator("#workflowHumanScope")).toHaveText(
    "Records your decision for this step. It does not verify the task."
  );
  const positions = await page.locator("#workflowHumanEvidence").evaluate((element) => ({
    evidenceBottom: element.getBoundingClientRect().bottom,
    controlsTop: document.getElementById("workflowHumanApprovalFields")!.getBoundingClientRect().top
  }));
  expect(positions.evidenceBottom).toBeLessThanOrEqual(positions.controlsTop);
  await page.setViewportSize({ width: 390, height: 844 });
  const covered = await page.locator("#workflowHumanForm").evaluate((form) => {
    const submit = form.querySelector("#workflowHumanSubmit")!.getBoundingClientRect();
    return Array.from(
      form.querySelectorAll("input, textarea, summary, #workflowHumanRule, #workflowHumanScope")
    )
      .filter((field) => {
        const box = field.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.top < innerHeight &&
          box.bottom > 0 &&
          box.left < submit.right &&
          box.right > submit.left &&
          box.top < submit.bottom &&
          box.bottom > submit.top
        );
      })
      .map((field) => field.id || field.textContent);
  });
  expect(covered).toEqual([]);
  await page.locator("#workflowHumanDoNotApprove").check();
  await expect(page.locator("#workflowHumanApprove")).not.toBeChecked();
  await page.locator("#workflowHumanApprove").check();
  await expect(page.locator("#workflowHumanDoNotApprove")).not.toBeChecked();
  await page.locator("#workflowHumanNote").fill("Compare the recorded summary with the source.");
  await page
    .locator("#workflowHumanNote")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expectResponseControlsClear(page, [
    "#workflowHumanApprove",
    "#workflowHumanDoNotApprove",
    "#workflowHumanNote",
    "#workflowHumanAdvanced > summary",
    "#workflowHumanRule",
    "#workflowHumanScope",
    "#workflowHumanSubmit"
  ]);
  await page.clock.install();
  const data = page.locator("#workflowHumanEvidence .recorded-review-values");
  await data.evaluate((element) => (element.scrollTop = 70));
  const scroll = await data.evaluate((element) => element.scrollTop);
  await page.clock.fastForward(2000);
  await expect(page.locator("#workflowNote")).toHaveText("Execution state refreshed.");
  expect(await data.evaluate((element) => element.scrollTop)).toBe(scroll);
  expect(
    await page.evaluate(
      () => (window as unknown as { __reviewEvidenceInjected?: number }).__reviewEvidenceInjected
    )
  ).toBeUndefined();
});

test("closing creation preserves the form draft and Advanced restores it into the original controller", async ({
  page,
  app
}) => {
  const { seen } = await homeData(page);
  await app.pair(page);
  await page.locator("#shellNewWorkflow").click();
  await page.locator("#workflowBuilderName").fill("Draft review");
  const row = page.locator(".workflow-builder-step");
  await row.getByLabel("Step name", { exact: true }).fill("Review");
  await row.getByLabel("Instructions", { exact: true }).fill("Read the supplied material.");
  await page.locator("#workspaceActionClose").click();
  await expect(page.locator("#workflowPanel")).toHaveJSProperty("open", false);
  await page.locator("#workspaceActionReopen").click();
  await expect(page.locator("#workflowBuilderName")).toHaveValue("Draft review");
  await expect(page.locator("#workspaceActionBody > #workflowBuilder")).toBeVisible();
  await expect(page.locator("#workflowBuilder")).toHaveCount(1);
  await page.locator("#workflowBuilderAdvanced").click();
  await expect(page.locator("#workspaceActionBody > #workflowPanel")).toBeVisible();
  await expect(page.locator("#workflowPanel > #workflowBuilder")).toBeHidden();
  await expect(page.locator("#workflowDefinition")).toHaveValue(/Draft review/);
  expect(seen.some((entry) => ["create_plan", "run_plan"].includes(entry.name))).toBe(false);
});
