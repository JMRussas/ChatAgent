import { toolResultSchema } from "../../src/app/toolResult";
import { RoleCatalog } from "../../src/app/roleCatalog";
import { createLiveBriefing } from "../../src/sports/liveBriefing";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DispatchHost,
  ORIGINAL_CONTAINER_WORKSPACE,
  REQUIRED_SOURCE_PATHS
} from "../../src/integrations/hekate/dispatchHost";
const sportsConfig = JSON.parse(readFileSync("data/sports/nfl-live-briefing.example.json", "utf8"));
import { CapabilityChat } from "../../src/app/capabilityChat";
import { ContextManager } from "../../src/app/contextManager";
import { test as base, expect } from "@playwright/test";
import { createChatServer } from "../../src/server";
import { createEphemeralAuth } from "../../src/auth/ephemeral";
import { PairingController } from "../../src/auth/pairing";
import type { Page } from "@playwright/test";
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

/**
 * A real DispatchHost over paths that do not exist, with a spawn that always throws: a pin
 * check fails before any native call, so no Python, Hekate or model can ever run. Specs stub
 * the browser's dispatch requests with page.route; only the auth boundary tests reach it.
 */
function inertDispatchHost() {
  const base = path.join(tmpdir(), `chatagent-inert-dispatch-${process.pid}`);
  const zero = "0".repeat(64);
  const guid = (n: string) =>
    `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  return new DispatchHost(
    {
      journalDir: path.join(base, "journal"),
      containerWorkspace: ORIGINAL_CONTAINER_WORKSPACE,
      traceRoot: path.join(base, "trace"),
      python: { executable: path.join(base, "python"), sha256: zero, version: "inert" },
      source: {
        e1Root: path.join(base, "e1"),
        files: REQUIRED_SOURCE_PATHS.map((rel) => ({ path: rel, sha256: zero })),
        uvLock: { path: "uv.lock", sha256: zero }
      },
      bounds: {
        stdoutBytes: 1024,
        stderrBytes: 1024,
        commandDeadlineMs: 1000,
        launchDeadlineMs: 2000,
        waitS: 1,
        toolMaxBytes: 1024,
        pinDeadlineMs: 1000
      },
      roots: [
        {
          rootId: "11111111-2222-4333-8444-555555555555",
          taskId: guid("a"),
          stateDir: path.join(base, "state"),
          planFile: path.join(base, "plan.json"),
          planSha256: zero,
          importSha256: zero,
          runRoot: path.join(base, "trace", "run"),
          executable: path.join(base, "model"),
          executableSha256: zero,
          worker: "claude",
          rootGo: "inert",
          actor: "inert",
          limits: { maxDurationS: 60, pollS: 5, maxPollS: 5, heartbeatS: 5, maxNodes: 1 }
        }
      ]
    },
    {
      spawn: () => {
        throw new Error("browser fixtures never start a process");
      },
      env: {}
    }
  );
}

async function runtime(
  maxEventStreams?: number,
  documentationTasks = false,
  planStatus = false,
  planRunControls = false,
  attemptProgress = false
) {
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
  let idleSkewMs = 0;
  const timeline = new InMemoryConversationTimelineStore(
      undefined,
      undefined,
      () => Date.now() + idleSkewMs
    ),
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
  // Real authentication: an in-memory identity and the real pairing flow.
  const ephemeral = createEphemeralAuth();
  const pairing = new PairingController();
  const tasks: Array<{
    taskId: string;
    conversationId: unknown;
    question: string;
    status: string;
    createdAt: number;
    scheduled: boolean;
    answer: null | {
      status?: string;
      answer: string;
      citations: Array<{ path: string; start_line: number; end_line: number }>;
    };
  }> = [];
  const server = createChatServer(service, {
    ...(documentationTasks
      ? {
          documentTasks: {
            close() {},
            async request(data: Record<string, unknown>) {
              if (data.op === "list")
                return tasks.filter((t) => t.conversationId === data.conversationId);
              if (data.op === "start") {
                const task = {
                  taskId: (tasks.length + 1).toString(16).padStart(32, "0"),
                  conversationId: data.conversationId,
                  question: String(data.question),
                  status: "running",
                  createdAt: Date.now() / 1000,
                  scheduled: true,
                  answer: null
                };
                tasks.push(task);
                return task;
              }
              const task = tasks.find(
                (t) => t.taskId === data.taskId && t.conversationId === data.conversationId
              );
              if (!task) throw new Error("Unknown task");
              if (data.op === "cancel") {
                task.status = "cancelled";
                task.scheduled = false;
              }
              return task;
            }
          }
        }
      : {}),
    // Enables the panel and route only; specs stub the browser's plan requests with
    // page.route, so no Hekate is contacted. The discard port is never listening.
    ...(planStatus ? { planApiUrl: "http://127.0.0.1:9" } : {}),
    ...(planRunControls ? { dispatchHost: inertDispatchHost() } : {}),
    // Opt-in progress route and panel; specs stub the browser's requests with page.route and
    // the server's own observer can only reach the never-listening discard port.
    ...(attemptProgress ? { attemptProgress: true } : {}),
    briefings: sports.http,
    maxEventStreams,
    auth: ephemeral.auth,
    pairing: {
      controller: pairing,
      issueSession: ephemeral.issueSession,
      announce: () => undefined
    }
  });
  let streamRefusals = 0;
  server.on("request", (req, res) =>
    res.once("finish", () => {
      if (req.url?.includes("/events/stream") && res.statusCode === 429) streamRefusals++;
    })
  );
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
    tasks,
    controls,
    disconnect: () => server.closeStreams(),
    /** Pairs the browser through the real /pair page, using a code read from the controller. */
    pair: async (page: Page) => {
      const code = pairing.issue();
      await page.goto(`http://127.0.0.1:${handle.address.port}/pair`);
      await page.locator("#pairCode").fill(code);
      await page.getByRole("button", { name: "Pair" }).click();
      await page.waitForURL(`http://127.0.0.1:${handle.address.port}/`);
    },
    /** Issues a code without pairing, for tests of the pairing page itself. */
    issuePairingCode: () => pairing.issue(),
    /** Invalidates every session and token, as an operator rotation would. */
    rotateCredentials: () => ephemeral.rotate(),
    bearer: (role: "client" | "operator" = "client") => ephemeral.headers(role),
    /** Occupies one event-stream slot from outside the page until the returned release. */
    holdStream: async () => {
      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${handle.address.port}/conversations/holder/events/stream`,
        {
          headers: ephemeral.headers("client"),
          signal: controller.signal
        }
      );
      if (response.status !== 200) throw new Error(`holder refused: ${response.status}`);
      // Keep a live reader: an unreferenced response body can be collected and its
      // connection closed, which would silently free the slot.
      const reader = response.body!.getReader();
      return () => {
        void reader.cancel().catch(() => undefined);
        controller.abort();
      };
    },
    streamSlots: () => server.retentionStats().streams,
    streamRefusals: () => streamRefusals,
    // Moves the retention clock past the idle TTL; settled conversations expire lazily.
    expireIdleConversations: () => {
      idleSkewMs += 2 * 86400000;
    },
    close: async () => {
      await handle.shutdown();
      sports.http.close();
      if (workerError) throw workerError;
    }
  };
}
export const test = base.extend<{
  streamCap: number | undefined;
  documentationTasks: boolean;
  planStatus: boolean;
  planRunControls: boolean;
  attemptProgress: boolean;
  app: Awaited<ReturnType<typeof runtime>>;
}>({
  streamCap: [undefined, { option: true }],
  documentationTasks: [false, { option: true }],
  planStatus: [false, { option: true }],
  planRunControls: [false, { option: true }],
  attemptProgress: [false, { option: true }],
  app: async (
    { streamCap, documentationTasks, planStatus, planRunControls, attemptProgress },
    use
  ) => {
    const app = await runtime(
      streamCap,
      documentationTasks,
      planStatus,
      planRunControls,
      attemptProgress
    );
    try {
      await use(app);
    } finally {
      await app.close();
    }
  }
});
export { expect };
