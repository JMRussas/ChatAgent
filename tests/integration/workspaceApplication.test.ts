import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { WorkspaceCatalog } from "../../src/workspace/catalog";
import { ProjectWorkflowRouter } from "../../src/workspace/projectWorkflows";
import { WorkspaceService } from "../../src/workspace/service";
import { readCodingProject } from "../../src/workspace/codingProjects";
import {
  WorkflowError,
  type StoredWorkflowPlan,
  type WorkflowDefinition,
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

async function workspaceFixture() {
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
  const start = async (identity = auth, apiUrl?: string) => {
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
      return new WorkflowApplication(new WorkflowService(store, runDir, { actions }), actions);
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
    const response = (path: string, data?: unknown, headers = identity.headers("operator")) =>
      fetch(base + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { ...headers, "content-type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
    const rpc = async (name: string, data: unknown) => {
      const result = await response("/workspace/tools/" + name, data);
      expect(result.status).toBe(200);
      return result.json();
    };
    return { base, response, rpc, close, chat, persistence };
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

describe("existing coding project observation", () => {
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
