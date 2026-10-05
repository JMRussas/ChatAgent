import { it, expect, vi } from "vitest";
import { FileLatencyTelemetryStore } from "../../src/telemetry/latencyTelemetryStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { ToolResultStore } from "../../src/app/toolResult";
import { GenerationLifecycle } from "../../src/app/generationLifecycle";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import {
  InventoryStore,
  computeReadiness,
  type DiscoveryObservation
} from "../../src/models/inventory";
import { discoveryLimitsSchema } from "../../src/config/discoveryLimits";
import { UNKNOWN_RESOURCE_FACTS, type Connection } from "../../src/models/connections";
import { readDiscoveryJson } from "../../src/models/discovery/util";

const snapshot = (n: number) => ({
  estimator: { priors: [], samples: [] },
  policy: { maxFastP95Ms: n }
});
it("coalesces stalled telemetry to one replacement, joins superseded callers and recovers after failure", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: number[] = [];
  class Store extends FileLatencyTelemetryStore {
    protected async writeSnapshot(value: string) {
      const n = JSON.parse(value).policy.maxFastP95Ms;
      writes.push(n);
      if (n === 1) {
        await held;
        throw Error("disk failure");
      }
    }
  }
  const store = new Store("unused");
  const first = expect(store.save(snapshot(1))).rejects.toThrow("disk failure");
  const second = store.save(snapshot(2));
  for (let n = 3; n <= 1000; n++) expect(store.save(snapshot(n))).toBe(second);
  expect(store.retentionStats()).toMatchObject({ writing: 1, queued: 1 });
  expect(writes).toEqual([1]);
  release();
  await first;
  await second;
  expect(writes).toEqual([1, 1000]);
  expect(store.retentionStats()).toEqual({ writing: 0, queued: 0, bytes: 0 });
  await store.save(snapshot(1001));
  expect(writes).toEqual([1, 1000, 1001]);
});
const task = (id: string) => ({
  taskId: id,
  conversationId: "c",
  messageId: id,
  normalizedPrompt: "q",
  createdAtIso: "now"
});
it("rejects queue overflow atomically and only removes matching queued work", async () => {
  const queue = new InMemoryTaskQueue(2);
  const input = task("a");
  await queue.enqueue(input);
  input.conversationId = "mutated";
  await queue.enqueue(task("b"));
  await expect(queue.enqueue(task("overflow"))).rejects.toMatchObject({
    code: "DEEP_QUEUE_CAPACITY"
  });
  expect(queue.size()).toBe(2);
  const dequeued = await queue.dequeue();
  expect(queue.removeMessage("c", "a")).toEqual([]);
  expect(dequeued?.conversationId).toBe("c");
  expect(queue.removeMessage("c", "b").map((t) => t.taskId)).toEqual(["b"]);
  expect(queue.removeMessage("c", "b")).toEqual([]);
  expect(queue.size()).toBe(0);
  await queue.enqueue(task("same"));
  await queue.enqueue({ ...task("same"), conversationId: "other" });
  expect(queue.removeMessage("c", "same")).toHaveLength(1);
  expect(queue.hasConversation("other")).toBe(true);
  expect(queue.retentionStats().bytes).toBeGreaterThan(0);
  await queue.dequeue();
  expect(queue.retentionStats().bytes).toBe(0);
});
it("clears settled answer buffers only after consumers release, preserving history", async () => {
  const timeline = new InMemoryConversationTimelineStore();
  const lifecycle = new GenerationLifecycle();
  const release = lifecycle.retain("c", "m");
  const attempt = lifecycle.create("c", "m", "fast", timeline);
  attempt.text = "answer";
  await attempt.finish("stop", { text: "answer" });
  expect(attempt.text).toBe("answer");
  release();
  expect(attempt.text).toBe("");
  expect(lifecycle.retentionStats().answerBytes).toBe(0);
  expect((await timeline.getEvents("c")).filter((e) => e.type === "terminal")[0].text).toBe(
    "answer"
  );
});
const result = (size: number) => ({
  version: "tool-result-v1" as const,
  context: {
    status: "ready" as const,
    summary: "s",
    scope: "s",
    coverage: "complete" as const,
    limitations: [],
    expiresAt: new Date(1000).toISOString()
  },
  payload: { kind: "table" as const, title: "t", columns: ["c"], rows: [["x".repeat(size)]] },
  evidence: {
    sourceUrl: "https://example.test",
    observedAt: new Date(0).toISOString(),
    revision: "r"
  }
});
it("evicts oldest results under byte pressure and rejects oversized results without evicting live evidence", () => {
  const store = new ToolResultStore(() => 0, 100, 900);
  const first = store.put("u", "c", result(100));
  const second = store.put("u", "c", result(100));
  expect(() => store.get(first.context.resultId, "u", "c")).toThrow("RESULT_NOT_FOUND");
  const before = store.retentionStats();
  expect(() => store.put("u", "c", result(1000))).toThrow("RESULT_TOO_LARGE");
  expect(store.retentionStats()).toEqual(before);
  expect(store.get(second.context.resultId, "u", "c")).toBeDefined();
  store.forgetConversation("c");
  expect(store.retentionStats().bytes).toBe(0);
});
const connection: Connection = {
  connectionId: "conn",
  apiKind: "ollama-chat",
  baseUrl: "http://unused",
  resourceFacts: UNKNOWN_RESOURCE_FACTS,
  quota: {},
  compute: { ownedOrRented: "unknown" }
};
const observation = (id: string): DiscoveryObservation => ({
  bindingId: id,
  connectionId: "conn",
  model: id,
  observedAtIso: new Date(0).toISOString(),
  source: "test",
  installed: "yes",
  access: "allowed",
  health: "reachable",
  apiCompatibility: ["ollama-chat"]
});
it("atomically replaces complete discovery and preserves prior validity on partial, oversized or invalid listings", async () => {
  const adapter = { discover: vi.fn() };
  const limits = discoveryLimitsSchema.parse({
    maxModelsPerConnection: 2,
    maxObservations: 2,
    maxBytes: 2000
  });
  const store = new InventoryStore(
    { "ollama-chat": adapter },
    { intervalMs: 1000, ttlMs: 1000, timeoutMs: 1000, maxConcurrentRequests: 4 },
    () => new Date(0),
    limits
  );
  for (let n = 0; n < 50; n++) {
    adapter.discover.mockResolvedValueOnce([observation(`m${n}`)]);
    await store.refreshConnection(connection);
    expect(store.listObservations().map((o) => o.model)).toEqual([`m${n}`]);
  }
  const before = store.listObservations();
  const exported = store.getObservation("m49")!;
  exported.source = "x".repeat(3000);
  expect(store.listObservations()).toEqual(before);
  for (const listing of [
    { observations: [observation("partial")], complete: false },
    [observation("a"), observation("b"), observation("c")],
    [{ ...observation("a"), source: "x".repeat(3000) }],
    [observation("a"), { ...observation("bad"), observedAtIso: "invalid" }]
  ]) {
    adapter.discover.mockResolvedValueOnce(listing);
    await store.refreshConnection(connection);
    expect(store.listObservations()).toEqual(before);
  }
  adapter.discover.mockResolvedValueOnce([]);
  await store.refreshConnection(connection);
  expect(store.retentionStats().observations).toBe(0);
  expect(
    computeReadiness({
      enabled: true,
      adapterImplemented: true,
      observation: store.getObservation("m49"),
      nowIso: new Date(0).toISOString()
    })
  ).toBe("unchecked");
});
it("cancels oversized streamed discovery bodies before JSON parsing", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(101)));
      },
      cancel() {
        cancelled = true;
      }
    })
  );
  await expect(readDiscoveryJson(response, { remaining: 100 })).rejects.toThrow(
    "DISCOVERY_RESPONSE_TOO_LARGE"
  );
  expect(cancelled).toBe(true);
});

it("caps the Bedrock SDK response stream before deserialization", async () => {
  const { createServer } = await import("node:http");
  const { BoundedDiscoveryHttpHandler } =
    await import("../../src/models/discovery/bedrockDiscovery");
  const server = createServer((_req, res) => res.end("x".repeat(101)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handler = new BoundedDiscoveryHttpHandler(100);
  try {
    const address = server.address() as import("node:net").AddressInfo;
    await expect(
      handler.handle({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: address.port,
        method: "GET",
        path: "/",
        headers: {},
        query: {},
        clone() {
          return this;
        }
      })
    ).rejects.toThrow("DISCOVERY_RESPONSE_TOO_LARGE");
  } finally {
    handler.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("bounds queued task bytes and restores byte accounting after removal and dequeue", async () => {
  const queue = new InMemoryTaskQueue(100, 400);
  await queue.enqueue(task("a"));
  const before = queue.retentionStats();
  await expect(
    queue.enqueue({ ...task("large"), normalizedPrompt: "x".repeat(500) })
  ).rejects.toMatchObject({ code: "DEEP_QUEUE_CAPACITY" });
  expect(queue.retentionStats()).toEqual(before);
  queue.removeMessage("c", "a");
  expect(queue.retentionStats().bytes).toBe(0);
  await queue.enqueue(task("b"));
  await queue.dequeue();
  expect(queue.retentionStats().bytes).toBe(0);
});
