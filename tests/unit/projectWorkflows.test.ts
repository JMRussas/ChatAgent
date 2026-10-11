import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCatalog } from "../../src/workspace/catalog";
import { ProjectWorkflowRouter } from "../../src/workspace/projectWorkflows";
import type { WorkflowContext, WorkflowToolService } from "../../src/workflows/types";

const context: WorkflowContext = {
  principal: { principalId: "alice", roles: new Set(["operator"]), via: "bearer" },
  operationId: "operation"
};
const directories: string[] = [];
function runDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "project-workflows-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function service(): WorkflowToolService & {
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    tools: [
      {
        name: "list_plans",
        description: "List",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }
      }
    ],
    call: vi.fn(async () => ({ plans: [] })),
    close: vi.fn(async () => undefined)
  };
}
describe("project workflow routing", () => {
  it("looks up an existing default without registering it or exposing another owner's project", () => {
    const catalog = new WorkspaceCatalog();
    const binding = randomUUID();
    const router = new ProjectWorkflowRouter({
      catalog,
      legacy: service(),
      factory: () => service(),
      runDir: runDirectory(),
      legacyProject: { name: "Default", hekateProjectId: binding }
    });
    expect(router.existingLegacyProject("alice")).toBeUndefined();
    expect(catalog.listProjects("alice")).toEqual([]);
    catalog.createProject("bob", { name: "Bob's default", hekateProjectId: binding });
    expect(router.existingLegacyProject("alice")).toBeUndefined();
    const registered = catalog.createProject("alice", {
      name: "Alice's default",
      hekateProjectId: binding
    });
    expect(router.existingLegacyProject("alice")).toEqual(registered);
    expect(catalog.listProjects("alice")).toEqual([registered]);
  });

  it("preserves legacy storage and scopes explicit project calls to reusable per-project services", async () => {
    const catalog = new WorkspaceCatalog();
    const runDir = runDirectory();
    const legacy = service();
    const first = catalog.createProject("alice", { name: "First", hekateProjectId: randomUUID() });
    const second = catalog.createProject("alice", {
      name: "Second",
      hekateProjectId: randomUUID()
    });
    const created: ReturnType<typeof service>[] = [];
    const factory = vi.fn(() => {
      const instance = service();
      created.push(instance);
      return instance;
    });
    const router = new ProjectWorkflowRouter({
      catalog,
      legacy,
      factory,
      runDir,
      legacyProject: { name: "Default", hekateProjectId: randomUUID() }
    });
    await router.call("list_plans", {}, context);
    await router.call("get_plan", { projectId: first.id, id: "plan-one" }, context);
    await router.call("list_plans", { projectId: first.id }, context);
    await router.call("list_plans", { projectId: second.id }, context);
    expect(legacy.call).toHaveBeenCalledExactlyOnceWith("list_plans", {}, context);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(
      first,
      join(runDir, "projects", first.id, first.hekateProjectId!)
    );
    expect(created[0].call).toHaveBeenCalledWith("get_plan", { id: "plan-one" }, context);
    expect(created[0].call).toHaveBeenCalledWith("list_plans", {}, context);
    expect(created[1].call).toHaveBeenCalledExactlyOnceWith("list_plans", {}, context);
    if (process.platform !== "win32")
      expect(
        statSync(join(runDir, "projects", first.id, first.hekateProjectId!)).mode & 0o777
      ).toBe(0o700);
    expect(router.tools[0].inputSchema).toMatchObject({
      properties: { projectId: { type: "string", format: "uuid" } },
      required: []
    });
    await router.close();
    expect(legacy.close).toHaveBeenCalledOnce();
    expect(created.every((instance) => instance.close.mock.calls.length === 1)).toBe(true);
  });

  it("requires explicit project selection without a configured default while retaining action discovery and API actions", async () => {
    const catalog = new WorkspaceCatalog();
    const legacy = service();
    const factory = vi.fn(() => service());
    const router = new ProjectWorkflowRouter({ catalog, legacy, factory, runDir: runDirectory() });
    for (const name of [
      "list_plans",
      "create_plan",
      "get_plan",
      "run_plan",
      "get_run",
      "stop_run",
      "submit_step_result",
      "respond_to_task_request",
      "update_plan"
    ])
      await expect(router.call(name, {}, context)).rejects.toMatchObject({
        code: "DEFAULT_PROJECT_REQUIRED",
        status: 409
      });
    expect(legacy.call).not.toHaveBeenCalled();
    await router.call("list_actions", {}, context);
    await router.call("fetch_report", { query: {} }, context);
    expect(legacy.call).toHaveBeenCalledWith("list_actions", {}, context);
    expect(legacy.call).toHaveBeenCalledWith("fetch_report", { query: {} }, context);
    expect(factory).not.toHaveBeenCalled();
    const project = catalog.createProject("alice", {
      name: "Registered",
      hekateProjectId: randomUUID()
    });
    await router.call("list_plans", { projectId: project.id }, context);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("refuses missing bindings, foreign projects, invalid IDs, and nonoperators without a fallback call", async () => {
    const catalog = new WorkspaceCatalog();
    const disabled = catalog.createProject("alice", { name: "Repository only" });
    const foreign = catalog.createProject("bob", {
      name: "Foreign",
      hekateProjectId: randomUUID()
    });
    const legacy = service();
    const factory = vi.fn(() => service());
    const router = new ProjectWorkflowRouter({ catalog, legacy, factory, runDir: runDirectory() });
    await expect(
      router.call("list_plans", { projectId: disabled.id }, context)
    ).rejects.toMatchObject({ code: "PROJECT_WORKFLOWS_DISABLED" });
    await expect(
      router.call("list_plans", { projectId: foreign.id }, context)
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      router.call("list_plans", { projectId: "invalid" }, context)
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(router.call("list_plans", { projectId: null }, context)).rejects.toMatchObject({
      code: "invalid_input"
    });
    await expect(
      router.call(
        "list_plans",
        {},
        { ...context, principal: { ...context.principal, roles: new Set(["client"]) } }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(legacy.call).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("registers the owner default lazily and keeps explicit default selection in the existing run directory", async () => {
    const catalog = new WorkspaceCatalog();
    const legacy = service();
    const factory = vi.fn(() => service());
    const router = new ProjectWorkflowRouter({
      catalog,
      legacy,
      factory,
      runDir: runDirectory(),
      legacyProject: { name: "Default", hekateProjectId: randomUUID() }
    });
    expect(catalog.listProjects("alice")).toEqual([]);
    await router.call("list_plans", {}, context);
    const project = router.legacyProject("alice")!;
    await router.call("list_plans", { projectId: project.id }, context);
    expect(catalog.listProjects("alice")).toHaveLength(1);
    expect(legacy.call).toHaveBeenCalledTimes(2);
    expect(factory).not.toHaveBeenCalled();
  });

  it("links newly created plans to their conversation and preserves their established binding", async () => {
    const catalog = new WorkspaceCatalog();
    const project = catalog.createProject("alice", {
      name: "Project",
      hekateProjectId: randomUUID()
    });
    const runDir = runDirectory();
    const planId = randomUUID();
    const factory = vi.fn(() => {
      const instance = service();
      instance.call.mockResolvedValue({ id: planId });
      return instance;
    });
    const router = new ProjectWorkflowRouter({
      catalog,
      legacy: service(),
      factory,
      runDir
    });
    await router.call(
      "create_plan",
      { projectId: project.id, definition: {} },
      { ...context, conversationId: "chat" }
    );
    expect(catalog.linkedConversation("alice", project.id, planId)).toBe("chat");
    expect(() =>
      catalog.updateProject("alice", project.id, 1, { hekateProjectId: randomUUID() })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_BINDING_IMMUTABLE", status: 409 }));
    await router.call("list_plans", { projectId: project.id }, context);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenLastCalledWith(
      project,
      join(runDir, "projects", project.id, project.hekateProjectId!)
    );
  });

  it("moves an existing plan's saved conversation link after an explicit edit or run, using the plan ID rather than the run ID", async () => {
    const runDir = runDirectory();
    const catalogFile = join(runDir, "workspace.json");
    const catalog = new WorkspaceCatalog(catalogFile);
    const project = catalog.createProject("alice", {
      name: "Existing project",
      hekateProjectId: randomUUID()
    });
    const planId = randomUUID(),
      runId = randomUUID();
    catalog.associatePlan("alice", project.id, planId, "original-discussion");
    const application = service();
    // The application boundary returns a saved plan for an edit and a distinct
    // run identity referring to that plan for execution. The catalog and router are real.
    application.call.mockImplementation(async (name: string) =>
      name === "run_plan" ? { id: runId, planId, status: "running" } : { id: planId, revision: 2 }
    );
    const router = new ProjectWorkflowRouter({
      catalog,
      legacy: service(),
      factory: () => application,
      runDir
    });
    await router.call(
      "update_plan",
      { projectId: project.id, id: planId, revision: 1, definition: {} },
      { ...context, conversationId: "editing-discussion" }
    );
    expect(catalog.linkedConversation("alice", project.id, planId)).toBe("editing-discussion");
    await router.call(
      "update_plan",
      { projectId: project.id, id: planId, revision: 2, definition: {} },
      context
    );
    expect(catalog.linkedConversation("alice", project.id, planId)).toBe("editing-discussion");
    await router.call(
      "run_plan",
      { projectId: project.id, id: planId, revision: 2 },
      { ...context, conversationId: "execution-discussion" }
    );
    const restored = new WorkspaceCatalog(catalogFile);
    expect(restored.linkedConversation("alice", project.id, planId)).toBe("execution-discussion");
    expect(restored.linkedConversation("alice", project.id, runId)).toBeUndefined();
    expect(restored.conversationMetadata("alice", "execution-discussion")).toBeDefined();
    expect(restored.conversationMetadata("bob", "execution-discussion")).toBeUndefined();
    await router.close();
  });
});
