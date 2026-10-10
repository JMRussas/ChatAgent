import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { SafeCapabilityError, type CapabilityTool } from "../app/capabilityChat";
import type { UserMessage } from "../domain/types";
import { formatWorkflowResult } from "../workflows/application";
import { WorkflowError, type WorkflowContext, type WorkflowToolService } from "../workflows/types";
import { WorkspaceCatalog, type LegacyWorkspaceProject, type WorkspaceProject } from "./catalog";

const PROJECT_OPERATIONS = new Set([
  "list_plans",
  "get_plan",
  "create_plan",
  "update_plan",
  "run_plan",
  "get_run",
  "stop_run",
  "submit_step_result",
  "respond_to_task_request"
]);

/** Project selection changes storage, while each service retains its shared action registry. */
export class ProjectWorkflowRouter implements WorkflowToolService {
  readonly tools;
  private readonly services = new Map<string, WorkflowToolService>();
  private closed = false;
  constructor(
    private readonly options: {
      catalog: WorkspaceCatalog;
      legacy: WorkflowToolService;
      legacyProject?: LegacyWorkspaceProject;
      runDir: string;
      factory: (project: WorkspaceProject, runDir: string) => WorkflowToolService;
    }
  ) {
    this.tools = options.legacy.tools.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties as Record<string, unknown> | undefined),
          projectId: {
            type: "string",
            format: "uuid",
            description: "Workspace project to use; omit for the legacy default project."
          }
        }
      }
    }));
  }

  legacyProject(owner: string): WorkspaceProject | undefined {
    return this.options.legacyProject
      ? this.options.catalog.getOrCreateLegacyProject(owner, this.options.legacyProject)
      : undefined;
  }

  async call(name: string, input: unknown, context: WorkflowContext): Promise<unknown> {
    if (this.closed) throw new WorkflowError("service_closed", "Workflow service is closed.", 503);
    if (!context.principal.roles.has("operator"))
      throw new WorkflowError("forbidden", "Operator role required.", 403);
    if (
      input !== undefined &&
      (input === null || typeof input !== "object" || Array.isArray(input))
    )
      throw new WorkflowError("invalid_input", "Workflow input must be an object.");
    const { projectId, ...args } = (input ?? {}) as Record<string, unknown>;
    if (projectId === undefined) {
      if (!this.options.legacyProject && PROJECT_OPERATIONS.has(name))
        throw new WorkflowError(
          "DEFAULT_PROJECT_REQUIRED",
          "Select a registered workspace project before managing plans or runs. No default Hekate project is configured.",
          409
        );
      const project = this.legacyProject(context.principal.principalId);
      const result = await this.options.legacy.call(name, args, context);
      if (project) this.associateResult(name, result, project.id, context);
      return result;
    }
    const parsed = z.string().uuid().safeParse(projectId);
    if (!parsed.success)
      throw new WorkflowError("invalid_input", "Workspace project ID must be a UUID.");
    const project = this.options.catalog.getProject(context.principal.principalId, parsed.data);
    if (!project.hekateProjectId)
      throw new WorkflowError(
        "PROJECT_WORKFLOWS_DISABLED",
        "This project has no Hekate binding. Configure it before managing workflow plans.",
        409
      );
    // Stable project bindings use separate artifact directories. Services remain owned
    // until shutdown; no unrelated project's artifacts are reused.
    const key = `${project.id}:${project.hekateProjectId}`;
    let service =
      project.hekateProjectId === this.options.legacyProject?.hekateProjectId.toLowerCase()
        ? this.options.legacy
        : this.services.get(key);
    if (!service) {
      if (this.services.size >= 500)
        throw new WorkflowError(
          "PROJECT_WORKFLOW_CAPACITY",
          "Too many project workflow services are open. Restart after completing active work.",
          503
        );
      const directory = join(this.options.runDir, "projects", project.id, project.hekateProjectId);
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } catch {
        throw new WorkflowError(
          "PROJECT_STORAGE_UNAVAILABLE",
          "Project workflow storage could not be prepared.",
          503
        );
      }
      service = this.options.factory(project, directory);
      this.services.set(key, service);
    }
    const result = await service.call(name, args, context);
    this.associateResult(name, result, project.id, context);
    return result;
  }

  private associateResult(
    name: string,
    result: unknown,
    projectId: string,
    context: WorkflowContext
  ) {
    if (["create_plan", "update_plan", "run_plan"].includes(name) && context.conversationId) {
      const schema =
        name === "run_plan"
          ? z
              .object({ planId: z.string().uuid() })
              .passthrough()
              .transform(({ planId }) => ({ id: planId }))
          : z.object({ id: z.string().uuid() }).passthrough();
      const plan = schema.safeParse(result);
      if (plan.success)
        this.options.catalog.associatePlan(
          context.principal.principalId,
          projectId,
          plan.data.id,
          context.conversationId
        );
    }
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
      execute: async (input, _user, requestId, signal, conversationId, authority) => {
        const principal = authority?.principal;
        if (!principal)
          throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
        try {
          return await this.call(tool.name, input, {
            principal,
            operationId: requestId,
            signal,
            conversationId
          });
        } catch (error) {
          if (error instanceof WorkflowError)
            throw new SafeCapabilityError(error.code, error.message);
          throw error;
        }
      }
    }));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(
      [this.options.legacy, ...this.services.values()].map((service) => service.close?.())
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
