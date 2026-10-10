import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownerBelongsToPrincipal, scopedOwnerKey } from "../auth/authenticator";
import type { ChatService } from "../app/chatService";
import { SafeCapabilityError, type CapabilityTool } from "../app/capabilityChat";
import type { UserMessage } from "../domain/types";
import { formatWorkflowResult } from "../workflows/application";
import {
  WorkflowError,
  type WorkflowContext,
  type WorkflowTool,
  type WorkflowToolService,
  type StoredWorkflowPlan,
  type WorkflowRun
} from "../workflows/types";
import { WorkspaceCatalog } from "./catalog";
import { ProjectWorkflowRouter } from "./projectWorkflows";
import { readCodingProject } from "./codingProjects";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const id = z.string().min(1).max(200);
const projectFields = {
  name: z.string().trim().min(1).max(200),
  repositoryPath: z.string().min(1).max(4096).optional(),
  hekateProjectId: uuid.optional(),
  preparedPlanRoots: z.array(uuid).max(20).optional(),
  archived: z.boolean().optional()
};
const conversationFields = {
  title: z.string().trim().min(1).max(200).optional(),
  projectId: uuid.nullable().optional(),
  archived: z.boolean().optional()
};
const jsonObject = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});
const projectJson = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  repositoryPath: { type: "string", maxLength: 4096 },
  hekateProjectId: { type: "string", format: "uuid" },
  preparedPlanRoots: { type: "array", maxItems: 20, items: { type: "string", format: "uuid" } },
  archived: { type: "boolean" }
};
const conversationJson = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  projectId: { type: ["string", "null"], format: "uuid" },
  archived: { type: "boolean" }
};
const specs: Array<WorkflowTool & { schema: z.ZodTypeAny }> = [
  {
    name: "get_workspace",
    description:
      "List the caller's projects, saved conversations and observed work. Optional projectId narrows work discovery.",
    readOnly: true,
    inputSchema: jsonObject({ projectId: { type: "string", format: "uuid" } }),
    schema: z.object({ projectId: uuid.optional() }).strict()
  },
  {
    name: "register_project",
    description:
      "Register an existing repository and optional Hekate project. Registration does not grant coding execution access.",
    readOnly: false,
    inputSchema: jsonObject(projectJson, ["name"]),
    schema: z.object(projectFields).strict()
  },
  {
    name: "update_project",
    description: "Rename, archive or configure a registered project using its current revision.",
    readOnly: false,
    inputSchema: jsonObject(
      {
        id: { type: "string", format: "uuid" },
        revision: { type: "integer", minimum: 1 },
        ...projectJson
      },
      ["id", "revision"]
    ),
    schema: z
      .object({
        id: uuid,
        revision: z.number().int().min(1),
        ...Object.fromEntries(
          Object.entries(projectFields).map(([key, schema]) => [key, schema.optional()])
        )
      })
      .strict()
  },
  {
    name: "create_conversation",
    description: "Create an owned conversation that can be reopened in the workspace.",
    readOnly: false,
    inputSchema: jsonObject(conversationJson),
    schema: z.object(conversationFields).strict()
  },
  {
    name: "update_conversation",
    description:
      "Rename, file or archive an existing owned conversation without removing its history.",
    readOnly: false,
    inputSchema: jsonObject({ id: { type: "string" }, ...conversationJson }, ["id"]),
    schema: z.object({ id, ...conversationFields }).strict()
  },
  {
    name: "link_plan",
    description:
      "Associate an existing workflow or observed coding plan with an owned project conversation.",
    readOnly: false,
    inputSchema: jsonObject(
      {
        projectId: { type: "string", format: "uuid" },
        planId: { type: "string", format: "uuid" },
        conversationId: { type: "string" }
      },
      ["projectId", "planId", "conversationId"]
    ),
    schema: z.object({ projectId: uuid, planId: uuid, conversationId: id }).strict()
  }
];

/** One navigation index over existing histories and work; it owns no execution queue. */
export class WorkspaceService implements WorkflowToolService {
  readonly tools: readonly WorkflowTool[];
  constructor(
    private readonly options: {
      catalog: WorkspaceCatalog;
      chat: ChatService;
      workflows?: ProjectWorkflowRouter;
      apiUrl?: string;
      persistenceEnabled?: boolean;
    }
  ) {
    this.tools = [
      ...specs.map(({ schema: _schema, ...tool }) => tool),
      ...(options.workflows?.tools ?? [])
    ];
    options.chat.addRetirementParticipant({
      forget: (conversationId) => options.catalog.forgetConversationById(conversationId)
    });
  }
  ownedConversation(principalId: string, conversationId: string): string {
    const owner = this.options.chat.conversationOwner(conversationId);
    if (!ownerBelongsToPrincipal(owner, principalId))
      throw new WorkflowError("CONVERSATION_NOT_FOUND", "No such conversation", 404);
    return owner!;
  }
  private summary(owner: string, conversationId: string) {
    const row = this.options.chat.listConversations(owner).find((row) => row.id === conversationId);
    if (!row) throw new WorkflowError("CONVERSATION_NOT_FOUND", "No such conversation", 404);
    const metadata = this.options.catalog.conversationMetadata(owner, conversationId);
    return {
      ...row,
      title: metadata?.title ?? row.title,
      projectId: metadata?.projectId ?? null,
      archived: metadata?.archived ?? false,
      reopenable: row.status !== "expired"
    };
  }
  async call(name: string, input: unknown, context: WorkflowContext): Promise<unknown> {
    if (!context.principal.roles.has("operator"))
      throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
    const owner = context.principal.principalId;
    const spec = specs.find((spec) => spec.name === name);
    if (!spec) {
      if (!this.options.workflows)
        throw new WorkflowError("WORKFLOWS_DISABLED", "Workflows are not configured.", 404);
      if (context.conversationId) this.ownedConversation(owner, context.conversationId);
      const projectId = context.conversationId
        ? this.options.catalog.conversationMetadata(owner, context.conversationId)?.projectId
        : undefined;
      const scopedInput =
        projectId &&
        input !== null &&
        (input === undefined || (typeof input === "object" && !Array.isArray(input))) &&
        (input as Record<string, unknown> | undefined)?.projectId === undefined
          ? { ...(input as Record<string, unknown> | undefined), projectId }
          : input;
      const result = await this.options.workflows.call(name, scopedInput, context);
      return result;
    }
    const parsed = spec.schema.safeParse(input ?? {});
    if (!parsed.success)
      throw new WorkflowError("INVALID_WORKSPACE_INPUT", "Invalid workspace tool input.", 400);
    const args = parsed.data as Record<string, any>;
    switch (name) {
      case "register_project":
        return this.options.catalog.createProject(owner, args as any);
      case "update_project": {
        const { id, revision, ...patch } = args;
        return this.options.catalog.updateProject(owner, id, revision, patch);
      }
      case "create_conversation": {
        if (args.projectId) this.options.catalog.getProject(owner, args.projectId);
        const conversationId = randomUUID();
        this.options.chat.claimConversation(
          conversationId,
          scopedOwnerKey(owner, ["workspace", conversationId])
        );
        this.options.catalog.updateConversation(owner, conversationId, args);
        return this.summary(owner, conversationId);
      }
      case "update_conversation": {
        this.ownedConversation(owner, args.id);
        const { id, ...patch } = args;
        this.options.catalog.updateConversation(owner, id, patch);
        return this.summary(owner, id);
      }
      case "link_plan": {
        this.ownedConversation(owner, args.conversationId);
        this.options.catalog.getProject(owner, args.projectId);
        // Verify existence in the selected project before saving a navigation association.
        let found = false;
        if (this.options.workflows) {
          try {
            await this.options.workflows.call(
              "get_plan",
              { id: args.planId, projectId: args.projectId },
              context
            );
            found = true;
          } catch (error) {
            if (!(error instanceof WorkflowError && error.status === 404)) throw error;
          }
        }
        if (!found && this.options.apiUrl) {
          const project = this.options.catalog.getProject(owner, args.projectId);
          if (project.hekateProjectId)
            found = (
              await readCodingProject(this.options.apiUrl, project.hekateProjectId, {
                signal: context.signal
              })
            ).work.some((row) => row.id === args.planId && !row.error);
        }
        if (!found) throw new WorkflowError("PLAN_NOT_FOUND", "No such plan in this project.", 404);
        return this.options.catalog.associatePlan(
          owner,
          args.projectId,
          args.planId,
          args.conversationId
        );
      }
      default:
        return this.workspace(context, args.projectId);
    }
  }
  private async workspace(context: WorkflowContext, projectId?: string) {
    const owner = context.principal.principalId;
    this.options.workflows?.legacyProject(owner);
    const projects = this.options.catalog.listProjects(owner);
    if (projectId) this.options.catalog.getProject(owner, projectId);
    const conversations = this.options.chat.listConversations(owner).map((row) => {
      const metadata = this.options.catalog.conversationMetadata(owner, row.id);
      return {
        ...row,
        title: metadata?.title ?? row.title,
        projectId: metadata?.projectId ?? null,
        archived: metadata?.archived ?? false,
        reopenable: row.status !== "expired"
      };
    });
    const work: Array<Record<string, unknown>> = [];
    const errors: Array<{ projectId: string; message: string }> = [];
    const selected = projects.filter((project) =>
      projectId ? project.id === projectId : !project.archived
    );
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    let cursor = 0,
      truncated = false;
    await Promise.all(
      Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (cursor < selected.length) {
          const project = selected[cursor++];
          if (!project.hekateProjectId) continue;
          const append = (row: Record<string, unknown>) => {
            if (work.length >= 500) {
              truncated = true;
              return;
            }
            work.push({
              ...row,
              projectId: project.id,
              conversationId:
                this.options.catalog.linkedConversation(owner, project.id, row.id as string) ?? null
            });
          };
          const reads = await Promise.allSettled([
            this.options.workflows?.call(
              "list_plans",
              { projectId: project.id },
              { ...context, signal }
            ),
            this.options.apiUrl
              ? readCodingProject(this.options.apiUrl, project.hekateProjectId, {
                  preparedRoots: project.preparedPlanRoots,
                  signal
                })
              : undefined
          ]);
          for (let i = 0; i < reads.length; i++) {
            const result = reads[i];
            if (result.status === "rejected") {
              errors.push({
                projectId: project.id,
                message:
                  result.reason instanceof WorkflowError
                    ? result.reason.message
                    : "Project work is unavailable."
              });
              continue;
            }
            if (!result.value) continue;
            if (i === 0) {
              for (const plan of (
                result.value as { plans: Array<StoredWorkflowPlan & { latestRunId?: string }> }
              ).plans) {
                let run: WorkflowRun | undefined;
                let runUnavailable = false;
                if (plan.latestRunId) {
                  try {
                    run = (await this.options.workflows!.call(
                      "get_run",
                      { id: plan.latestRunId, projectId: project.id },
                      { ...context, signal }
                    )) as WorkflowRun;
                  } catch {
                    runUnavailable = true;
                  }
                }
                const currentRun = run?.revision === plan.revision ? run : undefined;
                const next = currentRun?.steps.find((step) => step.status !== "completed");
                const status = runUnavailable
                  ? "unavailable"
                  : (currentRun?.status ?? (run ? "todo" : plan.work));
                append({
                  id: plan.id,
                  name: plan.definition.name,
                  kind: "workflow",
                  status,
                  latestRunId: plan.latestRunId ?? null,
                  nextStep:
                    next?.name ?? (status === "todo" ? plan.definition.steps[0]?.name : undefined),
                  error: runUnavailable ? "The recorded run could not be read." : currentRun?.error
                });
              }
            } else {
              const resultValue = result.value as Awaited<ReturnType<typeof readCodingProject>>;
              truncated ||= resultValue.truncated;
              if (resultValue.unavailable)
                errors.push({
                  projectId: project.id,
                  message: "Some coding plans could not be read or verified for this project."
                });
              for (const row of resultValue.work)
                append({ ...row, nextStep: row.nextStep?.name, nextStepId: row.nextStep?.id });
            }
          }
        }
      })
    );
    return {
      projects,
      conversations,
      work: work.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      errors,
      truncated,
      persistenceEnabled: this.options.persistenceEnabled ?? false
    };
  }
  capabilities(message?: UserMessage): CapabilityTool[] {
    if (!message?.applicationContext?.principal.roles.has("operator")) return [];
    return this.tools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      effect: tool.readOnly ? "read" : "write",
      inputSchema: tool.inputSchema,
      validate: (input) => input,
      formatResult: (result) => formatWorkflowResult(tool.name, result),
      execute: async (input, _user, operationId, signal, conversationId, authority) => {
        if (!authority?.principal)
          throw new SafeCapabilityError("OPERATOR_REQUIRED", "An operator credential is required.");
        try {
          return await this.call(tool.name, input, {
            principal: authority.principal,
            operationId,
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
    await this.options.workflows?.close?.();
  }
}
