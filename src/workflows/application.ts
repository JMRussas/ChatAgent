import { z } from "zod";
import type { CapabilityTool } from "../app/capabilityChat";
import type { UserMessage } from "../domain/types";
import { WorkflowService } from "./service";
import { HekateWorkflowStore } from "./hekateStore";
import {
  WorkflowError,
  workflowDefinitionSchema,
  type WorkflowAction,
  type WorkflowContext,
  type WorkflowToolService
} from "./types";

const querySchema = z.object({ query: z.record(z.string().max(2000)).default({}) }).strict();
const planResultSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().min(0),
  definition: workflowDefinitionSchema,
  work: z.enum(["todo", "in_progress", "done", "cancelled"])
});
const runResultSchema = z.object({
  id: z.string().uuid(),
  definition: workflowDefinitionSchema,
  status: z.enum(["running", "waiting_input", "completed", "failed", "stopped", "uncertain"])
});
/** Summaries describe returned state; malformed outcomes retain the generic display. */
export function formatWorkflowResult(tool: string, result: unknown): string | undefined {
  if (["create_plan", "update_plan", "get_plan"].includes(tool)) {
    const parsed = planResultSchema.safeParse(result);
    if (!parsed.success) return undefined;
    const plan = parsed.data;
    const heading = tool === "get_plan" ? "Plan" : "Saved plan";
    return (
      `${heading} “${plan.definition.name}” (${plan.definition.steps.length} step${plan.definition.steps.length === 1 ? "" : "s"}).\n\n` +
      plan.definition.steps.map((step, index) => `${index + 1}. ${step.name}`).join("\n")
    );
  }
  if (["run_plan", "stop_run", "submit_step_result", "get_run"].includes(tool)) {
    const parsed = runResultSchema.safeParse(result);
    if (!parsed.success) return undefined;
    const status = {
      running: "running",
      waiting_input: "waiting for input",
      completed: "completed",
      failed: "failed",
      stopped: "stopped",
      uncertain: "outcome uncertain"
    }[parsed.data.status];
    return `Workflow “${parsed.data.definition.name}”: ${status}.`;
  }
  return undefined;
}
const endpointSchema = z.record(z.string().url()).superRefine((endpoints, context) => {
  for (const [name, address] of Object.entries(endpoints)) {
    const url = new URL(address);
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      context.addIssue({
        code: "custom",
        path: [name],
        message: "An action needs a valid name and HTTP(S) endpoint without embedded credentials."
      });
  }
});

/** Configured API actions are shared by direct tool calls and workflow steps. */
export function workflowHttpActions(
  raw: string | undefined,
  transport: typeof fetch = fetch
): WorkflowAction[] {
  const endpoints = endpointSchema.parse(raw === undefined ? {} : JSON.parse(raw));
  return Object.entries(endpoints).map(([name, address]) => ({
    name,
    readOnly: true,
    description: `Read the configured ${name} API endpoint. Optional query parameters are string values.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "object", additionalProperties: { type: "string", maxLength: 2000 } }
      },
      additionalProperties: false
    },
    async execute(input: unknown, context: WorkflowContext) {
      const { query } = querySchema.parse(input);
      const url = new URL(address);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const signal = context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000);
      try {
        const response = await transport(url, {
          signal,
          redirect: "error",
          headers: { accept: "application/json, text/plain" }
        });
        if (!response.ok)
          throw new WorkflowError(
            "API_REQUEST_FAILED",
            `The ${name} API returned HTTP ${response.status}.`,
            502
          );
        const reader = response.body?.getReader();
        if (!reader)
          throw new WorkflowError(
            "API_RESPONSE_INVALID",
            "The API returned no readable response.",
            502
          );
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 128 * 1024)
              throw new WorkflowError(
                "API_RESPONSE_TOO_LARGE",
                "The API response exceeds the workflow input limit.",
                413
              );
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const data: unknown = response.headers.get("content-type")?.includes("json")
          ? JSON.parse(text)
          : text;
        return { status: response.status, data };
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError(
          "API_UNAVAILABLE",
          `The ${name} API request failed or was interrupted.`,
          503
        );
      }
    }
  }));
}

/** One registry is used by HTTP, MCP, chat and the sequential runner. */
export class WorkflowApplication implements WorkflowToolService {
  readonly tools;
  private readonly actions: Map<string, WorkflowAction>;
  constructor(
    private readonly service: WorkflowService,
    actions: WorkflowAction[]
  ) {
    this.actions = new Map(actions.map((action) => [action.name, action]));
    if (
      this.actions.size !== actions.length ||
      actions.some((action) => service.tools.some((tool) => tool.name === action.name))
    )
      throw new WorkflowError(
        "DUPLICATE_ACTION",
        "Workflow action names must be unique and distinct from management tools."
      );
    this.tools = [
      ...service.tools,
      ...actions.map((action) => ({ ...action, readOnly: action.readOnly ?? false }))
    ].map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description,
      inputSchema,
      readOnly
    }));
  }
  async call(name: string, input: unknown, context: WorkflowContext): Promise<unknown> {
    if (!context.principal.roles.has("operator"))
      throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
    const action = this.actions.get(name);
    return action ? action.execute(input, context) : this.service.call(name, input, context);
  }
  capabilities(message?: UserMessage): CapabilityTool[] {
    if (!message?.applicationContext?.principal.roles.has("operator")) return [];
    return this.tools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      effect: tool.readOnly ? "read" : "write",
      formatResult: (result) => formatWorkflowResult(tool.name, result),
      validate: (input: unknown) => input,
      execute: (input, _user, requestId, signal, conversationId, authority) => {
        const principal = authority?.principal;
        if (!principal)
          throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
        return this.call(tool.name, input, {
          principal,
          operationId: requestId,
          signal,
          conversationId
        });
      }
    }));
  }
  close() {
    return this.service.close();
  }
}

export function createWorkflowApplication(options: {
  apiUrl: string;
  projectId: string;
  runDir: string;
  endpoints?: string;
  model?: (prompt: string, inputs: unknown, context: WorkflowContext) => Promise<unknown>;
}) {
  const actions = workflowHttpActions(options.endpoints);
  return new WorkflowApplication(
    new WorkflowService(
      new HekateWorkflowStore(options.apiUrl, options.projectId),
      options.runDir,
      { actions, model: options.model }
    ),
    actions
  );
}
