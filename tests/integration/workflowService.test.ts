import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/auth/authenticator";
import type { TaskExecutor } from "../../src/tasks/types";
import { WorkflowRunStore } from "../../src/workflows/runStore";
import { WorkflowService } from "../../src/workflows/service";
import {
  WorkflowError,
  type StoredWorkflowPlan,
  type WorkflowAction,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowPlanStore,
  type WorkflowRun
} from "../../src/workflows/types";

class MemoryStore implements WorkflowPlanStore {
  plans = new Map<string, StoredWorkflowPlan>();
  calls = 0;
  async list(ownerId: string) {
    this.calls++;
    return [...this.plans.values()].filter((p) => p.ownerId === ownerId);
  }
  async get(ownerId: string, id: string) {
    this.calls++;
    const plan = this.plans.get(id);
    if (!plan || plan.ownerId !== ownerId)
      throw new WorkflowError("plan_not_found", "Plan not found", 404);
    return structuredClone(plan);
  }
  async create(ownerId: string, definition: WorkflowDefinition) {
    this.calls++;
    const plan: StoredWorkflowPlan = {
      id: randomUUID(),
      ownerId,
      definition,
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
    if (plan.revision !== revision)
      throw new WorkflowError("revision_conflict", "Stale revision", 409);
    const next = { ...plan, definition, revision: revision + 1 };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async start(ownerId: string, id: string, revision: number, runId: string) {
    const plan = await this.get(ownerId, id);
    if (plan.revision !== revision || (plan.work !== "todo" && plan.work !== "done"))
      throw new WorkflowError("start_conflict", "Cannot start", 409);
    const next: StoredWorkflowPlan = {
      ...plan,
      work: "in_progress",
      attemptId: runId,
      attemptEpoch: plan.attemptEpoch + 1
    };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async finish(ownerId: string, id: string, runId: string, epoch: number, artifactRef: string) {
    const plan = await this.get(ownerId, id);
    if (plan.attemptId !== runId || plan.attemptEpoch !== epoch)
      throw new WorkflowError("fence_mismatch", "Fence mismatch", 409);
    const next: StoredWorkflowPlan = { ...plan, work: "done", artifactRef };
    this.plans.set(id, next);
    return structuredClone(next);
  }
  async release(ownerId: string, id: string, runId: string, epoch: number) {
    const plan = await this.get(ownerId, id);
    if (plan.attemptId !== runId || plan.attemptEpoch !== epoch)
      throw new WorkflowError("fence_mismatch", "Fence mismatch", 409);
    const next: StoredWorkflowPlan = { ...plan, work: "todo", attemptId: null };
    this.plans.set(id, next);
    return structuredClone(next);
  }
}

const principal = (roles: string[] = ["operator"], principalId = "local:A"): Principal => ({
  principalId,
  roles: new Set(roles) as Principal["roles"],
  via: "bearer"
});
const ctx = (p = principal()): WorkflowContext => ({ principal: p, operationId: randomUUID() });
const def = (steps: unknown[]): unknown => ({ version: 1, name: "wf", steps });
const tool = (
  id: string,
  name: string,
  inputs: Record<string, unknown> = {},
  extra: object = {}
) => ({
  id,
  name: id,
  inputs,
  action: { type: "tool", tool: name },
  ...extra
});
const action = (name: string, execute: WorkflowAction["execute"]): WorkflowAction => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 200; i++) {
    const value = await read();
    last = value;
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = last as Partial<WorkflowRun> | undefined;
  const detail = Array.isArray(run?.steps)
    ? {
        status: run.status,
        error: run.error,
        steps: run.steps.map(({ id, status, error }) => ({ id, status, error }))
      }
    : last;
  throw new Error("condition not reached: " + JSON.stringify(detail));
}

describe("WorkflowService", () => {
  let dir: string;
  let store: MemoryStore;
  const services: WorkflowService[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-service-"));
    store = new MemoryStore();
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.close()));
    await rm(dir, { recursive: true, force: true });
  });
  const make = (options: ConstructorParameters<typeof WorkflowService>[2] = {}) => {
    const service = new WorkflowService(store, dir, options);
    services.push(service);
    return service;
  };
  const plan = async (service: WorkflowService, steps: unknown[]) =>
    (await service.call("create_plan", { definition: def(steps) }, ctx())) as StoredWorkflowPlan;
  const getRun = async (service: WorkflowService, id: string) =>
    (await service.call("get_run", { id }, ctx())) as WorkflowRun;
  const start = async (service: WorkflowService, p: StoredWorkflowPlan) =>
    (await service.call("run_plan", { id: p.id, revision: p.revision }, ctx())) as WorkflowRun;

  const agentStep = (executor = "native", tools: string[] = []) => ({
    id: "task",
    name: "Review report",
    action: {
      type: "agent",
      executor,
      task: {
        objective: "Review the report",
        context: "Use the supplied reporting period",
        references: [{ id: "policy", label: "Review guidance", content: "Cite the report." }],
        completionCriteria: ["Report actual results"],
        tools,
        limits: { maxTurns: 8 }
      }
    }
  });

  it("resumes an agent after restart with supplied context and a granted tool without replaying prior work", async () => {
    const read = vi.fn(async () => ({ count: 7 }));
    const write = vi.fn(async () => ({ saved: true }));
    const execute: TaskExecutor["execute"] = vi.fn(async (task, host, checkpoint) => {
      if (!checkpoint) {
        expect(task.references[0]?.content).toBe("Cite the report.");
        await host.callTool("read", {});
        await host.requestContext("Which period?");
        return { text: "Need period", checkpoint: { stage: 1 } };
      }
      if ((checkpoint as { stage: number }).stage === 1) {
        expect(task.context).toContain("October");
        await host.requestTool("write", "Save the reviewed count");
        return { text: "Need save access", checkpoint: { stage: 2 } };
      }
      expect(task.tools).toEqual(["read", "write"]);
      expect(await host.callTool("write", { count: 7 })).toEqual({ saved: true });
      return { text: "Seven records reviewed and saved." };
    });
    const options = {
      actions: [action("read", read), action("write", write)],
      executors: [{ id: "native", execute }]
    };
    const first = make(options);
    const p = await plan(first, [
      agentStep("native", ["read"]),
      {
        id: "review",
        name: "Final review",
        action: { type: "human", instructions: "Review the result" }
      }
    ]);
    const started = await start(first, p);
    const parked = await until(
      () => getRun(first, started.id),
      (run) => run.status === "waiting_input"
    );
    expect(parked.steps[0]?.output).toBeUndefined();
    expect((await store.get(principal().principalId, p.id)).work).toBe("in_progress");
    await first.close();
    const second = make(options);
    await expect(
      second.call(
        "submit_step_result",
        { id: started.id, stepId: "task", output: "October" },
        ctx()
      )
    ).rejects.toMatchObject({ code: "wrong_response_type" });
    const contextRequest = parked.steps[0]!.agent!.requests[0]!;
    await second.call(
      "respond_to_task_request",
      { id: started.id, stepId: "task", requestId: contextRequest.id, response: "October" },
      ctx()
    );
    const toolWait = await until(
      () => getRun(second, started.id),
      (run) => run.status === "waiting_input" && run.steps[0]?.agent?.requests.length === 2
    );
    const toolRequest = toolWait.steps[0]!.agent!.requests[1]!;
    await expect(
      second.call(
        "respond_to_task_request",
        { id: started.id, stepId: "task", requestId: contextRequest.id, response: "November" },
        ctx()
      )
    ).rejects.toMatchObject({ code: "request_not_pending" });
    await expect(
      second.call(
        "respond_to_task_request",
        { id: started.id, stepId: "task", requestId: toolRequest.id, response: { approved: true } },
        ctx(principal(["operator"], "other"))
      )
    ).rejects.toMatchObject({ code: "run_not_found" });
    await second.call(
      "respond_to_task_request",
      { id: started.id, stepId: "task", requestId: toolRequest.id, response: { approved: true } },
      ctx()
    );
    const review = await until(
      () => getRun(second, started.id),
      (run) => run.steps[1]?.status === "waiting_input"
    );
    expect(review.steps[0]?.output).toEqual({
      text: "Seven records reviewed and saved.",
      executor: "native"
    });
    expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledExactlyOnceWith(
      { count: 7 },
      expect.objectContaining({ principal: expect.objectContaining({ principalId: "local:A" }) })
    );
    expect(review.steps[0]?.agent?.events.map((event) => event.type)).toContain("tool_finished");
    await second.call(
      "submit_step_result",
      { id: started.id, stepId: "review", output: { accepted: true } },
      ctx()
    );
    expect(
      (
        await until(
          () => getRun(second, started.id),
          (run) => run.status === "completed"
        )
      ).status
    ).toBe("completed");
  });

  it("declining a requested tool resumes with access still denied and the decision visible", async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const executor: TaskExecutor = {
      id: "native",
      execute: async (task, host, checkpoint) => {
        if (!checkpoint) {
          await host.requestTool("write", "May I save?");
          return { text: "", checkpoint: { requested: true } };
        }
        expect(task.context).toContain("declined");
        await expect(host.callTool("write", {})).rejects.toMatchObject({
          code: "tool_not_allowed"
        });
        return { text: "Save declined. Report only." };
      }
    };
    const service = make({ actions: [action("write", write)], executors: [executor] });
    const started = await start(service, await plan(service, [agentStep()]));
    const waiting = await until(
      () => getRun(service, started.id),
      (run) => run.status === "waiting_input"
    );
    await service.call(
      "respond_to_task_request",
      {
        id: started.id,
        stepId: "task",
        requestId: waiting.steps[0]!.agent!.requests[0]!.id,
        response: { approved: false }
      },
      ctx()
    );
    const completed = await until(
      () => getRun(service, started.id),
      (run) => run.status === "completed"
    );
    expect(completed.steps[0]?.agent?.allowedTools).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("waits for agent cleanup on stop before allowing another attempt", async () => {
    let entered!: () => void, cleanup!: () => void;
    const startedExecution = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cleaned = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    const executor: TaskExecutor = {
      id: "native",
      execute: async (_task, host) => {
        entered();
        await new Promise<void>((resolve) =>
          host.signal.addEventListener("abort", () => resolve(), { once: true })
        );
        await cleaned;
        host.signal.throwIfAborted();
        return { text: "late result" };
      }
    };
    const service = make({ executors: [executor] });
    const p = await plan(service, [agentStep()]);
    const started = await start(service, p);
    await startedExecution;
    const stopping = service.call("stop_run", { id: started.id }, ctx());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.get(principal().principalId, p.id)).work).toBe("in_progress");
    await expect(start(service, p)).rejects.toMatchObject({ code: "not_runnable" });
    cleanup();
    expect(await stopping).toMatchObject({ status: "stopped" });
    expect((await store.get(principal().principalId, p.id)).work).toBe("todo");
    expect((await getRun(service, started.id)).steps[0]?.output).toBeUndefined();
  });

  it("retains the attempt when native cleanup cannot be confirmed", async () => {
    const service = make({
      executors: [
        {
          id: "native",
          execute: async () => {
            throw new WorkflowError(
              "task_cleanup_uncertain",
              "Cleanup could not be confirmed",
              502
            );
          }
        }
      ]
    });
    const p = await plan(service, [agentStep()]);
    const started = await start(service, p);
    const failed = await until(
      () => getRun(service, started.id),
      (run) => run.status !== "running"
    );
    expect(failed.status).toBe("uncertain");
    expect((await store.get(principal().principalId, p.id)).work).toBe("in_progress");
  });

  it("does not advance when a scoped MCP client catches a persistence failure", async () => {
    const operation = vi.fn(async () => ({ saved: true }));
    const service = make({
      actions: [action("save", operation)],
      executors: [
        {
          id: "native",
          execute: async (_task, host) => {
            const write = WorkflowRunStore.prototype.write;
            const spy = vi
              .spyOn(WorkflowRunStore.prototype, "write")
              .mockImplementation(async function (this: WorkflowRunStore, run) {
                if (run.steps[0]?.agent?.events.some((event) => event.type === "tool_finished"))
                  throw new Error("disk failed");
                return write.call(this, run);
              });
            try {
              await expect(host.callTool("save", {})).rejects.toMatchObject({
                code: "task_outcome_uncertain"
              });
            } finally {
              spy.mockRestore();
            }
            return { text: "Pretend finished" };
          }
        }
      ]
    });
    const p = await plan(service, [agentStep("native", ["save"]), tool("next", "save")]);
    const started = await start(service, p);
    const failed = await until(
      () => getRun(service, started.id),
      (run) => run.status !== "running"
    );
    expect(failed.status).toBe("uncertain");
    expect(failed.steps[1]?.status).toBe("pending");
    expect(operation).toHaveBeenCalledOnce();
    expect((await store.get(principal().principalId, p.id)).work).toBe("in_progress");
  });

  it("parks a final reply with unresolved operation failures instead of advancing, then resumes with operator guidance", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new WorkflowError("report_refused", "Report unavailable", 404))
      .mockResolvedValue({ count: 7 });
    const next = vi.fn(async () => ({ recorded: true }));
    const service = make({
      actions: [{ ...action("read", read), readOnly: true }, action("record", next)],
      executors: [
        {
          id: "native",
          execute: async (task, host, checkpoint) => {
            if (!checkpoint) {
              await expect(host.callTool("read", {})).rejects.toMatchObject({
                code: "report_refused"
              });
              return { text: "I could not retrieve the report.", checkpoint: { stage: 1 } };
            }
            expect(task.context).toContain("Try the report again");
            const result = await host.callTool("read", {});
            return { text: `Report count: ${(result as { count: number }).count}` };
          }
        }
      ]
    });
    const p = await plan(service, [agentStep("native", ["read"]), tool("next", "record")]);
    const started = await start(service, p);
    const parked = await until(
      () => getRun(service, started.id),
      (run) => run.status !== "running"
    );
    expect(parked.status).toBe("waiting_input");
    expect(parked.steps[0]?.output).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    const request = parked.steps[0]!.agent!.requests[0]!;
    expect(request).toMatchObject({ kind: "context", origin: "runtime", status: "pending" });
    await service.call(
      "respond_to_task_request",
      {
        id: started.id,
        stepId: "task",
        requestId: request.id,
        response: "Try the report again; the service is available."
      },
      ctx()
    );
    const finished = await until(
      () => getRun(service, started.id),
      (run) => run.status === "completed"
    );
    expect(finished.steps[0]?.output).toMatchObject({ text: "Report count: 7" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
  });

  it("holds an unconfirmed write outcome even if a model catches its error and reports success", async () => {
    const write = vi.fn(async () => {
      throw new Error("Private upstream detail");
    });
    const service = make({
      actions: [action("write", write)],
      executors: [
        {
          id: "native",
          execute: async (_task, host) => {
            await expect(host.callTool("write", {})).rejects.toMatchObject({
              code: "task_outcome_uncertain"
            });
            await expect(host.callTool("write", {})).rejects.toMatchObject({
              code: "task_outcome_uncertain"
            });
            return { text: "Claimed success" };
          }
        }
      ]
    });
    const p = await plan(service, [agentStep("native", ["write"])]);
    const started = await start(service, p);
    const failed = await until(
      () => getRun(service, started.id),
      (run) => run.status !== "running"
    );
    expect(failed.status).toBe("uncertain");
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.stringify(failed)).not.toContain("Private upstream detail");
    expect((await store.get(principal().principalId, p.id)).work).toBe("in_progress");
  });

  it("passes outputs through tool, model, human and a following tool, waiting for the human", async () => {
    const record = vi.fn(async (input: unknown) => ({ stored: input }));
    const service = make({
      actions: [
        action("scores", async () => ({ ok: true, games: [1, 2, 3] })),
        action("record", record)
      ],
      model: async (prompt, inputs) => ({
        summary: `${prompt}:${(inputs as { games: unknown[] }).games.length}`
      })
    });
    const p = await plan(service, [
      tool("fetch", "scores", {}, { success: { path: "ok", equals: true } }),
      {
        id: "sum",
        name: "sum",
        inputs: { games: { $step: "fetch", path: "games" } },
        action: { type: "model", prompt: "count" }
      },
      {
        id: "approve",
        name: "approve",
        inputs: { text: { $step: "sum", path: "summary" } },
        action: { type: "human", instructions: "Approve it" }
      },
      tool("save", "record", {
        summary: { $step: "sum", path: "summary" },
        decision: { $step: "approve", path: "decision" }
      })
    ]);
    const started = await start(service, p);
    expect(started.status).toBe("running");
    expect(started.id).not.toBe(p.id);
    expect(started.attemptEpoch).toBe(1);

    const waiting = await until(
      () => getRun(service, started.id),
      (r) => r.status === "waiting_input"
    );
    expect(waiting.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "waiting_input",
      "pending"
    ]);
    expect(waiting.steps[2].inputs).toEqual({ text: "count:3" });
    expect(record).not.toHaveBeenCalled();
    expect(store.plans.get(p.id)?.work).toBe("in_progress");

    await service.call(
      "submit_step_result",
      { id: started.id, stepId: "approve", output: { decision: "yes" } },
      ctx()
    );
    const done = await until(
      () => getRun(service, started.id),
      (r) => r.status === "completed"
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(done.steps[3].output).toEqual({ stored: { summary: "count:3", decision: "yes" } });
    expect(store.plans.get(p.id)).toMatchObject({
      work: "done",
      artifactRef: `workflow:${started.id}`
    });
  });

  it("a failed step prevents its successor, keeps partial output and releases the plan", async () => {
    const after = vi.fn(async () => ({}));
    const service = make({
      actions: [
        action("one", async () => ({ n: 1 })),
        action("bad", async () => ({ ok: false })),
        action("after", after)
      ]
    });
    const p = await plan(service, [
      tool("a", "one"),
      tool("b", "bad", {}, { success: { path: "ok", equals: true } }),
      tool("c", "after")
    ]);
    const started = await start(service, p);
    const run = await until(
      () => getRun(service, started.id),
      (r) => r.status === "failed"
    );
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "failed", "pending"]);
    expect(run.steps[0].output).toEqual({ n: 1 });
    expect(after).not.toHaveBeenCalled();
    expect(store.plans.get(p.id)).toMatchObject({ work: "todo", attemptId: null });
  });

  it("rejects late outputs after timeout and after stop, and never starts a successor", async () => {
    const releases: Array<() => void> = [];
    const successor = vi.fn(async () => ({}));
    const service = make({
      actions: [
        action(
          "stubborn",
          () => new Promise((resolve) => releases.push(() => resolve({ late: true })))
        ),
        action("successor", successor)
      ]
    });
    const steps = (timeoutMs: number) => [
      tool("slow", "stubborn", {}, { timeoutMs }),
      tool("next", "successor")
    ];

    const timed = await start(service, await plan(service, steps(100)));
    const failed = await until(
      () => getRun(service, timed.id),
      (r) => r.status === "failed"
    );
    expect(failed.steps[0].error).toMatch(/timed out/);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await getRun(service, timed.id)).steps[0].output).toBeUndefined();

    const p2 = await plan(service, steps(5000));
    const running = await start(service, p2);
    await until(
      async () => releases.length,
      (n) => n === 1
    );
    const stopped = (await service.call("stop_run", { id: running.id }, ctx())) as WorkflowRun;
    expect(stopped.status).toBe("stopped");
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = await getRun(service, running.id);
    expect(after.steps.map((s) => s.status)).toEqual(["stopped", "pending"]);
    expect(after.steps[0].output).toBeUndefined();
    expect(successor).not.toHaveBeenCalled();
    expect(store.plans.get(p2.id)?.work).toBe("todo");
  });

  it("checks the operator role before touching the store or the run directory", async () => {
    const service = make();
    const client = ctx(principal(["client"]));
    for (const [name, input] of [
      ["list_plans", {}],
      ["create_plan", { definition: def([]) }],
      ["get_run", { id: randomUUID() }]
    ] as const)
      await expect(service.call(name, input, client)).rejects.toMatchObject({ status: 403 });
    expect(store.calls).toBe(0);
  });

  it("validates input and bindings before any effect", async () => {
    const service = make({ actions: [action("t", async () => ({}))] });
    await expect(
      service.call("run_plan", { id: "nope", revision: 1 }, ctx())
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.call("get_plan", { id: randomUUID(), extra: 1 }, ctx())
    ).rejects.toMatchObject({ code: "invalid_input" });
    const bad = (inputs: unknown) =>
      service.call(
        "create_plan",
        { definition: def([tool("a", "t"), tool("b", "t", inputs as Record<string, unknown>)]) },
        ctx()
      );
    await expect(bad({ x: { $step: "b" } })).rejects.toMatchObject({ code: "invalid_definition" });
    await expect(bad({ x: { $step: "zzz" } })).rejects.toMatchObject({
      code: "invalid_definition"
    });
    await expect(bad({ x: { $step: "a", path: "__proto__.y" } })).rejects.toMatchObject({
      code: "invalid_definition"
    });
    await expect(bad(JSON.parse('{"nested":[{"constructor":1}]}'))).rejects.toMatchObject({
      code: "invalid_definition"
    });
    await expect(
      service.call("create_plan", { definition: def([tool("a", "unregistered")]) }, ctx())
    ).rejects.toMatchObject({ code: "invalid_definition" });
    expect(store.plans.size).toBe(0);
  });

  it("delegates revision conflicts and refuses stale or repeated runs", async () => {
    const service = make({ actions: [action("t", () => new Promise(() => undefined))] });
    const p = await plan(service, [tool("a", "t", {}, { timeoutMs: 5000 })]);
    await expect(
      service.call(
        "update_plan",
        { id: p.id, revision: 99, definition: def([tool("a", "t")]) },
        ctx()
      )
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(service.call("run_plan", { id: p.id, revision: 99 }, ctx())).rejects.toMatchObject(
      { status: 409 }
    );
    await start(service, p);
    await expect(start(service, p)).rejects.toMatchObject({ status: 409 });
    const other = ctx(principal(["operator"], "local:B"));
    await expect(service.call("get_plan", { id: p.id }, other)).rejects.toMatchObject({
      status: 404
    });
  });

  it("reports a missing start confirmation as uncertain without launching", async () => {
    const execute = vi.fn(async () => ({}));
    const service = make({ actions: [action("t", execute)] });
    const p = await plan(service, [tool("a", "t")]);
    store.start = async () => {
      throw new Error("socket hang up");
    };
    await expect(start(service, p)).rejects.toMatchObject({ code: "start_uncertain" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([502, 503])(
    "keeps a classified %i start failure uncertain even when admission was saved",
    async (status) => {
      const execute = vi.fn(async () => ({}));
      const service = make({ actions: [action("t", execute)] });
      const p = await plan(service, [tool("a", "t")]);
      const original = store.start.bind(store);
      store.start = async (...args: Parameters<MemoryStore["start"]>) => {
        await original(...args);
        throw new WorkflowError("store_unavailable", "Readback failed", status);
      };
      await expect(start(service, p)).rejects.toMatchObject({ code: "start_uncertain" });
      const saved = store.plans.get(p.id)!;
      expect((await getRun(service, saved.attemptId!)).status).toBe("uncertain");
      expect(saved.work).toBe("in_progress");
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it.each(["tool", "human"])(
    "stopping between steps prevents admission of a %s successor",
    async (kind) => {
      const next = vi.fn(async () => ({}));
      const service = make({
        actions: [action("first", async () => ({ ok: true })), action("next", next)]
      });
      const successor =
        kind === "human"
          ? { id: "next", name: "next", action: { type: "human", instructions: "Review" } }
          : tool("next", "next");
      const p = await plan(service, [tool("first", "first"), successor]);
      let entered!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const boundary = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = WorkflowRunStore.prototype.write;
      const spy = vi.spyOn(WorkflowRunStore.prototype, "write").mockImplementation(async function (
        this: WorkflowRunStore,
        run
      ) {
        if (run.status === "running" && run.steps[0].status === "completed") {
          entered();
          await boundary;
        }
        return write.call(this, run);
      });
      try {
        const started = await start(service, p);
        await atBoundary;
        const stopping = service.call("stop_run", { id: started.id }, ctx());
        release();
        const stopped = (await stopping) as WorkflowRun;
        expect(stopped.status).toBe("stopped");
        expect(next).not.toHaveBeenCalled();
        expect(stopped.steps[1].status).toBe("stopped");
        expect(stopped.steps[1].startedAt).toBeUndefined();
      } finally {
        release();
        spy.mockRestore();
      }
    }
  );

  it("runs a completed plan as a fresh attempt while preserving the earlier artifact", async () => {
    let calls = 0;
    const execute = vi.fn(async () => ({ n: ++calls }));
    const service = make({ actions: [action("t", execute)] });
    const p = await plan(service, [tool("a", "t")]);
    const first = await start(service, p);
    const done = await until(
      () => getRun(service, first.id),
      (run) => run.status === "completed"
    );
    const second = await start(service, p);
    const again = await until(
      () => getRun(service, second.id),
      (run) => run.status === "completed"
    );
    expect(again.id).not.toBe(done.id);
    expect(again.attemptEpoch).toBe(done.attemptEpoch + 1);
    expect((await getRun(service, first.id)).steps[0].output).toEqual(done.steps[0].output);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("marks a saved running run uncertain in a recreated service and never replays it", async () => {
    const execute = vi.fn(async () => ({}));
    const service = make({ actions: [action("t", execute)] });
    const p = await plan(service, [tool("a", "t")]);
    const runId = randomUUID();
    await store.start("local:A", p.id, p.revision, runId);
    const now = new Date().toISOString();
    await new WorkflowRunStore(dir).create({
      version: 1,
      id: runId,
      planId: p.id,
      ownerId: "local:A",
      definition: p.definition,
      revision: p.revision,
      attemptEpoch: 1,
      status: "running",
      steps: [{ id: "a", name: "a", status: "running" }],
      startedAt: now,
      updatedAt: now
    });
    const reopened = make({ actions: [action("t", execute)] });
    const run = await getRun(reopened, runId);
    expect(run.status).toBe("uncertain");
    expect(run.steps[0].status).toBe("uncertain");
    await expect(start(reopened, p)).rejects.toMatchObject({ status: 409 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resumes a persisted waiting run in a new service exactly once", async () => {
    const before = vi.fn(async () => ({ n: 1 }));
    const afterHuman = vi.fn(async (input: unknown) => ({ got: input }));
    const actions = () => [action("before", before), action("after", afterHuman)];
    const first = make({ actions: actions() });
    const p = await plan(first, [
      tool("a", "before"),
      {
        id: "h",
        name: "h",
        action: { type: "human", instructions: "Do it" },
        success: { path: "approved", equals: true }
      },
      tool("z", "after", { answer: { $step: "h" } })
    ]);
    const started = await start(first, p);
    await until(
      () => getRun(first, started.id),
      (r) => r.status === "waiting_input"
    );
    await first.close();

    const second = make({ actions: actions() });
    const submit = (output: unknown) =>
      second.call("submit_step_result", { id: started.id, stepId: "h", output }, ctx());
    await expect(submit({ approved: false })).rejects.toMatchObject({ code: "success_not_met" });
    await expect(
      second.call("submit_step_result", { id: started.id, stepId: "a", output: {} }, ctx())
    ).rejects.toMatchObject({ code: "not_waiting" });
    await submit({ approved: true });
    const done = await until(
      () => getRun(second, started.id),
      (r) => r.status === "completed"
    );
    await expect(submit({ approved: true })).rejects.toMatchObject({ status: 409 });
    expect(before).toHaveBeenCalledTimes(1);
    expect(afterHuman).toHaveBeenCalledTimes(1);
    expect(done.steps[2].output).toEqual({ got: { answer: { approved: true } } });
    expect(store.plans.get(p.id)?.work).toBe("done");
  });

  it("stops a waiting run, releases the plan and lists actions", async () => {
    const service = make({ actions: [action("t", async () => ({}))] });
    const p = await plan(service, [
      { id: "h", name: "h", action: { type: "human", instructions: "wait" } }
    ]);
    const started = await start(service, p);
    await until(
      () => getRun(service, started.id),
      (r) => r.status === "waiting_input"
    );
    const stopped = (await service.call("stop_run", { id: started.id }, ctx())) as WorkflowRun;
    expect(stopped.status).toBe("stopped");
    expect(store.plans.get(p.id)?.work).toBe("todo");
    const reopened = make();
    expect(await reopened.call("get_plan", { id: p.id }, ctx())).toMatchObject({
      attemptId: null,
      latestRunId: started.id
    });
    expect(await reopened.call("list_plans", {}, ctx())).toMatchObject({
      plans: [{ id: p.id, latestRunId: started.id }]
    });
    expect(await service.call("list_actions", {}, ctx())).toMatchObject({
      actions: [{ name: "t" }],
      modelAvailable: false
    });
  });

  it("a second service observes a live run without changing its ownership or outcome", async () => {
    let release!: () => void;
    const work = new Promise<unknown>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const service = make({ actions: [action("t", () => work)] });
    const p = await plan(service, [tool("a", "t")]);
    const started = await start(service, p);
    const observer = make();
    expect((await getRun(observer, started.id)).status).toBe("running");
    release();
    expect(
      (
        await until(
          () => getRun(observer, started.id),
          (run) => run.status === "completed"
        )
      ).status
    ).toBe("completed");
  });

  it("attributes an aggregate artifact size failure to the current step and keeps earlier results", async () => {
    const execute = vi.fn(async () => "x".repeat(256 * 1024 - 2));
    const service = make({ actions: [action("large", execute)] });
    const p = await plan(
      service,
      ["a", "b", "c", "d", "e"].map((id) => tool(id, "large"))
    );
    const started = await start(service, p);
    const failed = await until(
      () => getRun(service, started.id),
      (run) => run.status === "failed"
    );
    expect(failed.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "failed",
      "pending"
    ]);
    expect(failed.steps[0].output).toHaveLength(256 * 1024 - 2);
    expect(failed.steps[3].output).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(4);
    expect(store.plans.get(p.id)?.work).toBe("todo");
  });

  it("holds the plan uncertain when its terminal execution state cannot be persisted", async () => {
    const service = make({
      actions: [
        action("bad", async () => {
          throw new Error("Action failed");
        })
      ]
    });
    const p = await plan(service, [tool("a", "bad")]);
    const write = WorkflowRunStore.prototype.write;
    const spy = vi.spyOn(WorkflowRunStore.prototype, "write").mockImplementation(async function (
      this: WorkflowRunStore,
      run
    ) {
      if (run.status === "failed") throw new WorkflowError("run_store_io", "Storage failed", 500);
      return write.call(this, run);
    });
    try {
      const started = await start(service, p);
      const uncertain = await until(
        () => getRun(service, started.id),
        (run) => run.status === "uncertain"
      );
      expect(uncertain.error).toContain("terminal execution state could not be persisted");
      expect(store.plans.get(p.id)).toMatchObject({ work: "in_progress", attemptId: started.id });
      await expect(start(service, p)).rejects.toMatchObject({ status: 409 });
    } finally {
      spy.mockRestore();
    }
  });

  it("close preserves a durable human wait while its save is finishing", async () => {
    const service = make();
    const p = await plan(service, [
      { id: "h", name: "Review", action: { type: "human", instructions: "Review" } }
    ]);
    let saved!: () => void, release!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const boundary = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = WorkflowRunStore.prototype.write;
    const spy = vi.spyOn(WorkflowRunStore.prototype, "write").mockImplementation(async function (
      this: WorkflowRunStore,
      run
    ) {
      await write.call(this, run);
      if (run.status === "waiting_input") {
        saved();
        await boundary;
      }
    });
    try {
      const started = await start(service, p);
      await atBoundary;
      const closing = service.close();
      release();
      await closing;
      const reopened = make();
      expect((await getRun(reopened, started.id)).status).toBe("waiting_input");
      await reopened.call(
        "submit_step_result",
        { id: started.id, stepId: "h", output: { approved: true } },
        ctx()
      );
      expect(
        (
          await until(
            () => getRun(reopened, started.id),
            (run) => run.status === "completed"
          )
        ).status
      ).toBe("completed");
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("close interrupts an in-flight call and records uncertain", async () => {
    let signal: AbortSignal | undefined;
    const service = make({
      actions: [
        action("t", (_input, context) => {
          signal = context.signal;
          return new Promise(() => undefined);
        })
      ]
    });
    const p = await plan(service, [tool("a", "t", {}, { timeoutMs: 5000 })]);
    const started = await start(service, p);
    await until(
      async () => signal,
      (s) => s !== undefined
    );
    await service.close();
    expect(signal?.aborted).toBe(true);
    const reopened = make();
    expect((await getRun(reopened, started.id)).status).toBe("uncertain");
  });
});
