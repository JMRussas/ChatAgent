import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCatalog } from "../../src/workspace/catalog";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workspace-catalog-"));
  directories.push(directory);
  return { directory, file: join(directory, "workspace.json") };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workspace catalog", () => {
  it("restores owner-scoped projects and conversation links without copying history", () => {
    const { directory, file } = fixture();
    const catalog = new WorkspaceCatalog(file);
    const project = catalog.createProject("alice", {
      name: "ChatAgent",
      repositoryPath: directory,
      hekateProjectId: randomUUID(),
      preparedPlanRoots: [randomUUID()]
    });
    catalog.createProject("bob", { name: "Other project" });
    catalog.updateConversation("alice", "existing-chat", {
      title: "Design review",
      projectId: project.id,
      archived: true
    });
    const planId = randomUUID();
    catalog.associatePlan("alice", project.id, planId, "existing-chat");
    const restored = new WorkspaceCatalog(file);
    expect(restored.listProjects("alice")).toEqual([project]);
    expect(restored.listProjects("bob")).toHaveLength(1);
    expect(restored.conversationMetadata("bob", "existing-chat")).toBeUndefined();
    expect(restored.conversationMetadata("alice", "existing-chat")).toMatchObject({
      title: "Design review",
      projectId: project.id,
      archived: true
    });
    expect(restored.linkedConversation("alice", project.id, planId)).toBe("existing-chat");
    expect(() => restored.getProject("bob", project.id)).toThrowError(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" })
    );
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.conversations[0]).not.toHaveProperty("events");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects stale revisions and cross-owner assignments while protecting returned copies", () => {
    const catalog = new WorkspaceCatalog();
    const project = catalog.createProject("alice", { name: "Original" });
    const updated = catalog.updateProject("alice", project.id, project.revision, {
      name: "Current",
      archived: true
    });
    expect(updated.revision).toBe(2);
    expect(() =>
      catalog.updateProject("alice", project.id, project.revision, { name: "Lost update" })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_REVISION_CONFLICT" }));
    expect(() => catalog.updateConversation("bob", "chat", { projectId: project.id })).toThrowError(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" })
    );
    updated.name = "Mutated copy";
    expect(catalog.getProject("alice", project.id).name).toBe("Current");
    catalog.updateConversation("alice", "chat", { projectId: project.id });
    expect(
      catalog.updateConversation("alice", "chat", { projectId: null }).projectId
    ).toBeUndefined();
  });

  it("keeps the old in-memory revision after an atomic file replacement fails", () => {
    const { file } = fixture();
    const catalog = new WorkspaceCatalog(file);
    const project = catalog.createProject("alice", { name: "Saved" });
    const planId = randomUUID();
    catalog.associatePlan("alice", project.id, planId, "chat");
    const original = readFileSync(file, "utf8");
    renameSync(file, `${file}.saved`);
    mkdirSync(file);
    expect(() => catalog.updateProject("alice", project.id, 1, { name: "Unsaved" })).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_CATALOG_UNAVAILABLE" })
    );
    expect(catalog.getProject("alice", project.id)).toEqual(project);
    expect(() => catalog.forgetConversationById("chat")).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_CATALOG_UNAVAILABLE" })
    );
    expect(catalog.conversationMetadata("alice", "chat")).toBeDefined();
    expect(catalog.linkedConversation("alice", project.id, planId)).toBe("chat");
    rmSync(file, { recursive: true });
    renameSync(`${file}.saved`, file);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(catalog.updateProject("alice", project.id, 1, { name: "Retry" }).revision).toBe(2);
  });

  it("allows a first Hekate binding but rejects replacement and clearing after restart", () => {
    const { file } = fixture();
    const catalog = new WorkspaceCatalog(file);
    const project = catalog.createProject("alice", { name: "Unconnected" });
    const binding = randomUUID();
    const connected = catalog.updateProject("alice", project.id.toUpperCase(), 1, {
      hekateProjectId: binding.toUpperCase()
    });
    const restored = new WorkspaceCatalog(file);
    expect(() =>
      restored.updateProject("alice", project.id, connected.revision, {
        hekateProjectId: randomUUID()
      })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_BINDING_IMMUTABLE", status: 409 }));
    expect(() =>
      restored.updateProject("alice", project.id, connected.revision, {
        hekateProjectId: undefined
      })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_BINDING_IMMUTABLE" }));
    expect(restored.getProject("alice", project.id)).toEqual(connected);
    expect(restored.getProject("alice", project.id.toUpperCase())).toEqual(connected);
    expect(() =>
      restored.createProject("alice", {
        name: "Duplicate case",
        hekateProjectId: binding.toUpperCase()
      })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_BINDING_CONFLICT" }));
    expect(
      restored.updateProject("alice", project.id, connected.revision, {
        name: "Renamed",
        hekateProjectId: binding.toUpperCase()
      })
    ).toMatchObject({
      name: "Renamed",
      hekateProjectId: binding,
      revision: connected.revision + 1
    });
  });

  it("atomically retires all metadata and associations for a trusted global conversation identity", () => {
    const { file } = fixture();
    const catalog = new WorkspaceCatalog(file);
    const id = randomUUID();
    const alice = catalog.createProject("alice", { name: "Alice" });
    const bob = catalog.createProject("bob", { name: "Bob" });
    const alicePlan = randomUUID(),
      bobPlan = randomUUID(),
      retainedPlan = randomUUID();
    catalog.associatePlan("alice", alice.id, alicePlan, id);
    catalog.associatePlan("bob", bob.id, bobPlan, id);
    catalog.associatePlan("alice", alice.id, retainedPlan, "other-chat");
    catalog.forgetConversationById(id);
    const restored = new WorkspaceCatalog(file);
    expect(restored.conversationMetadata("alice", id)).toBeUndefined();
    expect(restored.conversationMetadata("bob", id)).toBeUndefined();
    expect(restored.linkedConversation("alice", alice.id, alicePlan)).toBeUndefined();
    expect(restored.linkedConversation("bob", bob.id, bobPlan)).toBeUndefined();
    expect(restored.linkedConversation("alice", alice.id, retainedPlan)).toBe("other-chat");
    expect(restored.listProjects("alice")).toEqual([alice]);
  });

  it("refuses corruption and invalid owner references without resetting the saved catalog", () => {
    const { file } = fixture();
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(() => new WorkspaceCatalog(file)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_CATALOG_INVALID" })
    );
    expect(readFileSync(file, "utf8")).toBe("{broken");
    const other = fixture();
    const catalog = new WorkspaceCatalog(other.file);
    const project = catalog.createProject("alice", { name: "Owner" });
    catalog.updateConversation("alice", "chat", { projectId: project.id });
    const saved = JSON.parse(readFileSync(other.file, "utf8"));
    saved.conversations[0].ownerId = "bob";
    const corrupted = JSON.stringify(saved);
    writeFileSync(other.file, corrupted);
    expect(() => new WorkspaceCatalog(other.file)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_CATALOG_INVALID" })
    );
    expect(readFileSync(other.file, "utf8")).toBe(corrupted);
  });

  it("checks repository directories, prepared root bounds, and snapshot capacity", () => {
    const { directory, file } = fixture();
    const catalog = new WorkspaceCatalog();
    expect(() =>
      catalog.createProject("alice", { name: "Relative", repositoryPath: "relative" })
    ).toThrowError(expect.objectContaining({ code: "REPOSITORY_PATH_INVALID" }));
    expect(() =>
      catalog.createProject("alice", {
        name: "Missing",
        repositoryPath: join(directory, "missing")
      })
    ).toThrowError(expect.objectContaining({ code: "REPOSITORY_PATH_INVALID" }));
    const root = randomUUID();
    expect(() =>
      catalog.createProject("alice", { name: "Duplicate", preparedPlanRoots: [root, root] })
    ).toThrowError(expect.objectContaining({ code: "WORKSPACE_INPUT_INVALID" }));
    expect(() =>
      catalog.createProject("alice", {
        name: "Too many",
        preparedPlanRoots: Array.from({ length: 21 }, () => randomUUID())
      })
    ).toThrow();
    writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1));
    expect(() => new WorkspaceCatalog(file)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_CATALOG_INVALID" })
    );
    expect(existsSync(file)).toBe(true);
  });

  it("registers the legacy binding idempotently and retires only the requested owner's links", () => {
    const { file } = fixture();
    const catalog = new WorkspaceCatalog(file);
    const input = { name: "Default", hekateProjectId: randomUUID() };
    const project = catalog.getOrCreateLegacyProject("alice", input);
    expect(catalog.getOrCreateLegacyProject("alice", input).id).toBe(project.id);
    expect(new WorkspaceCatalog(file).getOrCreateLegacyProject("alice", input).id).toBe(project.id);
    const independent = new WorkspaceCatalog().getOrCreateLegacyProject("alice", input);
    expect(independent.id).toBe(project.id);
    expect(catalog.getOrCreateLegacyProject("bob", input).id).not.toBe(project.id);
    expect(() => catalog.createProject("alice", input)).toThrowError(
      expect.objectContaining({ code: "PROJECT_BINDING_CONFLICT" })
    );
    catalog.updateConversation("bob", "shared-slug", { title: "Keep" });
    const planId = randomUUID();
    catalog.associatePlan("alice", project.id, planId, "shared-slug");
    catalog.forgetConversation("alice", "shared-slug");
    const restored = new WorkspaceCatalog(file);
    expect(restored.conversationMetadata("alice", "shared-slug")).toBeUndefined();
    expect(restored.linkedConversation("alice", project.id, planId)).toBeUndefined();
    expect(restored.conversationMetadata("bob", "shared-slug")?.title).toBe("Keep");
  });
});
