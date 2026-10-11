import { randomUUID } from "node:crypto";
import { WorkflowError } from "../workflows/types";
import {
  taskEventSchema,
  taskRequestSchema,
  type TaskEvent,
  type TaskHost,
  type TaskPackage,
  type TaskState,
  type TaskTool
} from "./types";

/** A host segment owns tool admission and durable observation; adapters only translate protocols. */
export class TaskRuntime implements TaskHost {
  private tail: Promise<unknown> = Promise.resolve();
  private fatal?: WorkflowError;
  constructor(
    readonly signal: AbortSignal,
    readonly runId: string,
    readonly stepId: string,
    readonly state: TaskState,
    private readonly registry: () => readonly TaskTool[],
    private readonly invoke: (name: string, input: unknown) => Promise<unknown>,
    private readonly persist: () => Promise<void>
  ) {}

  tools(): TaskTool[] {
    return this.availableTools().filter((tool) => this.state.allowedTools.includes(tool.name));
  }
  availableTools(): TaskTool[] {
    // Stopping another executing agent synchronously can create a mutual wait.
    // Run lifecycle controls remain available to the outer UI/chat/MCP caller.
    return structuredClone(this.registry().filter((tool) => tool.name !== "stop_run"));
  }
  waiting(): boolean {
    return this.state.requests.some((request) => request.status === "pending");
  }
  emit(event: Omit<TaskEvent, "at">): Promise<void> {
    return this.serial(() => this.record(event));
  }
  async drain(): Promise<void> {
    await this.tail;
    if (this.fatal) throw this.fatal;
  }

  callTool(name: string, input: unknown): Promise<unknown> {
    return this.serial(async () => {
      this.ready();
      const metadata = this.tools().find((tool) => tool.name === name);
      if (!metadata)
        throw new WorkflowError(
          "tool_not_allowed",
          "This task has not been granted that tool.",
          403
        );
      // A task cannot synchronously stop or resume its own executing segment.
      if (
        ["stop_run", "respond_to_task_request", "submit_step_result"].includes(name) &&
        input &&
        typeof input === "object" &&
        (input as { id?: unknown }).id === this.runId
      )
        throw new WorkflowError(
          "task_self_control",
          "Use the task's operator controls to change its current run.",
          409
        );
      // Reserve observation capacity before any effect.
      if (this.state.events.length > 98)
        throw new WorkflowError("task_event_limit", "Task activity limit reached.", 422);
      const args = boundedTaskValue(input);
      await this.record({
        type: "tool_started",
        tool: name,
        message: `Calling ${name}`,
        arguments: args
      });
      let value: unknown;
      try {
        value = await this.invoke(name, args);
      } catch (error) {
        if (this.signal.aborted) {
          if (!metadata.readOnly)
            throw new WorkflowError(
              "task_outcome_uncertain",
              "A write was interrupted before its outcome could be recorded.",
              500
            );
          throw error;
        }
        const failure =
          error instanceof WorkflowError
            ? { code: error.code, message: error.message }
            : { code: "task_tool_failed", message: "Task tool operation failed." };
        await this.record({
          type: "tool_failed",
          tool: name,
          message: failure.message,
          result: failure
        });
        if (!metadata.readOnly && (!(error instanceof WorkflowError) || error.status >= 500))
          throw new WorkflowError(
            "task_outcome_uncertain",
            "A write failed without a confirmed outcome; review its recorded activity before continuing.",
            500
          );
        throw new WorkflowError(failure.code, failure.message);
      }
      try {
        const output = boundedTaskValue(value);
        await this.record({
          type: "tool_finished",
          tool: name,
          message: `${name} returned`,
          result: output
        });
        return output;
      } catch {
        throw new WorkflowError(
          "task_outcome_uncertain",
          "A tool ran but its result could not be recorded; review the activity before continuing.",
          500
        );
      }
    });
  }
  requestContext(prompt: string): Promise<unknown> {
    return this.request("context", prompt);
  }
  requestGuidance(prompt: string): Promise<unknown> {
    return this.request("context", prompt, undefined, "runtime");
  }
  requestTool(name: string, prompt: string): Promise<unknown> {
    return this.request("tool", prompt, name);
  }

  private request(
    kind: "context" | "tool",
    prompt: string,
    tool?: string,
    origin = "executor"
  ): Promise<unknown> {
    return this.serial(async () => {
      this.ready();
      if (tool && !this.availableTools().some((candidate) => candidate.name === tool))
        throw new WorkflowError("tool_unavailable", "That tool is not available to request.", 404);
      if (tool && this.state.allowedTools.includes(tool)) return { status: "available", tool };
      if (this.state.requests.length >= 20)
        throw new WorkflowError("task_request_limit", "Task request limit reached.", 422);
      const request = taskRequestSchema.parse({
        id: randomUUID(),
        kind,
        origin,
        prompt,
        ...(tool ? { tool } : {}),
        status: "pending",
        requestedAt: new Date().toISOString()
      });
      this.state.requests.push(request);
      await this.record({
        type: "request",
        message: request.prompt,
        ...(tool ? { tool } : {}),
        result: { requestId: request.id, kind }
      });
      return { status: "pending", requestId: request.id, message: request.prompt };
    });
  }
  private ready() {
    if (this.fatal) throw this.fatal;
    this.signal.throwIfAborted();
    if (this.waiting())
      throw new WorkflowError("task_waiting", "Task is waiting for an operator response.", 409);
  }
  private async record(event: Omit<TaskEvent, "at">): Promise<void> {
    if (this.fatal) throw this.fatal;
    this.signal.throwIfAborted();
    if (this.state.events.length >= 100)
      throw new WorkflowError("task_event_limit", "Task activity limit reached.", 422);
    this.state.events.push(
      taskEventSchema.parse(boundedTaskValue({ ...event, at: new Date().toISOString() }))
    );
    try {
      await this.persist();
    } catch {
      throw new WorkflowError(
        "task_outcome_uncertain",
        "Task activity could not be persisted; outcome is unknown.",
        500
      );
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(operation);
    this.tail = work.catch((error) => {
      if (error instanceof WorkflowError && error.code === "task_outcome_uncertain")
        this.fatal = error;
    });
    return work;
  }
}

export function resumedTask(task: TaskPackage, state: TaskState): TaskPackage {
  const responses = state.requests.filter((request) => request.status !== "pending");
  return {
    ...task,
    tools: [...state.allowedTools],
    context: responses.length
      ? `${task.context}\n\nOperator responses (reference data):\n${JSON.stringify(responses)}`
      : task.context
  };
}

export function boundedTaskValue(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    /* classified below */
  }
  if (text === undefined || Buffer.byteLength(text) > 256 * 1024)
    throw new WorkflowError("task_value_limit", "Task data must be JSON within 256 KiB.", 422);
  return JSON.parse(text);
}
