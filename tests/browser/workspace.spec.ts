import type { Page } from "@playwright/test";
import { test, expect } from "./fixture";

const FIRST = "11111111-2222-4333-8444-555555555555";
const SECOND = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PLAN = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ROOT = "cccccccc-dddd-4eee-8fff-000000000000";
const HOSTILE = '<img src=x onerror="window.workspaceInjected=1">';
function project(id: string, name: string) {
  return {
    id,
    name,
    repositoryPath: "D:/Git/" + name,
    hekateProjectId: id,
    preparedPlanRoots: [],
    archived: false,
    revision: 1
  };
}
function conversation(id: string, title: string, projectId: string | null) {
  return {
    id,
    title,
    projectId,
    archived: false,
    lastActivityAt: "2026-10-10T20:00:00Z",
    preview: "Recent project discussion",
    status: "ready",
    reopenable: true
  };
}
async function workspace(page: Page, historyDelayMs = 0) {
  const state = {
    projects: [project(FIRST, "First project"), project(SECOND, "Second project")],
    conversations: [
      conversation("saved-first", "First discussion", FIRST),
      conversation("saved-second", "Second discussion", SECOND)
    ],
    work: [
      {
        id: PLAN,
        projectId: FIRST,
        name: "Review report",
        kind: "workflow",
        status: "todo",
        conversationId: "saved-first",
        nextStep: "Review"
      },
      {
        id: ROOT,
        projectId: SECOND,
        name: "Prepared changes",
        kind: "coding",
        status: "ready",
        prepared: true,
        nextStep: "Check changes"
      }
    ],
    errors: [] as { projectId: string; message: string }[],
    persistenceEnabled: true,
    truncated: false,
    fail: ""
  };
  const seen: { name: string; input: Record<string, unknown> }[] = [];
  const bridge: { path: string; method: string; input: Record<string, unknown> | null }[] = [];
  await page.route("**/workspace/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    seen.push({ name, input });
    if (state.fail && name === "get_workspace")
      return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", error: state.fail } });
    let result: unknown;
    if (name === "get_workspace") result = state;
    else if (name === "register_project") {
      const created = { ...project(ROOT, String(input.name)), ...input };
      state.projects.push(created);
      result = created;
    } else if (name === "update_project") {
      const index = state.projects.findIndex((entry) => entry.id === input.id);
      state.projects[index] = {
        ...state.projects[index]!,
        ...input,
        revision: state.projects[index]!.revision + 1
      };
      result = state.projects[index];
    } else if (name === "create_conversation") {
      const created = conversation(
        "saved-new",
        String(input.title || "New conversation"),
        typeof input.projectId === "string" ? input.projectId : null
      );
      state.conversations.push(created);
      result = created;
    } else if (name === "update_conversation") {
      const index = state.conversations.findIndex((entry) => entry.id === input.id);
      state.conversations[index] = { ...state.conversations[index]!, ...input };
      result = state.conversations[index];
    } else throw new Error("Unexpected workspace tool " + name);
    await route.fulfill({ json: result });
  });
  await page.route("**/workspace/conversations/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    bridge.push({
      path,
      method: request.method(),
      input: request.postData() ? request.postDataJSON() : null
    });
    if (path.endsWith("/events/stream")) {
      if (historyDelayMs) await new Promise((resolve) => setTimeout(resolve, historyDelayMs));
      const events = [
        {
          type: "user",
          messageId: "old-message",
          text: "Saved conversation history",
          eventId: "old-user",
          createdAtIso: "2026-10-10T20:00:00Z"
        }
      ];
      return route.fulfill({
        contentType: "text/event-stream",
        body: "event: timeline\ndata: " + JSON.stringify({ events }) + "\n\n"
      });
    }
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { fastResponse: { analysis: {} } } });
    return route.fulfill({ json: {} });
  });
  return { state, seen, bridge };
}

test.use({ workspace: true, workflows: true, planStatus: true, planRunControls: true });

test("projects and saved conversations can be selected, edited, searched and archived", async ({
  page,
  app
}) => {
  const { state, seen } = await workspace(page, 180);
  for (let index = 0; index < 18; index++) {
    state.conversations.push(
      conversation("saved-extra-" + index, "Additional discussion " + index, FIRST)
    );
    state.work.push({
      id: "work-extra-" + index,
      projectId: FIRST,
      name: "Additional workflow " + index,
      kind: "workflow",
      status: "todo",
      nextStep: "Review",
      conversationId: "saved-first"
    });
  }
  await page.route("**/workflows/tools/*", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("list_actions")
        ? { actions: [], executors: [], modelAvailable: false }
        : { plans: [] }
    })
  );
  await app.pair(page);
  await expect(page.locator("#workspaceConversations")).toContainText("First discussion");
  for (const id of ["workspaceConversations", "workspaceWork"]) {
    await expect(page.locator("#" + id + " > li")).toHaveCount(20);
    const dimensions = await page
      .locator("#" + id)
      .evaluate((list) => ({ height: list.clientHeight, content: list.scrollHeight }));
    expect(dimensions.height).toBeLessThanOrEqual(420);
    expect(dimensions.content).toBeGreaterThan(dimensions.height);
  }
  await page.getByLabel("Project", { exact: true }).selectOption(FIRST);
  await expect(page.locator("#workspaceConversations")).not.toContainText("Second discussion");
  await expect(page.locator("#workspaceWork")).toContainText("Review report");
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await page.getByLabel("Repository path (optional)").fill("D:/Git/renamed-repo");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect.poll(() => state.projects[0]!.repositoryPath).toBe("D:/Git/renamed-repo");
  expect(seen.find((entry) => entry.name === "update_project")!.input.revision).toBe(1);
  await page.getByRole("button", { name: "First discussion", exact: true }).click();
  await expect(page.locator("#thread")).toContainText("Saved conversation history");
  await expect(page.locator("#thread .bubble.user").first()).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () =>
      page
        .locator("#thread .bubble.user")
        .first()
        .evaluate((bubble) => bubble.getBoundingClientRect().top)
    )
    .toBeLessThan(180);
  await page.getByLabel("Conversation title", { exact: true }).fill("Release discussion");
  await page.getByRole("button", { name: "Save conversation", exact: true }).click();
  await expect(page.locator("#workspaceConversations")).toContainText("Release discussion");
  await page.getByRole("button", { name: "Archive conversation", exact: true }).click();
  await expect(page.locator("#workspaceConversations")).not.toContainText("Release discussion");
  await page.getByLabel("Include archived conversations").check();
  await expect(page.locator("#workspaceConversations")).toContainText("Release discussion");
  await page.getByRole("button", { name: "Restore conversation", exact: true }).click();
  await page.getByLabel("Search conversations").fill("unmatched");
  await expect(page.locator("#workspaceConversations")).toContainText("No conversations match.");
  await page.getByLabel("Search conversations").fill("");
  await page.getByLabel("Project", { exact: true }).selectOption(SECOND);
  await page.getByLabel("New conversation title").fill("Second planning session");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#workspaceSelectedTitle")).toContainText("Second planning session");
  expect(state.conversations.at(-1)!.projectId).toBe(SECOND);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Third project");
  await page.getByLabel("Repository path (optional)").fill("D:/Git/third");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(ROOT);
  expect(seen.find((entry) => entry.name === "register_project")!.input.repositoryPath).toBe(
    "D:/Git/third"
  );
  expect(seen.filter((entry) => entry.name === "get_workspace").at(-1)!.input.projectId).toBe(ROOT);
});

test("saved conversations use the authorized bridge for send and reload without editing identifiers", async ({
  page,
  app
}) => {
  const { bridge } = await workspace(page);
  await page.route("**/workflows/tools/*", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("list_actions")
        ? { actions: [], executors: [], modelAvailable: false }
        : { plans: [] }
    })
  );
  await app.pair(page);
  await page.getByRole("button", { name: "Second discussion", exact: true }).click();
  await expect(page.locator("#thread")).toContainText("Saved conversation history");
  await expect(page.locator("#conversationIdentifiers")).not.toHaveAttribute("open");
  await page.getByLabel("Prompt", { exact: true }).fill("Continue this project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() =>
      bridge.some(
        (entry) =>
          entry.path === "/workspace/conversations/saved-second/messages" &&
          entry.input?.text === "Continue this project"
      )
    )
    .toBe(true);
  await page.reload();
  await expect(page.locator("#workspaceSelectedTitle")).toContainText("Second discussion");
  await expect(page.locator("#conversationId")).toHaveValue("saved-second");
  await expect(page.locator("#thread")).toContainText("Saved conversation history");
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(SECOND);
});

test("opening work selects its plan and explicit Run forwards the project and originating conversation", async ({
  page,
  app
}) => {
  await workspace(page);
  const definition = {
    version: 1,
    name: "Review report",
    description: "Review the report",
    steps: [
      {
        id: "review",
        name: "Review",
        inputs: {},
        action: { type: "human", instructions: "Please review" }
      }
    ]
  };
  const saved = { id: PLAN, revision: 1, definition, work: "todo", attemptId: null };
  const seen: { name: string; input: Record<string, unknown>; conversation: string | undefined }[] =
    [];
  await page.route("**/workflows/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    seen.push({
      name,
      input,
      conversation: route.request().headers()["x-workspace-conversation-id"]
    });
    const result =
      name === "list_plans"
        ? { plans: input.projectId === SECOND ? [] : [saved] }
        : name === "list_actions"
          ? { actions: [], executors: [], modelAvailable: false }
          : name === "run_plan" || name === "get_run"
            ? {
                id: ROOT,
                planId: PLAN,
                definition,
                status: "waiting_input",
                steps: [{ id: "review", name: "Review", status: "waiting_input" }]
              }
            : name === "create_plan"
              ? { ...saved, definition: input.definition }
              : saved;
    await route.fulfill({ json: result });
  });
  await app.pair(page);
  const work = page.locator('[data-work="' + PLAN + '"]');
  await work.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator("#workflowTitle")).toHaveText("Review report");
  expect(seen.filter((entry) => entry.name === "run_plan")).toHaveLength(0);
  await expect(page.locator("#workflowRun")).toBeEnabled();
  await work.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator("#workflowRunStatus")).toContainText("Needs your input");
  const run = seen.find((entry) => entry.name === "run_plan")!;
  expect(run.input.projectId).toBe(FIRST);
  expect(run.conversation).toBe("saved-first");
  await page.getByLabel("Project", { exact: true }).selectOption(SECOND);
  await page.locator("#workflowRunRefresh").click();
  expect(seen.filter((entry) => entry.name === "get_run").at(-1)!.input.projectId).toBe(FIRST);
  await page.getByLabel("Project", { exact: true }).selectOption(FIRST);
  await page.locator("#workflowNew").click();
  await page.getByLabel("Project", { exact: true }).selectOption(SECOND);
  await expect(page.locator("#workflowSavedState")).toContainText("Draft");
  await expect(page.locator("#workflowProjectScope")).toContainText("keeps its original project");
  await page.locator("#workflowSave").click();
  await expect(page.locator("#workflowSavedState")).toContainText("Saved revision");
  const created = seen.find((entry) => entry.name === "create_plan")!;
  expect(created.input.projectId).toBe(FIRST);
  expect(created.conversation).toBe("saved-first");
});

test("prepared coding work opens existing controls while unavailable and hostile records stay inert", async ({
  page,
  app
}) => {
  const { state, seen } = await workspace(page);
  state.projects[0]!.name = HOSTILE;
  state.conversations[0]!.title = HOSTILE;
  state.conversations[0]!.preview = HOSTILE;
  state.conversations[0]!.reopenable = false;
  state.work[0]!.name = HOSTILE;
  state.errors.push({ projectId: FIRST, message: HOSTILE });
  state.truncated = true;
  state.work.push({
    id: SECOND,
    projectId: SECOND,
    name: "Earlier completed work",
    kind: "workflow",
    status: "completed",
    conversationId: "saved-second",
    nextStep: "Done"
  });
  state.work.push({
    id: FIRST,
    projectId: SECOND,
    name: "Observed coding plan",
    kind: "coding",
    status: "ready",
    prepared: false,
    nextStep: "Review"
  });
  await page.route("**/workflows/tools/*", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("list_actions")
        ? { actions: [], executors: [], modelAvailable: false }
        : { plans: [] }
    })
  );
  const development: string[] = [];
  await page.route("**/development/**", async (route) => {
    development.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
  });
  await app.pair(page);
  await expect(page.locator("#workspaceErrors")).toHaveText(HOSTILE);
  await expect(page.locator("#workspaceNote")).toContainText("More work exists");
  await expect(page.locator("#workspaceWork")).not.toContainText("Earlier completed work");
  await page.getByLabel("Include completed work").check();
  await expect(page.locator("#workspaceWork")).toContainText("Earlier completed work");
  await expect(page.locator('[data-work="' + FIRST + '"]')).toContainText("Coding plan");
  expect(
    await page
      .locator('[data-work="' + FIRST + '"]')
      .getByRole("button", { name: "Run", exact: true })
      .count()
  ).toBe(0);
  await expect(page.locator("#workspaceConversations button").first()).toBeDisabled();
  expect(await page.locator("#workspacePanel img").count()).toBe(0);
  await page
    .locator('[data-conversation="saved-first"]')
    .getByRole("button", { name: "Archive " + HOSTILE, exact: true })
    .click();
  await expect(page.locator('[data-conversation="saved-first"]')).toHaveCount(0);
  expect(state.conversations[0]!.archived).toBe(true);
  await page.getByLabel("Project", { exact: true }).selectOption(SECOND);
  await page
    .locator('[data-work="' + ROOT + '"]')
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(page.locator("#planRoot")).toHaveValue(ROOT);
  await expect(page.locator("#planStatusPanel")).toHaveAttribute("open");
  await expect.poll(() => development.some((path) => path.endsWith("/status"))).toBe(true);
  expect(development.some((path) => path.endsWith("/launch"))).toBe(false);
  expect(seen.filter((entry) => entry.name === "get_workspace").at(-1)!.input.projectId).toBe(
    SECOND
  );
  state.fail = HOSTILE;
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.locator("#workspaceNote")).toHaveText(HOSTILE);
  expect(
    await page.evaluate(
      () => (window as unknown as { workspaceInjected?: number }).workspaceInjected
    )
  ).toBeUndefined();
});
