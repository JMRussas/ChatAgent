import { createHash } from "node:crypto";
import { z } from "zod";
import { planApiBase } from "../integrations/hekate/devCoordination";
import {
  WorkflowError,
  workflowDefinitionSchema,
  type StoredWorkflowPlan,
  type WorkflowDefinition,
  type WorkflowPlanStore
} from "./types";

const uuid = z.string().uuid();
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nodeSchema = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  nodeType: z.string(),
  value: z.string().max(65536).nullable(),
  contentRevision: counter.min(1),
  stateRevision: counter,
  work: z.enum(["todo", "in_progress", "done", "cancelled"]),
  attemptId: z.string().nullable(),
  attemptEpoch: counter,
  artifactRef: z.string().nullable()
});
const graphSchema = z.object({
  contractVersion: z.literal("plan-contract/v1"),
  rootId: uuid,
  projectId: uuid,
  defaultGate: z.literal("completed"),
  nodes: z.array(nodeSchema).min(1).max(2),
  dependencies: z.array(z.unknown()).max(0)
});
const markerSchema = z
  .object({
    kind: z.literal("chatagent-workflow"),
    version: z.literal(1),
    ownerId: z.string().min(1)
  })
  .strict();

function stableId(...parts: string[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decode(value: string | null): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    throw new WorkflowError("WORKFLOW_INVALID_STORAGE", "The saved workflow is invalid.", 502);
  }
}

/** Managed Hekate nodes own plan definitions and attempt state; results are artifact references. */
export class HekateWorkflowStore implements WorkflowPlanStore {
  private readonly api: string;
  constructor(
    apiUrl: string,
    private readonly projectId: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.api = planApiBase(apiUrl);
    if (!uuid.safeParse(projectId).success)
      throw new WorkflowError("WORKFLOW_INVALID_PROJECT", "A valid workflow project is required.");
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(10000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await this.fetchImpl(`${this.api}/api/plan-contract/v1${path}`, {
        method,
        redirect: "error",
        signal: combined,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const reader = response.body?.getReader();
      if (!reader)
        throw new WorkflowError(
          "WORKFLOW_INVALID_STORAGE",
          "The workflow store returned an invalid response.",
          502
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (combined.aborted) throw combined.reason;
          if (done) break;
          size += value.byteLength;
          if (size > 1048576)
            throw new WorkflowError(
              "WORKFLOW_RESPONSE_TOO_LARGE",
              "The workflow response exceeds its limit.",
              502
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!response.ok) {
        const status =
          response.status === 404
            ? 404
            : response.status === 409 || response.status === 422
              ? 409
              : 502;
        throw new WorkflowError(
          status === 404
            ? "WORKFLOW_NOT_FOUND"
            : status === 409
              ? "WORKFLOW_CONFLICT"
              : "WORKFLOW_STORE_UNAVAILABLE",
          status === 404
            ? "Workflow not found."
            : status === 409
              ? "The workflow changed or this operation cannot proceed. Reload its current state."
              : "The workflow store could not complete the operation.",
          status
        );
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError(
        combined.aborted ? "WORKFLOW_ABORTED" : "WORKFLOW_STORE_UNAVAILABLE",
        combined.aborted
          ? "The workflow operation was interrupted or timed out."
          : "The workflow store could not complete the operation.",
        503
      );
    }
  }

  private parse(ownerId: string, id: string, raw: unknown, allowEmpty = false) {
    const result = graphSchema.safeParse(raw);
    if (!result.success)
      throw new WorkflowError("WORKFLOW_INVALID_STORAGE", "The saved workflow is invalid.", 502);
    const graph = result.data;
    const root = graph.nodes.find((node) => node.id === id);
    if (
      graph.rootId !== id ||
      graph.projectId !== this.projectId ||
      !root ||
      root.parentId !== null ||
      root.nodeType !== "plan"
    )
      throw new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow not found.", 404);
    let rootValue: unknown;
    try {
      rootValue = JSON.parse(root.value ?? "");
    } catch {
      throw new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow not found.", 404);
    }
    const marker = markerSchema.safeParse(rootValue);
    if (!marker.success || marker.data.ownerId !== ownerId)
      throw new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow not found.", 404);
    const task = graph.nodes.find((node) => node.id !== id);
    if (
      (!task && !allowEmpty) ||
      (task &&
        (task.id !== stableId("workflow-task", id) ||
          task.parentId !== id ||
          task.nodeType !== "task"))
    )
      throw new WorkflowError(
        "WORKFLOW_INVALID_STORAGE",
        "The saved workflow has an invalid task structure.",
        502
      );
    return { graph, root, task };
  }

  private stored(ownerId: string, id: string, raw: unknown): StoredWorkflowPlan {
    const { task } = this.parse(ownerId, id, raw);
    const node = task!;
    const definition = workflowDefinitionSchema.safeParse(decode(node.value));
    if (
      !definition.success ||
      ((node.work === "in_progress" || node.work === "done") &&
        (!node.attemptId || node.attemptEpoch < 1))
    )
      throw new WorkflowError(
        "WORKFLOW_INVALID_STORAGE",
        "The saved workflow definition or attempt is invalid.",
        502
      );
    return {
      id,
      ownerId,
      definition: definition.data,
      revision: node.contentRevision,
      stateRevision: node.stateRevision,
      taskId: node.id,
      work: node.work,
      attemptId: node.attemptId,
      attemptEpoch: node.attemptEpoch,
      artifactRef: node.artifactRef
    };
  }

  async get(ownerId: string, id: string, signal?: AbortSignal): Promise<StoredWorkflowPlan> {
    if (!uuid.safeParse(id).success)
      throw new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow not found.", 404);
    return this.stored(ownerId, id, await this.request(`/plans/${id}`, "GET", undefined, signal));
  }

  async list(ownerId: string, signal?: AbortSignal): Promise<StoredWorkflowPlan[]> {
    const plans: StoredWorkflowPlan[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ projectId: this.projectId, limit: "100" });
      if (after) query.set("afterRootId", after);
      const result = z
        .object({
          contractVersion: z.literal("plan-contract/v1"),
          plans: z.array(z.object({ rootId: uuid, projectId: uuid })).max(100),
          nextAfterRootId: uuid.nullable()
        })
        .safeParse(await this.request(`/plans?${query}`, "GET", undefined, signal));
      if (!result.success)
        throw new WorkflowError("WORKFLOW_INVALID_STORAGE", "The workflow list is invalid.", 502);
      for (const item of result.data.plans) {
        if (item.projectId !== this.projectId || seen.has(item.rootId))
          throw new WorkflowError(
            "WORKFLOW_INVALID_STORAGE",
            "The workflow list contains invalid scope or pagination.",
            502
          );
        seen.add(item.rootId);
        const raw = await this.request(`/plans/${item.rootId}`, "GET", undefined, signal);
        const root = z
          .object({ nodes: z.array(z.object({ id: uuid, value: z.string().nullable() })) })
          .safeParse(raw);
        if (!root.success)
          throw new WorkflowError("WORKFLOW_INVALID_STORAGE", "The workflow list is invalid.", 502);
        const value = root.data.nodes.find((node) => node.id === item.rootId)?.value;
        let marker: unknown;
        try {
          marker = JSON.parse(value ?? "");
        } catch {
          continue;
        }
        const parsed = markerSchema.safeParse(marker);
        if (parsed.success && parsed.data.ownerId === ownerId)
          plans.push(this.stored(ownerId, item.rootId, raw));
      }
      if (result.data.nextAfterRootId === null) return plans;
      if (after === result.data.nextAfterRootId || !seen.has(result.data.nextAfterRootId))
        throw new WorkflowError(
          "WORKFLOW_INVALID_STORAGE",
          "The workflow list pagination is invalid.",
          502
        );
      after = result.data.nextAfterRootId;
    }
    throw new WorkflowError(
      "WORKFLOW_LIST_LIMIT",
      "The project has too many plans to list in one operation.",
      409
    );
  }

  async create(
    ownerId: string,
    definition: WorkflowDefinition,
    operationId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan> {
    const validated = workflowDefinitionSchema.parse(definition);
    const value = JSON.stringify(validated);
    if (value.length > 65536)
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_TOO_LARGE",
        "The workflow definition exceeds its size limit."
      );
    const id = stableId("workflow-plan", this.projectId, ownerId, operationId);
    let raw: unknown;
    try {
      raw = await this.request(`/plans/${id}`, "GET", undefined, signal);
    } catch (error) {
      if (!(error instanceof WorkflowError) || error.code !== "WORKFLOW_NOT_FOUND") throw error;
      raw = await this.request(
        "/plans",
        "POST",
        {
          rootId: id,
          projectId: this.projectId,
          name: validated.name,
          value: JSON.stringify({ kind: "chatagent-workflow", version: 1, ownerId }),
          attributes: {},
          defaultGate: "completed",
          operationKey: `workflow-create-${id}`,
          expectedStateRevision: 0,
          actor: ownerId
        },
        signal
      );
    }
    const { root, task } = this.parse(ownerId, id, raw, true);
    if (task) {
      const existing = this.stored(ownerId, id, raw);
      if (JSON.stringify(existing.definition) !== value)
        throw new WorkflowError(
          "WORKFLOW_CONFLICT",
          "This operation already created a different workflow.",
          409
        );
      return existing;
    }
    await this.request(
      `/nodes/${id}/children`,
      "POST",
      {
        childId: stableId("workflow-task", id),
        nodeType: "task",
        name: validated.name,
        siblingOrder: 0,
        value,
        attributes: {},
        operationKey: `workflow-task-${id}`,
        expectedStateRevision: root.stateRevision,
        actor: ownerId
      },
      signal
    );
    const saved = await this.get(ownerId, id, signal);
    if (JSON.stringify(saved.definition) !== value)
      throw new WorkflowError(
        "WORKFLOW_CONFLICT",
        "The workflow changed during creation. Reload its current state.",
        409
      );
    return saved;
  }

  async update(
    ownerId: string,
    id: string,
    revision: number,
    definition: WorkflowDefinition,
    operationId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan> {
    const plan = await this.get(ownerId, id, signal);
    this.checkRevision(plan, revision);
    if (plan.work === "in_progress")
      throw new WorkflowError(
        "WORKFLOW_RUNNING",
        "Stop the running workflow before editing its definition.",
        409
      );
    const value = JSON.stringify(workflowDefinitionSchema.parse(definition));
    if (value.length > 65536)
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_TOO_LARGE",
        "The workflow definition exceeds its size limit."
      );
    await this.request(
      `/nodes/${plan.taskId}/content`,
      "PUT",
      {
        value,
        attributes: {},
        expectedContentRevision: revision,
        expectedStateRevision: plan.stateRevision,
        operationKey: `workflow-update-${stableId(ownerId, operationId)}`,
        actor: ownerId
      },
      signal
    );
    const saved = await this.get(ownerId, id, signal);
    if (saved.revision !== revision + 1 || JSON.stringify(saved.definition) !== value)
      throw new WorkflowError(
        "WORKFLOW_CONFLICT",
        "The workflow changed during the update. Reload its current state.",
        409
      );
    return saved;
  }

  private checkRevision(plan: StoredWorkflowPlan, revision: number) {
    if (plan.revision !== revision)
      throw new WorkflowError(
        "WORKFLOW_CONFLICT",
        "The workflow definition changed. Reload before continuing.",
        409
      );
  }

  async start(
    ownerId: string,
    id: string,
    revision: number,
    runId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan> {
    const plan = await this.get(ownerId, id, signal);
    this.checkRevision(plan, revision);
    if (plan.work === "in_progress" && plan.attemptId === runId) return plan;
    if (plan.work !== "todo" && plan.work !== "done")
      throw new WorkflowError(
        "WORKFLOW_CONFLICT",
        "The workflow is already running or has been cancelled.",
        409
      );
    await this.request(
      `/nodes/${plan.taskId}/transition`,
      "POST",
      {
        to: "in_progress",
        attemptId: runId,
        executorRef: "chatagent:workflow",
        expectedStateRevision: plan.stateRevision,
        operationKey: `workflow-start-${runId}`,
        actor: ownerId
      },
      signal
    );
    const saved = await this.get(ownerId, id, signal);
    if (
      saved.work !== "in_progress" ||
      saved.attemptId !== runId ||
      saved.attemptEpoch !== plan.attemptEpoch + 1
    )
      throw new WorkflowError(
        "WORKFLOW_STALE_RUN",
        "The execution changed while it was being started.",
        409
      );
    return saved;
  }

  private async end(
    ownerId: string,
    id: string,
    runId: string,
    epoch: number,
    to: "done" | "todo",
    artifactRef: string | undefined,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan> {
    const plan = await this.get(ownerId, id, signal);
    if (
      to === "done" &&
      plan.work === to &&
      plan.attemptEpoch === epoch &&
      plan.attemptId === runId &&
      plan.artifactRef === artifactRef
    )
      return plan;
    if (plan.work !== "in_progress" || plan.attemptId !== runId || plan.attemptEpoch !== epoch)
      throw new WorkflowError(
        "WORKFLOW_STALE_RUN",
        "This execution is no longer the workflow's current attempt.",
        409
      );
    await this.request(
      `/nodes/${plan.taskId}/transition`,
      "POST",
      {
        to,
        attemptId: runId,
        attemptEpoch: epoch,
        ...(artifactRef === undefined ? {} : { artifactRef }),
        expectedStateRevision: plan.stateRevision,
        operationKey: `workflow-${to}-${runId}-${epoch}`,
        actor: ownerId
      },
      signal
    );
    const saved = await this.get(ownerId, id, signal);
    if (
      saved.work !== to ||
      saved.attemptEpoch !== epoch ||
      (to === "done" && (saved.attemptId !== runId || saved.artifactRef !== artifactRef))
    )
      throw new WorkflowError(
        "WORKFLOW_STALE_RUN",
        "The execution changed while its result was being saved.",
        409
      );
    return saved;
  }

  finish(
    ownerId: string,
    id: string,
    runId: string,
    epoch: number,
    artifactRef: string,
    signal?: AbortSignal
  ) {
    return this.end(ownerId, id, runId, epoch, "done", artifactRef, signal);
  }

  release(ownerId: string, id: string, runId: string, epoch: number, signal?: AbortSignal) {
    return this.end(ownerId, id, runId, epoch, "todo", undefined, signal);
  }
}
