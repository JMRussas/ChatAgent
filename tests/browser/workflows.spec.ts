import type { Page } from "@playwright/test";
import type {
  StoredWorkflowPlan,
  WorkflowDefinition,
  WorkflowRun
} from "../../src/workflows/types";
import { test, expect } from "./fixture";
import type { TaskState } from "../../src/tasks/types";

const PLAN_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const definition: WorkflowDefinition = {
  version: 1,
  name: "Review a report",
  description: "An ordinary human step",
  steps: [
    {
      id: "review",
      name: "Review",
      inputs: {},
      action: { type: "human", instructions: "Review the report and record your decision." },
      timeoutMs: 120000
    }
  ]
};
function stored(overrides: Partial<StoredWorkflowPlan> = {}): StoredWorkflowPlan {
  return {
    id: PLAN_ID,
    ownerId: "operator",
    definition: structuredClone(definition),
    revision: 1,
    stateRevision: 1,
    taskId: PLAN_ID,
    work: "todo",
    attemptId: null,
    attemptEpoch: 0,
    artifactRef: null,
    ...overrides
  };
}
function execution(status: WorkflowRun["status"] = "waiting_input"): WorkflowRun {
  return {
    version: 1,
    id: RUN_ID,
    planId: PLAN_ID,
    ownerId: "operator",
    definition: structuredClone(definition),
    revision: 1,
    attemptEpoch: 1,
    status,
    steps: [
      { id: "review", name: "Review", status: status === "running" ? "running" : "waiting_input" }
    ],
    startedAt: "2026-10-10T12:00:00Z",
    updatedAt: "2026-10-10T12:00:00Z"
  };
}
async function tools(page: Page, plans = [stored()]) {
  const seen: { name: string; input: Record<string, unknown>; method: string }[] = [];
  const state = {
    plans,
    run: execution(),
    error: "",
    taskResponse: null as ((input: Record<string, unknown>) => WorkflowRun) | null
  };
  await page.route("**/workflows/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    seen.push({ name, input, method: route.request().method() });
    if (state.error && name === "get_run")
      return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", error: state.error } });
    let result: unknown;
    switch (name) {
      case "list_plans":
        result = { plans: state.plans };
        break;
      case "list_actions":
        result = {
          actions: [
            { name: "fetch_json", description: "Retrieve JSON", inputSchema: {} },
            { name: "archive_report", description: "Save a report", inputSchema: {} }
          ],
          modelAvailable: true,
          model: { mode: "unknown" },
          taskTools: [
            { name: "fetch_json", description: "Retrieve JSON", inputSchema: {}, readOnly: true },
            {
              name: "archive_report",
              description: "Save a report",
              inputSchema: {},
              readOnly: false
            }
          ],
          executors: ["claude", "ollama"]
        };
        break;
      case "get_plan":
        result = state.plans.find((plan) => plan.id === input.id);
        break;
      case "create_plan": {
        const plan = stored({ definition: input.definition as WorkflowDefinition });
        state.plans.push(plan);
        result = plan;
        break;
      }
      case "update_plan": {
        const plan = stored({ definition: input.definition as WorkflowDefinition, revision: 2 });
        state.plans = [plan];
        result = plan;
        break;
      }
      case "run_plan":
        state.plans = state.plans.map((plan) => ({
          ...plan,
          work: "in_progress",
          attemptId: RUN_ID
        }));
        result = state.run;
        break;
      case "get_run":
        result = state.run;
        break;
      case "stop_run":
        state.run.status = "stopped";
        state.run.steps[0].status = "stopped";
        state.plans = state.plans.map((plan) => ({ ...plan, work: "todo", attemptId: null }));
        result = state.run;
        break;
      case "submit_step_result":
        state.run.status = "completed";
        const human = state.run.steps.find((step) => step.id === input.stepId)!;
        human.status = "completed";
        human.output = input.output;
        state.plans = state.plans.map((plan) => ({ ...plan, work: "done", attemptId: RUN_ID }));
        result = state.run;
        break;
      case "respond_to_task_request":
        if (!state.taskResponse) throw new Error("Unexpected task response");
        result = state.taskResponse(input);
        break;
      default:
        return route.fulfill({ status: 404, json: { error: "Unknown tool" } });
    }
    await route.fulfill({ json: result });
  });
  return { state, seen };
}

test.describe("workflow controls", () => {
  test.use({ workflows: true });

  test("creates, saves, reopens, and edits a plan without starting execution", async ({
    page,
    app
  }) => {
    const stub = await tools(page, []);
    await app.pair(page);
    await expect(page.locator("#workflowNote")).toHaveText("Choose a saved plan or create one.");
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await page.getByRole("button", { name: "Advanced: edit plan JSON", exact: true }).click();
    await page.getByLabel("Plan definition (JSON)").fill(JSON.stringify(definition));
    await expect(page.getByRole("button", { name: "Run saved plan" })).toBeDisabled();
    await page.getByRole("button", { name: "Save plan" }).click();
    await expect(page.locator("#workflowSavedState")).toHaveText("Saved revision 1.");
    await page.reload();
    await page.locator("#workflowList").getByRole("button", { name: definition.name }).click();
    await expect(page.getByLabel("Plan definition (JSON)")).toHaveValue(
      JSON.stringify(definition, null, 2)
    );
    const updated = { ...definition, name: "Review updated report" };
    await page.getByText("Edit plan definition", { exact: true }).click();
    await page.getByLabel("Plan definition (JSON)").fill(JSON.stringify(updated));
    await page.getByRole("button", { name: "Refresh plans", exact: true }).click();
    await expect(page.getByLabel("Plan definition (JSON)")).toHaveValue(JSON.stringify(updated));
    await expect(page.getByRole("button", { name: "Run saved plan" })).toBeDisabled();
    await page.getByRole("button", { name: "Save plan" }).click();
    await expect(page.locator("#workflowSavedState")).toHaveText("Saved revision 2.");
    expect(stub.seen.find((call) => call.name === "update_plan")?.input).toEqual({
      id: PLAN_ID,
      revision: 1,
      definition: updated
    });
    expect(stub.seen.some((call) => call.name === "run_plan")).toBe(false);
    expect(stub.seen.every((call) => call.method === "POST")).toBe(true);
  });

  test("runs a saved plan and records a human result through the shared tools", async ({
    page,
    app
  }) => {
    const mixed: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          id: "summary",
          name: "Summarize report",
          inputs: {},
          action: { type: "model", prompt: "Summarize" },
          timeoutMs: 120000
        },
        definition.steps[0]
      ]
    };
    const stub = await tools(page, [stored({ definition: mixed })]);
    const text = "Report summary: " + "A".repeat(1200);
    stub.state.run.definition = mixed;
    stub.state.run.steps.unshift({
      id: "summary",
      name: "Summarize report",
      status: "completed",
      inputs: { report: "source data" },
      output: { text }
    });
    await app.pair(page);
    await page.locator("#workflowList").getByRole("button", { name: definition.name }).click();
    await page.getByRole("button", { name: "Run saved plan" }).click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute(
      "data-status",
      "waiting_input"
    );
    await expect(page.locator("#workflowDescription")).toHaveText(definition.description);
    await expect(page.locator('#workflowSteps [data-step="summary"] > p')).toHaveText(text);
    await expect(page.locator("#workflowSteps details[open]")).toHaveCount(0);
    const width = await page
      .locator("#workflowSteps")
      .evaluate((element) => ({ content: element.scrollWidth, box: element.clientWidth }));
    expect(width.content).toBeLessThanOrEqual(width.box + 2);
    await page.getByText("Recorded steps and outputs", { exact: true }).click();
    await page
      .locator('#workflowSteps [data-step="summary"]')
      .getByText("Output details", { exact: true })
      .click();
    await expect(page.locator("#workflowHumanInstructions")).toHaveText(
      definition.steps[0].action.type === "human" ? definition.steps[0].action.instructions : ""
    );
    await page.locator("#workflowHumanAdvanced > summary").click();
    await page.getByRole("radio", { name: "Raw JSON", exact: true }).check();
    await page.getByLabel("Step result (JSON)").fill('{"approved":true}');
    await page.getByRole("button", { name: "Submit answer" }).click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "completed");
    await expect(page.locator('#workflowSteps [data-step="review"] > p')).toHaveText("Approved");
    await expect(page.locator("#workflowList")).toContainText("Completed");
    await expect(
      page.locator('#workflowSteps [data-step="summary"] details[data-detail="Output details"]')
    ).toHaveAttribute("open", "");
    await expect(page.locator("#workflowSteps")).toContainText('"approved": true');
    await expect(page.locator("#workflowHumanForm")).toBeHidden();
    expect(stub.seen.find((call) => call.name === "run_plan")?.input).toEqual({
      id: PLAN_ID,
      revision: 1
    });
    expect(stub.seen.find((call) => call.name === "submit_step_result")?.input).toEqual({
      id: RUN_ID,
      stepId: "review",
      output: { approved: true }
    });
  });

  test("observes execution, preserves a draft, stops polling on failure, and allows Stop", async ({
    page,
    app
  }) => {
    const stub = await tools(page);
    stub.state.run = execution("running");
    await app.pair(page);
    await page.locator("#workflowList").getByRole("button", { name: definition.name }).click();
    await page.clock.install();
    await page.getByRole("button", { name: "Run saved plan" }).click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "running");
    await page.getByText("Edit plan definition", { exact: true }).click();
    const draft = JSON.stringify({ ...definition, description: "Unsaved local edit" });
    await page.getByLabel("Plan definition (JSON)").fill(draft);
    await page.clock.fastForward(2000);
    await expect.poll(() => stub.seen.filter((call) => call.name === "get_run").length).toBe(1);
    await expect(page.locator("#workflowNote")).toHaveText("Execution state refreshed.");
    await expect(page.getByLabel("Plan definition (JSON)")).toHaveValue(draft);
    stub.state.error = "Service temporarily unavailable";
    await page.clock.fastForward(2000);
    await expect(page.locator("#workflowNote")).toHaveText(stub.state.error);
    const count = stub.seen.length;
    await page.clock.fastForward(20000);
    expect(stub.seen).toHaveLength(count);
    await page.getByRole("button", { name: "Stop execution" }).click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "stopped");
    await page.clock.fastForward(20000);
    expect(stub.seen.filter((call) => call.name === "stop_run")).toHaveLength(1);
    expect(stub.seen.filter((call) => call.name === "get_run")).toHaveLength(2);
    stub.state.error = "";
    stub.state.plans = [Object.assign(stored(), { latestRunId: RUN_ID })];
    await page.reload();
    await page.locator("#workflowList").getByRole("button", { name: definition.name }).click();
    await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "stopped");
  });

  test("renders untrusted names, instructions and outputs as inert text", async ({ page, app }) => {
    const hostile =
      '<img src=x onerror="window.__workflowPwned=1"><script>window.__workflowPwned=1</script>';
    const plan = stored({
      definition: {
        ...definition,
        name: hostile,
        steps: [
          {
            ...definition.steps[0],
            name: hostile,
            action: { type: "human", instructions: hostile }
          }
        ]
      }
    });
    const stub = await tools(page, [plan]);
    stub.state.run.definition = plan.definition;
    stub.state.run.steps[0].name = hostile;
    await app.pair(page);
    await page.locator("#workflowList").getByRole("button", { name: hostile }).click();
    await page.getByRole("button", { name: "Run saved plan" }).click();
    await expect(page.locator("#workflowHumanInstructions")).toHaveText(hostile);
    await page.locator("#workflowHumanAdvanced > summary").click();
    await page.getByRole("radio", { name: "Raw JSON", exact: true }).check();
    await page.getByLabel("Step result (JSON)").fill(JSON.stringify({ text: hostile }));
    await page.getByRole("button", { name: "Submit answer" }).click();
    await expect(page.locator("#workflowSteps")).toContainText("workflowPwned");
    expect(
      await page.evaluate(() => (window as unknown as { __workflowPwned?: number }).__workflowPwned)
    ).toBeUndefined();
    await expect(page.locator("#workflowPanel img, #workflowPanel script")).toHaveCount(0);
  });

  for (const approved of [true, false]) {
    test(`creates an agent task, provides context, and ${approved ? "allows its tool and completes" : "declines its tool and stops"}`, async ({
      page,
      app
    }) => {
      const stub = await tools(page, []);
      await app.pair(page);
      await page.getByRole("button", { name: "New agent task", exact: true }).click();
      await page.getByLabel("Task name", { exact: true }).fill("Summarize the current report");
      await page
        .getByLabel("Objective", { exact: true })
        .fill("Read the report, summarize the useful changes, and ask for missing context.");
      await page.getByLabel("Executor", { exact: true }).selectOption("claude");
      await page
        .getByLabel("Task context (optional)")
        .fill("Keep the summary useful to an operator.");
      await page.getByText("Add a reference", { exact: true }).click();
      await page.getByLabel("Reference label", { exact: true }).fill("Current report");
      await page
        .getByLabel("Reference content", { exact: true })
        .fill("The report describes shared workflow tools.");
      await expect(
        page
          .locator("#workflowAgentTools")
          .getByRole("heading", { name: "Reads only", exact: true })
      ).toBeVisible();
      await expect(
        page
          .locator("#workflowAgentTools")
          .getByRole("heading", { name: "Can create or change plans and workspace", exact: true })
      ).toBeVisible();
      await page.getByRole("checkbox", { name: "fetch_json — Retrieve JSON" }).check();
      await page
        .getByLabel("Completion criteria (one per line)")
        .fill("Describe the useful changes\nState remaining limitations");
      await page.getByRole("button", { name: "Create agent task", exact: true }).click();
      await expect(page.locator("#workflowNote")).toHaveText(
        "Agent task saved. Review it and click Run when ready."
      );
      expect(stub.seen.some((call) => call.name === "run_plan")).toBe(false);
      const created = stub.state.plans[0].definition;
      expect(created.steps[0].action).toMatchObject({
        type: "agent",
        executor: "claude",
        task: {
          objective: "Read the report, summarize the useful changes, and ask for missing context.",
          context: "Keep the summary useful to an operator.",
          references: [
            {
              id: "reference",
              label: "Current report",
              content: "The report describes shared workflow tools."
            }
          ],
          tools: ["fetch_json"],
          completionCriteria: ["Describe the useful changes", "State remaining limitations"],
          limits: { maxTurns: 12 }
        }
      });
      await expect(page.locator("#workflowPlanSteps")).toContainText("State remaining limitations");
      await expect(page.locator("#workflowPlanSteps")).toContainText("Reference: Current report");
      const contextRequest = "11111111-2222-4333-8444-555555555551";
      const toolRequest = "11111111-2222-4333-8444-555555555552";
      const agent: TaskState = {
        executor: "claude",
        allowedTools: ["fetch_json"],
        requests: [
          {
            id: contextRequest,
            kind: "context",
            prompt: "Which reporting period should I use?",
            status: "pending",
            requestedAt: "2026-10-10T12:00:00Z"
          }
        ],
        events: [
          {
            type: "message",
            message: "I found the report and need its reporting period.",
            at: "2026-10-10T12:00:00Z"
          }
        ],
        checkpoint: { private: "PRIVATE_CHECKPOINT_DO_NOT_RENDER" }
      };
      stub.state.run = {
        ...execution(),
        definition: created,
        steps: [
          Object.assign(
            { id: "task", name: created.name, status: "waiting_input" as const },
            { agent }
          )
        ]
      };
      stub.state.taskResponse = (input) => {
        const request = agent.requests.find((request) => request.id === input.requestId)!;
        request.response = input.response;
        if (request.kind === "context") {
          request.status = "answered";
          agent.events.push({
            type: "provided",
            message: "Reporting period supplied.",
            at: "2026-10-10T12:01:00Z"
          });
          agent.requests.push({
            id: toolRequest,
            kind: "tool",
            tool: "archive_report",
            prompt: "May I save the summary?",
            status: "pending",
            requestedAt: "2026-10-10T12:01:00Z"
          });
        } else {
          request.status = approved ? "answered" : "declined";
          if (approved) {
            agent.allowedTools.push("archive_report");
            agent.events.push({
              type: "tool_finished",
              tool: "archive_report",
              message: "Summary saved.",
              arguments: { title: "Current report" },
              result: { saved: true },
              at: "2026-10-10T12:02:00Z"
            });
            stub.state.run.status = "completed";
            stub.state.run.steps[0].status = "completed";
            stub.state.run.steps[0].output = {
              text: "The workflow tools are shared. Deployment verification remains outstanding."
            };
            stub.state.plans = stub.state.plans.map((plan) => ({ ...plan, work: "done" }));
          } else {
            agent.events.push({
              type: "provided",
              message: "Archive permission declined; preparing an alternative.",
              at: "2026-10-10T12:02:00Z"
            });
            stub.state.run.status = "running";
            stub.state.run.steps[0].status = "running";
          }
        }
        return stub.state.run;
      };
      await page.getByRole("button", { name: "Run saved plan" }).click();
      await expect(page.locator("#workflowAgentRequestPrompt")).toHaveText(
        "Which reporting period should I use?"
      );
      await expect(page.locator("#workflowHumanForm")).toBeHidden();
      await page.clock.install();
      await page
        .locator("#workflowAgentRequestForm")
        .getByLabel("Your answer", { exact: true })
        .fill("Use this week's report.");
      await page.clock.fastForward(2000);
      await expect(page.locator("#workflowNote")).toHaveText("Execution state refreshed.");
      await expect(
        page.locator("#workflowAgentRequestForm").getByLabel("Your answer", { exact: true })
      ).toHaveValue("Use this week's report.");
      await page.getByRole("button", { name: "Send context", exact: true }).click();
      await expect(page.locator("#workflowAgentRequestPrompt")).toContainText(
        "May I save the summary?"
      );
      await page
        .getByRole("button", { name: approved ? "Allow tool" : "Decline tool", exact: true })
        .click();
      const responses = stub.seen.filter((call) => call.name === "respond_to_task_request");
      expect(responses.map((call) => call.input)).toEqual([
        {
          id: RUN_ID,
          stepId: "task",
          requestId: contextRequest,
          response: "Use this week's report."
        },
        { id: RUN_ID, stepId: "task", requestId: toolRequest, response: { approved } }
      ]);
      if (approved) {
        await expect(page.locator("#workflowRunStatus")).toHaveAttribute(
          "data-status",
          "completed"
        );
        await expect(page.locator("#workflowSteps")).toContainText("Summary saved.");
        await expect(page.locator("#workflowSteps")).toContainText(
          "Deployment verification remains outstanding."
        );
        await expect(page.locator("#workflowList")).toContainText("Completed");
      } else {
        await expect(page.locator("#workflowSteps")).toContainText("Archive permission declined");
        await page.getByRole("button", { name: "Stop execution", exact: true }).click();
        await expect(page.locator("#workflowRunStatus")).toHaveAttribute("data-status", "stopped");
      }
      await expect(page.locator("#workflowPanel")).not.toContainText(
        "PRIVATE_CHECKPOINT_DO_NOT_RENDER"
      );
    });
  }
});

test.describe("step creation", () => {
  test.use({ workflows: true });
  for (const policy of [
    { mode: "fixed", provider: "ollama", model: "workflow-fast" },
    { mode: "catalog" },
    { mode: "unknown" },
    { mode: "unconfigured" }
  ] as const) {
    test(
      "model creation reports " + policy.mode + " policy without changing the saved action",
      async ({ page, app }) => {
        const stub = await tools(page, []);
        await page.route("**/workflows/tools/list_actions", (route) =>
          route.fulfill({
            json: {
              actions: [{ name: "fetch_json", description: "Retrieve JSON", inputSchema: {} }],
              taskTools: [],
              executors: ["claude"],
              modelAvailable: policy.mode !== "unconfigured",
              model: policy
            }
          })
        );
        if (policy.mode === "fixed") await page.setViewportSize({ width: 390, height: 844 });
        await app.pair(page);
        await page.locator("#workflowNew").click();
        const row = page.locator(".workflow-builder-step");
        const actor = row.getByLabel("Who does it", { exact: true });
        const option = actor.locator('option[value="model"]');
        await expect(row.locator('[data-field="modelNote"]')).toBeHidden();
        await expect(actor.locator('optgroup option[value="tool:fetch_json"]')).toHaveCount(1);
        if (policy.mode === "unconfigured") {
          await expect(option).toBeDisabled();
          expect(stub.seen.some((call) => call.name === "create_plan")).toBe(false);
          return;
        }
        await expect(option).toBeEnabled();
        await actor.selectOption("model");
        await expect(row.locator('[data-field="modelNote"]')).toBeVisible();
        await expect(row.locator('[data-field="agentDetails"]')).toBeHidden();
        if (policy.mode === "fixed") {
          await expect(option).toContainText(policy.model);
          await expect(option).toContainText(policy.provider);
        } else if (policy.mode === "catalog") {
          await expect(option).toContainText("catalog");
          await expect(option).not.toContainText("workflow-fast");
        } else await expect(option).toContainText("identity not reported");
        await page.locator("#workflowBuilderName").fill("Summarize recorded results");
        await row.getByLabel("Step name", { exact: true }).fill("Summarize");
        await row.getByLabel("Prompt", { exact: true }).fill("Summarize the supplied inputs.");
        await actor.selectOption("human");
        await expect(row.locator('[data-field="modelNote"]')).toBeHidden();
        await actor.selectOption("model");
        await expect(row.getByLabel("Prompt", { exact: true })).toHaveValue(
          "Summarize the supplied inputs."
        );
        await page.locator("#workflowBuilderSave").click();
        await expect(page.locator("#workflowSavedState")).toContainText("Saved revision");
        const definition = stub.seen.find((call) => call.name === "create_plan")!.input
          .definition as WorkflowDefinition;
        expect(definition.steps[0].action).toEqual({
          type: "model",
          prompt: "Summarize the supplied inputs."
        });
        expect(stub.seen.some((call) => call.name === "run_plan")).toBe(false);
      }
    );
  }

  test("agent assignment and reordering retain task choices while deriving unique bounded step ids", async ({
    page,
    app
  }) => {
    const stub = await tools(page, []);
    await app.pair(page);
    await page.locator("#workflowNew").click();
    await page.locator("#workflowBuilderName").fill("Investigate and review");
    const rows = page.locator(".workflow-builder-step");
    const longName = "1 Investigate " + "x".repeat(170);
    await rows.nth(0).getByLabel("Step name", { exact: true }).fill(longName);
    await rows.nth(0).getByLabel("Who does it", { exact: true }).selectOption("agent:claude");
    await rows
      .nth(0)
      .getByLabel("Objective", { exact: true })
      .fill("Investigate the recorded evidence.");
    await rows.nth(0).getByText("Agent details", { exact: true }).click();
    await rows
      .nth(0)
      .getByLabel("Completion criteria (one per line)", { exact: true })
      .fill("Describe the source\nState the limits");
    await expect(
      rows.nth(0).getByRole("heading", { name: "Reads only", exact: true })
    ).toBeVisible();
    await expect(
      rows
        .nth(0)
        .getByRole("heading", { name: "Can create or change plans and workspace", exact: true })
    ).toBeVisible();
    await rows.nth(0).getByLabel("fetch_json — Retrieve JSON", { exact: true }).check();
    await rows.nth(0).getByLabel("archive_report — Save a report", { exact: true }).check();
    await page.locator("#workflowBuilderAdd").click();
    await rows.nth(1).getByLabel("Step name", { exact: true }).fill(longName);
    await rows.nth(1).getByLabel("Instructions", { exact: true }).fill("Review the source.");
    const before = JSON.parse(
      (await page.locator("#workflowBuilderPreview").textContent()) || "null"
    ) as WorkflowDefinition;
    expect(before.steps[0].id).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
    expect(before.steps[0].id).toHaveLength(64);
    expect(before.steps[1].id.endsWith("-2")).toBe(true);
    expect(before.steps[1].id).toHaveLength(64);
    await rows.nth(1).getByRole("button", { name: "Move up", exact: true }).click();
    await expect(rows.nth(0).getByLabel("Who does it", { exact: true })).toHaveValue("human");
    await expect(rows.nth(1).getByLabel("Who does it", { exact: true })).toHaveValue(
      "agent:claude"
    );
    await expect(
      rows.nth(1).getByLabel("Completion criteria (one per line)", { exact: true })
    ).toHaveValue("Describe the source\nState the limits");
    await rows.nth(1).getByRole("button", { name: "Move up", exact: true }).click();
    await page.locator("#workflowBuilderSave").click();
    await expect(page.locator("#workflowSavedState")).toHaveText("Saved revision 1.");
    const created = stub.seen.find((call) => call.name === "create_plan")!.input
      .definition as WorkflowDefinition;
    expect(created.steps).toEqual(before.steps);
    expect(created.steps[0].action).toMatchObject({
      type: "agent",
      executor: "claude",
      task: {
        tools: ["fetch_json", "archive_report"],
        completionCriteria: ["Describe the source", "State the limits"],
        limits: { maxTurns: 12 }
      }
    });
    expect(created.steps[0].timeoutMs).toBe(300000);
    expect(created.steps[1].inputs).toEqual({
      [created.steps[0].id]: { $step: created.steps[0].id }
    });
    expect(stub.seen.some((call) => call.name === "run_plan")).toBe(false);
  });
});
