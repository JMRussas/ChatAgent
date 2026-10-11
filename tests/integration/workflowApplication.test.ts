import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityChat } from "../../src/app/capabilityChat";
import { ChatService } from "../../src/app/chatService";
import { ContextManager } from "../../src/app/contextManager";
import { DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { createEphemeralAuth } from "../../src/auth/ephemeral";
import { InMemoryTaskQueue, type FastModelProvider } from "../../src/providers/interfaces";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { WorkflowApplication, formatWorkflowResult } from "../../src/workflows/application";
import { workflowModelAction } from "../../src/workflows/modelAction";
import { WorkflowService } from "../../src/workflows/service";
import {
  WorkflowError,
  type StoredWorkflowPlan,
  type WorkflowDefinition,
  type WorkflowPlanStore,
  type WorkflowRun
} from "../../src/workflows/types";

/** Domain storage is isolated; the application, transport, chat and runner are real. */
class PlanStore implements WorkflowPlanStore {
  private readonly plans = new Map<string, StoredWorkflowPlan>();
  async list(ownerId: string) {
    return [...this.plans.values()]
      .filter((plan) => plan.ownerId === ownerId)
      .map((plan) => structuredClone(plan));
  }
  async get(ownerId: string, id: string) {
    const plan = this.plans.get(id);
    if (!plan || plan.ownerId !== ownerId)
      throw new WorkflowError("plan_not_found", "No such plan", 404);
    return structuredClone(plan);
  }
  async create(ownerId: string, definition: WorkflowDefinition) {
    const plan: StoredWorkflowPlan = {
      id: randomUUID(),
      ownerId,
      definition: structuredClone(definition),
      revision: 1,
      stateRevision: 1,
      taskId: randomUUID(),
      work: "todo",
      attemptId: null,
      attemptEpoch: 0,
      artifactRef: null
    };
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }
  async update(ownerId: string, id: string, revision: number, definition: WorkflowDefinition) {
    const plan = await this.get(ownerId, id);
    if (plan.revision !== revision || plan.work === "in_progress")
      throw new WorkflowError("revision_conflict", "Plan changed or is running", 409);
    const next = { ...plan, definition: structuredClone(definition), revision: revision + 1 };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async start(ownerId: string, id: string, revision: number, runId: string) {
    const plan = await this.get(ownerId, id);
    if (plan.revision !== revision || plan.work !== "todo")
      throw new WorkflowError("start_conflict", "Cannot start this plan", 409);
    const next: StoredWorkflowPlan = {
      ...plan,
      work: "in_progress",
      attemptId: runId,
      attemptEpoch: plan.attemptEpoch + 1
    };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  private async fenced(ownerId: string, id: string, runId: string, epoch: number) {
    const plan = await this.get(ownerId, id);
    if (plan.attemptId !== runId || plan.attemptEpoch !== epoch)
      throw new WorkflowError("fence_mismatch", "The task attempt changed", 409);
    return plan;
  }
  async finish(ownerId: string, id: string, runId: string, epoch: number, artifactRef: string) {
    const next: StoredWorkflowPlan = {
      ...(await this.fenced(ownerId, id, runId, epoch)),
      work: "done",
      artifactRef
    };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async release(ownerId: string, id: string, runId: string, epoch: number) {
    const next: StoredWorkflowPlan = {
      ...(await this.fenced(ownerId, id, runId, epoch)),
      work: "todo",
      attemptId: null
    };
    this.plans.set(id, next);
    return structuredClone(next);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const definition = {
  version: 1,
  name: "Review the report",
  steps: [
    {
      id: "retrieve",
      name: "Retrieve report",
      action: { type: "tool", tool: "read_report" },
      success: { path: "ok", equals: true }
    },
    {
      id: "summarize",
      name: "Summarize report",
      inputs: { items: { $step: "retrieve", path: "items" } },
      action: { type: "model", prompt: "Summarize the report" }
    },
    {
      id: "approve",
      name: "Human review",
      inputs: { summary: { $step: "summarize", path: "text" } },
      action: { type: "human", instructions: "Review the summary and approve it" },
      success: { path: "approved", equals: true }
    }
  ]
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "workflow-application-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const auth = createEphemeralAuth();
  const budget = {
    windowTokens: 64000,
    maxHistoryTurns: 12,
    safetyTokens: 256,
    fastOutputTokens: 1024,
    deepOutputTokens: 2048
  };
  const facts = () => ({
    fastProvider: "test",
    fastModel: "planner",
    deepProvider: "test",
    deepModel: "summary",
    generatedAtIso: new Date().toISOString()
  });
  const readReport = vi.fn(async () => ({ ok: true, items: 3 }));
  const actions = [
    {
      name: "read_report",
      description: "Read the report",
      inputSchema: { type: "object" },
      execute: readReport
    }
  ];
  const modelGenerate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
    text: "The report contains three items.",
    finishReason: "stop"
  }));
  const workflows = new WorkflowApplication(
    new WorkflowService(new PlanStore(), dir, {
      actions,
      model: workflowModelAction({ createProvisionalReply: modelGenerate }, budget, facts)
    }),
    actions
  );
  const timeline = new InMemoryConversationTimelineStore();
  const queue = new InMemoryTaskQueue();
  let plannerResult: unknown = {
    action: "answer",
    message: "We can keep talking while your work waits."
  };
  const chatGenerate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
    text: JSON.stringify(plannerResult),
    finishReason: "stop"
  }));
  const chat = new ChatService(
    new CapabilityChat(
      { createProvisionalReply: chatGenerate },
      queue,
      timeline,
      new ContextManager(timeline, budget),
      facts,
      (message) => workflows.capabilities(message)
    ),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const server = createChatServer(chat, { auth: auth.auth, workflowTools: workflows });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tool = async <T>(name: string, input: unknown): Promise<T> => {
    const response = await fetch(`${base}/workflows/tools/${name}`, {
      method: "POST",
      headers: { ...auth.headers("operator"), "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  };
  const send = async (text: string) => {
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { ...auth.headers("operator"), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "report-chat",
        userId: "operator",
        messageId: randomUUID(),
        text
      })
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return {
    base,
    auth,
    dir,
    tool,
    send,
    modelGenerate,
    readReport,
    setPlanner: (result: unknown) => {
      plannerResult = result;
    },
    chatGenerate,
    timeline
  };
}

describe("shared workflow application", () => {
  it("presents saved work clearly while retaining actual handles for the next model turn", async () => {
    const a = await setup();
    a.setPlanner({ action: "act", call: { tool: "create_plan", arguments: { definition } } });
    const reply = await a.send("Create the report plan");
    const saved = (await a.tool<{ plans: StoredWorkflowPlan[] }>("list_plans", {})).plans[0];
    expect(reply.fastResponse.provisionalReply).toContain(`Saved plan “${saved.definition.name}”`);
    expect(reply.fastResponse.provisionalReply).toContain("1. Retrieve report");
    expect(reply.fastResponse.provisionalReply).not.toContain(saved.id);
    const recorded = (await a.timeline.getEvents("report-chat")).find(
      (event) => event.applicationResult
    );
    expect(recorded?.applicationResult).toMatchObject({
      tool: "create_plan",
      result: {
        id: saved.id,
        revision: saved.revision,
        definition: saved.definition
      }
    });
    const restored = new InMemoryConversationTimelineStore();
    restored.restoreSnapshot(JSON.parse(JSON.stringify(a.timeline.exportSnapshot())));
    expect(
      (await restored.getEvents("report-chat")).find((event) => event.applicationResult)
        ?.applicationResult
    ).toEqual(recorded?.applicationResult);
    a.setPlanner({ action: "answer", message: "The saved plan is ready." });
    await a.send("Which plan did you save?");
    const instruction = a.chatGenerate.mock.calls[1][0].context?.systemInstruction ?? "";
    expect(instruction).toContain(saved.id);
    expect(instruction).toContain(`"revision":${saved.revision}`);
    expect(instruction).not.toContain(saved.taskId);
    expect(
      formatWorkflowResult("create_plan", { definition, claimedSuccess: true })
    ).toBeUndefined();
  });
  it("uses one saved plan through MCP, direct controls and chat, and completes mixed work after human review", async () => {
    const a = await setup();
    const client = new Client({ name: "integrated-workflow-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${a.base}/mcp`), {
        requestInit: { headers: a.auth.headers("operator") }
      })
    );
    const created = await client.callTool({ name: "create_plan", arguments: { definition } });
    expect(created.isError).toBe(false);
    const plan = created.structuredContent as unknown as StoredWorkflowPlan;
    expect(await a.tool("get_plan", { id: plan.id })).toMatchObject(plan);
    a.setPlanner({
      action: "act",
      call: {
        tool: "update_plan",
        arguments: {
          id: plan.id,
          revision: plan.revision,
          definition: { ...definition, name: "Review the updated report" }
        }
      }
    });
    const changed = await a.send("Rename the report plan");
    expect(changed.fastResponse.provisionalReply).toContain("Review the updated report");
    const updated = await a.tool<StoredWorkflowPlan>("get_plan", { id: plan.id });
    expect(updated.revision).toBe(2);
    expect(updated.definition.name).toBe("Review the updated report");
    const started = await client.callTool({
      name: "run_plan",
      arguments: { id: plan.id, revision: updated.revision }
    });
    expect(started.isError, JSON.stringify(started.structuredContent)).toBe(false);
    const run = started.structuredContent as unknown as WorkflowRun;
    expect(run.status).toBe("running");
    let observed: WorkflowRun | undefined;
    await vi.waitFor(async () => {
      observed = await a.tool<WorkflowRun>("get_run", { id: run.id });
      expect(observed.status).toBe("waiting_input");
    });
    expect(observed?.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "waiting_input"
    ]);
    expect(observed?.steps[2].inputs).toEqual({ summary: "The report contains three items." });
    expect(a.readReport).toHaveBeenCalledTimes(1);
    expect(a.modelGenerate).toHaveBeenCalledTimes(1);
    expect(a.modelGenerate.mock.calls[0][0].message.text).toContain('"items":3');
    a.setPlanner({
      action: "answer",
      message: "Your report is waiting for review; we can continue talking."
    });
    expect((await a.send("Can we keep talking?")).fastResponse.provisionalReply).toContain(
      "continue talking"
    );
    expect((await a.tool<WorkflowRun>("get_run", { id: run.id })).status).toBe("waiting_input");
    await a.tool("submit_step_result", {
      id: run.id,
      stepId: "approve",
      output: { approved: true }
    });
    await vi.waitFor(async () => {
      const result = await client.callTool({ name: "get_run", arguments: { id: run.id } });
      expect(result.isError).toBe(false);
      observed = result.structuredContent as unknown as WorkflowRun;
      expect(observed.status).toBe("completed");
    });
    expect(observed?.steps[2].output).toEqual({ approved: true });
    expect((await a.tool<StoredWorkflowPlan>("get_plan", { id: plan.id })).work).toBe("done");
    expect(JSON.parse(await readFile(join(a.dir, `${run.id}.json`), "utf8"))).toMatchObject({
      id: run.id,
      status: "completed"
    });
    expect(a.modelGenerate).toHaveBeenCalledTimes(1);
  });

  it("requires operator authorization and exact origin for browser mutations", async () => {
    const a = await setup();
    const url = `${a.base}/workflows/tools/create_plan`;
    const request = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ definition })
      });
    expect((await request({})).status).toBe(401);
    expect((await request(a.auth.headers("client"))).status).toBe(403);
    expect(
      (await request({ ...a.auth.headers("operator"), origin: "http://example.invalid" })).status
    ).toBe(403);
    const cookie = `ca_session=${a.auth.issueSession()}`;
    expect((await request({ cookie })).status).toBe(403);
    const accepted = await request({ cookie, origin: a.base });
    expect(accepted.status).toBe(200);
    const saved = (await accepted.json()) as StoredWorkflowPlan;
    expect((await a.tool<StoredWorkflowPlan>("get_plan", { id: saved.id })).definition.name).toBe(
      definition.name
    );
    expect(a.modelGenerate).not.toHaveBeenCalled();
    expect(a.readReport).not.toHaveBeenCalled();
    const list = await a.tool<{ plans: StoredWorkflowPlan[] }>("list_plans", {});
    expect(list.plans).toHaveLength(1);
  });
  it("records the attempted application call and its safe conflict without reporting success", async () => {
    const a = await setup();
    const saved = await a.tool<StoredWorkflowPlan>("create_plan", { definition });
    const action = {
      action: "act",
      call: {
        tool: "update_plan",
        arguments: {
          id: saved.id,
          revision: saved.revision + 1,
          definition: { ...definition, name: "Stale edit" }
        }
      }
    };
    a.setPlanner(action);
    const response = await fetch(`${a.base}/messages`, {
      method: "POST",
      headers: { ...a.auth.headers("operator"), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "report-chat",
        userId: "operator",
        messageId: randomUUID(),
        text: "Edit the plan"
      })
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "revision_conflict"
    });
    const events = await a.timeline.getEvents("report-chat");
    expect(
      events.find((event) => event.type === "activity" && event.capabilityPlan)?.capabilityPlan
    ).toEqual(action);
    expect(events.at(-1)).toMatchObject({
      finishReason: "error",
      errorCode: "revision_conflict",
      text: "Plan changed or is running"
    });
    expect(
      events.find((event) => event.type === "activity" && event.activity === "failed")
    ).toMatchObject({
      capabilityPlan: action,
      errorCode: "revision_conflict",
      text: "Plan changed or is running"
    });
    expect(
      events.some((event) => event.applicationResult || event.processingStatus === "complete")
    ).toBe(false);
    expect((await a.tool<StoredWorkflowPlan>("get_plan", { id: saved.id })).revision).toBe(
      saved.revision
    );
  });
});
