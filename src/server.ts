import { createProtocolV1Handler } from "./app/protocolV1";
import { verifyThinkingConfig } from "./config/thinkingConfig";
import { DuplicateMessageError } from "./app/generationLifecycle";
import { GenerationError } from "./domain/generation";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ChatOrchestrator, DeepWorker } from "./app/orchestrator";
import { ChatService, ConversationOwnershipConflictError } from "./app/chatService";
import { ContextBudgetError } from "./app/contextBuilder";
import { loadSummaryConfig } from "./config/summaryConfig";
import { ModelContextSummarizer } from "./app/contextSummarizer";
import { ContextManager } from "./app/contextManager";
import { InMemoryDeadLetterStore } from "./app/deadLetterStore";
import { InMemoryConversationTimelineStore } from "./app/timelineStore";
import { loadContextBudgetConfigFromEnv, type ContextBudgetConfig } from "./config/contextConfig";
import { parseBooleanEnv, parseBoundedNumberEnv, parsePositiveIntEnv } from "./config/runtimeEnv";
import { describeProviderConfig, loadRuntimeProviderConfigFromEnv, type RuntimeProviderConfig } from "./config/providerConfig";
import type { UserMessage } from "./domain/types";
import { InMemoryTaskQueue } from "./providers/interfaces";
import { buildFastProvider, buildProviderPair } from "./providers/providerFactory";
import { AdaptiveRoutingCoordinator } from "./routing/adaptiveRouting";
import { InMemoryLatencyEstimator } from "./telemetry/latencyEstimator";
import { FileLatencyTelemetryStore } from "./telemetry/latencyTelemetryStore";
import { renderHomePageHtml } from "./ui/homePage";
import { z } from "zod";
import { describeModelCatalog, loadModelCatalog } from "./config/modelCatalog";

function seedPriorsForProfile(
  estimator: InMemoryLatencyEstimator,
  profile: { provider: string; model: string },
  route: "direct" | "deep" | "clarify",
  baseP95Ms: number
): void {
  const sizes: Array<{ sizeBand: "small" | "medium" | "large"; multiplier: number }> = [
    { sizeBand: "small", multiplier: 0.85 },
    { sizeBand: "medium", multiplier: 1 },
    { sizeBand: "large", multiplier: 1.3 }
  ];

  for (const size of sizes) {
    const p95 = Math.round(baseP95Ms * size.multiplier);
    estimator.seedPrior(
      {
        provider: profile.provider,
        model: profile.model,
        route,
        sizeBand: size.sizeBand
      },
      {
        p50: Math.round(p95 * 0.5),
        p90: Math.round(p95 * 0.8),
        p95,
        p99: Math.round(p95 * 1.5)
      }
    );
  }
}

function baseP95ByProvider(provider: string, route: "direct" | "deep" | "clarify"): number {
  if (provider === "ollama") {
    if (route === "deep") return 4200;
    if (route === "clarify") return 900;
    return 1300;
  }

  if (provider === "bedrock") {
    if (route === "deep") return 3600;
    if (route === "clarify") return 700;
    return 1050;
  }

  if (provider === "azure") {
    if (route === "deep") return 3200;
    if (route === "clarify") return 650;
    return 950;
  }

  if (route === "deep") return 3000;
  if (route === "clarify") return 600;
  return 900;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}

interface RuntimeModeInfo {
  mode: "mock" | "live" | "unknown";
  fastProvider?: string;
  fastModel?: string;
  deepProvider?: string;
  deepModel?: string;
}

interface ServerOptions {
  modelCatalog?: ReturnType<typeof describeModelCatalog>;
  runtimeMode?: RuntimeModeInfo;
  shutdown?: () => Promise<void>;
  contextTelemetry?: () => ReturnType<ContextManager["getSummaryTelemetry"]>;
}

function resolveRuntimeModeInfo(config: RuntimeProviderConfig): RuntimeModeInfo {
  const mode = config.fast.provider === "mock" && config.deep.provider === "mock" ? "mock" : "live";

  return {
    mode,
    fastProvider: config.fast.provider,
    fastModel: config.fast.model,
    deepProvider: config.deep.provider,
    deepModel: config.deep.model
  };
}

class HttpRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

const MessageBodySchema = z.object({
  messageId: z.string().uuid().optional(),
  conversationId: z.string().min(1),
  userId: z.string().min(1),
  text: z.string().min(1),
  timestampIso: z.string().min(1).optional()
});

const QueueDepthBodySchema = z.object({
  queueDepth: z.number().finite().int().nonnegative().optional()
});

const RoutingPolicyBodySchema = z.object({
  maxFastP95Ms: z.number().finite().positive().optional()
});

function resolveDeepWorkerAutoRunConfig(env: NodeJS.ProcessEnv) {
  return {
    enabled: parseBooleanEnv(env.DEEP_WORKER_AUTO_RUN, true),
    intervalMs: parsePositiveIntEnv(env.DEEP_WORKER_INTERVAL_MS, 500, 100, 60_000)
  };
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || Array.isArray(body) || typeof body !== "object") {
    throw new HttpRequestError(400, "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpRequestError(400, "Invalid JSON body");
  }
}

function writeSseEvent(res: ServerResponse, eventName: string, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${data}\n\n`);
}

export function createChatServer(service: ChatService, options: ServerOptions = {}) {
  const protocolV1 = createProtocolV1Handler(service);
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");

      if (await protocolV1(req, res, url, () => parseJsonBody(req))) return;

      if (method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHomePageHtml(options.runtimeMode));
        return;
      }

      if (method === "POST" && url.pathname === "/messages") {
        const body = MessageBodySchema.parse(requireObjectBody(await parseJsonBody(req)));

        const response = await service.submitMessage({
          messageId: body.messageId,
          conversationId: body.conversationId,
          userId: body.userId,
          text: body.text,
          timestampIso: body.timestampIso ?? new Date().toISOString()
        });

        return json(res, 200, response);
      }

      const cancelPath = url.pathname.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelPath) {
        const state = await service.cancelMessage(decodeURIComponent(cancelPath[1]), decodeURIComponent(cancelPath[2]));
        return state ? json(res, 200, state) : json(res, 404, { error: "Message not found" });
      }

      if (method === "POST" && url.pathname === "/workers/deep/run-once") {
        const result = await service.runDeepWorkerOnce();
        return json(res, 200, { result: result ?? null });
      }

      if (method === "GET" && url.pathname === "/workers/deep/dead-letters") {
        const records = await service.listDeadLetters();
        return json(res, 200, { records });
      }

      if (method === "POST" && url.pathname.startsWith("/workers/deep/dead-letters/") && url.pathname.endsWith("/replay")) {
        const parts = url.pathname.split("/");
        const taskId = parts[4];

        if (!taskId) {
          return json(res, 400, { error: "taskId is required" });
        }

        const replayed = await service.replayDeadLetter(taskId);
        if (!replayed) {
          return json(res, 404, { error: "Dead-letter task not found" });
        }

        return json(res, 200, { replayed: true, taskId });
      }

      if (method === "GET" && url.pathname === "/telemetry/context") {
        return json(res, 200, options.contextTelemetry?.() ?? {});
      }

      if (method === "GET" && url.pathname === "/telemetry/latency") {
        const telemetry = service.getRoutingTelemetry();
        return json(res, 200, {
          ...telemetry,
          runtimeMode: options.runtimeMode ?? { mode: "unknown" }
        });
      }

      if (method === "GET" && url.pathname === "/models") {
        return json(res, 200, options.modelCatalog ?? { version: 1, routingMode: "fixed-fast-deep", models: [], unlistedSelections: [] });
      }

      if (method === "POST" && url.pathname === "/routing/policy/tune") {
        const body = QueueDepthBodySchema.parse(requireObjectBody(await parseJsonBody(req)));
        const policy = service.tuneRoutingPolicy(body.queueDepth ?? 0);
        return json(res, 200, { policy });
      }

      if (method === "POST" && url.pathname === "/routing/policy/set") {
        const body = RoutingPolicyBodySchema.parse(requireObjectBody(await parseJsonBody(req)));
        const policy = service.setRoutingPolicy({
          maxFastP95Ms: body.maxFastP95Ms
        });
        return json(res, 200, { policy });
      }

      if (method === "GET" && url.pathname.startsWith("/conversations/") && url.pathname.endsWith("/events")) {
        const parts = url.pathname.split("/");
        const conversationId = parts[2];
        const events = await service.getTimeline(conversationId);
        return json(res, 200, { events });
      }

      if (method === "GET" && url.pathname.startsWith("/conversations/") && url.pathname.endsWith("/events/stream")) {
        const parts = url.pathname.split("/");
        const conversationId = parts[2];

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        let lastSerializedEvents = "";

        const pushTimeline = async (force = false) => {
          if (res.writableEnded) return;

          const events = await service.getTimeline(conversationId);
          const serialized = JSON.stringify(events);

          if (!force && serialized === lastSerializedEvents) {
            return;
          }

          lastSerializedEvents = serialized;
          writeSseEvent(res, "timeline", { events });
        };

        try {
          await pushTimeline(true);
        } catch {
          res.end();
          return;
        }

        const pollTimer = setInterval(() => {
          void pushTimeline(false).catch(() => res.end());
        }, 350);

        const heartbeatTimer = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": ping\n\n");
          }
        }, 15_000);

        req.on("close", () => {
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          if (!res.writableEnded) {
            res.end();
          }
        });

        return;
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof DuplicateMessageError) return json(res, 409, { error: error.message, code: error.code });
      if (error instanceof GenerationError) return json(res, error.code === "CONTEXT_TOO_LARGE" ? 413 : 502, { error: "Generation failed", code: error.code });
      if (error instanceof HttpRequestError) {
        return json(res, error.statusCode, { error: error.message });
      }

      if (error instanceof z.ZodError) {
        return json(res, 400, { error: "Invalid request body" });
      }

      if (error instanceof ContextBudgetError) {
        return json(res, 413, { error: error.message, code: error.code });
      }

      if (error instanceof ConversationOwnershipConflictError) {
        return json(res, 409, { error: error.message, code: error.code });
      }

      return json(res, 500, { error: (error as Error).message });
    }
  });
  let shutdown: Promise<void> | undefined;
  const close = server.close.bind(server);
  // Node's close callback must not announce completion before internal jobs settle.
  server.close = ((callback?: (error?: Error) => void) => {
    shutdown ??= options.shutdown?.() ?? Promise.resolve();
    close(error => { void shutdown!.then(() => callback?.(error), failure => callback?.(failure)); });
    return server;
  }) as typeof server.close;
  return server;
}

export async function startServer(port: number): Promise<void> {
  const config = loadRuntimeProviderConfigFromEnv();
  const summaryConfig = loadSummaryConfig();
  if (summaryConfig.mode === "model" && process.env.CONTEXT_SUMMARY_MODEL_BINDING !== "fast")
    throw new Error("CONTEXT_SUMMARY_MODE=model requires CONTEXT_SUMMARY_MODEL_BINDING=fast (explicit extra model calls)");
  const catalog = await loadModelCatalog(process.env.MODEL_CATALOG_PATH);
  const contextBudget: ContextBudgetConfig = loadContextBudgetConfigFromEnv(process.env, { config, catalog });
  const modelCatalog = describeModelCatalog(catalog, config);
  const thinking = await verifyThinkingConfig(config);
  const providers = buildProviderPair(config, contextBudget, thinking);
  const estimator = new InMemoryLatencyEstimator();

  const fastProfile = {
    provider: config.fast.provider,
    model: config.fast.model
  };

  const deepProfile = {
    provider: config.deep.provider,
    model: config.deep.model
  };

  seedPriorsForProfile(estimator, fastProfile, "direct", baseP95ByProvider(fastProfile.provider, "direct"));
  seedPriorsForProfile(estimator, fastProfile, "clarify", baseP95ByProvider(fastProfile.provider, "clarify"));
  seedPriorsForProfile(estimator, fastProfile, "deep", baseP95ByProvider(fastProfile.provider, "deep"));
  seedPriorsForProfile(estimator, deepProfile, "deep", baseP95ByProvider(deepProfile.provider, "deep"));

  const adaptiveRouting = new AdaptiveRoutingCoordinator(estimator, fastProfile, deepProfile, {
    maxFastP95Ms: parseBoundedNumberEnv(process.env.ROUTING_MAX_FAST_P95_MS, 1000, 400, 5000)
  });

  const telemetryStore = new FileLatencyTelemetryStore(process.env.TELEMETRY_STORE_PATH ?? "data/latency-telemetry.json");
  const existingSnapshot = await telemetryStore.load();
  if (existingSnapshot) {
    adaptiveRouting.hydrateState(existingSnapshot);
  }
  if (process.env.ROUTING_MAX_FAST_P95_MS !== undefined) {
    adaptiveRouting.setMaxFastP95Ms(parseBoundedNumberEnv(process.env.ROUTING_MAX_FAST_P95_MS, 1000, 400, 5000));
  }

  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const deadLetters = new InMemoryDeadLetterStore();
  const summaryProvider = summaryConfig.mode === "model"
    ? new ModelContextSummarizer(buildFastProvider(config, { ...contextBudget, fastOutputTokens: summaryConfig.maxTokens }, thinking),
      contextBudget.windowTokens, summaryConfig.maxTokens, contextBudget.safetyTokens) : undefined;
  const contextManager = new ContextManager(timeline, contextBudget, { config: summaryConfig, summarizer: summaryProvider });
  const trustedFactsProvider = () => ({
    fastProvider: config.fast.provider,
    fastModel: config.fast.model,
    deepProvider: config.deep.provider,
    deepModel: config.deep.model,
    generatedAtIso: new Date().toISOString()
  });
  const orchestrator = new ChatOrchestrator(providers.fastProvider, queue, timeline, adaptiveRouting, contextManager, trustedFactsProvider);
  const worker = new DeepWorker(queue, providers.deepProvider, timeline, 2, deadLetters, adaptiveRouting);
  const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters, adaptiveRouting);

  const saveTelemetry = async () => {
    try {
      await telemetryStore.save(adaptiveRouting.snapshotState());
    } catch (error) {
      console.warn(`Telemetry save failed: ${(error as Error).message}`);
    }
  };

  const autoRunConfig = resolveDeepWorkerAutoRunConfig(process.env);

  const runDeepWorkerTick = async () => {
    try {
      await service.runDeepWorkerOnce();
    } catch (error) {
      console.warn(`Deep worker auto-run failed: ${(error as Error).message}`);
    }
  };

  const runtimeMode = resolveRuntimeModeInfo(config);
  const server = createChatServer(service, { runtimeMode, modelCatalog, shutdown: () => contextManager.shutdown(), contextTelemetry: () => contextManager.getSummaryTelemetry() });
  // Do not report success or start background work until the port is bound.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use. This server did not start. Stop the existing server or choose a different PORT.`)
        : error);
    };
    server.once("error", onError);
    server.listen(port, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const telemetrySaveIntervalMs = parsePositiveIntEnv(process.env.TELEMETRY_SAVE_INTERVAL_MS, 5000, 250, 60_000);
  const timer = setInterval(() => {
    void saveTelemetry();
  }, telemetrySaveIntervalMs);

  const deepWorkerTimer = autoRunConfig.enabled
    ? setInterval(() => {
        void runDeepWorkerTick();
      }, autoRunConfig.intervalMs)
    : undefined;

  server.on("close", () => {
    clearInterval(timer);
    if (deepWorkerTimer) {
      clearInterval(deepWorkerTimer);
    }
    void saveTelemetry();
  });

  const stop = () => {
    clearInterval(timer);
    if (deepWorkerTimer) clearInterval(deepWorkerTimer);
    server.close(() => { server.closeAllConnections(); });
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("close", () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });

  // Safe to log: describeProviderConfig() never includes secret values
  // (e.g. AZURE_OPENAI_API_KEY), only provider/model names, endpoints, and
  // region — see its docstring in ./config/providerConfig.
  const autoRunLabel = autoRunConfig.enabled ? `on/${autoRunConfig.intervalMs}ms` : "off";
  console.log(`Chat server listening on port ${port} (${describeProviderConfig(config)}; deep-worker auto=${autoRunLabel})`);
}
