import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HekateWorkflowStore } from "../../src/workflows/hekateStore";
import { workflowDefinitionSchema } from "../../src/workflows/types";

interface Node {
  id: string;
  parentId: string | null;
  nodeType: string;
  value: string | null;
  contentRevision: number;
  stateRevision: number;
  work: string;
  attemptId: string | null;
  attemptEpoch: number;
  artifactRef: string | null;
}
interface Graph {
  contractVersion: string;
  rootId: string;
  projectId: string;
  defaultGate: string;
  nodes: Node[];
  dependencies: unknown[];
}
const definition = workflowDefinitionSchema.parse({
  version: 1,
  name: "Review information",
  steps: [
    {
      id: "review",
      name: "Review",
      action: { type: "human", instructions: "Check the information." }
    }
  ]
});

describe("Hekate workflow storage over its HTTP contract", () => {
  let server: Server;
  let store: HekateWorkflowStore;
  let projectId: string;
  let graphs: Map<string, Graph>;
  let writes: { path: string; body: Record<string, unknown> }[];
  let rejectChild: boolean;
  let oversized: boolean;
  let raceOnContent: boolean;
  beforeEach(async () => {
    projectId = randomUUID();
    graphs = new Map();
    writes = [];
    rejectChild = false;
    oversized = false;
    raceOnContent = false;
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const path = url.pathname.replace("/api/plan-contract/v1", "");
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const parts = path.split("/");
      if (req.method === "GET" && path === "/plans") {
        const items = [...graphs.values()].filter(
          (graph) => graph.projectId === url.searchParams.get("projectId")
        );
        return send(200, {
          contractVersion: "plan-contract/v1",
          plans: items.map(({ rootId, projectId }) => ({ rootId, projectId })),
          nextAfterRootId: null
        });
      }
      if (req.method === "GET") {
        if (oversized) return send(200, { data: "x".repeat(1048577) });
        const graph = graphs.get(parts[2]!);
        return graph ? send(200, graph) : send(404, { code: "plan_not_found" });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/plans") {
        const id = String(body.rootId);
        if (graphs.has(id)) return send(409, { code: "plan_exists" });
        const root: Node = {
          id,
          parentId: null,
          nodeType: "plan",
          value: String(body.value),
          contentRevision: 1,
          stateRevision: 1,
          work: "todo",
          attemptId: null,
          attemptEpoch: 0,
          artifactRef: null
        };
        const graph: Graph = {
          rootId: id,
          projectId: String(body.projectId),
          contractVersion: "plan-contract/v1",
          defaultGate: String(body.defaultGate),
          nodes: [root],
          dependencies: []
        };
        graphs.set(id, graph);
        return send(200, graph);
      }
      const graph = [...graphs.values()].find((graph) =>
        graph.nodes.some((node) => node.id === parts[2])
      );
      const node = graph?.nodes.find((node) => node.id === parts[2]);
      if (!graph || !node) return send(404, { code: "node_not_found" });
      if (raceOnContent && parts[3] === "content") node.stateRevision++;
      if (node.stateRevision !== body.expectedStateRevision)
        return send(409, { code: "stale_revision" });
      if (parts[3] === "children") {
        if (rejectChild) return send(503, { message: "private driver secret must never escape" });
        graph.nodes.push({
          id: String(body.childId),
          parentId: node.id,
          nodeType: String(body.nodeType),
          value: String(body.value),
          contentRevision: 1,
          stateRevision: 0,
          work: "todo",
          attemptId: null,
          attemptEpoch: 0,
          artifactRef: null
        });
      } else if (parts[3] === "content") {
        if (node.contentRevision !== body.expectedContentRevision)
          return send(409, { code: "stale_content" });
        node.value = String(body.value);
        node.contentRevision++;
      } else if (parts[3] === "transition") {
        if (body.to === "in_progress") {
          if (node.work !== "todo" && node.work !== "done")
            return send(422, { code: "invalid_transition" });
          node.attemptId = String(body.attemptId);
          node.attemptEpoch++;
        } else {
          if (
            node.work !== "in_progress" ||
            node.attemptId !== body.attemptId ||
            node.attemptEpoch !== body.attemptEpoch
          )
            return send(409, { code: "stale_attempt" });
          if (body.to === "todo") node.attemptId = null;
          else node.artifactRef = String(body.artifactRef);
        }
        node.work = String(body.to);
      } else return send(404, {});
      node.stateRevision++;
      return send(200, graph);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    store = new HekateWorkflowStore(`http://127.0.0.1:${address.port}`, projectId);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("creates an editable workflow and retries creation without duplicate tasks", async () => {
    const created = await store.create("alice", definition, "create-one");
    const retried = await store.create("alice", definition, "create-one");
    expect(retried).toEqual(created);
    expect(graphs.size).toBe(1);
    expect(graphs.get(created.id)?.nodes).toHaveLength(2);
    expect(created.definition).toEqual(definition);
    expect(created.revision).toBe(1);
    const edited = await store.update(
      "alice",
      created.id,
      1,
      { ...definition, name: "Updated workflow" },
      "edit-one"
    );
    expect(edited.definition.name).toBe("Updated workflow");
    expect(edited.revision).toBe(2);
    await expect(
      store.update("alice", created.id, 1, definition, "stale-edit")
    ).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect(writes.filter((write) => write.path.endsWith("/content"))).toHaveLength(1);
  });

  it("recovers a partial creation using the retained managed root", async () => {
    rejectChild = true;
    await expect(store.create("alice", definition, "partial")).rejects.toMatchObject({
      code: "WORKFLOW_STORE_UNAVAILABLE"
    });
    expect(graphs.size).toBe(1);
    rejectChild = false;
    const saved = await store.create("alice", definition, "partial");
    expect(saved.definition).toEqual(definition);
    expect(graphs.size).toBe(1);
    expect(graphs.get(saved.id)?.nodes).toHaveLength(2);
  });

  it("lists only owner workflows and refuses cross-owner or foreign task access", async () => {
    const alice = await store.create("alice", definition, "alice");
    await store.create("bob", definition, "bob");
    expect((await store.list("alice")).map((plan) => plan.id)).toEqual([alice.id]);
    await expect(store.get("bob", alice.id)).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    await expect(store.update("bob", alice.id, 1, definition, "wrong-owner")).rejects.toMatchObject(
      { code: "WORKFLOW_NOT_FOUND" }
    );
    const graph = graphs.get(alice.id)!;
    graph.projectId = randomUUID();
    await expect(store.get("alice", alice.id)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND"
    });
    graph.projectId = projectId;
    graph.nodes[1]!.id = randomUUID();
    await expect(store.start("alice", alice.id, 1, "run")).rejects.toMatchObject({
      code: "WORKFLOW_INVALID_STORAGE"
    });
  });

  it("fences executions, forbids editing active work, and retains an exact finished artifact", async () => {
    const plan = await store.create("alice", definition, "runs");
    const run = await store.start("alice", plan.id, plan.revision, "run-one");
    expect(run.work).toBe("in_progress");
    expect(run.attemptEpoch).toBe(1);
    expect(await store.start("alice", plan.id, 1, "run-one")).toEqual(run);
    await expect(
      store.update("alice", plan.id, 1, definition, "active-edit")
    ).rejects.toMatchObject({ code: "WORKFLOW_RUNNING" });
    await expect(store.finish("alice", plan.id, "wrong-run", 1, "artifact")).rejects.toMatchObject({
      code: "WORKFLOW_STALE_RUN"
    });
    const done = await store.finish("alice", plan.id, "run-one", 1, "run-artifact-one");
    expect(done.work).toBe("done");
    expect(done.artifactRef).toBe("run-artifact-one");
    expect(await store.finish("alice", plan.id, "run-one", 1, "run-artifact-one")).toEqual(done);
    const reopened = await store.start("alice", plan.id, 1, "run-two");
    expect(reopened.attemptEpoch).toBe(2);
    await expect(store.release("alice", plan.id, "run-one", 1)).rejects.toMatchObject({
      code: "WORKFLOW_STALE_RUN"
    });
    const released = await store.release("alice", plan.id, "run-two", 2);
    expect(released.work).toBe("todo");
    expect(released.attemptId).toBeNull();
    await expect(store.release("alice", plan.id, "wrong-run", 2)).rejects.toMatchObject({
      code: "WORKFLOW_STALE_RUN"
    });
  });

  it("rejects concurrent updates through the store revision fence", async () => {
    const plan = await store.create("alice", definition, "concurrent");
    raceOnContent = true;
    await expect(
      store.update("alice", plan.id, 1, { ...definition, name: "Conflicting edit" }, "edit")
    ).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect((await store.get("alice", plan.id)).definition).toEqual(definition);
    expect((await store.get("alice", plan.id)).revision).toBe(1);
  });

  it("enforces the HTTP response byte limit", async () => {
    const plan = await store.create("alice", definition, "oversized");
    oversized = true;
    await expect(store.get("alice", plan.id)).rejects.toMatchObject({
      code: "WORKFLOW_RESPONSE_TOO_LARGE",
      status: 502
    });
  });

  it("sanitizes HTTP failures and rejects network locations outside loopback", async () => {
    rejectChild = true;
    await expect(store.create("alice", definition, "failure")).rejects.toMatchObject({
      message: "The workflow store could not complete the operation.",
      status: 502
    });
    expect(() => new HekateWorkflowStore("http://example.com", projectId)).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(store.list("alice", controller.signal)).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED"
    });
  });
});
