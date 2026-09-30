import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager } from "../../src/app/contextManager";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ChatService } from "../../src/app/chatService";
import type { DeepResult, DeepTask } from "../../src/domain/types";
import type { DeepModelProvider } from "../../src/providers/interfaces";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { AdaptiveRoutingCoordinator } from "../../src/routing/adaptiveRouting";
import { createChatServer } from "../../src/server";
import { InMemoryLatencyEstimator } from "../../src/telemetry/latencyEstimator";
import { describeModelCatalog, loadModelCatalog, modelCatalogSchema } from "../../src/config/modelCatalog";
import { bindingKey } from "../../src/models/connections";
import type { ModelObservation } from "../../src/models/inventory";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});

describe("chat server", () => {
  it("serves the model inventory with fixed routing and unchecked availability", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const service = new ChatService(new ChatOrchestrator(new MockFastProvider(), queue, timeline),
      new DeepWorker(queue, new MockDeepProvider(), timeline), timeline);
    const modelCatalog = describeModelCatalog(await loadModelCatalog(), {
      fast: { provider: "mock", model: "mock-v1", temperature: 0.2 },
      deep: { provider: "mock", model: "mock-v1", temperature: 0.2 }
    });
    const server = createChatServer(service, { modelCatalog: () => modelCatalog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(modelCatalog);
  });
  it("serves fresh-ready local and stale cloud fixtures with distinct availability over GET /models (spec 03)", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const service = new ChatService(new ChatOrchestrator(new MockFastProvider(), queue, timeline),
      new DeepWorker(queue, new MockDeepProvider(), timeline), timeline);

    const baseEntry = (await loadModelCatalog()).models.find(entry => entry.id === "mock-default")!;
    const catalog = modelCatalogSchema.parse({
      version: 1,
      models: [
        { ...baseEntry, id: "local-fixture", provider: "ollama", model: "qwen3:8b" },
        { ...baseEntry, id: "cloud-fixture", provider: "bedrock", model: "anthropic.model-deep" }
      ]
    });
    const config = {
      fast: { provider: "ollama" as const, model: "qwen3:8b", temperature: 0.2 },
      deep: { provider: "azure" as const, model: "custom-deployment", temperature: 0.2 },
      azure: { endpoint: "https://example.test", apiKey: "test-secret", apiVersion: "test" }
    };

    const freshLocal: ModelObservation = {
      bindingId: bindingKey("default-ollama", "ollama-chat", "qwen3:8b"),
      connectionId: "default-ollama", model: "qwen3:8b",
      observedAtIso: "2026-09-29T00:00:00.000Z", expiresAtIso: "2099-01-01T00:00:00.000Z",
      source: "ollama-api-tags", installed: "yes", access: "allowed", health: "reachable", apiCompatibility: ["ollama-chat"]
    };
    const staleCloud: ModelObservation = {
      bindingId: bindingKey("default-bedrock", "bedrock-converse", "anthropic.model-deep"),
      connectionId: "default-bedrock", model: "anthropic.model-deep",
      observedAtIso: "2000-01-01T00:00:00.000Z", expiresAtIso: "2000-01-01T00:10:00.000Z",
      source: "bedrock-list-foundation-models", installed: "yes", access: "unknown", health: "reachable", apiCompatibility: ["bedrock-converse"]
    };

    const modelCatalog = () => describeModelCatalog(catalog, config, { observations: [freshLocal, staleCloud] });
    const server = createChatServer(service, { modelCatalog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/models`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { models: Array<{ id: string; availability: string }>; discovered: unknown[] };

    expect(payload.models.find((m) => m.id === "local-fixture")?.availability).toBe("ready");
    expect(payload.models.find((m) => m.id === "cloud-fixture")?.availability).toBe("stale");
    expect(payload.discovered).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("test-secret");
  });
  it("streams conversation timeline over SSE", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-stream",
        userId: "user-http",
        text: "hello from stream test"
      })
    });

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/conversations/conv-stream/events/stream`, {
      signal: controller.signal
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const chunk = await reader!.read();
    controller.abort();

    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(text).toContain("event: timeline");
    expect(text).toContain("hello from stream test");
  });

  it("serves the UI shell on GET /", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("ChatAgent Fast + Deep Thread");
    expect(body).toContain('id="runtimeMode"');
    expect(body).toContain('id="fastProvider"');
    expect(body).toContain('id="deepProvider"');
    expect(body).toContain("const runtimeInfo =");
    expect(body).toContain("/events/stream");
  });

  it("supports provisional then refined flow through HTTP endpoints", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const messageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-http",
        userId: "user-http",
        text: "Find latest inflation data and cite sources"
      })
    });

    expect(messageResponse.status).toBe(200);

    const messagePayload = (await messageResponse.json()) as {
      fastResponse: { processingStatus: string };
    };
    expect(messagePayload.fastResponse.processingStatus).toBe("provisional");

    const runWorkerResponse = await fetch(`${baseUrl}/workers/deep/run-once`, {
      method: "POST"
    });
    expect(runWorkerResponse.status).toBe(200);

    const eventsResponse = await fetch(`${baseUrl}/conversations/conv-http/events`);
    expect(eventsResponse.status).toBe(200);

    const eventsPayload = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(eventsPayload.events.map((e) => e.type)).toEqual(["user", "activity", "activity", "delta", "provisional", "terminal", "activity", "delta", "refined", "terminal"]);
  });

  it("exposes dead-letter records and supports replay", async () => {
    class AlwaysFailingProvider implements DeepModelProvider {
      async resolveDeepTask(_input: DeepTask): Promise<DeepResult> {
        throw new Error("forced failure");
      }
    }

    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const deadLetters = new InMemoryDeadLetterStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new AlwaysFailingProvider(), timeline, 0, deadLetters);
    const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-dead-letter-http",
        userId: "user-http",
        text: "Find latest inflation data and cite sources"
      })
    });

    await fetch(`${baseUrl}/workers/deep/run-once`, { method: "POST" });

    const listResponse = await fetch(`${baseUrl}/workers/deep/dead-letters`);
    expect(listResponse.status).toBe(200);

    const listPayload = (await listResponse.json()) as {
      records: Array<{ task: { taskId: string } }>;
    };
    expect(listPayload.records.length).toBe(1);

    const taskId = listPayload.records[0].task.taskId;
    const replayResponse = await fetch(`${baseUrl}/workers/deep/dead-letters/${taskId}/replay`, {
      method: "POST"
    });
    expect(replayResponse.status).toBe(200);

    const listAfterReplay = await fetch(`${baseUrl}/workers/deep/dead-letters`);
    const afterPayload = (await listAfterReplay.json()) as {
      records: Array<{ task: { taskId: string } }>;
    };
    expect(afterPayload.records.length).toBe(0);
    expect(queue.size()).toBe(1);
  });

  it("exposes latency telemetry and supports policy tuning", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();

    const estimator = new InMemoryLatencyEstimator();
    estimator.seedPrior(
      {
        provider: "mock",
        model: "mock-v1",
        route: "direct",
        sizeBand: "medium"
      },
      { p50: 500, p90: 900, p95: 1300, p99: 2000 }
    );

    const adaptive = new AdaptiveRoutingCoordinator(
      estimator,
      { provider: "mock", model: "mock-v1" },
      { provider: "mock", model: "mock-v1" },
      { maxFastP95Ms: 1000 }
    );

    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline, adaptive);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline, 2, undefined, adaptive);
    const service = new ChatService(orchestrator, worker, timeline, queue, undefined, adaptive);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const telemetryResponse = await fetch(`${baseUrl}/telemetry/latency`);
    expect(telemetryResponse.status).toBe(200);

    const telemetryPayload = (await telemetryResponse.json()) as {
      policy: { maxFastP95Ms: number };
      estimates: Array<{ p95: number }>;
      queueDepth?: number;
      runtimeMode?: { mode: string };
    };

    expect(telemetryPayload.policy.maxFastP95Ms).toBe(1000);
    expect(telemetryPayload.estimates.length).toBeGreaterThan(0);
    expect(typeof telemetryPayload.queueDepth).toBe("number");
    expect(telemetryPayload.runtimeMode?.mode).toBe("unknown");

    const tuneResponse = await fetch(`${baseUrl}/routing/policy/tune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queueDepth: 10 })
    });

    expect(tuneResponse.status).toBe(200);

    const tunePayload = (await tuneResponse.json()) as {
      policy: { maxFastP95Ms: number };
    };

    expect(tunePayload.policy.maxFastP95Ms).toBeLessThan(1000);

    const setResponse = await fetch(`${baseUrl}/routing/policy/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxFastP95Ms: 1400 })
    });

    expect(setResponse.status).toBe(200);

    const setPayload = (await setResponse.json()) as {
      policy: { maxFastP95Ms: number };
    };

    expect(setPayload.policy.maxFastP95Ms).toBe(1400);
  });

  it("returns 400 for malformed JSON payloads", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const messageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });

    expect(messageResponse.status).toBe(400);

    const messagePayload = (await messageResponse.json()) as { error: string };
    expect(messagePayload.error).toBe("Invalid JSON body");

    const policyResponse = await fetch(`${baseUrl}/routing/policy/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });

    expect(policyResponse.status).toBe(400);

    const policyPayload = (await policyResponse.json()) as { error: string };
    expect(policyPayload.error).toBe("Invalid JSON body");
  });

  it("returns 409 when a different userId submits to an already-claimed conversation", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-owner", userId: "alice", text: "hello" })
    });

    const conflictResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-owner", userId: "bob", text: "hi" })
    });

    expect(conflictResponse.status).toBe(409);
    const payload = (await conflictResponse.json()) as { code?: string };
    expect(payload.code).toBe("CONVERSATION_OWNER_MISMATCH");

    const events = await (await fetch(`${baseUrl}/conversations/conv-owner/events`)).json() as { events: Array<{ type: string }> };
    expect(events.events.filter((e) => e.type === "user")).toHaveLength(1);
  });

  it("returns 413 CONTEXT_TOO_LARGE for an oversized message without appending events", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const tinyBudget = { windowTokens: 10, maxHistoryTurns: 12, safetyTokens: 0, fastOutputTokens: 1, deepOutputTokens: 1 };
    const contextManager = new ContextManager(timeline, tinyBudget);
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline, undefined, contextManager);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-huge", userId: "user-huge", text: "a".repeat(500) })
    });

    expect(response.status).toBe(413);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("CONTEXT_TOO_LARGE");

    const events = await (await fetch(`${baseUrl}/conversations/conv-huge/events`)).json() as { events: unknown[] };
    expect(events.events).toEqual([]);
    expect(queue.size()).toBe(0);
  });

  it("returns 400 for null and invalid object bodies", async () => {
    const queue = new InMemoryTaskQueue();
    const timeline = new InMemoryConversationTimelineStore();
    const orchestrator = new ChatOrchestrator(new MockFastProvider(), queue, timeline);
    const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
    const service = new ChatService(orchestrator, worker, timeline);

    const server = createChatServer(service);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const nullMessageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null"
    });

    expect(nullMessageResponse.status).toBe(400);
    expect((await nullMessageResponse.json()) as { error: string }).toEqual({
      error: "Request body must be a JSON object"
    });

    const invalidMessageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "", userId: "u1", text: "hello" })
    });

    expect(invalidMessageResponse.status).toBe(400);

    const nullPolicyResponse = await fetch(`${baseUrl}/routing/policy/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null"
    });

    expect(nullPolicyResponse.status).toBe(400);

    const invalidTuneResponse = await fetch(`${baseUrl}/routing/policy/tune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queueDepth: -1 })
    });

    expect(invalidTuneResponse.status).toBe(400);
  });
});
