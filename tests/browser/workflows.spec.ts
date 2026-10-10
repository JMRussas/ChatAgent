import type { Page } from "@playwright/test";
import type {
  StoredWorkflowPlan,
  WorkflowDefinition,
  WorkflowRun
} from "../../src/workflows/types";
import { test, expect } from "./fixture";

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
  const state = { plans, run: execution(), error: "" };
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
          actions: [{ name: "fetch_json", description: "Retrieve JSON", inputSchema: {} }],
          modelAvailable: true
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
    await page
      .locator('#workflowSteps [data-step="summary"]')
      .getByText("Output details", { exact: true })
      .click();
    await expect(page.locator("#workflowHumanInstructions")).toHaveText(
      definition.steps[0].action.type === "human" ? definition.steps[0].action.instructions : ""
    );
    await page.getByLabel("Step result (JSON)").fill('{"approved":true}');
    await page.getByRole("button", { name: "Submit result" }).click();
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
    await page.getByLabel("Step result (JSON)").fill(JSON.stringify({ text: hostile }));
    await page.getByRole("button", { name: "Submit result" }).click();
    await expect(page.locator("#workflowSteps")).toContainText("workflowPwned");
    expect(
      await page.evaluate(() => (window as unknown as { __workflowPwned?: number }).__workflowPwned)
    ).toBeUndefined();
    await expect(page.locator("#workflowPanel img, #workflowPanel script")).toHaveCount(0);
  });
});
