import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { makePrivate } from "../auth/filePrivacy";
import { processTreeTerminator, type ProcessTreeTerminator } from "../providers/cli/runner";
import { WorkflowError } from "../workflows/types";
import { openTaskMcpGateway } from "./mcpGateway";
import { taskPrompt } from "./taskTools";
import {
  type TaskExecutionResult,
  type TaskExecutor,
  type TaskHost,
  type TaskPackage
} from "./types";

export interface ClaudeTaskOptions {
  executable: string;
  workDir: string;
  model: string;
  budgetUsd: number;
  executableArgs?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminator?: ProcessTreeTerminator;
}
const checkpointSchema = z
  .object({ sessionId: z.string().uuid(), turns: z.number().int().min(1).max(30) })
  .strict();
const fail = (code: string, message: string) => new WorkflowError(code, message, 502);

/** Native Claude conversation, scoped MCP tools and owned processes; no JSON action planner. */
export class ClaudeTaskExecutor implements TaskExecutor {
  readonly id = "claude";
  private readonly options: ClaudeTaskOptions;
  constructor(options: ClaudeTaskOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.workDir) ||
      !options.model.trim() ||
      !Number.isFinite(options.budgetUsd) ||
      options.budgetUsd <= 0 ||
      !Number.isSafeInteger(options.timeoutMs ?? 300000) ||
      (options.timeoutMs ?? 300000) <= 0 ||
      !Number.isSafeInteger(options.maxOutputBytes ?? 1048576) ||
      (options.maxOutputBytes ?? 1048576) <= 0
    )
      throw new WorkflowError(
        "invalid_claude_task_config",
        "Claude task execution requires explicit executable, workspace, model and budget."
      );
    this.options = { ...options, executableArgs: [...(options.executableArgs ?? [])] };
  }
  async execute(
    task: TaskPackage,
    host: TaskHost,
    checkpoint?: unknown
  ): Promise<TaskExecutionResult> {
    host.signal.throwIfAborted();
    const previous = checkpoint === undefined ? undefined : checkpointSchema.parse(checkpoint);
    const remaining = task.limits.maxTurns - (previous?.turns ?? 0);
    if (remaining <= 0)
      throw fail("task_turn_limit", "This task has exhausted its model turn allowance.");
    z.string().uuid().parse(host.runId);
    z.string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .parse(host.stepId);
    await mkdir(this.options.workDir, { recursive: true });
    const root = await realpath(this.options.workDir);
    const executable = await realpath(this.options.executable);
    if (!(await stat(executable)).isFile())
      throw fail("task_executable_invalid", "Claude executable is unavailable.");
    const cwd = join(root, host.runId, host.stepId);
    await mkdir(cwd, { recursive: true });
    const resolvedCwd = await realpath(cwd);
    const within = relative(root, resolvedCwd);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      throw fail("task_workspace_invalid", "The task workspace is outside its configured root.");
    try {
      await makePrivate(resolvedCwd, "directory");
    } catch {
      throw fail(
        "task_workspace_not_private",
        "Claude's task workspace could not be made private. Configure a directory whose permissions this operator can manage."
      );
    }
    const gateway = await openTaskMcpGateway(host);
    const config = join(resolvedCwd, `.task-mcp-${randomUUID()}.json`);
    try {
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: {
            task: {
              type: "http",
              url: gateway.url,
              headers: { Authorization: `Bearer ${gateway.token}` }
            }
          }
        }),
        { flag: "wx", mode: 0o600 }
      );
      host.signal.throwIfAborted();
      const args = [
        ...this.options.executableArgs!,
        "--print",
        "--model",
        this.options.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--tools",
        "",
        "--allowedTools",
        "mcp__task__*",
        "--mcp-config",
        config,
        "--max-turns",
        String(remaining),
        "--max-budget-usd",
        String(this.options.budgetUsd),
        ...(previous ? ["--resume", previous.sessionId] : [])
      ];
      return await this.run(args, resolvedCwd, taskPrompt(task), host, remaining, previous);
    } finally {
      try {
        await gateway.close();
      } finally {
        await unlink(config).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
  private async run(
    args: string[],
    cwd: string,
    prompt: string,
    host: TaskHost,
    remaining: number,
    previous?: z.infer<typeof checkpointSchema>
  ): Promise<TaskExecutionResult> {
    const child = spawn(this.options.executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const terminator = this.options.terminator ?? processTreeTerminator;
    let failure: Error | undefined;
    let cleanupFailure = false;
    let cleanup: Promise<void> | undefined;
    let closed = false;
    let bytes = 0;
    let buffer = "";
    let sessionId: string | undefined = previous?.sessionId;
    let result: { text: string; turns: number } | undefined;
    let events = Promise.resolve();
    const assistants = new Set<string>();
    const texts = new Set<string>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const kill = () =>
      (cleanup ??= terminator.terminate(child).catch(() => {
        cleanupFailure = true;
        child.kill("SIGKILL");
      }));
    const stop = (error: Error) => {
      failure ??= error;
      void kill();
    };
    const abort = () =>
      stop(
        host.signal.reason instanceof WorkflowError &&
          host.signal.reason.code === "task_outcome_uncertain"
          ? host.signal.reason
          : fail("task_cancelled", "Claude task execution was cancelled.")
      );
    const emit = (text: string) => {
      if (!text || texts.has(text)) return;
      texts.add(text);
      events = events
        .then(async () => {
          if (!failure) await host.emit({ type: "message", message: text.slice(0, 4000) });
        })
        .catch((error) =>
          stop(
            error instanceof WorkflowError && error.code === "task_outcome_uncertain"
              ? error
              : fail("task_event_failed", "Claude task progress could not be recorded.")
          )
        );
    };
    const parse = (line: string) => {
      if (!line.trim() || failure) return;
      try {
        const event: unknown = JSON.parse(line);
        if (
          !event ||
          typeof event !== "object" ||
          !("type" in event) ||
          typeof event.type !== "string"
        )
          throw Error();
        const value = event as Record<string, any>;
        if (value.session_id !== undefined) {
          const id = z.string().uuid().parse(value.session_id);
          if (sessionId && sessionId !== id) throw Error();
          sessionId = id;
        }
        if (value.type === "assistant") {
          if (
            result ||
            typeof value.message?.id !== "string" ||
            !Array.isArray(value.message.content)
          )
            throw Error();
          assistants.add(value.message.id);
          if (assistants.size > remaining) {
            stop(fail("task_turn_limit", "Claude exceeded this task's turn allowance."));
            return;
          }
          for (const part of value.message.content)
            if (part?.type === "text") {
              if (typeof part.text !== "string") throw Error();
              emit(part.text);
            }
        } else if (value.type === "result") {
          if (result || value.is_error !== false || typeof value.result !== "string" || !sessionId)
            throw Error();
          const reported =
            value.num_turns === undefined
              ? assistants.size
              : z.number().int().min(1).parse(value.num_turns);
          const turns = Math.max(reported, assistants.size);
          if (turns < 1 || turns > remaining) {
            stop(fail("task_turn_limit", "Claude exceeded this task's turn allowance."));
            return;
          }
          result = { text: value.result, turns };
          emit(value.result);
        }
      } catch {
        stop(fail("task_protocol_invalid", "Claude did not return a valid task result."));
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (this.options.maxOutputBytes ?? 1048576)) {
        stop(fail("task_output_limit", "Claude task output exceeded its limit."));
        return;
      }
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0 && !failure) {
          parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      } catch {
        stop(fail("task_protocol_invalid", "Claude returned invalid task output."));
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (this.options.maxOutputBytes ?? 1048576))
        stop(fail("task_output_limit", "Claude task output exceeded its limit."));
    });
    child.stdin!.on("error", () => undefined);
    child.on("error", () => {
      failure ??= fail("task_start_failed", "Claude task execution could not start.");
    });
    const done = new Promise<void>((resolve) =>
      child.once("close", (code) => {
        try {
          buffer += decoder.decode();
          parse(buffer);
        } catch {
          failure ??= fail("task_protocol_invalid", "Claude returned invalid task output.");
        }
        if (code !== 0)
          failure ??= fail("task_nonzero_exit", "Claude task execution exited unsuccessfully.");
        closed = true;
        resolve();
      })
    );
    const timeout = setTimeout(
      () => stop(fail("task_timeout", "Claude task execution reached its time limit.")),
      this.options.timeoutMs ?? 300000
    );
    host.signal.addEventListener("abort", abort, { once: true });
    if (host.signal.aborted) abort();
    else child.stdin!.end(prompt);
    try {
      await done;
      await events;
      await kill();
      if (cleanupFailure)
        throw fail(
          "task_cleanup_uncertain",
          "Owned Claude processes could not be confirmed stopped."
        );
      if (failure) throw failure;
      if (!result || !result.text.trim() || !sessionId)
        throw fail("task_protocol_invalid", "Claude returned no complete task result.");
      return {
        text: result.text,
        checkpoint: { sessionId, turns: (previous?.turns ?? 0) + result.turns }
      };
    } finally {
      clearTimeout(timeout);
      host.signal.removeEventListener("abort", abort);
      if (!closed) await kill();
      await done;
      await cleanup;
    }
  }
}
