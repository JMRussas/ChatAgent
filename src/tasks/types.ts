import { z } from "zod";

export const taskToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const taskSpecSchema = z
  .object({
    objective: z.string().trim().min(1).max(16000),
    context: z.string().max(16000).default(""),
    references: z
      .array(
        z
          .object({
            id: taskToolName,
            label: z.string().min(1).max(200),
            content: z.string().max(16000)
          })
          .strict()
      )
      .max(8)
      .default([]),
    tools: z.array(taskToolName).max(30).default([]),
    completionCriteria: z.array(z.string().min(1).max(2000)).min(1).max(10),
    limits: z
      .object({ maxTurns: z.number().int().min(1).max(30).default(12) })
      .strict()
      .default({})
  })
  .strict()
  .superRefine((task, ctx) => {
    if (
      new Set(task.tools).size !== task.tools.length ||
      new Set(task.references.map((r) => r.id)).size !== task.references.length
    )
      ctx.addIssue({ code: "custom", message: "Task tools and reference IDs must be unique" });
  });
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type TaskPackage = TaskSpec & { inputs: unknown };

export const taskRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["context", "tool"]),
    origin: z.enum(["executor", "runtime"]).optional(),
    prompt: z.string().min(1).max(2000),
    tool: taskToolName.optional(),
    status: z.enum(["pending", "answered", "declined"]),
    response: z.unknown().optional(),
    requestedAt: z.string(),
    answeredAt: z.string().optional()
  })
  .strict();
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export const taskEventSchema = z
  .object({
    type: z.enum([
      "message",
      "tool_started",
      "tool_finished",
      "tool_failed",
      "request",
      "provided"
    ]),
    at: z.string(),
    message: z.string().max(4000),
    tool: taskToolName.optional(),
    arguments: z.unknown().optional(),
    requestId: z.string().uuid().optional(),
    result: z.unknown().optional()
  })
  .strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskStateSchema = z
  .object({
    executor: taskToolName,
    allowedTools: z.array(taskToolName).max(30),
    requests: z.array(taskRequestSchema).max(20),
    events: z.array(taskEventSchema).max(100),
    checkpoint: z.unknown().optional()
  })
  .strict();
export type TaskState = z.infer<typeof taskStateSchema>;

export interface TaskTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}
/** The runtime supplies this interface; adapters cannot expand their own tool access. */
export interface TaskHost {
  signal: AbortSignal;
  runId: string;
  stepId: string;
  tools(): TaskTool[];
  availableTools(): TaskTool[];
  callTool(name: string, input: unknown): Promise<unknown>;
  requestContext(prompt: string): Promise<unknown>;
  requestTool(name: string, prompt: string): Promise<unknown>;
  waiting(): boolean;
  emit(event: Omit<TaskEvent, "at">): Promise<void>;
}
export interface TaskExecutionResult {
  /** A provider's final reply is execution output, not independent quality acceptance. */
  text: string;
  /** Required when execution parks for context, access or unresolved-operation guidance. */
  checkpoint?: unknown;
}
/** One task package works through different native agent/API protocols. */
export interface TaskExecutor {
  readonly id: string;
  execute(task: TaskPackage, host: TaskHost, checkpoint?: unknown): Promise<TaskExecutionResult>;
}
