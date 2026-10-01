import { vi } from "vitest";
import {
  modelEntrySchema,
  type ModelEntry,
  type ModelCatalog
} from "../../src/config/modelCatalog";
import { dispatchPolicySchema, type BindingResources } from "../../src/config/dispatchConfig";
import { ProviderRegistry, entryBindingId } from "../../src/providers/providerRegistry";
import type { ModelObservation } from "../../src/models/inventory";
import type { FastModelProvider, DeepModelProvider } from "../../src/providers/interfaces";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ContextManager } from "../../src/app/contextManager";
import { CatalogDispatch } from "../../src/routing/catalogDispatch";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ChatService } from "../../src/app/chatService";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import { AdaptiveRoutingCoordinator } from "../../src/routing/adaptiveRouting";
import { InMemoryLatencyEstimator } from "../../src/telemetry/latencyEstimator";

export const now = "2026-09-29T12:00:00.000Z";
export const evidence = {
  source: "operator-fixture",
  kind: "configured" as const,
  checkedAtIso: "2026-09-29T11:00:00.000Z",
  expiresAtIso: "2026-09-30T12:00:00.000Z"
};
export const budget = {
  windowTokens: 8192,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 2048
};
export function resources(overrides: Partial<BindingResources> = {}): BindingResources {
  return {
    facts: { executionScope: "local-device", billingComponents: ["owned-compute"] },
    evidence,
    incremental: { currency: "USD", maxInvocationUsd: 0, evidence },
    ...overrides
  };
}
export function entry(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return modelEntrySchema.parse({
    id,
    provider: "mock",
    model: id,
    enabled: true,
    roles: ["fast", "deep"],
    tasks: ["conversation", "coding", "reasoning", "summarization", "extraction"],
    capabilities: {
      thinking: "unknown",
      tools: "unsupported",
      vision: "unsupported",
      structuredOutput: "supported"
    },
    limits: { contextTokens: 8192, maxOutputTokens: 2048 },
    deployment: "unknown",
    ...overrides
  });
}
export function observation(e: ModelEntry): ModelObservation {
  return {
    bindingId: entryBindingId(e),
    connectionId: `default-${e.provider}`,
    model: e.model,
    installed: "yes",
    access: "allowed",
    health: "reachable",
    apiCompatibility: ["mock"],
    observedAtIso: now,
    expiresAtIso: evidence.expiresAtIso,
    revision: "rev-1",
    source: "fixture"
  };
}
export function runtime(
  entries = [entry("a")],
  behaviors: Record<string, { fast?: FastModelProvider; deep?: DeepModelProvider }> = {},
  observer?: ConstructorParameters<typeof InMemoryConversationTimelineStore>[0]
) {
  const catalog: ModelCatalog = { version: 1, models: entries };
  const registry = new ProviderRegistry();
  const observations = entries.map(observation);
  const policy = dispatchPolicySchema.parse({
    bindings: Object.fromEntries(entries.map((e) => [e.id, resources()]))
  });
  const calls = new Map<string, { fast: FastModelProvider; deep: DeepModelProvider }>();
  for (const e of entries) {
    const fast: FastModelProvider = behaviors[e.id]?.fast ?? {
      createProvisionalReply: vi.fn(async () => ({ text: e.id, finishReason: "stop" as const }))
    };
    const deep: DeepModelProvider = behaviors[e.id]?.deep ?? {
      resolveDeepTask: vi.fn(async (task) => ({
        taskId: task.taskId,
        finalReply: e.id,
        finishReason: "stop" as const,
        confidence: 1,
        citations: [],
        totalLatencyMs: 1
      }))
    };
    calls.set(e.id, { fast, deep });
    registry.register({
      bindingId: entryBindingId(e),
      entry: e,
      connection: {
        connectionId: `default-${e.provider}`,
        apiKind: "mock",
        resourceFacts: resources().facts,
        quota: {},
        compute: { ownedOrRented: "unknown" }
      },
      fast,
      deep,
      capabilities: ["structuredOutput"]
    });
  }
  const dispatch = new CatalogDispatch(
    catalog,
    registry,
    policy,
    budget,
    () => observations,
    () => new Date(now)
  );
  const timeline = new InMemoryConversationTimelineStore(observer),
    queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore();
  const manager = new ContextManager(timeline, budget);
  const adaptive = new AdaptiveRoutingCoordinator(
    new InMemoryLatencyEstimator(),
    { provider: "mock", model: "fixed" },
    { provider: "mock", model: "fixed" }
  );
  const unusedFast = { createProvisionalReply: vi.fn() },
    unusedDeep = { resolveDeepTask: vi.fn() };
  const orchestrator = new ChatOrchestrator(
    unusedFast,
    queue,
    timeline,
    adaptive,
    manager,
    undefined,
    dispatch
  );
  const worker = new DeepWorker(queue, unusedDeep, timeline, 2, dead, adaptive, dispatch);
  const service = new ChatService(orchestrator, worker, timeline, queue, dead, adaptive);
  return {
    catalog,
    registry,
    observations,
    policy,
    dispatch,
    timeline,
    queue,
    manager,
    orchestrator,
    worker,
    service,
    calls,
    unusedFast,
    unusedDeep
  };
}
export const message = (text = "Explain code", messageId = "turn-1") => ({
  text,
  messageId,
  userId: "u",
  conversationId: "c",
  timestampIso: now
});
