import { z } from "zod";
import type { Principal } from "../auth/authenticator";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const workflowStepSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(200),
    inputs: z.record(z.unknown()).default({}),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("tool"), tool: identifier }).strict(),
      z.object({ type: z.literal("model"), prompt: z.string().min(1).max(16000) }).strict(),
      z.object({ type: z.literal("human"), instructions: z.string().min(1).max(4000) }).strict()
    ]),
    timeoutMs: z.number().int().min(100).max(300000).default(120000),
    success: z
      .object({ path: z.string().max(200), equals: z.unknown() })
      .strict()
      .optional()
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    steps: z.array(workflowStepSchema).min(1).max(50)
  })
  .strict()
  .superRefine((definition, context) => {
    if (new Set(definition.steps.map((step) => step.id)).size !== definition.steps.length)
      context.addIssue({ code: "custom", message: "Step IDs must be unique", path: ["steps"] });
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export interface WorkflowContext {
  principal: Principal;
  operationId: string;
  signal?: AbortSignal;
  conversationId?: string;
}

export interface StoredWorkflowPlan {
  id: string;
  ownerId: string;
  definition: WorkflowDefinition;
  revision: number;
  stateRevision: number;
  taskId: string;
  work: "todo" | "in_progress" | "done" | "cancelled";
  attemptId: string | null;
  attemptEpoch: number;
  artifactRef: string | null;
}

export interface WorkflowPlanStore {
  list(ownerId: string, signal?: AbortSignal): Promise<StoredWorkflowPlan[]>;
  get(ownerId: string, id: string, signal?: AbortSignal): Promise<StoredWorkflowPlan>;
  create(
    ownerId: string,
    definition: WorkflowDefinition,
    operationId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan>;
  update(
    ownerId: string,
    id: string,
    revision: number,
    definition: WorkflowDefinition,
    operationId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan>;
  start(
    ownerId: string,
    id: string,
    revision: number,
    runId: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan>;
  finish(
    ownerId: string,
    id: string,
    runId: string,
    epoch: number,
    artifactRef: string,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan>;
  release(
    ownerId: string,
    id: string,
    runId: string,
    epoch: number,
    signal?: AbortSignal
  ): Promise<StoredWorkflowPlan>;
}

export type WorkflowRunStatus =
  "running" | "waiting_input" | "completed" | "failed" | "stopped" | "uncertain";
export interface WorkflowStepResult {
  id: string;
  name: string;
  status:
    "pending" | "running" | "waiting_input" | "completed" | "failed" | "stopped" | "uncertain";
  inputs?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}
export interface WorkflowRun {
  version: 1;
  id: string;
  planId: string;
  ownerId: string;
  definition: WorkflowDefinition;
  revision: number;
  attemptEpoch: number;
  status: WorkflowRunStatus;
  steps: WorkflowStepResult[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  conversationId?: string;
}

export interface WorkflowAction {
  name: string;
  description: string;
  /** Omitted actions are treated as writes when exposed to models. */
  readOnly?: boolean;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, context: WorkflowContext): Promise<unknown>;
}
export interface WorkflowTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}
export interface WorkflowToolService {
  readonly tools: readonly WorkflowTool[];
  call(name: string, input: unknown, context: WorkflowContext): Promise<unknown>;
  close?(): Promise<void>;
}
export class WorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}
