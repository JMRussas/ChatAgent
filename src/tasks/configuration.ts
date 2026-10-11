import { join, resolve } from "node:path";
import { WorkflowError } from "../workflows/types";
import { ClaudeTaskExecutor } from "./claudeExecutor";
import { OllamaTaskExecutor } from "./ollamaExecutor";
import type { TaskExecutor } from "./types";

/** Native agent execution is explicitly configured, independently of answer-only chat providers. */
export function configuredTaskExecutors(env: NodeJS.ProcessEnv, runDir: string): TaskExecutor[] {
  const executors: TaskExecutor[] = [];
  if (env.TASK_CLAUDE_EXECUTABLE) {
    if (!env.TASK_CLAUDE_BUDGET_USD?.trim())
      throw new WorkflowError(
        "task_budget_required",
        "TASK_CLAUDE_EXECUTABLE requires an explicit TASK_CLAUDE_BUDGET_USD."
      );
    executors.push(
      new ClaudeTaskExecutor({
        executable: env.TASK_CLAUDE_EXECUTABLE,
        workDir: resolve(env.TASK_CLAUDE_WORK_DIR ?? join(runDir, "agent-work")),
        model: env.TASK_CLAUDE_MODEL ?? "sonnet",
        budgetUsd: Number(env.TASK_CLAUDE_BUDGET_USD)
      })
    );
  }
  if (env.TASK_OLLAMA_MODEL)
    executors.push(
      new OllamaTaskExecutor({
        baseUrl: env.TASK_OLLAMA_BASE_URL ?? env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
        model: env.TASK_OLLAMA_MODEL
      })
    );
  return executors;
}
