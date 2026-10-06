import { createChatServer } from "../../server";
import { createEphemeralAuth } from "../../auth/ephemeral";
import { createRuntimeHandle } from "../../app/runtimeHandle";
import { ChatOrchestrator, DeepWorker } from "../../app/orchestrator";
import { ChatService } from "../../app/chatService";
import { ContextManager } from "../../app/contextManager";
import {
  InMemoryTaskQueue,
  type FastModelProvider,
  type DeepModelProvider
} from "../../providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../providers/mockProviders";
import { GenerationError } from "../../domain/generation";
import type { ConversationContext } from "../../domain/context";
import type { InMemoryConversationTimelineStore } from "../../app/timelineStore";
import { runLiveBenchmark } from "../../bench/liveBenchmark";
import { canonical, type Dataset } from "./contract";

/** Dedicated local HTTP runtime: no environment-selected providers or application server. */
export async function startHttpOverhead(
  timeline: InMemoryConversationTimelineStore,
  dataset: Dataset,
  persist: () => Promise<void>
) {
  const queue = new InMemoryTaskQueue();
  const manager = new ContextManager(timeline, {
    windowTokens: 8192,
    maxHistoryTurns: 12,
    safetyTokens: 256,
    fastOutputTokens: 512,
    deepOutputTokens: 2048
  });
  const requests: unknown[] = [],
    conversations = new Map<string, string>(),
    attempted = new Set<string>();
  const fastMock = new MockFastProvider(),
    deepMock = new MockDeepProvider();
  const context = (value?: ConversationContext) =>
    value
      ? {
          systemInstruction: value.systemInstruction,
          roleInstructions: value.roleInstructions,
          messages: value.messages.map((m) => ({ role: m.role, content: m.content })),
          memory: value.memory,
          activeTasks: value.activeTasks,
          estimatedInputTokens: value.estimatedInputTokens
        }
      : null;
  const fast: FastModelProvider = {
    metadata: fastMock.metadata,
    createProvisionalReply: async (input, control) => {
      conversations.set(input.message.text, input.message.conversationId);
      requests.push({
        phase: "fast",
        prompt: input.message.text,
        correctedText: input.correctedText,
        route: input.routeDecision,
        context: context(input.context)
      });
      return fastMock.createProvisionalReply(input, control);
    }
  };
  const deep: DeepModelProvider = {
    metadata: deepMock.metadata,
    resolveDeepTask: async (input, control) => {
      const retry = attempted.has(input.taskId);
      attempted.add(input.taskId);
      requests.push({
        phase: "deep",
        prompt: input.normalizedPrompt,
        retry,
        context: context(input.context)
      });
      if (!retry) throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      return deepMock.resolveDeepTask(input, control);
    }
  };
  const orchestrator = new ChatOrchestrator(fast, queue, timeline, undefined, manager, () => ({
    fastProvider: "mock",
    fastModel: "mock-v1",
    deepProvider: "mock",
    deepModel: "mock-v1",
    generatedAtIso: "2026-09-30T00:00:00.000Z"
  }));
  const service = new ChatService(
    orchestrator,
    new DeepWorker(queue, deep, timeline),
    timeline,
    queue
  );
  // In-process server: an in-memory identity, and the client token for its requests.
  const ephemeral = createEphemeralAuth();
  const server = createChatServer(service, { auth: ephemeral.auth });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  let workerError: unknown;
  const worker = setInterval(() => {
    void service.runDeepWorkerOnce().catch((error) => {
      workerError = error;
    });
  }, 5);
  const handle = createRuntimeHandle(server, service, {
    config: { graceMs: 100, timeoutMs: 5000 },
    stopBackground: () => clearInterval(worker),
    stopInternal: () => manager.shutdown(),
    persist
  });
  return {
    close: () => handle.shutdown(),
    run: async () => {
      const records = await runLiveBenchmark(dataset.prompts, {
        baseUrl: `http://127.0.0.1:${handle.address.port}`,
        headers: ephemeral.headers("client"),
        deadlineMs: 5000,
        pollIntervalMs: 5
      });
      if (
        workerError ||
        records.length !== dataset.prompts.length ||
        records.some((r) => r.outcome !== "stop" || r.evidenceMode !== "synthetic")
      )
        throw new Error("EVAL_HTTP_WORKLOAD_FAILED");
      const turns = [];
      let eventCount = 0;
      for (const [i, prompt] of dataset.prompts.entries()) {
        const conversation = conversations.get(prompt.text);
        if (!conversation) throw new Error("EVAL_HTTP_MISSING_TURN");
        const events = await timeline.getEvents(conversation);
        eventCount += events.length;
        const expectedDeep = i % 2 === 1;
        if (
          records[i].routeDecision !== (expectedDeep ? "deep" : "direct") ||
          records[i].retryCount !== (expectedDeep ? 1 : 0)
        )
          throw new Error("EVAL_HTTP_UNEXPECTED_ROUTE_OR_RETRY");
        turns.push({
          promptId: prompt.id,
          route: records[i].routeDecision,
          phases: ["fast", "deep"].map((phase) => ({
            phase,
            events: events
              .filter(
                (e) => e.phase === phase && ["provisional", "refined", "terminal"].includes(e.type)
              )
              .map((e) => ({
                type: e.type,
                text: e.text,
                finishReason: e.finishReason,
                retrying: e.retrying,
                model: e.model && {
                  provider: e.model.provider,
                  model: e.model.model,
                  bindingId: e.model.bindingId
                }
              }))
          }))
        });
      }
      return {
        output: { requests: requests.map(canonical).sort(), turns },
        eventCount,
        observations: records.map((r) => ({
          promptId: r.promptId,
          firstAnswerObservedMs: r.firstAnswerObservedMs,
          finalObservedMs: r.finalObservedMs,
          elapsedMs: r.elapsedMs
        }))
      };
    }
  };
}
