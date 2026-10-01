import { toolResultSchema } from "../../src/app/toolResult";
import { RoleCatalog } from "../../src/app/roleCatalog";
import { createLiveBriefing } from "../../src/sports/liveBriefing";
import { readFileSync } from "node:fs";
const sportsConfig = JSON.parse(readFileSync("data/sports/nfl-live-briefing.example.json", "utf8"));
import { CapabilityChat } from "../../src/app/capabilityChat";
import { ContextManager } from "../../src/app/contextManager";
import { test as base, expect } from "@playwright/test";
import { createChatServer } from "../../src/server";
import { createRuntimeHandle } from "../../src/app/runtimeHandle";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import {
  InMemoryTaskQueue,
  type FastModelProvider,
  type DeepModelProvider
} from "../../src/providers/interfaces";
import {
  GenerationError,
  type GenerationControl,
  type GenerationResult
} from "../../src/domain/generation";

async function runtime() {
  const pending = new Map<string, { emit(text: string): Promise<void>; finish(): void }>();
  const controls: {
    worker: boolean;
    plan: unknown | null;
    inputs: unknown[];
    referenceSourceUrl?: string;
    referenceCell?: string;
  } = { worker: true, plan: null, inputs: [] };
  async function generate(
    phase: string,
    text: string,
    control?: GenerationControl
  ): Promise<GenerationResult> {
    if (phase === "fast") await control?.onDelta(`Draft: ${text}`);
    if (phase === "fast" && text.includes("cite"))
      return { text: `Draft: ${text}`, finishReason: "stop" };
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        pending.delete(`${phase}:${text}`);
        reject(new GenerationError("CANCELLED", false));
      };
      if (control?.signal.aborted) return abort();
      control?.signal.addEventListener("abort", abort, { once: true });
      pending.set(`${phase}:${text}`, {
        emit: async (chunk) => {
          await control?.onDelta(chunk);
        },
        finish: () => {
          control?.signal.removeEventListener("abort", abort);
          pending.delete(`${phase}:${text}`);
          resolve();
        }
      });
    });
    if (text.includes("auth failure")) throw new GenerationError("PROVIDER_AUTH", false);
    if (text.includes("quota failure")) throw new GenerationError("QUOTA_EXHAUSTED", false);
    if (text.includes("provider failure")) throw new GenerationError("PROVIDER_ERROR", false);
    return {
      text: `${phase === "deep" ? "Refined" : "Final"}: ${text}`,
      finishReason: text.includes("length limit") ? "length" : "stop"
    };
  }
  const fast: FastModelProvider = {
    metadata: { provider: "mock", model: "browser-fast" },
    createProvisionalReply: (input, c) => generate("fast", input.message.text, c)
  };
  const deep: DeepModelProvider = {
    metadata: { provider: "mock", model: "browser-deep", reasoningEnabled: true },
    resolveDeepTask: async (task, c) => {
      const result = await generate("deep", task.normalizedPrompt, c);
      return {
        taskId: task.taskId,
        finalReply: result.text,
        finishReason: result.finishReason,
        confidence: 1,
        citations: [],
        totalLatencyMs: 0
      };
    }
  };
  const timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue();
  const sports = createLiveBriefing(sportsConfig, "fixture-key", (async (url) =>
    String(url).includes("/games")
      ? Response.json({
          data: [
            {
              id: 10,
              datetime: "2026-09-28T20:00:00Z",
              status_state: "final",
              home_team: { id: 1, full_name: "Harbor <Comets>" },
              visitor_team: { id: 2, full_name: "Visitor Stars" },
              home_team_score: 101,
              visitor_team_score: 98
            }
          ],
          meta: { next_cursor: null }
        })
      : Response.json({
          data: [
            {
              id: 1,
              full_name: "Harbor <Comets>",
              name: "Comets",
              abbreviation: "HC",
              city: "Harbor"
            },
            {
              id: 2,
              full_name: "PRIVATE_OTHER_ROW",
              name: "Other",
              abbreviation: "PO",
              city: "Elsewhere"
            }
          ]
        })) as typeof fetch);
  const legacy = new ChatOrchestrator(fast, queue, timeline);
  const planner = new CapabilityChat(
    {
      metadata: { provider: "mock", model: "test-planner" },
      createProvisionalReply: async (input) => {
        controls.inputs.push(input);
        return { text: JSON.stringify(controls.plan), finishReason: "stop" };
      }
    },
    queue,
    timeline,
    new ContextManager(timeline, {
      windowTokens: 16384,
      maxHistoryTurns: 12,
      safetyTokens: 256,
      fastOutputTokens: 512,
      deepOutputTokens: 2048
    }),
    () => ({
      fastProvider: "mock",
      fastModel: "test-planner",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date().toISOString()
    }),
    () =>
      sports.http.tools().map((tool) => ({
        ...tool,
        execute: async (args, user, request, signal, conversation) => {
          const result = await tool.execute(args, user, request, signal, conversation);
          if (!controls.referenceSourceUrl) return result;
          const parsed = toolResultSchema.parse(result);
          if (controls.referenceCell && parsed.payload)
            parsed.payload.rows[0][0] = controls.referenceCell;
          return sports.http.directory!.results.put(user, conversation!, {
            ...parsed,
            evidence: { ...parsed.evidence, sourceUrl: controls.referenceSourceUrl }
          });
        }
      })),
    undefined,
    new RoleCatalog({
      version: "role-catalog-v1",
      roles: [
        {
          id: "writer",
          version: "1",
          bindingId: "fixed",
          instructions: "Use selected evidence only.",
          toolIds: [],
          maxToolCalls: 0,
          maxInputTokens: 6000
        },
        {
          id: "researcher",
          version: "1",
          bindingId: "fixed",
          instructions: "Find evidence.",
          toolIds: ["sports:list-teams", "sports:find-games"],
          maxToolCalls: 2,
          maxInputTokens: 6000
        }
      ]
    }),
    "native",
    () => sports.http.directory?.results
  );
  const service = new ChatService(
    {
      handleUserMessage: (message) =>
        controls.plan ? planner.handleUserMessage(message) : legacy.handleUserMessage(message),
      runControlOptions: () => planner.runControlOptions(),
      thinkingOptions: (id) => planner.thinkingOptions(id),
      cancel: (conversation, message) => legacy.cancel(conversation, message),
      whenIdle: () => planner.whenIdle()
    },
    new DeepWorker(queue, deep, timeline),
    timeline,
    queue
  );
  const server = createChatServer(service, { briefings: sports.http });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let workerError: unknown;
  const worker = setInterval(() => {
    if (controls.worker)
      void service.runDeepWorkerOnce().catch((e) => {
        workerError = e;
      });
  }, 10);
  const handle = createRuntimeHandle(server, service, {
    config: { graceMs: 0, timeoutMs: 2000 },
    stopBackground: () => clearInterval(worker),
    stopInternal: async () => {},
    persist: async () => {}
  });
  return {
    url: `http://127.0.0.1:${handle.address.port}`,
    pending,
    controls,
    disconnect: () => server.closeStreams(),
    close: async () => {
      await handle.shutdown();
      sports.http.close();
      if (workerError) throw workerError;
    }
  };
}
export const test = base.extend<{ app: Awaited<ReturnType<typeof runtime>> }>({
  app: async ({}, use) => {
    const app = await runtime();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  }
});
export { expect };
