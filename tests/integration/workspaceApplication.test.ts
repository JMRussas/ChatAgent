import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityChat } from "../../src/app/capabilityChat";
import { ChatService } from "../../src/app/chatService";
import { ContextManager } from "../../src/app/contextManager";
import { ConversationPersistence } from "../../src/app/conversationPersistence";
import { DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { createEphemeralAuth } from "../../src/auth/ephemeral";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { WorkflowApplication } from "../../src/workflows/application";
import { WorkflowService } from "../../src/workflows/service";
import type { TaskExecutor } from "../../src/tasks/types";
import { HekateWorkflowStore } from "../../src/workflows/hekateStore";
import { WorkspaceCatalog } from "../../src/workspace/catalog";
import { ProjectWorkflowRouter } from "../../src/workspace/projectWorkflows";
import { WorkspaceService } from "../../src/workspace/service";
import { readCodingProject } from "../../src/workspace/codingProjects";
import { workStates } from "../../src/workspace/listWork";
import {
  WorkflowError,
  type StoredWorkflowPlan,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowPlanStore
} from "../../src/workflows/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const rawPlan = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
const original = JSON.parse(rawPlan);
const projectId = original.projectId as string;
const codingRoot = original.rootId as string;
function graph(rootId = codingRoot, project = projectId, marker?: unknown) {
  const view = JSON.parse(rawPlan.replaceAll(codingRoot, rootId));
  view.projectId = project;
  view.nodes[0].value = marker === undefined ? "Existing coding work" : JSON.stringify(marker);
  return view;
}
function metadata(rootId: string, project = projectId) {
  return {
    rootId,
    projectId: project,
    name: "Listed plan",
    contractVersion: "plan-contract/v1",
    supported: true
  };
}
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Domain definitions persist across fixture restarts; real workflow artifacts live on disk. */
class PlanStore implements WorkflowPlanStore {
  private readonly plans = new Map<string, StoredWorkflowPlan>();
  async list(owner: string) {
    return [...this.plans.values()]
      .filter((plan) => plan.ownerId === owner)
      .map((plan) => structuredClone(plan));
  }
  async get(owner: string, id: string) {
    const plan = this.plans.get(id);
    if (!plan || plan.ownerId !== owner)
      throw new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow not found.", 404);
    return structuredClone(plan);
  }
  async create(owner: string, definition: WorkflowDefinition) {
    const plan: StoredWorkflowPlan = {
      id: randomUUID(),
      ownerId: owner,
      definition,
      revision: 1,
      stateRevision: 1,
      taskId: randomUUID(),
      work: "todo",
      attemptId: null,
      attemptEpoch: 0,
      artifactRef: null
    };
    this.plans.set(plan.id, structuredClone(plan));
    return structuredClone(plan);
  }
  async update(owner: string, id: string, revision: number, definition: WorkflowDefinition) {
    const plan = await this.get(owner, id);
    if (plan.revision !== revision || plan.work === "in_progress")
      throw new WorkflowError("WORKFLOW_CONFLICT", "Workflow changed.", 409);
    const next = { ...plan, definition, revision: revision + 1 };
    this.plans.set(id, structuredClone(next));
    return structuredClone(next);
  }
  async start(owner: string, id: string, revision: number, runId: string) {
    const plan = await this.get(owner, id);
    if (plan.revision !== revision || plan.work !== "todo")
      throw new WorkflowError("WORKFLOW_CONFLICT", "Workflow changed.", 409);
    const next: StoredWorkflowPlan = {
      ...plan,
      work: "in_progress",
      attemptId: runId,
      attemptEpoch: plan.attemptEpoch + 1
    };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async finish(owner: string, id: string, runId: string, epoch: number, artifactRef: string) {
    const plan = await this.fenced(owner, id, runId, epoch);
    const next: StoredWorkflowPlan = { ...plan, work: "done", artifactRef };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async release(owner: string, id: string, runId: string, epoch: number) {
    const plan = await this.fenced(owner, id, runId, epoch);
    const next: StoredWorkflowPlan = { ...plan, work: "todo", attemptId: null };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  private async fenced(owner: string, id: string, runId: string, epoch: number) {
    const plan = await this.get(owner, id);
    if (plan.attemptId !== runId || plan.attemptEpoch !== epoch)
      throw new WorkflowError("WORKFLOW_CONFLICT", "Workflow attempt changed.", 409);
    return plan;
  }
}

async function workspaceFixture(executors: TaskExecutor[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-application-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const auth = createEphemeralAuth();
  const foreignAuth = createEphemeralAuth();
  const legacyProjectId = randomUUID();
  const stores = new Map<string, PlanStore>();
  const readReport = vi.fn(async () => ({ items: 3 }));
  const actions = [
    {
      name: "read_report",
      description: "Read the report",
      inputSchema: { type: "object" },
      execute: readReport
    }
  ];
  let planningReply: unknown = { action: "answer", message: "The project discussion is saved." };
  const generate = vi.fn(async () => ({
    text: JSON.stringify(planningReply),
    finishReason: "stop" as const
  }));
  const start = async (identity = auth, apiUrl?: string, nativeStore = false) => {
    const catalog = new WorkspaceCatalog(join(directory, "workspace.json"));
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const budget = {
      windowTokens: 64000,
      maxHistoryTurns: 12,
      safetyTokens: 256,
      fastOutputTokens: 1024,
      deepOutputTokens: 2048
    };
    let workspace: WorkspaceService | undefined;
    const chat = new ChatService(
      new CapabilityChat(
        { createProvisionalReply: generate },
        queue,
        timeline,
        new ContextManager(timeline, budget),
        () => ({
          fastProvider: "test",
          fastModel: "planner",
          deepProvider: "test",
          deepModel: "test",
          generatedAtIso: new Date().toISOString()
        }),
        (message) => workspace?.capabilities(message) ?? []
      ),
      new DeepWorker(queue, new MockDeepProvider(), timeline),
      timeline,
      queue
    );
    const persistence = new ConversationPersistence(
      join(directory, "conversations.json"),
      timeline,
      chat
    );
    const application = (hekateId: string, runDir: string) => {
      let store = stores.get(hekateId);
      if (!store) {
        store = new PlanStore();
        stores.set(hekateId, store);
      }
      let app: WorkflowApplication;
      app = new WorkflowApplication(
        new WorkflowService(
          nativeStore ? new HekateWorkflowStore(apiUrl!, hekateId) : store,
          runDir,
          {
            actions,
            executors,
            taskTools: () => (workspace?.taskView(hekateId) ?? app).tools,
            callTaskTool: (name, input, context) =>
              (workspace?.taskView(hekateId) ?? app).call(name, input, context)
          }
        ),
        actions
      );
      return app;
    };
    const runDir = join(directory, "runs");
    const workflows = new ProjectWorkflowRouter({
      catalog,
      runDir,
      legacy: application(legacyProjectId, runDir),
      legacyProject: { name: "Default project", hekateProjectId: legacyProjectId },
      factory: (project, path) => application(project.hekateProjectId!, path)
    });
    workspace = new WorkspaceService({
      catalog,
      chat,
      workflows,
      apiUrl,
      persistenceEnabled: true
    });
    const server = createChatServer(chat, {
      auth: identity.auth,
      workflowTools: workspace,
      workspaceTools: workspace,
      conversationPersistence: persistence
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await workspace!.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      persistence.close();
    };
    cleanups.push(close);
    const response = (
      path: string,
      data?: unknown,
      headers: Record<string, string> = identity.headers("operator")
    ) =>
      fetch(base + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { ...headers, "content-type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
    const rpc = async (name: string, data: unknown) => {
      const result = await response("/workspace/tools/" + name, data);
      expect(
        result.status,
        `${name}: ${result.status === 200 ? "" : await result.clone().text()}`
      ).toBe(200);
      return result.json();
    };
    return { base, response, rpc, close, chat, persistence, workflows, catalog, workspace };
  };
  return {
    directory,
    auth,
    foreignAuth,
    start,
    readReport,
    generate,
    plan: (value: unknown) => {
      planningReply = value;
    }
  };
}

const triageDefinition = (tools: string[]) => ({
  version: 1,
  name: "Read project work",
  steps: [
    {
      id: "triage",
      name: "Read outstanding work",
      action: {
        type: "agent",
        executor: "triage",
        task: {
          objective: "Read the source project's outstanding work and cite actual records.",
          tools,
          completionCriteria: ["Use actual returned project records."]
        }
      }
    }
  ]
});
async function observedRun(
  rpc: (name: string, data: unknown) => Promise<any>,
  projectId: string,
  id: string,
  predicate: (run: WorkflowRun) => boolean
) {
  let run!: WorkflowRun;
  await vi.waitFor(
    async () => {
      run = await rpc("get_run", { id, projectId });
      expect(predicate(run), JSON.stringify({ status: run.status, error: run.error })).toBe(true);
    },
    { timeout: 8000, interval: 30 }
  );
  return run;
}

describe("native task workspace authority", () => {
  it("rejects malformed whole scoped arguments before they can fall through to a reassigned conversation", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    const source = await app.rpc("register_project", {
      name: "Original task source",
      hekateProjectId: randomUUID()
    });
    const other = await app.rpc("register_project", {
      name: "Reassigned conversation project",
      hekateProjectId: randomUUID()
    });
    const conversation = await app.rpc("create_conversation", {
      title: "Reassigned",
      projectId: other.id
    });
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    const context = { principal, operationId: randomUUID(), conversationId: conversation.id };
    const view = app.workspace.taskView(source.hekateProjectId);
    const dispatch = vi.spyOn(app.workspace, "call");
    for (const input of [null, [], "null", 7, true]) {
      await expect(view.call("list_work", input, context)).rejects.toMatchObject({
        code: "INVALID_WORKSPACE_INPUT",
        status: 400
      });
    }
    for (const tool of view.tools.filter(
      (tool) =>
        tool.name !== "update_conversation" &&
        Object.hasOwn(tool.inputSchema.properties ?? {}, "projectId")
    )) {
      await expect(view.call(tool.name, null, context)).rejects.toMatchObject({
        code: "INVALID_WORKSPACE_INPUT",
        status: 400
      });
    }
    expect(dispatch).not.toHaveBeenCalled();
    for (const input of [undefined, {}]) {
      expect(await view.call("list_work", input, context)).toMatchObject({
        scope: { projectId: source.id, source: "task" }
      });
      expect(await view.call("list_plans", input, context)).toEqual({ plans: [] });
    }
    await view.call(
      "update_conversation",
      { id: conversation.id, title: "Title changed only" },
      context
    );
    expect(app.catalog.conversationMetadata(principal.principalId, conversation.id)).toMatchObject({
      title: "Title changed only",
      projectId: other.id
    });
    expect(app.catalog.listProjects(principal.principalId)).toHaveLength(2);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("keeps the source project across conversation reassignment and restart while allowing an explicit owned project", async () => {
    let source: any;
    let other: any;
    let foreign: any;
    let planId: string;
    const executor: TaskExecutor = {
      id: "triage",
      async execute(_task, host, checkpoint) {
        expect(await host.callTool("list_work", {})).toMatchObject({
          scope: { projectId: source.id, source: "task" },
          items: [expect.objectContaining({ id: planId, projectId: source.id })]
        });
        if (!checkpoint) {
          expect(await host.callTool("list_work", { projectId: other.id })).toMatchObject({
            scope: { projectId: other.id, source: "explicit" },
            items: [expect.objectContaining({ name: "Other project's review" })]
          });
          await expect(host.callTool("list_work", { projectId: foreign.id })).rejects.toMatchObject(
            { code: "PROJECT_NOT_FOUND" }
          );
          // An actual successful same-tool read resolves the failed read; no effect is retried.
          await host.callTool("list_work", {});
          await host.requestContext("Review the project counts before continuing.");
          return { text: "Awaiting the operator's context.", checkpoint: { stage: 1 } };
        }
        expect(await host.callTool("get_work_digest", { id: planId })).toMatchObject({
          id: planId,
          projectId: source.id,
          run: { id: host.runId, current: true }
        });
        return { text: "Read the original project's records after restart." };
      }
    };
    const fixture = await workspaceFixture([executor]);
    const first = await fixture.start();
    source = await first.rpc("register_project", { name: "Source", hekateProjectId: randomUUID() });
    other = await first.rpc("register_project", { name: "Other", hekateProjectId: randomUUID() });
    foreign = first.catalog.createProject(fixture.foreignAuth.auth.principalId, {
      name: "Foreign source binding",
      hekateProjectId: source.hekateProjectId
    });
    await first.rpc("create_plan", {
      projectId: other.id,
      definition: {
        version: 1,
        name: "Other project's review",
        steps: [{ id: "review", name: "Review", action: { type: "human", instructions: "Review" } }]
      }
    });
    const conversation = await first.rpc("create_conversation", {
      title: "Triage",
      projectId: source.id
    });
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    const context = { principal, operationId: randomUUID(), conversationId: conversation.id };
    const plan = (await first.workspace.call(
      "create_plan",
      { definition: triageDefinition(["list_work", "get_work_digest"]) },
      context
    )) as StoredWorkflowPlan;
    planId = plan.id;
    const started = (await first.workspace.call(
      "run_plan",
      { id: plan.id, revision: plan.revision },
      context
    )) as WorkflowRun;
    const parked = await observedRun(
      first.rpc,
      source.id,
      started.id,
      (run) => run.status === "waiting_input"
    );
    expect(parked.ownerId).toBe(principal.principalId);
    expect(parked.steps[0]!.agent!.events).toContainEqual(
      expect.objectContaining({
        type: "tool_started",
        tool: "list_work",
        arguments: {}
      })
    );
    expect(parked.steps[0]!.agent!.events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        tool: "list_work",
        result: expect.objectContaining({ code: "PROJECT_NOT_FOUND" })
      })
    );
    expect(parked.steps[0]!.output).toBeUndefined();
    const taskView = first.workspace.taskView(source.hekateProjectId);
    const linkMetadata = taskView.tools.find((tool) => tool.name === "link_plan")!;
    expect(linkMetadata.inputSchema.required).not.toContain("projectId");
    expect(
      first.workspace.tools.find((tool) => tool.name === "link_plan")!.inputSchema.required
    ).toContain("projectId");
    await taskView.call("link_plan", { planId, conversationId: conversation.id }, context);
    expect(first.catalog.linkedConversation(principal.principalId, source.id, planId)).toBe(
      conversation.id
    );
    await first.rpc("update_conversation", { id: conversation.id, projectId: other.id });
    // projectId is a patch here: a title-only rename must not reassign this conversation.
    await first.workspace
      .taskView(source.hekateProjectId)
      .call("update_conversation", { id: conversation.id, title: "Renamed triage" }, context);
    expect(
      first.catalog.conversationMetadata(principal.principalId, conversation.id)
    ).toMatchObject({
      title: "Renamed triage",
      projectId: other.id
    });
    await first.close();
    const resumed = await fixture.start();
    await resumed.workspace.call(
      "respond_to_task_request",
      {
        projectId: source.id,
        id: started.id,
        stepId: "triage",
        requestId: parked.steps[0]!.agent!.requests[0]!.id,
        response: "Counts reviewed; continue the original project."
      },
      { ...context, operationId: randomUUID() }
    );
    const completed = await observedRun(
      resumed.rpc,
      source.id,
      started.id,
      (run) => run.status === "completed"
    );
    expect(
      completed.steps[0]!.agent!.events.filter(
        (event) => event.type === "tool_finished" && event.tool === "list_work"
      ).at(-1)?.result
    ).toMatchObject({ scope: { projectId: source.id, source: "task" } });
    expect(completed.steps[0]!.output).toMatchObject({ executor: "triage" });
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("preserves grants, denied writes, self-control guards and failed-read recovery through the workspace registry", async () => {
    let project: any;
    let planId: string;
    const executor: TaskExecutor = {
      id: "triage",
      async execute(task, host, checkpoint) {
        const stage = (checkpoint as { stage?: number } | undefined)?.stage ?? 0;
        if (stage === 0) {
          await expect(host.callTool("get_work_digest", { id: planId })).rejects.toMatchObject({
            code: "tool_not_allowed"
          });
          for (const name of ["get_workspace", "stop_run"])
            await expect(host.requestTool(name, "Request access")).rejects.toMatchObject({
              code: "tool_unavailable"
            });
          await expect(
            host.callTool("respond_to_task_request", { id: host.runId })
          ).rejects.toMatchObject({ code: "task_self_control" });
          await expect(
            host.callTool("list_work", { projectId: project.hekateProjectId })
          ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
          await host.callTool("list_work", {});
          await host.requestTool("register_project", "May I register another project?");
          return { text: "Requesting explicit write access.", checkpoint: { stage: 1 } };
        }
        if (stage === 1) {
          expect(task.tools).not.toContain("register_project");
          await expect(
            host.callTool("register_project", { name: "Must not be written" })
          ).rejects.toMatchObject({ code: "tool_not_allowed" });
          await host.requestTool("get_work_digest", "May I read the plan's decision summary?");
          return { text: "Requesting read access.", checkpoint: { stage: 2 } };
        }
        expect(task.tools).toContain("get_work_digest");
        expect(await host.callTool("get_work_digest", { id: planId })).toMatchObject({
          id: planId,
          projectId: project.id
        });
        return { text: "Read the granted factual summary." };
      }
    };
    const fixture = await workspaceFixture([executor]);
    const app = await fixture.start();
    project = await app.rpc("register_project", {
      name: "Task source",
      hekateProjectId: randomUUID()
    });
    const definition = triageDefinition(["list_work", "respond_to_task_request"]);
    const excluded = await app.response("/workspace/tools/create_plan", {
      projectId: project.id,
      definition: triageDefinition(["get_workspace"])
    });
    expect(await excluded.json()).toMatchObject({ code: "tool_unavailable" });
    const plan = await app.rpc("create_plan", { projectId: project.id, definition });
    planId = plan.id;
    const started = await app.rpc("run_plan", {
      projectId: project.id,
      id: plan.id,
      revision: plan.revision
    });
    const writeRequest = await observedRun(
      app.rpc,
      project.id,
      started.id,
      (run) => run.status === "waiting_input"
    );
    expect(writeRequest.steps[0]!.agent!.requests[0]).toMatchObject({
      kind: "tool",
      tool: "register_project",
      origin: "executor"
    });
    await app.rpc("respond_to_task_request", {
      projectId: project.id,
      id: started.id,
      stepId: "triage",
      requestId: writeRequest.steps[0]!.agent!.requests[0]!.id,
      response: { approved: false }
    });
    const readRequest = await observedRun(
      app.rpc,
      project.id,
      started.id,
      (run) => run.status === "waiting_input" && run.steps[0]!.agent!.requests.length === 2
    );
    expect(readRequest.steps[0]!.agent!.allowedTools).toEqual(
      definition.steps[0]!.action.task.tools
    );
    await app.rpc("respond_to_task_request", {
      projectId: project.id,
      id: started.id,
      stepId: "triage",
      requestId: readRequest.steps[0]!.agent!.requests[1]!.id,
      response: { approved: true }
    });
    const completed = await observedRun(
      app.rpc,
      project.id,
      started.id,
      (run) => run.status === "completed"
    );
    expect(completed.steps[0]!.agent!.allowedTools).toContain("get_work_digest");
    expect(
      app.catalog.listProjects(fixture.auth.auth.principalId).map((item) => item.name)
    ).toEqual(["Task source"]);
    expect(
      completed.steps[0]!.agent!.events.filter(
        (event) => event.type === "tool_started" && event.tool === "register_project"
      )
    ).toEqual([]);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("rejects an unavailable source binding and conflicting names without implicit registration or input rewriting", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    const project = await app.rpc("register_project", {
      name: "Conversation project",
      hekateProjectId: randomUUID()
    });
    const conversation = await app.rpc("create_conversation", {
      title: "Assigned",
      projectId: project.id
    });
    const context = { principal, operationId: randomUUID(), conversationId: conversation.id };
    const missing = app.workspace.taskView(randomUUID());
    await expect(missing.call("list_work", {}, context)).rejects.toMatchObject({
      code: "TASK_PROJECT_UNAVAILABLE",
      status: 409
    });
    expect(await missing.call("list_work", { projectId: project.id }, context)).toMatchObject({
      scope: { projectId: project.id }
    });
    await expect(
      missing.call(
        "list_work",
        {},
        { ...context, principal: { ...principal, roles: new Set(["client" as const]) } }
      )
    ).rejects.toMatchObject({ code: "OPERATOR_REQUIRED" });
    for (const projectId of [null, 123])
      await expect(missing.call("list_work", { projectId }, context)).rejects.toMatchObject({
        code: "INVALID_WORKSPACE_INPUT"
      });
    await expect(missing.call("get_workspace", {}, context)).rejects.toMatchObject({
      code: "tool_unavailable"
    });
    // Registration has no project scope selector; its strict schema must receive the original args.
    const registered = (await missing.call(
      "register_project",
      { name: "Explicit registration" },
      context
    )) as { id: string };
    expect(app.catalog.getProject(principal.principalId, registered.id).name).toBe(
      "Explicit registration"
    );
    for (const name of ["list_work", "get_workspace"]) {
      const actions = [
        {
          name,
          description: "Configured conflicting action",
          inputSchema: { type: "object" },
          execute: async () => ({})
        }
      ];
      const workflow = new WorkflowApplication(
        new WorkflowService(new PlanStore(), join(fixture.directory, name), { actions }),
        actions
      );
      const colliding = new ProjectWorkflowRouter({
        catalog: app.catalog,
        legacy: workflow,
        runDir: fixture.directory,
        factory: () => workflow
      });
      expect(
        () => new WorkspaceService({ catalog: app.catalog, chat: app.chat, workflows: colliding })
      ).toThrow(expect.objectContaining({ code: "DUPLICATE_WORKSPACE_TOOL" }));
      await colliding.close();
    }
    expect(app.catalog.listProjects(principal.principalId)).toHaveLength(2);
    expect(fixture.generate).not.toHaveBeenCalled();
  });
});

describe("existing coding project observation", () => {
  it("reads a multi-node coding digest through the actual Hekate store boundary while preserving corrupt workflow storage errors", async () => {
    const observed = graph();
    observed.defaultGate = "completed";
    observed.dependencies = [
      { predecessorId: observed.nodes[4].id, successorId: observed.nodes[1].id, gate: "accepted" }
    ];
    expect(observed.nodes.length).toBeGreaterThan(2);
    const requests: string[] = [];
    let returned = observed;
    const base = await endpoint((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/api/plan-contract/v1/plans")
        return json(res, {
          contractVersion: "plan-contract/v1",
          plans: [metadata(codingRoot)],
          nextAfterRootId: null
        });
      if (url.pathname.endsWith(codingRoot)) return json(res, returned);
      json(res, {}, 404);
    });
    const fixture = await workspaceFixture();
    const app = await fixture.start(fixture.auth, base, true);
    const project = await app.rpc("register_project", {
      name: "Actual Hekate coding boundary",
      hekateProjectId: projectId
    });
    expect(
      (await app.response("/workspace/tools/get_plan", { id: codingRoot, projectId: project.id }))
        .status
    ).toBe(502);
    const digest = await app.rpc("get_work_digest", { id: codingRoot, projectId: project.id });
    expect(digest).toMatchObject({
      kind: "coding",
      projectId: project.id,
      state: "needs_decision",
      decision: { kind: "result" },
      revision: null,
      alsoAllocated: 1,
      progress: { done: 1, total: 4 }
    });
    returned = structuredClone(observed);
    returned.nodes[0].value = JSON.stringify({
      kind: "chatagent-workflow",
      version: 1,
      ownerId: fixture.auth.auth.principalId
    });
    const corruptedWorkflow = await app.response("/workspace/tools/get_work_digest", {
      id: codingRoot,
      projectId: project.id
    });
    expect(corruptedWorkflow.status).toBe(502);
    expect(await corruptedWorkflow.json()).toMatchObject({ code: "WORKFLOW_INVALID_STORAGE" });
    returned = { ...structuredClone(observed), nodes: [] };
    const corruptedGraph = await app.response("/workspace/tools/get_work_digest", {
      id: codingRoot,
      projectId: project.id
    });
    expect(corruptedGraph.status).toBe(502);
    expect(await corruptedGraph.json()).toMatchObject({ code: "WORKFLOW_INVALID_STORAGE" });
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.readReport).not.toHaveBeenCalled();
  });
  it("shows actual coding progress once, excludes shared workflow roots and foreign project data", async () => {
    const workflowRoot = randomUUID();
    const foreignListedRoot = randomUUID();
    const movedRoot = randomUUID();
    const foreignProject = randomUUID();
    const seen: string[] = [];
    const base = await endpoint((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/api/plan-contract/v1/plans") {
        expect(url.searchParams.get("projectId")).toBe(projectId);
        expect(url.searchParams.get("limit")).toBe("100");
        json(res, {
          contractVersion: "plan-contract/v1",
          plans: [
            metadata(codingRoot),
            metadata(codingRoot),
            metadata(workflowRoot),
            metadata(foreignListedRoot, foreignProject),
            metadata(movedRoot)
          ],
          nextAfterRootId: randomUUID()
        });
      } else if (url.pathname.endsWith(codingRoot)) json(res, graph());
      else if (url.pathname.endsWith(workflowRoot))
        json(res, graph(workflowRoot, projectId, { kind: "chatagent-workflow", ownerId: "other" }));
      else if (url.pathname.endsWith(movedRoot)) {
        const foreign = graph(movedRoot, foreignProject);
        foreign.nodes[0].name = "PRIVATE_FOREIGN_PLAN";
        json(res, foreign);
      } else json(res, { secret: "PRIVATE_FOREIGN_PLAN" }, 500);
    });
    const result = await readCodingProject(base, projectId.toUpperCase(), {
      preparedRoots: [codingRoot.toUpperCase()]
    });
    expect(result).toMatchObject({
      truncated: true,
      unavailable: 1,
      work: [
        {
          id: codingRoot,
          name: "C1 disposable status fixture",
          kind: "coding",
          status: "active",
          prepared: true,
          nextStep: { name: "In progress", status: "in_progress" }
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FOREIGN_PLAN");
    expect(seen.filter((path) => path.endsWith(codingRoot))).toHaveLength(1);
    expect(seen.some((path) => path.includes(foreignListedRoot))).toBe(false);
    expect(seen.every((path) => path.startsWith("GET "))).toBe(true);
    const fixture = await workspaceFixture();
    const app = await fixture.start(fixture.auth, base);
    const project = await app.rpc("register_project", {
      name: "Existing coding repository",
      hekateProjectId: projectId,
      preparedPlanRoots: [codingRoot]
    });
    const directory = await app.rpc("get_workspace", { projectId: project.id });
    expect(directory.work).toEqual([
      expect.objectContaining({
        id: codingRoot,
        projectId: project.id,
        kind: "coding",
        status: "active",
        nextStep: "In progress",
        nextStepId: original.nodes[2].id,
        prepared: true,
        conversationId: null
      })
    ]);
    const codingDigest = await app.rpc("get_work_digest", {
      id: codingRoot,
      projectId: project.id
    });
    expect(codingDigest).toMatchObject({
      kind: "coding",
      state: "needs_decision",
      revision: null,
      run: null,
      alsoAllocated: 1,
      decision: { kind: "result" },
      next: { actor: "You" },
      progress: { done: 1 }
    });
    expect(directory.work[0].digest).toEqual(codingDigest);
    expect(codingDigest.verification).toMatchObject({
      by: "hekate_accepted",
      scope: "step",
      at: null
    });
    expect(JSON.stringify(directory)).not.toContain("PRIVATE_FOREIGN_PLAN");
    expect(directory.errors).toContainEqual({
      projectId: project.id,
      message: "Some coding plans could not be read or verified for this project."
    });
    expect(seen.every((path) => path.startsWith("GET "))).toBe(true);
  });

  it("retains per-root unavailability and refuses a failed listing without exposing backend details", async () => {
    let listingFails = false;
    const base = await endpoint((req, res) => {
      if (listingFails) return json(res, { secret: "PRIVATE_BACKEND_DETAILS" }, 500);
      if (req.url?.includes("?"))
        json(res, {
          contractVersion: "plan-contract/v1",
          plans: [metadata(codingRoot)],
          nextAfterRootId: null
        });
      else json(res, { secret: "PRIVATE_BACKEND_DETAILS" }, 500);
    });
    const result = await readCodingProject(base, projectId);
    expect(result).toMatchObject({
      unavailable: 1,
      work: [{ id: codingRoot, status: "unavailable", error: "CODING_HTTP_ERROR" }]
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BACKEND_DETAILS");
    listingFails = true;
    await expect(readCodingProject(base, projectId)).rejects.toMatchObject({
      code: "CODING_HTTP_ERROR",
      message: "The coding plan API could not return the requested state."
    });
  });

  it("bounds graph bodies and the whole observation deadline", async () => {
    let slow = false;
    const base = await endpoint((req, res) => {
      if (req.url?.includes("?"))
        json(res, {
          contractVersion: "plan-contract/v1",
          plans: [metadata(codingRoot)],
          nextAfterRootId: null
        });
      else if (slow) {
        const timeout = setTimeout(() => json(res, graph()), 200);
        res.once("close", () => clearTimeout(timeout));
      } else json(res, graph());
    });
    expect(await readCodingProject(base, projectId, { maxBytes: 1024 })).toMatchObject({
      unavailable: 1,
      work: [{ error: "CODING_RESPONSE_TOO_LARGE", status: "unavailable" }]
    });
    slow = true;
    expect(await readCodingProject(base, projectId, { timeoutMs: 50 })).toMatchObject({
      unavailable: 1,
      work: [{ error: "CODING_ABORTED", status: "unavailable" }]
    });
  });
});

describe("authenticated saved workspace journeys", () => {
  it("exposes the same read-only digest over HTTP and native MCP without registering a default project or replaying work", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    const missing = await app.response("/workspace/tools/get_work_digest", { id: randomUUID() });
    expect(missing.status).toBe(409);
    expect(app.catalog.listProjects(fixture.auth.auth.principalId)).toEqual([]);
    const toolList = await (await app.response("/workspace/tools")).json();
    expect(toolList.tools).toContainEqual(
      expect.objectContaining({ name: "get_work_digest", readOnly: true })
    );
    const project = await app.rpc("register_project", {
      name: "Read-only summary project",
      hekateProjectId: randomUUID()
    });
    const plan = await app.rpc("create_plan", {
      projectId: project.id,
      definition: {
        version: 1,
        name: "Review without executing",
        steps: [
          {
            id: "review",
            name: "Review",
            action: { type: "human", instructions: "Approve only after checking evidence." }
          }
        ]
      }
    });
    const before = readFileSync(join(fixture.directory, "workspace.json"), "utf8");
    const direct = await app.rpc("get_work_digest", { id: plan.id, projectId: project.id });
    const client = new Client({ name: "digest-observer", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.base + "/mcp"), {
        requestInit: { headers: fixture.auth.headers("operator") }
      })
    );
    const discovery = await client.listTools();
    expect(discovery.tools).toContainEqual(
      expect.objectContaining({
        name: "get_work_digest",
        annotations: expect.objectContaining({ readOnlyHint: true })
      })
    );
    expect(discovery.tools).toContainEqual(
      expect.objectContaining({
        name: "list_work",
        annotations: expect.objectContaining({ readOnlyHint: true })
      })
    );
    const list = await app.rpc("list_work", { projectId: project.id });
    const nativeList = await client.callTool({
      name: "list_work",
      arguments: { projectId: project.id }
    });
    expect(nativeList.isError).toBe(false);
    expect(nativeList.structuredContent).toEqual(list);
    expect(list.items).toEqual([direct]);
    expect(list.counts).toMatchObject({ read: 1, ready: 1 });
    const remote = await client.callTool({
      name: "get_work_digest",
      arguments: { id: plan.id, projectId: project.id }
    });
    expect(remote.isError).toBe(false);
    expect(remote.structuredContent).toEqual(direct);
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    expect(
      await app.workspace.call(
        "get_work_digest",
        { id: plan.id, projectId: project.id },
        { principal, operationId: randomUUID() }
      )
    ).toEqual(direct);
    const capability = app.workspace
      .capabilities({
        conversationId: "observer",
        userId: "observer",
        text: "Read work",
        timestampIso: new Date().toISOString(),
        applicationContext: { principal }
      })
      .find((tool) => tool.id === "get_work_digest")!;
    expect(capability.effect).toBe("read");
    const formatted = capability.formatResult!(direct);
    expect(formatted).toContain("Ready");
    expect(formatted).toContain("Review · You");
    expect(formatted).toContain("Last outcome: none recorded");
    expect(formatted).toContain("Verification: not verified");
    const listCapability = app.workspace
      .capabilities({
        conversationId: "observer",
        userId: "observer",
        text: "List work",
        timestampIso: new Date().toISOString(),
        applicationContext: { principal }
      })
      .find((tool) => tool.id === "list_work")!;
    expect(listCapability.effect).toBe("read");
    expect(listCapability.formatResult!(list)).toContain("Observed work: 1");
    expect(listCapability.formatResult!(list)).toContain(plan.id);
    expect(listCapability.formatResult!(list)).toContain(project.id);
    expect(direct).toMatchObject({
      state: "ready",
      decision: null,
      run: null,
      progress: { done: 0, total: 1 }
    });
    expect(readFileSync(join(fixture.directory, "workspace.json"), "utf8")).toBe(before);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.readReport).not.toHaveBeenCalled();
    expect(
      (
        await app.response(
          "/workspace/tools/get_work_digest",
          { id: plan.id, projectId: project.id },
          fixture.auth.headers("client")
        )
      ).status
    ).toBe(403);
  });
  it("lists only owned explicit or conversation scope, otherwise active projects, without implicit registration or metadata writes", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    expect(await app.rpc("list_work", {})).toMatchObject({
      scope: { source: "all_active", projectsRead: 0 },
      counts: { read: 0 }
    });
    expect(app.catalog.listProjects(fixture.auth.auth.principalId)).toEqual([]);
    const first = await app.rpc("register_project", {
      name: "First active",
      hekateProjectId: randomUUID()
    });
    const second = await app.rpc("register_project", {
      name: "Second active",
      hekateProjectId: randomUUID()
    });
    const unbacked = await app.rpc("register_project", { name: "Metadata-only project" });
    const archived = await app.rpc("register_project", {
      name: "Archived",
      hekateProjectId: randomUUID(),
      archived: true
    });
    const definition = {
      version: 1,
      name: "Ready review",
      description: "d".repeat(4000),
      steps: [
        { id: "review", name: "Review", action: { type: "human", instructions: "p".repeat(4000) } }
      ]
    };
    const plans = await Promise.all(
      [first, second, archived].map((project) =>
        app.rpc("create_plan", { projectId: project.id, definition })
      )
    );
    const selectedConversation = await app.rpc("create_conversation", { projectId: first.id });
    const unassignedConversation = await app.rpc("create_conversation", {});
    const reads = vi.spyOn(app.workflows, "call");
    const before = readFileSync(join(fixture.directory, "workspace.json"), "utf8");
    const headers = {
      ...fixture.auth.headers("operator"),
      "x-workspace-conversation-id": selectedConversation.id
    };
    const selectedResponse = await app.response("/workspace/tools/list_work", {}, headers);
    expect(selectedResponse.status).toBe(200);
    const selected = await selectedResponse.json();
    expect(selected).toMatchObject({
      scope: { projectId: first.id, source: "conversation", projectsRead: 1 },
      counts: { read: 1, ready: 1 },
      source: { truncated: false, errorCount: 0 }
    });
    expect(selected.items[0]).toMatchObject({
      id: plans[0].id,
      projectId: first.id,
      truncated: true
    });
    expect(
      reads.mock.calls
        .filter(([name]) => name === "list_plans")
        .map(([, args]) => (args as any).projectId)
    ).toEqual([first.id]);
    reads.mockClear();
    const allResponse = await app.response(
      "/workspace/tools/list_work",
      {},
      {
        ...fixture.auth.headers("operator"),
        "x-workspace-conversation-id": unassignedConversation.id
      }
    );
    expect(allResponse.status).toBe(200);
    const all = await allResponse.json();
    expect(all).toMatchObject({
      scope: { projectId: null, source: "all_active", projectsRead: 2 },
      counts: { read: 2, ready: 2 }
    });
    expect(new Set(all.items.map((item: any) => item.id))).toEqual(
      new Set([plans[0].id, plans[1].id])
    );
    const explicit = await (
      await app.response(
        "/workspace/tools/list_work",
        { projectId: second.id.toUpperCase() },
        headers
      )
    ).json();
    expect(explicit).toMatchObject({
      scope: { projectId: second.id, source: "explicit", projectsRead: 1 },
      items: [{ id: plans[1].id }]
    });
    reads.mockClear();
    const unqueried = await app.rpc("list_work", { projectId: unbacked.id });
    expect(unqueried).toMatchObject({
      scope: { projectId: unbacked.id, source: "explicit", projectsRead: 0 },
      counts: { read: 0 },
      items: []
    });
    expect(reads).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.directory, "workspace.json"), "utf8")).toBe(before);
    reads.mockRestore();
    const snapshot = await app.rpc("get_workspace", { projectId: first.id });
    expect(snapshot.work.map((row: any) => row.digest)).toEqual(selected.items);
    const foreign = await fixture.start(fixture.foreignAuth);
    const foreignReads = vi.spyOn(foreign.workflows, "call");
    const protectedBefore = readFileSync(join(fixture.directory, "workspace.json"), "utf8");
    expect(
      (await foreign.response("/workspace/tools/list_work", { projectId: first.id })).status
    ).toBe(404);
    expect(foreignReads).not.toHaveBeenCalled();
    expect(foreign.catalog.listProjects(fixture.foreignAuth.auth.principalId)).toEqual([]);
    expect(readFileSync(join(fixture.directory, "workspace.json"), "utf8")).toBe(protectedBefore);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.readReport).not.toHaveBeenCalled();
  });

  it("keeps a known recorded execution failure complete, and only marks actual run read failures as incomplete source", async () => {
    const fixture = await workspaceFixture();
    fixture.readReport.mockRejectedValueOnce(new Error("PRIVATE_EXECUTOR_ERROR"));
    const app = await fixture.start();
    const project = await app.rpc("register_project", {
      name: "Known execution failure",
      hekateProjectId: randomUUID()
    });
    const plan = await app.rpc("create_plan", {
      projectId: project.id,
      definition: {
        version: 1,
        name: "Fail and inspect",
        steps: [{ id: "read", name: "Read report", action: { type: "tool", tool: "read_report" } }]
      }
    });
    const run = await app.rpc("run_plan", {
      projectId: project.id,
      id: plan.id,
      revision: plan.revision
    });
    await expect
      .poll(async () => (await app.rpc("get_run", { projectId: project.id, id: run.id })).status)
      .toBe("failed");
    const known = await app.rpc("list_work", { projectId: project.id });
    expect(known).toMatchObject({
      counts: { read: 1, needs_attention: 1 },
      source: { truncated: false, errorCount: 0 },
      errors: [],
      errorsOmitted: 0,
      items: [
        {
          state: "needs_attention",
          errors: ["Step action failed"],
          run: { id: run.id, status: "failed", current: true }
        }
      ]
    });
    const workspace = await app.rpc("get_workspace", { projectId: project.id });
    expect(workspace.work[0]).toMatchObject({ status: "failed", error: "Step action failed" });
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    const formatted = app.workspace
      .capabilities({
        conversationId: "observer",
        userId: "observer",
        text: "List work",
        timestampIso: new Date().toISOString(),
        applicationContext: { principal }
      })
      .find((tool) => tool.id === "list_work")!.formatResult!(known)!;
    expect(formatted).toContain("Needs attention");
    expect(formatted).not.toContain("Counts are lower bounds");
    expect(JSON.stringify(known)).not.toContain("PRIVATE_EXECUTOR_ERROR");
    const originalCall = app.workflows.call.bind(app.workflows);
    const reads = vi
      .spyOn(app.workflows, "call")
      .mockImplementation(async (name, input, context) => {
        if (name === "get_run") throw new Error("PRIVATE_STORAGE_ERROR");
        return originalCall(name, input, context);
      });
    const unread = await app.rpc("list_work", { projectId: project.id });
    expect(unread).toMatchObject({
      counts: { read: 1, needs_attention: 1 },
      source: { truncated: false, errorCount: 1 },
      errors: [
        { projectId: project.id, workId: plan.id, message: "The recorded run could not be read." }
      ],
      items: [{ state: "needs_attention", run: null }]
    });
    expect(reads.mock.calls.filter(([name]) => name === "get_run")).toHaveLength(1);
    expect(JSON.stringify(unread)).not.toContain("PRIVATE_STORAGE_ERROR");
    expect(fixture.readReport).toHaveBeenCalledTimes(1);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("reports controlled source caps, run and project errors, with bounded error details and honest preselection counts", async () => {
    let apiRequests = 0;
    const apiUrl = await endpoint((_req, res) => {
      apiRequests++;
      json(res, { private: "PRIVATE_PROVIDER_MESSAGE" }, 500);
    });
    const fixture = await workspaceFixture();
    const app = await fixture.start(fixture.auth, apiUrl);
    const project = await app.rpc("register_project", {
      name: "Observed failures",
      hekateProjectId: randomUUID()
    });
    const template = await app.rpc("create_plan", {
      projectId: project.id,
      definition: {
        version: 1,
        name: "Read error fixture",
        steps: [
          {
            id: "review",
            name: "Review",
            action: { type: "human", instructions: "Inspect actual evidence" }
          }
        ]
      }
    });
    const originalCall = app.workflows.call.bind(app.workflows);
    let total = 30;
    let failedRuns = true;
    vi.spyOn(app.workflows, "call").mockImplementation(async (name, input, context) => {
      if (name === "list_plans")
        return {
          plans: Array.from({ length: total }, () => ({
            ...template,
            id: randomUUID(),
            ...(failedRuns ? { latestRunId: randomUUID() } : {})
          }))
        };
      if (name === "get_run") throw new Error("PRIVATE_PROVIDER_MESSAGE");
      return originalCall(name, input, context);
    });
    const errors = await app.rpc("list_work", { projectId: project.id });
    expect(errors).toMatchObject({
      counts: { read: 30, needs_attention: 30 },
      source: { truncated: false, errorCount: 31 },
      selection: { matched: 30, returned: 25, omitted: 5 },
      errorsOmitted: 11
    });
    expect(errors.errors).toHaveLength(20);
    expect(errors.errors[0]).toMatchObject({
      projectId: project.id,
      workId: expect.any(String),
      message: "The recorded run could not be read."
    });
    expect(JSON.stringify(errors)).not.toContain("PRIVATE_PROVIDER_MESSAGE");
    total = 501;
    failedRuns = false;
    const capped = await app.rpc("list_work", { projectId: project.id, state: ["ready"] });
    expect(capped).toMatchObject({
      counts: { read: 500, ready: 500 },
      source: { truncated: true, errorCount: 1 },
      selection: { matched: 500, returned: 25, omitted: 475 }
    });
    for (const args of [
      { limit: 0 },
      { limit: 26 },
      { state: [] },
      { state: ["ready", "ready"] },
      { state: ["invented"] }
    ])
      expect((await app.response("/workspace/tools/list_work", args)).status).toBe(400);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.readReport).not.toHaveBeenCalled();
    const foreign = await fixture.start(fixture.foreignAuth, apiUrl);
    const foreignReads = vi.spyOn(foreign.workflows, "call");
    const beforeApi = apiRequests;
    expect(
      (await foreign.response("/workspace/tools/list_work", { projectId: project.id })).status
    ).toBe(404);
    expect(foreignReads).not.toHaveBeenCalled();
    expect(apiRequests).toBe(beforeApi);
  });

  it("bounds encoded directory work without replacing project metadata or copying full outputs", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    const project = await app.rpc("register_project", {
      name: "Large observed project",
      hekateProjectId: randomUUID()
    });
    const name = "x" + "\0".repeat(198) + "x";
    const plan = await app.rpc("create_plan", {
      projectId: project.id,
      definition: {
        version: 1,
        name,
        steps: [{ id: "review", name, action: { type: "human", instructions: "p".repeat(4000) } }]
      }
    });
    vi.spyOn(app.catalog, "listProjects").mockReturnValue([
      project,
      ...Array.from({ length: 200 }, () => ({
        ...project,
        id: randomUUID(),
        repositoryPath: "D:/" + "r".repeat(3990)
      }))
    ]);
    const originalCall = app.workflows.call.bind(app.workflows);
    vi.spyOn(app.workflows, "call").mockImplementation(async (name, input, context) => {
      if (name === "list_plans")
        return { plans: Array.from({ length: 500 }, () => ({ ...plan, id: randomUUID() })) };
      return originalCall(name, input, context);
    });
    const response = await app.response("/workspace/tools/get_workspace", {
      projectId: project.id
    });
    expect(response.status).toBe(200);
    const encoded = await response.text();
    expect(Buffer.byteLength(encoded)).toBeLessThan(2 * 1024 * 1024);
    const snapshot = JSON.parse(encoded);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.work.length).toBeGreaterThan(0);
    expect(snapshot.work.length).toBeLessThan(500);
    expect(snapshot.projects).toContainEqual(
      expect.objectContaining({ id: project.id, name: project.name })
    );
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.readReport).not.toHaveBeenCalled();
  });

  it("reopens and continues a legacy thread with its nondefault user label without guessing or changing the saved owner", async () => {
    const fixture = await workspaceFixture();
    const first = await fixture.start();
    const conversationId = "legacy-writing-thread";
    const submitted = await first.response("/messages", {
      conversationId,
      userId: "custom-writing-label",
      messageId: randomUUID(),
      text: "Keep my original draft discussion"
    });
    expect(submitted.status).toBe(200);
    const originalOwner = first.chat.conversationOwner(conversationId);
    const project = await first.rpc("register_project", { name: "Writing project" });
    await first.rpc("update_conversation", {
      id: conversationId,
      title: "Draft discussion",
      projectId: project.id,
      archived: true
    });
    const before = await first.response(`/workspace/conversations/${conversationId}/events`);
    expect(before.status).toBe(200);
    const originalEvents = (await before.json()).events;
    await first.close();
    const restored = await fixture.start();
    const directory = await restored.rpc("get_workspace", {});
    expect(directory.conversations).toContainEqual(
      expect.objectContaining({
        id: conversationId,
        title: "Draft discussion",
        projectId: project.id,
        archived: true,
        reopenable: true
      })
    );
    expect(
      (await (await restored.response(`/workspace/conversations/${conversationId}/events`)).json())
        .events
    ).toEqual(originalEvents);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    fixture.plan({ action: "answer", message: "The original draft thread continues." });
    const continued = await restored.response(
      `/workspace/conversations/${conversationId}/messages`,
      {
        messageId: randomUUID(),
        text: "Continue the draft discussion",
        userId: "a-label-that-does-not-own-this-thread"
      }
    );
    expect(continued.status).toBe(200);
    expect(restored.chat.conversationOwner(conversationId)).toBe(originalOwner);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    const events = (
      await (await restored.response(`/workspace/conversations/${conversationId}/events`)).json()
    ).events;
    expect(
      events.filter((event: any) => event.type === "user").map((event: any) => event.text)
    ).toEqual(["Keep my original draft discussion", "Continue the draft discussion"]);
    await restored.rpc("update_conversation", {
      id: conversationId,
      archived: false,
      projectId: null
    });
    expect((await restored.rpc("get_workspace", {})).conversations).toContainEqual(
      expect.objectContaining({ id: conversationId, projectId: null, archived: false })
    );
  });

  it("reopens a scoped conversation and its waiting project work after restart, with owner isolation", async () => {
    const fixture = await workspaceFixture();
    const first = await fixture.start();
    const principal = fixture.auth.auth.resolve(fixture.auth.headers("operator"))!;
    const formattedDigest = (app: typeof first, digest: unknown) =>
      app.workspace
        .capabilities({
          conversationId: "observer",
          userId: "observer",
          text: "Read work",
          timestampIso: new Date().toISOString(),
          applicationContext: { principal }
        })
        .find((tool) => tool.id === "get_work_digest")!.formatResult!(digest)!;
    const project = await first.rpc("register_project", {
      name: "Report review project",
      repositoryPath: fixture.directory,
      hekateProjectId: randomUUID()
    });
    const wireId = randomUUID();
    const initial = await first.response(`/v1/conversations/${wireId}/messages`, {
      protocolVersion: "1.0",
      accountId: "test-account",
      projectId: "test-scope",
      messageId: randomUUID(),
      text: "Discuss the report project",
      clientTimestampIso: new Date().toISOString()
    });
    expect(initial.status).toBe(200);
    const directory = await first.rpc("get_workspace", {});
    expect(directory.persistenceEnabled).toBe(true);
    expect(directory.conversations).toHaveLength(1);
    const conversationId = directory.conversations[0].id;
    expect(conversationId).not.toBe(wireId);
    await first.rpc("update_conversation", {
      id: conversationId,
      title: "Report discussion",
      projectId: project.id
    });
    const definition = {
      version: 1,
      name: "Read then review the report",
      steps: [
        { id: "read", name: "Read actual report", action: { type: "tool", tool: "read_report" } },
        {
          id: "review",
          name: "Human review",
          inputs: { items: { $step: "read", path: "items" } },
          action: { type: "human", instructions: "Review these report items" },
          success: { path: "approved", equals: true }
        }
      ]
    };
    fixture.plan({
      action: "act",
      call: { tool: "create_plan", arguments: { definition } }
    });
    const action = await first.response(`/workspace/conversations/${conversationId}/messages`, {
      messageId: randomUUID(),
      text: "Save the report review plan"
    });
    expect(action.status).toBe(200);
    const eventsResponse = await first.response(
      `/workspace/conversations/${conversationId}/events`
    );
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()).events;
    const plan = events.find((event: any) => event.applicationResult?.tool === "create_plan")
      ?.applicationResult.result;
    expect(plan).toMatchObject({ definition: { name: definition.name }, revision: 1 });
    expect(
      events.some(
        (event: any) => event.type === "user" && event.text === "Discuss the report project"
      )
    ).toBe(true);
    // The workspace bridge reopens the original namespace; legacy routes still refuse v1 internal IDs.
    expect(
      (await first.response(`/conversations/${conversationId}/events?userId=operator`)).status
    ).toBe(404);
    let started = await first.rpc("run_plan", {
      projectId: project.id,
      id: plan.id,
      revision: plan.revision
    });
    await expect
      .poll(async () => {
        started = await first.rpc("get_run", { projectId: project.id, id: started.id });
        return started.status;
      })
      .toBe("waiting_input");
    expect(started.steps[0].output).toEqual({ items: 3 });
    expect(started.steps[1]).toMatchObject({ status: "waiting_input", inputs: { items: 3 } });
    const savedDirectory = await first.rpc("get_workspace", { projectId: project.id });
    expect(savedDirectory.work).toContainEqual(
      expect.objectContaining({
        id: plan.id,
        projectId: project.id,
        conversationId,
        kind: "workflow",
        status: "waiting_input",
        nextStep: "Human review",
        latestRunId: started.id
      })
    );
    const waitingDigest = await first.rpc("get_work_digest", {
      id: plan.id,
      projectId: project.id.toUpperCase()
    });
    expect(waitingDigest).toMatchObject({
      state: "needs_decision",
      decision: {
        stepId: "review",
        kind: "result",
        prompt: definition.steps[1].action.instructions
      },
      progress: { done: 1, total: 2 },
      run: { id: started.id, current: true },
      verification: null
    });
    expect(savedDirectory.work.find((row: any) => row.id === plan.id).digest).toEqual(
      waitingDigest
    );
    const client = new Client({ name: "current-digest-observer", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(first.base + "/mcp"), {
        requestInit: { headers: fixture.auth.headers("operator") }
      })
    );
    const remoteDigest = await client.callTool({
      name: "get_work_digest",
      arguments: { id: plan.id, projectId: project.id }
    });
    expect(remoteDigest.isError).toBe(false);
    expect(remoteDigest.structuredContent).toEqual(waitingDigest);
    expect(
      await first.workspace.call(
        "get_work_digest",
        { id: plan.id, projectId: project.id },
        { principal, operationId: randomUUID(), conversationId }
      )
    ).toEqual(waitingDigest);
    const waitingText = formattedDigest(first, waitingDigest);
    expect(formattedDigest(first, remoteDigest.structuredContent)).toBe(waitingText);
    expect(waitingText).toContain("Needs your decision");
    expect(waitingText).toContain(waitingDigest.decision.prompt);
    expect(waitingText).toContain(waitingDigest.lastOutcome.summary);
    expect(waitingText).toContain(`run ${started.id}, revision ${plan.revision}, current`);
    expect(waitingText).toContain("Verification: not verified");
    expect(waitingDigest.lastOutcome.ref).toBe(`run:${started.id}:step:read`);
    expect(waitingText).not.toContain(JSON.stringify(started.steps[0].output));
    await client.close();
    const catalogBeforeReads = readFileSync(join(fixture.directory, "workspace.json"), "utf8");
    await first.rpc("get_work_digest", { id: plan.id, projectId: project.id });
    expect(readFileSync(join(fixture.directory, "workspace.json"), "utf8")).toBe(
      catalogBeforeReads
    );
    expect(fixture.readReport).toHaveBeenCalledTimes(1);
    const providerCalls = fixture.generate.mock.calls.length;
    await first.close();

    const foreign = await fixture.start(fixture.foreignAuth);
    const foreignDirectory = await foreign.rpc("get_workspace", {});
    expect(foreignDirectory.projects.some((row: any) => row.id === project.id)).toBe(false);
    expect(foreignDirectory.conversations).toEqual([]);
    expect(foreignDirectory.work).toEqual([]);
    expect(
      (await foreign.response(`/workspace/conversations/${conversationId}/events`)).status
    ).toBe(404);
    expect(
      (await foreign.response("/workspace/tools/get_workspace", { projectId: project.id })).status
    ).toBe(404);
    expect(
      (await foreign.response("/workspace/tools/get_plan", { projectId: project.id, id: plan.id }))
        .status
    ).toBe(404);
    expect(
      (
        await foreign.response("/workspace/tools/get_work_digest", {
          projectId: project.id,
          id: plan.id
        })
      ).status
    ).toBe(404);
    await foreign.close();

    const restored = await fixture.start();
    const restoredDirectory = await restored.rpc("get_workspace", { projectId: project.id });
    expect(restoredDirectory.conversations).toContainEqual(
      expect.objectContaining({
        id: conversationId,
        title: "Report discussion",
        projectId: project.id,
        reopenable: true
      })
    );
    const restoredEvents = await restored.response(
      `/workspace/conversations/${conversationId}/events`
    );
    expect(restoredEvents.status).toBe(200);
    expect((await restoredEvents.json()).events).toEqual(events);
    expect(fixture.generate).toHaveBeenCalledTimes(providerCalls);
    expect(fixture.readReport).toHaveBeenCalledTimes(1);
    expect(await restored.rpc("get_run", { projectId: project.id, id: started.id })).toMatchObject({
      status: "waiting_input",
      steps: [{ status: "completed", output: { items: 3 } }, { status: "waiting_input" }]
    });
    await restored.rpc("submit_step_result", {
      projectId: project.id,
      id: started.id,
      stepId: "review",
      output: { approved: true }
    });
    await expect
      .poll(
        async () =>
          (await restored.rpc("get_run", { projectId: project.id, id: started.id })).status
      )
      .toBe("completed");
    expect(await restored.rpc("get_plan", { projectId: project.id, id: plan.id })).toMatchObject({
      work: "done"
    });
    fixture.plan({ action: "answer", message: "The saved project conversation continues." });
    const continued = await restored.response(
      `/workspace/conversations/${conversationId}/messages`,
      { messageId: randomUUID(), text: "Continue the saved conversation" }
    );
    expect(continued.status).toBe(200);
    const continuedEvents = (
      await (await restored.response(`/workspace/conversations/${conversationId}/events`)).json()
    ).events;
    expect(
      continuedEvents.some(
        (event: any) => event.text === "The saved project conversation continues."
      )
    ).toBe(true);
    expect(fixture.readReport).toHaveBeenCalledTimes(1);
    expect((await restored.rpc("get_workspace", { projectId: project.id })).work).toContainEqual(
      expect.objectContaining({ id: plan.id, status: "completed", latestRunId: started.id })
    );
    const completedDigest = await restored.rpc("get_work_digest", {
      projectId: project.id,
      id: plan.id
    });
    expect(completedDigest).toMatchObject({
      state: "completed",
      next: null,
      progress: { done: 2, total: 2 },
      approval: {
        stepId: "review",
        ref: `run:${started.id}:step:review`
      },
      run: { current: true }
    });
    expect(completedDigest.approval.at).toBeTruthy();
    expect(completedDigest.verification).toBeNull();
    const completedText = formattedDigest(restored, completedDigest);
    expect(completedText).toContain("Completed");
    expect(completedText).toContain("Approval: recorded for step review");
    expect(completedText).toContain(completedDigest.approval.at);
    expect(completedText).toContain("Verification: not verified");
    expect(completedText).not.toContain("by you");
    const revisedDefinition = {
      ...definition,
      name: "Read and review the refreshed report",
      steps: definition.steps.map((step, index) =>
        index === 0 ? { ...step, name: "Read the refreshed report" } : step
      )
    };
    const revised = await restored.rpc("update_plan", {
      projectId: project.id,
      id: plan.id,
      revision: plan.revision,
      definition: revisedDefinition
    });
    expect(revised.revision).toBe(plan.revision + 1);
    const revisedWorkspace = await restored.rpc("get_workspace", {
      projectId: project.id.toUpperCase()
    });
    expect(revisedWorkspace.work).toContainEqual(
      expect.objectContaining({
        id: plan.id,
        name: revisedDefinition.name,
        status: "todo",
        nextStep: "Read the refreshed report",
        latestRunId: started.id
      })
    );
    expect(await restored.rpc("get_run", { projectId: project.id, id: started.id })).toMatchObject({
      status: "completed",
      revision: plan.revision,
      definition: { name: definition.name }
    });
    const historicalDigest = await restored.rpc("get_work_digest", {
      projectId: project.id,
      id: plan.id
    });
    expect(historicalDigest).toMatchObject({
      state: "ready",
      stateText: "Edited since the last run.",
      approval: null,
      revision: revised.revision,
      progress: { done: 0, total: 2 },
      verification: null,
      run: { revision: plan.revision, current: false },
      lastOutcome: { ref: `run:${started.id}:step:review` }
    });
    expect(revisedWorkspace.work.find((row: any) => row.id === plan.id).digest).toEqual(
      historicalDigest
    );
    const historicalList = await restored.rpc("list_work", {
      projectId: project.id,
      state: [...workStates]
    });
    expect(historicalList.items).toEqual([historicalDigest]);
    expect(historicalList.counts).toMatchObject({ read: 1, ready: 1, completed: 0 });
    const historicalText = formattedDigest(restored, historicalDigest);
    expect(historicalText).toContain("Ready");
    expect(historicalText).toContain("Edited since the last run");
    expect(historicalText).toContain("Historical revision outcome");
    expect(historicalText).toContain(`run ${started.id}, revision ${plan.revision}, historical`);
    expect(historicalText).not.toContain("Approval:");
    const originalCall = restored.workflows.call.bind(restored.workflows);
    const reads = vi
      .spyOn(restored.workflows, "call")
      .mockImplementation(async (name, input, context) => {
        if (name === "get_run") throw new Error("PRIVATE_BACKEND_DETAILS");
        return originalCall(name, input, context);
      });
    const unavailable = await restored.rpc("get_work_digest", {
      projectId: project.id,
      id: plan.id
    });
    expect(unavailable).toMatchObject({
      state: "needs_attention",
      errors: ["The recorded run could not be read."],
      run: null
    });
    expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_BACKEND_DETAILS");
    expect(reads.mock.calls.filter(([name]) => name === "get_run")).toHaveLength(1);
    reads.mockClear();
    const unavailableWorkspace = await restored.rpc("get_workspace", { projectId: project.id });
    expect(unavailableWorkspace.work.find((row: any) => row.id === plan.id).digest.state).toBe(
      "needs_attention"
    );
    expect(reads.mock.calls.filter(([name]) => name === "get_run")).toHaveLength(1);
    reads.mockRestore();
    expect(fixture.readReport).toHaveBeenCalledTimes(1);
  });

  it("keeps workspace discovery, metadata mutations and conversation access behind operator auth and same-origin checks", async () => {
    const fixture = await workspaceFixture();
    const app = await fixture.start();
    expect((await app.response("/workspace/tools", undefined, {} as any)).status).toBe(401);
    expect(
      (await app.response("/workspace/tools", undefined, fixture.auth.headers("client"))).status
    ).toBe(403);
    expect(
      (
        await app.response(
          "/workspace/tools/register_project",
          { name: "Unauthorized" },
          fixture.auth.headers("client")
        )
      ).status
    ).toBe(403);
    const crossOrigin = await fetch(app.base + "/workspace/tools/create_conversation", {
      method: "POST",
      headers: {
        ...fixture.auth.headers("operator"),
        "content-type": "application/json",
        Origin: "https://untrusted.example"
      },
      body: "{}"
    });
    expect(crossOrigin.status).toBe(403);
    const conversation = await app.rpc("create_conversation", { title: "Local conversation" });
    expect(
      (
        await app.response(
          `/workspace/conversations/${conversation.id}/events`,
          undefined,
          fixture.auth.headers("client")
        )
      ).status
    ).toBe(403);
    expect((await app.response(`/workspace/conversations/${randomUUID()}/events`)).status).toBe(
      404
    );
    const directory = await app.rpc("get_workspace", {});
    expect(directory.conversations).toHaveLength(1);
    expect(directory.projects.some((project: any) => project.name === "Unauthorized")).toBe(false);
    expect(fixture.generate).not.toHaveBeenCalled();
  });
});
