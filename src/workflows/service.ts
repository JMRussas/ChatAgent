import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkflowRunStore, type RunClaim } from "./runStore";
import {
  WorkflowError,
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowAction,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowPlanStore,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTool
} from "./types";

const MAX_VALUE_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const uuid = z.string().uuid();
const stepId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

type Model = (prompt: string, inputs: unknown, context: WorkflowContext) => Promise<unknown>;
type BackgroundContext = Omit<WorkflowContext, "signal">;
interface Active {
  run: WorkflowRun;
  ctx: BackgroundContext;
  controller: AbortController;
  lock: RunClaim;
  done?: Promise<void>;
}
interface Ref {
  step: string;
  path: string[];
}

/** A step ended because its signal fired; `reason` is "timeout", "stop" or "close". */
class StepAbort extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const definitionJson = {
  type: "object",
  description:
    'Workflow definition: version 1, name, optional description, and 1-50 sequential steps. Step inputs may embed {"$step":"earlier-step-id","path":"optional.dot.path"} to bind an earlier step\'s output.',
  required: ["version", "name", "steps"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 4000 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        required: ["id", "name", "action"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          inputs: { type: "object" },
          action: {
            oneOf: [
              {
                type: "object",
                required: ["type", "tool"],
                properties: { type: { const: "tool" }, tool: { type: "string" } }
              },
              {
                type: "object",
                required: ["type", "prompt"],
                properties: { type: { const: "model" }, prompt: { type: "string" } }
              },
              {
                type: "object",
                required: ["type", "instructions"],
                properties: { type: { const: "human" }, instructions: { type: "string" } }
              }
            ]
          },
          timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
          success: {
            type: "object",
            required: ["path", "equals"],
            additionalProperties: false,
            properties: { path: { type: "string", maxLength: 200 }, equals: {} }
          }
        }
      }
    }
  }
};
const idProps = { id: { type: "string", format: "uuid" } };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

const TOOL_SPECS: Array<WorkflowTool & { schema: z.ZodTypeAny }> = [
  {
    name: "list_plans",
    description: "List the caller's workflow plans.",
    readOnly: true,
    inputSchema: obj({}),
    schema: z.object({}).strict()
  },
  {
    name: "get_plan",
    description: "Get one workflow plan by plan ID.",
    readOnly: true,
    inputSchema: obj(idProps),
    schema: z.object({ id: uuid }).strict()
  },
  {
    name: "create_plan",
    description: "Create a sequential workflow plan from a definition.",
    readOnly: false,
    inputSchema: obj({ definition: definitionJson }),
    schema: z.object({ definition: z.unknown() }).strict()
  },
  {
    name: "update_plan",
    description: "Replace a plan's definition; fails if the revision is stale.",
    readOnly: false,
    inputSchema: obj({
      ...idProps,
      revision: { type: "integer", minimum: 0 },
      definition: definitionJson
    }),
    schema: z
      .object({ id: uuid, revision: z.number().int().min(0), definition: z.unknown() })
      .strict()
  },
  {
    name: "run_plan",
    description:
      "Start a plan revision in the background and return the new run (poll with get_run).",
    readOnly: false,
    inputSchema: obj({ ...idProps, revision: { type: "integer", minimum: 0 } }),
    schema: z.object({ id: uuid, revision: z.number().int().min(0) }).strict()
  },
  {
    name: "get_run",
    description: "Get a workflow run by run ID, including per-step results.",
    readOnly: true,
    inputSchema: obj(idProps),
    schema: z.object({ id: uuid }).strict()
  },
  {
    name: "stop_run",
    description:
      "Stop a running or waiting run; partial results are kept and the plan returns to todo.",
    readOnly: false,
    inputSchema: obj(idProps),
    schema: z.object({ id: uuid }).strict()
  },
  {
    name: "submit_step_result",
    description: "Supply the output of the run's current waiting human step and continue the run.",
    readOnly: false,
    inputSchema: obj({ ...idProps, stepId: { type: "string" }, output: {} }),
    schema: z.object({ id: uuid, stepId, output: z.unknown() }).strict()
  },
  {
    name: "list_actions",
    description:
      "List registered tool actions available to workflow steps and whether a model is available.",
    readOnly: true,
    inputSchema: obj({}),
    schema: z.object({}).strict()
  }
];

export class WorkflowService {
  readonly tools: readonly WorkflowTool[] = TOOL_SPECS.map(({ schema: _schema, ...tool }) => tool);
  private readonly runs: WorkflowRunStore;
  private readonly actions = new Map<string, WorkflowAction>();
  private readonly model?: Model;
  private readonly active = new Map<string, Active>();
  private closed = false;

  constructor(
    private readonly store: WorkflowPlanStore,
    runDir: string,
    options: { actions?: WorkflowAction[]; model?: Model } = {}
  ) {
    this.runs = new WorkflowRunStore(runDir);
    for (const action of options.actions ?? []) this.actions.set(action.name, action);
    this.model = options.model;
  }

  async call(name: string, input: unknown, context: WorkflowContext): Promise<unknown> {
    if (!context.principal.roles.has("operator"))
      throw new WorkflowError("forbidden", "Operator role required", 403);
    if (this.closed) throw new WorkflowError("service_closed", "Workflow service is closed", 503);
    const spec = TOOL_SPECS.find((tool) => tool.name === name);
    if (!spec) throw new WorkflowError("unknown_tool", "Unknown workflow tool", 404);
    const parsed = spec.schema.safeParse(input ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkflowError(
        "invalid_input",
        `Invalid input${issue.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue.message}`,
        400
      );
    }
    const args = parsed.data as Record<string, unknown>;
    const owner = context.principal.principalId;
    switch (name) {
      case "list_plans": {
        const plans = await this.guard(this.store.list(owner, context.signal));
        return { plans: await this.withLatest(owner, plans) };
      }
      case "get_plan":
        return (
          await this.withLatest(owner, [
            await this.guard(this.store.get(owner, args.id as string, context.signal))
          ])
        )[0];
      case "create_plan":
        return this.guard(
          this.store.create(
            owner,
            this.parseDefinition(args.definition),
            context.operationId,
            context.signal
          )
        );
      case "update_plan":
        return this.guard(
          this.store.update(
            owner,
            args.id as string,
            args.revision as number,
            this.parseDefinition(args.definition),
            context.operationId,
            context.signal
          )
        );
      case "run_plan":
        return this.runPlan(owner, args.id as string, args.revision as number, context);
      case "get_run":
        return this.loadReconciled(owner, args.id as string);
      case "stop_run":
        return this.stopRun(owner, args.id as string);
      case "submit_step_result":
        return this.submit(owner, args.id as string, args.stepId as string, args.output, context);
      default:
        return {
          actions: [...this.actions.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
          })),
          modelAvailable: this.model !== undefined
        };
    }
  }

  private async withLatest(owner: string, plans: StoredWorkflowPlan[]) {
    const latest = await this.runs.latest(
      owner,
      plans.map((plan) => plan.id)
    );
    return plans.map((plan) => ({
      ...plan,
      latestRunId: plan.attemptId ?? latest.get(plan.id) ?? null
    }));
  }

  /** Cancels owned calls; interrupted runs are recorded uncertain and never replayed. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.active.values()];
    // A human wait has no external call to interrupt; allow its durable write to finish.
    for (const a of pending) if (a.run.status !== "waiting_input") a.controller.abort("close");
    await Promise.all(pending.map((a) => a.done));
  }

  // --- plan validation -------------------------------------------------------------

  private parseDefinition(raw: unknown): WorkflowDefinition {
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkflowError(
        "invalid_definition",
        `Invalid definition at ${issue.path.join(".") || "root"}: ${issue.message}`,
        400
      );
    }
    this.validateBindings(parsed.data);
    return parsed.data;
  }

  private validateBindings(definition: WorkflowDefinition): void {
    const earlier = new Set<string>();
    for (const step of definition.steps) {
      if (step.action.type === "tool" && !this.actions.has(step.action.tool))
        throw new WorkflowError(
          "invalid_definition",
          `Step ${step.id} uses an unregistered tool`,
          400
        );
      mapInputs(step.inputs, (ref) => {
        if (!earlier.has(ref.step))
          throw new WorkflowError(
            "invalid_definition",
            `Step ${step.id} references ${ref.step} which is not an earlier step`,
            400
          );
        return null;
      });
      if (step.success) parsePath(step.success.path);
      earlier.add(step.id);
    }
  }

  // --- run lifecycle ---------------------------------------------------------------

  private async runPlan(
    owner: string,
    planId: string,
    revision: number,
    context: WorkflowContext
  ): Promise<WorkflowRun> {
    const plan = await this.guard(this.store.get(owner, planId, context.signal));
    if (plan.revision !== revision)
      throw new WorkflowError("revision_conflict", "Plan revision has changed", 409);
    if (plan.work !== "todo" && plan.work !== "done")
      throw new WorkflowError("not_runnable", "Plan is already running or cancelled", 409);
    const definition = this.parseDefinition(plan.definition);
    if (!this.model && definition.steps.some((step) => step.action.type === "model"))
      throw new WorkflowError("model_unavailable", "No model is configured for model steps", 422);

    const now = new Date().toISOString();
    const run: WorkflowRun = {
      version: 1,
      id: randomUUID(),
      planId: plan.id,
      ownerId: owner,
      definition,
      revision: plan.revision,
      attemptEpoch: 0,
      status: "running",
      steps: definition.steps.map((step) => ({ id: step.id, name: step.name, status: "pending" })),
      startedAt: now,
      updatedAt: now,
      ...(context.conversationId ? { conversationId: context.conversationId } : {})
    };
    const a: Active = {
      run,
      ctx: {
        principal: context.principal,
        operationId: context.operationId,
        conversationId: context.conversationId
      },
      controller: new AbortController(),
      lock: await this.runs.claim(run.id)
    };
    let launched = false;
    try {
      await this.runs.create(run);
      let started: StoredWorkflowPlan;
      try {
        started = await this.store.start(owner, plan.id, plan.revision, run.id, context.signal);
      } catch (error) {
        // A classified rejection means the fence was refused; anything else is unknown.
        if (error instanceof WorkflowError && error.status >= 400 && error.status < 500) {
          run.status = "failed";
          run.error = `Start rejected: ${error.message}`;
          run.endedAt = new Date().toISOString();
          await this.save(run).catch(() => undefined);
          throw error;
        }
        await this.markUncertain(a, "Plan start outcome is unknown; the run was not launched");
        throw new WorkflowError(
          "start_uncertain",
          "Plan start outcome is unknown; the run was not launched",
          502
        );
      }
      if (
        started.attemptId !== run.id ||
        started.work !== "in_progress" ||
        started.revision !== plan.revision
      ) {
        await this.markUncertain(
          a,
          "Plan start returned an unexpected attempt; the run was not launched"
        );
        throw new WorkflowError(
          "start_uncertain",
          "Plan start returned an unexpected attempt",
          502
        );
      }
      run.attemptEpoch = started.attemptEpoch;
      try {
        await this.save(run);
      } catch (cause) {
        await this.markUncertain(
          a,
          "Attempt epoch could not be persisted; the run was not launched"
        );
        throw Object.assign(
          new WorkflowError(
            "run_store_io",
            "Attempt epoch could not be persisted; the run was not launched",
            500
          ),
          { cause }
        );
      }
      const snapshot = structuredClone(run);
      this.active.set(run.id, a);
      if (this.closed) a.controller.abort("close");
      launched = true;
      a.done = this.pump(a);
      return snapshot;
    } finally {
      if (!launched) await a.lock.release();
    }
  }

  private async stopRun(owner: string, id: string): Promise<WorkflowRun> {
    const live = this.active.get(id);
    if (live && live.run.ownerId === owner) {
      live.controller.abort("stop");
      await live.done; // a run that parked at a human step meanwhile is stopped below
    }
    const run = await this.loadReconciled(owner, id);
    if (run.status !== "waiting_input") return run;
    const lock = await this.runs.claim(id);
    try {
      const current = await this.runs.read(owner, id);
      if (current.status !== "waiting_input") return current;
      const a: Active = {
        run: current,
        ctx: {
          principal: { principalId: owner, roles: new Set(["operator" as const]), via: "session" },
          operationId: randomUUID()
        },
        controller: new AbortController(),
        lock
      };
      a.controller.abort("stop");
      await this.settle(a, new StepAbort("stop"));
      return structuredClone(a.run);
    } finally {
      await lock.release();
    }
  }

  private async submit(
    owner: string,
    id: string,
    stepIdValue: string,
    output: unknown,
    context: WorkflowContext
  ): Promise<WorkflowRun> {
    const lock = await this.runs.claim(id);
    let launched = false;
    try {
      if (this.active.has(id))
        throw new WorkflowError("run_busy", "Workflow run is executing", 409);
      const run = await this.runs.read(owner, id);
      const index = run.steps.findIndex((step) => step.status !== "completed");
      if (
        run.status !== "waiting_input" ||
        index < 0 ||
        run.steps[index].status !== "waiting_input" ||
        run.steps[index].id !== stepIdValue
      )
        throw new WorkflowError("not_waiting", "Run is not waiting for that step", 409);
      this.validateBindings(run.definition);
      const result = normalizeJson(output);
      const definition = run.definition.steps[index];
      if (!meetsSuccess(definition, result))
        throw new WorkflowError(
          "success_not_met",
          "Submitted output does not satisfy the step's success condition",
          422
        );

      const plan = await this.guard(this.store.get(owner, run.planId, context.signal));
      if (!holdsFence(plan, run)) {
        run.steps[index].status = "uncertain";
        run.status = "uncertain";
        run.error = "Plan no longer shows this run's attempt; the run was not resumed";
        await this.save(run).catch(() => undefined);
        throw new WorkflowError("fence_lost", "Plan no longer shows this run's attempt", 409);
      }
      const now = new Date().toISOString();
      Object.assign(run.steps[index], { status: "completed", output: result, endedAt: now });
      run.status = "running";
      await this.save(run);
      const a: Active = {
        run,
        ctx: {
          principal: context.principal,
          operationId: context.operationId,
          conversationId: context.conversationId
        },
        controller: new AbortController(),
        lock
      };
      const snapshot = structuredClone(run);
      this.active.set(id, a);
      if (this.closed) a.controller.abort("close");
      launched = true;
      a.done = this.pump(a);
      return snapshot;
    } finally {
      if (!launched) await lock.release();
    }
  }

  /** Reads a run; a saved "running" record nobody in this process owns becomes uncertain. */
  private async loadReconciled(owner: string, id: string): Promise<WorkflowRun> {
    const run = await this.runs.read(owner, id);
    if (run.status !== "running" || this.active.has(id)) return run;
    let lock: RunClaim;
    try {
      lock = await this.runs.claim(id);
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "run_busy") return run;
      throw error;
    }
    try {
      const current = await this.runs.read(owner, id);
      if (current.status === "running" && !this.active.has(id)) {
        const a = { run: current, lock } as Active;
        await this.markUncertain(
          a,
          "Run was interrupted; its outcome is unknown and it will not be replayed"
        );
      }
      return current;
    } finally {
      await lock.release();
    }
  }

  // --- execution -------------------------------------------------------------------

  private async pump(a: Active): Promise<void> {
    const run = a.run;
    try {
      for (
        let i = run.steps.findIndex((s) => s.status !== "completed");
        i >= 0 && i < run.steps.length;
        i++
      ) {
        if (a.controller.signal.aborted) throw new StepAbort(String(a.controller.signal.reason));
        const step = run.definition.steps[i];
        const result = run.steps[i];
        const outputs = new Map(
          run.steps.filter((s) => s.status === "completed").map((s) => [s.id, s.output])
        );
        const inputs = mapInputs(step.inputs, (ref) => {
          const found = getPath(outputs.get(ref.step), ref.path);
          if (!found.found)
            throw new WorkflowError(
              "unresolved_binding",
              `Input binding to ${ref.step} did not resolve`,
              422
            );
          return found.value;
        });
        normalizeJson(inputs);
        Object.assign(result, { status: "running", inputs, startedAt: new Date().toISOString() });
        delete result.error;
        if (step.action.type === "human") {
          result.status = "waiting_input";
          run.status = "waiting_input";
          await this.save(run);
          if (a.controller.signal.aborted) throw new StepAbort(String(a.controller.signal.reason));
          return;
        }
        await this.save(run);
        const output = await this.execute(a, step, inputs);
        if (!meetsSuccess(step, output))
          throw new WorkflowError(
            "success_not_met",
            "Step output did not satisfy its success condition",
            422
          );
        Object.assign(result, { status: "completed", output, endedAt: new Date().toISOString() });
        try {
          await this.save(run);
        } catch (error) {
          // A completed action is not a completed step until its result is durable.
          result.status = "running";
          if (error instanceof WorkflowError && error.code === "record_too_large")
            delete result.output;
          throw error;
        }
      }
      await this.complete(a);
    } catch (error) {
      await this.settle(a, error).catch(() => undefined);
    } finally {
      this.active.delete(run.id);
      await a.lock.release();
    }
  }

  private async execute(a: Active, step: WorkflowStep, inputs: unknown): Promise<unknown> {
    const ctl = new AbortController();
    const forward = () => ctl.abort(a.controller.signal.reason);
    if (a.controller.signal.aborted) forward();
    else a.controller.signal.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => ctl.abort("timeout"), step.timeoutMs);
    const context: WorkflowContext = { ...a.ctx, signal: ctl.signal };
    try {
      if (ctl.signal.aborted) throw new StepAbort(String(ctl.signal.reason));
      const work = (async () => {
        if (step.action.type === "tool")
          return this.actions.get(step.action.tool)!.execute(inputs, context);
        if (step.action.type === "model" && this.model)
          return this.model(step.action.prompt, inputs, context);
        throw new WorkflowError("unavailable", "Step action is unavailable", 422);
      })();
      const aborted = new Promise<never>((_, reject) => {
        const fire = () => reject(new StepAbort(String(ctl.signal.reason)));
        if (ctl.signal.aborted) fire();
        else ctl.signal.addEventListener("abort", fire, { once: true });
      });
      work.catch(() => undefined);
      aborted.catch(() => undefined);
      const value = await Promise.race([work, aborted]);
      if (ctl.signal.aborted) throw new StepAbort(String(ctl.signal.reason)); // late results are never accepted
      return normalizeJson(value);
    } finally {
      clearTimeout(timer);
      a.controller.signal.removeEventListener("abort", forward);
    }
  }

  private async complete(a: Active): Promise<void> {
    const run = a.run;
    try {
      await this.guard(
        this.store.finish(run.ownerId, run.planId, run.id, run.attemptEpoch, `workflow:${run.id}`)
      );
    } catch {
      await this.markUncertain(a, "Plan completion could not be confirmed; results were persisted");
      return;
    }
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    await this.save(run).catch(() => undefined); // disk still says running; a reopen reports uncertain
  }

  /** Terminal handling for failure, stop and interruption; preserves partial results. */
  private async settle(a: Active, error: unknown): Promise<void> {
    const run = a.run;
    const current =
      run.steps.find((s) => s.status === "running" || s.status === "waiting_input") ??
      run.steps.find((s) => s.status === "pending");
    const now = new Date().toISOString();
    const reason = error instanceof StepAbort ? error.reason : undefined;
    if (reason === "close" || (error instanceof WorkflowError && error.code === "run_store_io")) {
      if (current) Object.assign(current, { status: "uncertain", endedAt: now });
      await this.markUncertain(
        a,
        reason === "close"
          ? "Service closed during the run; outcome is unknown"
          : "Run state could not be persisted; outcome is unknown"
      );
      return;
    }
    const status = reason === "stop" ? "stopped" : "failed";
    const message =
      reason === "stop"
        ? "Run stopped"
        : reason === "timeout"
          ? `Step timed out after ${run.definition.steps[run.steps.indexOf(current!)]?.timeoutMs}ms`
          : error instanceof WorkflowError
            ? error.message
            : "Step action failed";
    if (current) {
      Object.assign(current, { status, endedAt: now });
      if (status === "failed") {
        current.error = message;
        delete current.output;
      }
    }
    run.status = status;
    run.error = message;
    run.endedAt = now;
    try {
      await this.save(run);
    } catch {
      await this.markUncertain(a, `${message}; terminal execution state could not be persisted`);
      return;
    }
    if (!(await this.releaseFence(run))) {
      run.status = "uncertain";
      run.error = `${message}; releasing the plan attempt could not be confirmed`;
      await this.save(run).catch(() => undefined);
    }
  }

  private async releaseFence(run: WorkflowRun): Promise<boolean> {
    try {
      const plan = await this.store.get(run.ownerId, run.planId);
      if (!holdsFence(plan, run)) return false;
      return (
        (await this.store.release(run.ownerId, run.planId, run.id, run.attemptEpoch)).work ===
        "todo"
      );
    } catch {
      return false;
    }
  }

  private async markUncertain(a: Active, message: string): Promise<void> {
    const run = a.run;
    for (const step of run.steps)
      if (step.status === "running" || step.status === "waiting_input") step.status = "uncertain";
    run.status = "uncertain";
    run.error = message;
    run.endedAt = new Date().toISOString();
    await this.save(run).catch(() => undefined);
  }

  private async save(run: WorkflowRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await this.runs.write(run);
  }

  private async guard<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError("store_unavailable", "Workflow plan store request failed", 502);
    }
  }
}

// --- helpers -----------------------------------------------------------------------

function holdsFence(plan: StoredWorkflowPlan, run: WorkflowRun): boolean {
  return (
    plan.attemptId === run.id &&
    plan.attemptEpoch === run.attemptEpoch &&
    plan.revision === run.revision &&
    plan.work === "in_progress"
  );
}

function normalizeJson(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new WorkflowError("invalid_output", "Value is not JSON-serializable", 422);
  }
  if (text === undefined)
    throw new WorkflowError("invalid_output", "Value must not be undefined", 422);
  if (Buffer.byteLength(text) > MAX_VALUE_BYTES)
    throw new WorkflowError("output_too_large", "Value exceeds the size limit", 422);
  return JSON.parse(text);
}

function parsePath(path: string): string[] {
  const segments = path === "" ? [] : path.split(".");
  if (segments.some((segment) => segment === "" || UNSAFE_KEYS.has(segment)))
    throw new WorkflowError("invalid_definition", "Invalid path in definition", 400);
  return segments;
}

function getPath(value: unknown, path: string[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment) && Number(segment) < current.length)
      current = current[Number(segment)];
    else if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.hasOwn(current, segment)
    )
      current = (current as Record<string, unknown>)[segment];
    else return { found: false };
  }
  return { found: true, value: current };
}

function meetsSuccess(step: WorkflowStep, output: unknown): boolean {
  if (!step.success) return true;
  const found = getPath(output, parsePath(step.success.path));
  return found.found && deepEqual(found.value, step.success.equals);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    !a ||
    !b ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  );
}

/** Copies a JSON value, replacing `{ $step, path? }` bindings via `onRef` and refusing unsafe keys. */
function mapInputs(value: unknown, onRef: (ref: Ref) => unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH)
    throw new WorkflowError("invalid_definition", "Inputs are nested too deeply", 400);
  if (Array.isArray(value)) return value.map((item) => mapInputs(item, onRef, depth + 1));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "$step")) {
    const extra = Object.keys(record).filter((key) => key !== "$step" && key !== "path");
    if (
      typeof record.$step !== "string" ||
      extra.length ||
      (record.path !== undefined && typeof record.path !== "string")
    )
      throw new WorkflowError("invalid_definition", "Malformed step binding", 400);
    return onRef({
      step: record.$step,
      path: parsePath((record.path as string | undefined) ?? "")
    });
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (UNSAFE_KEYS.has(key))
      throw new WorkflowError("invalid_definition", "Inputs contain a forbidden key", 400);
    copy[key] = mapInputs(item, onRef, depth + 1);
  }
  return copy;
}
