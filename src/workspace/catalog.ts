import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { WorkflowError } from "../workflows/types";

const MAX_BYTES = 2 * 1024 * 1024;
const ownerSchema = z.string().min(1).max(200);
const conversationIdSchema = z.string().min(1).max(200);
const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const projectFields = {
  name: z.string().trim().min(1).max(200),
  repositoryPath: z.string().min(1).max(4096).optional(),
  hekateProjectId: uuid.optional(),
  preparedPlanRoots: z.array(uuid).max(20).default([]),
  archived: z.boolean().default(false)
};
const projectInputSchema = z.object(projectFields).strict();
const projectPatchSchema = projectInputSchema.partial().strict();
export const workspaceProjectSchema = projectInputSchema
  .extend({
    id: uuid,
    ownerId: ownerSchema,
    revision: z.number().int().min(1)
  })
  .strict();
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;
export type CreateWorkspaceProject = z.input<typeof projectInputSchema>;
export type UpdateWorkspaceProject = z.input<typeof projectPatchSchema>;
export type LegacyWorkspaceProject = Pick<CreateWorkspaceProject, "name" | "repositoryPath"> & {
  hekateProjectId: string;
};
export const conversationMetadataSchema = z
  .object({
    ownerId: ownerSchema,
    conversationId: conversationIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    projectId: uuid.optional(),
    archived: z.boolean()
  })
  .strict();
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>;
const conversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    projectId: uuid.nullable().optional(),
    archived: z.boolean().optional()
  })
  .strict();
export type UpdateConversationMetadata = z.input<typeof conversationPatchSchema>;
const associationSchema = z
  .object({
    ownerId: ownerSchema,
    projectId: uuid,
    planId: uuid,
    conversationId: conversationIdSchema
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(workspaceProjectSchema).max(500),
    conversations: z.array(conversationMetadataSchema).max(10000),
    associations: z.array(associationSchema).max(20000)
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

/** Owner-scoped metadata only. One process owns the optional atomic private file. */
export class WorkspaceCatalog {
  private state: Snapshot = { version: 1, projects: [], conversations: [], associations: [] };
  constructor(private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const info = lstatSync(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error();
      const bytes = readFileSync(filePath);
      if (bytes.byteLength > MAX_BYTES) throw new Error();
      const saved = snapshotSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      );
      this.validate(saved);
      this.state = saved;
    } catch {
      throw new WorkflowError(
        "WORKSPACE_CATALOG_INVALID",
        "The workspace catalog could not be restored. Its file was preserved.",
        503
      );
    }
  }

  private validate(snapshot: Snapshot) {
    const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
    const conversations = new Set(
      snapshot.conversations.map((c) => JSON.stringify([c.ownerId, c.conversationId]))
    );
    const links = new Set(
      snapshot.associations.map((a) => JSON.stringify([a.ownerId, a.projectId, a.planId]))
    );
    const bindings = snapshot.projects
      .filter((p) => p.hekateProjectId !== undefined)
      .map((p) => JSON.stringify([p.ownerId, p.hekateProjectId]));
    if (
      projects.size !== snapshot.projects.length ||
      conversations.size !== snapshot.conversations.length ||
      links.size !== snapshot.associations.length ||
      new Set(bindings).size !== bindings.length ||
      snapshot.projects.some(
        (p) =>
          new Set(p.preparedPlanRoots).size !== p.preparedPlanRoots.length ||
          (p.repositoryPath !== undefined && !isAbsolute(p.repositoryPath))
      ) ||
      snapshot.conversations.some(
        (c) => c.projectId !== undefined && projects.get(c.projectId)?.ownerId !== c.ownerId
      ) ||
      snapshot.associations.some(
        (a) =>
          projects.get(a.projectId)?.ownerId !== a.ownerId ||
          !conversations.has(JSON.stringify([a.ownerId, a.conversationId]))
      )
    )
      throw new Error("Invalid catalog references");
  }

  private commit(next: Snapshot) {
    const parsed = snapshotSchema.safeParse(next);
    if (!parsed.success)
      throw new WorkflowError(
        "WORKSPACE_CAPACITY",
        "The workspace catalog exceeds its metadata limits.",
        413
      );
    this.validate(parsed.data);
    const encoded = JSON.stringify(parsed.data);
    if (Buffer.byteLength(encoded) > MAX_BYTES)
      throw new WorkflowError(
        "WORKSPACE_CAPACITY",
        "The workspace catalog exceeds its storage limit.",
        413
      );
    if (this.filePath) {
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        if (existsSync(this.filePath)) {
          const info = lstatSync(this.filePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error();
        }
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, encoded, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, this.filePath);
      } catch {
        throw new WorkflowError(
          "WORKSPACE_CATALOG_UNAVAILABLE",
          "Workspace metadata could not be saved.",
          503
        );
      } finally {
        try {
          if (fd !== undefined) closeSync(fd);
        } catch {
          /* Preserve the write error. */
        }
        try {
          if (existsSync(temporary)) unlinkSync(temporary);
        } catch {
          /* Preserve the write error. */
        }
      }
    }
    // Publish only after the write succeeds, so failed writes do not advance revisions.
    this.state = parsed.data;
  }

  private input<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new WorkflowError("WORKSPACE_INPUT_INVALID", "Workspace metadata is invalid.");
    return parsed.data;
  }
  private checkRepository(path: string | undefined) {
    if (path === undefined) return;
    try {
      if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error();
    } catch {
      throw new WorkflowError(
        "REPOSITORY_PATH_INVALID",
        "Repository path must be an existing absolute directory."
      );
    }
  }

  listProjects(owner: string): WorkspaceProject[] {
    this.input(ownerSchema, owner);
    return structuredClone(this.state.projects.filter((p) => p.ownerId === owner));
  }
  getProject(owner: string, id: string): WorkspaceProject {
    id = this.input(uuid, id);
    const project = this.state.projects.find((p) => p.id === id && p.ownerId === owner);
    if (!project) throw new WorkflowError("PROJECT_NOT_FOUND", "Project was not found.", 404);
    return structuredClone(project);
  }
  createProject(owner: string, input: CreateWorkspaceProject): WorkspaceProject {
    this.input(ownerSchema, owner);
    const fields = this.input(projectInputSchema, input);
    this.checkRepository(fields.repositoryPath);
    this.checkBinding(owner, fields.hekateProjectId);
    if (new Set(fields.preparedPlanRoots).size !== fields.preparedPlanRoots.length)
      throw new WorkflowError("WORKSPACE_INPUT_INVALID", "Prepared plan roots must be unique.");
    const project = { ...fields, ownerId: owner, id: randomUUID(), revision: 1 };
    this.commit({ ...this.state, projects: [...this.state.projects, project] });
    return structuredClone(project);
  }
  getOrCreateLegacyProject(owner: string, input: LegacyWorkspaceProject): WorkspaceProject {
    this.input(ownerSchema, owner);
    const fields = this.input(projectInputSchema.extend({ hekateProjectId: uuid }), input);
    const existing = this.state.projects.find(
      (p) => p.ownerId === owner && p.hekateProjectId === fields.hekateProjectId
    );
    if (existing) return structuredClone(existing);
    this.checkRepository(fields.repositoryPath);
    const bytes = createHash("sha256")
      .update(JSON.stringify(["workspace-legacy-v1", owner, fields.hekateProjectId]))
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const project = { ...fields, ownerId: owner, id, revision: 1 };
    this.commit({ ...this.state, projects: [...this.state.projects, project] });
    return structuredClone(project);
  }
  updateProject(
    owner: string,
    id: string,
    revision: number,
    input: UpdateWorkspaceProject
  ): WorkspaceProject {
    const previous = this.getProject(owner, id);
    id = previous.id;
    if (previous.revision !== revision)
      throw new WorkflowError(
        "PROJECT_REVISION_CONFLICT",
        "Project metadata changed. Reload it before saving.",
        409
      );
    const patch = this.input(projectPatchSchema, input);
    // A binding owns its persisted run artifacts. First-time configuration is allowed;
    // replacing or clearing it would make active work inaccessible in this release.
    if (
      previous.hekateProjectId !== undefined &&
      Object.hasOwn(patch, "hekateProjectId") &&
      patch.hekateProjectId !== previous.hekateProjectId
    )
      throw new WorkflowError(
        "PROJECT_BINDING_IMMUTABLE",
        "An established Hekate binding cannot be changed. Register a separate project for another binding.",
        409
      );
    this.checkRepository(patch.repositoryPath);
    const project = { ...previous, ...patch, revision: previous.revision + 1 };
    this.checkBinding(owner, project.hekateProjectId, id);
    if (new Set(project.preparedPlanRoots).size !== project.preparedPlanRoots.length)
      throw new WorkflowError("WORKSPACE_INPUT_INVALID", "Prepared plan roots must be unique.");
    this.commit({
      ...this.state,
      projects: this.state.projects.map((p) => (p.id === id ? project : p))
    });
    return structuredClone(project);
  }
  private checkBinding(owner: string, hekateProjectId: string | undefined, exceptId?: string) {
    if (
      hekateProjectId !== undefined &&
      this.state.projects.some(
        (p) => p.ownerId === owner && p.hekateProjectId === hekateProjectId && p.id !== exceptId
      )
    )
      throw new WorkflowError(
        "PROJECT_BINDING_CONFLICT",
        "This Hekate project is already registered in your workspace.",
        409
      );
  }
  listConversations(owner: string): ConversationMetadata[] {
    this.input(ownerSchema, owner);
    return structuredClone(this.state.conversations.filter((c) => c.ownerId === owner));
  }
  conversationMetadata(owner: string, id: string): ConversationMetadata | undefined {
    return structuredClone(
      this.state.conversations.find((c) => c.ownerId === owner && c.conversationId === id)
    );
  }
  updateConversation(
    owner: string,
    id: string,
    input: UpdateConversationMetadata
  ): ConversationMetadata {
    this.input(ownerSchema, owner);
    this.input(conversationIdSchema, id);
    const patch = this.input(conversationPatchSchema, input);
    if (patch.projectId) this.getProject(owner, patch.projectId);
    const previous = this.conversationMetadata(owner, id) ?? {
      ownerId: owner,
      conversationId: id,
      archived: false
    };
    const metadata: ConversationMetadata = {
      ...previous,
      ...patch,
      projectId: patch.projectId === null ? undefined : (patch.projectId ?? previous.projectId)
    };
    this.commit({
      ...this.state,
      conversations: [
        ...this.state.conversations.filter((c) => c.ownerId !== owner || c.conversationId !== id),
        metadata
      ]
    });
    return structuredClone(metadata);
  }
  associatePlan(owner: string, projectId: string, planId: string, conversationId: string) {
    this.getProject(owner, projectId);
    const association = this.input(associationSchema, {
      ownerId: owner,
      projectId,
      planId,
      conversationId
    });
    const conversations = this.conversationMetadata(owner, conversationId)
      ? this.state.conversations
      : [...this.state.conversations, { ownerId: owner, conversationId, archived: false }];
    this.commit({
      ...this.state,
      conversations,
      associations: [
        ...this.state.associations.filter(
          (a) => a.ownerId !== owner || a.projectId !== projectId || a.planId !== planId
        ),
        association
      ]
    });
  }
  linkedConversation(owner: string, projectId: string, planId: string): string | undefined {
    projectId = this.getProject(owner, projectId).id;
    planId = this.input(uuid, planId);
    return this.state.associations.find(
      (a) => a.ownerId === owner && a.projectId === projectId && a.planId === planId
    )?.conversationId;
  }
  forgetConversation(owner: string, id: string) {
    this.input(ownerSchema, owner);
    this.input(conversationIdSchema, id);
    this.commit({
      ...this.state,
      conversations: this.state.conversations.filter(
        (c) => c.ownerId !== owner || c.conversationId !== id
      ),
      associations: this.state.associations.filter(
        (a) => a.ownerId !== owner || a.conversationId !== id
      )
    });
  }
  /** Trusted ChatService retirement hook only; never expose this ownerless operation as an RPC. */
  forgetConversationById(id: string) {
    this.input(conversationIdSchema, id);
    this.commit({
      ...this.state,
      conversations: this.state.conversations.filter((c) => c.conversationId !== id),
      associations: this.state.associations.filter((a) => a.conversationId !== id)
    });
  }
}
