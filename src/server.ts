import { createRuntimeHandle, loadShutdownConfig, type RuntimeHandle } from "./app/runtimeHandle";
import { loadDispatchConfig } from "./config/dispatchConfig";
import { CatalogDispatch } from "./routing/catalogDispatch";
import { ModelSelectionError } from "./routing/modelSelector";
import { buildProviderRegistry, entryBindingId } from "./providers/providerRegistry";
import { connectHekateClaude } from "./providers/cli/hekateClaude";
import { rejectUnsupportedInputs } from "./providers/interfaces";
import { resolve } from "node:path";
import { PythonDocumentTasks, DocumentTaskError, type DocumentTasks } from "./app/documentTasks";
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
import { loadDiscoveryConfigFromEnv } from "./config/discoveryConfig";
import { defaultConnectionsFromEnv, type Connection } from "./models/connections";
import { InventoryStore, type DiscoveryAdapter } from "./models/inventory";
import { OllamaDiscoveryAdapter } from "./models/discovery/ollamaDiscovery";
import { AzureDiscoveryAdapter } from "./models/discovery/azureDiscovery";
import { BedrockDiscoveryAdapter } from "./models/discovery/bedrockDiscovery";

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
  documentTasks?: DocumentTasks;
  // A function, not a static value: discovery observations change over the
  // process lifetime, so each request must recompute readiness from current data.
  modelCatalog?: () => Omit<ReturnType<typeof describeModelCatalog>, "routingMode"> & { routingMode: "catalog" | "fixed-fast-deep" };
  runtimeMode?: RuntimeModeInfo;
  shutdown?: () => Promise<void>;
  dispatchTelemetry?: () => ReturnType<CatalogDispatch["telemetry"]>;
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
  const responses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    responses.add(res);
    res.once("close", () => responses.delete(res));
    try {
      if (service.isShuttingDown) return json(res, 503, { code: "SHUTTING_DOWN", error: "Runtime is shutting down" });
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");

      if (await protocolV1(req, res, url, () => parseJsonBody(req))) return;

      if (method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHomePageHtml(options.runtimeMode, Boolean(options.documentTasks)));
        return;
      }

      if (method === "POST" && url.pathname === "/document-tasks") {
        if (!options.documentTasks) return json(res, 404, { error: "Documentation tasks are disabled" });
        const body = z.object({
          op: z.enum(["start", "list", "status", "resume", "cancel"]),
          conversationId: z.string().min(1).max(200), userId: z.string().min(1).max(200),
          requestId: z.string().uuid().optional(), taskId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
          question: z.string().trim().min(1).max(2000).optional()
        }).parse(requireObjectBody(await parseJsonBody(req)));
        if (body.op === "start" && (!body.requestId || !body.question)) throw new HttpRequestError(400, "Start requires requestId and question");
        if (!["start", "list"].includes(body.op) && !body.taskId) throw new HttpRequestError(400, "Task ID required");
        service.claimConversation(body.conversationId, body.userId, body.op === "start");
        const result = await options.documentTasks.request(body);
        return json(res, body.op === "start" || body.op === "resume" ? 202 : 200, result);
      }

      if (method === "POST" && url.pathname === "/messages") {
        const raw = requireObjectBody(await parseJsonBody(req));
        rejectUnsupportedInputs(raw);
        const body = MessageBodySchema.parse(raw);

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

      if (method === "GET" && url.pathname === "/telemetry/dispatch") {
        return json(res, 200, options.dispatchTelemetry?.() ?? { attempts: [], reservations: [] });
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
        return json(res, 200, options.modelCatalog?.() ?? { version: 1, routingMode: "fixed-fast-deep", models: [], discovered: [], unlistedSelections: [] });
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
      if (error instanceof DocumentTaskError) {
        const status = error.code === "CAPACITY_FULL" ? 429 : error.code === "OWNER_MISMATCH" || error.code === "REQUEST_CONFLICT" || error.code === "NOT_RESUMABLE" ? 409 : error.code === "TASK_NOT_FOUND" ? 404 : error.code.startsWith("INVALID_") ? 400 : 503;
        return json(res, status, { error: "Documentation task request failed", code: error.code });
      }
      if (error instanceof ModelSelectionError) return json(res, 503, { error: error.message, code: error.code, exclusions: error.exclusions });
      if (error instanceof DuplicateMessageError) return json(res, 409, { error: error.message, code: error.code });
      if (error instanceof GenerationError) return json(res, error.code === "SHUTTING_DOWN" ? 503 : error.code === "CONTEXT_TOO_LARGE" ? 413 : error.code === "CAPABILITY_UNSUPPORTED" ? 400 : 502, { error: "Generation failed", code: error.code });
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
    if (!shutdown) options.documentTasks?.close();
    shutdown ??= options.shutdown?.() ?? Promise.resolve();
    close(error => { void shutdown!.then(() => callback?.(error), failure => callback?.(failure)); });
    return server;
  }) as typeof server.close;
  return Object.assign(server, { closeStreams: () => {
    for (const response of responses) if (String(response.getHeader("Content-Type")).startsWith("text/event-stream")) response.end();
  } });
}

export async function startServer(port: number): Promise<RuntimeHandle> {
  const shutdownConfig = loadShutdownConfig();
  const config = loadRuntimeProviderConfigFromEnv();
  const summaryConfig = loadSummaryConfig();
  if (summaryConfig.mode === "model" && process.env.CONTEXT_SUMMARY_MODEL_BINDING !== "fast")
    throw new Error("CONTEXT_SUMMARY_MODE=model requires CONTEXT_SUMMARY_MODEL_BINDING=fast (explicit extra model calls)");
  const catalog = await loadModelCatalog(process.env.MODEL_CATALOG_PATH);
  const dispatchConfig = await loadDispatchConfig();
  const contextBudget: ContextBudgetConfig = loadContextBudgetConfigFromEnv(process.env, dispatchConfig.mode === "fixed" ? { config, catalog } : undefined);
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

  const discoveryConfig = loadDiscoveryConfigFromEnv();
  const connections: Connection[] = defaultConnectionsFromEnv(config, process.env, dispatchConfig.mode === "catalog" ? catalog.models.flatMap(e => e.provider === "cli" ? [] : [e.provider]) : []);
  const discoveryAdapters: Partial<Record<Connection["apiKind"], DiscoveryAdapter>> = {
    "mock": { discover: async connection => catalog.models.filter(e => e.provider === "mock").map(entry => ({
      bindingId: entryBindingId(entry), connectionId: connection.connectionId, model: entry.model,
      observedAtIso: new Date().toISOString(), source: "synthetic-mock-adapter",
      installed: "yes" as const, access: "allowed" as const, health: "reachable" as const, apiCompatibility: ["mock"]
    })) },
    "ollama-chat": new OllamaDiscoveryAdapter(),
    "azure-openai-chat": new AzureDiscoveryAdapter(),
    "bedrock-converse": new BedrockDiscoveryAdapter()
  };
  const registry = dispatchConfig.mode === "catalog" ? await buildProviderRegistry(catalog, connections, config, contextBudget) : undefined;
  const claudeBridge = connectHekateClaude(catalog, registry, contextBudget);
  connections.push(...claudeBridge.connections);
  if (claudeBridge.discovery) discoveryAdapters.cli = claudeBridge.discovery;
  const inventoryStore = new InventoryStore(discoveryAdapters, discoveryConfig);
  const dispatch = registry ? new CatalogDispatch(catalog, registry, dispatchConfig.policy, contextBudget, () => inventoryStore.listObservations()) : undefined;
  const buildCatalogResponse = () => {
    const view = describeModelCatalog(catalog, config, { connections, observations: inventoryStore.listObservations(), implementedBindingIds: claudeBridge.bindingIds });
    return { ...view, routingMode: dispatch ? "catalog" as const : "fixed-fast-deep" as const,
      models: dispatch ? view.models.map(model => ({ ...model, selectedRoles: [],
        resourceFacts: dispatch.policy.bindings[model.id]?.facts ?? model.resourceFacts,
        resourceEvidenceKind: dispatch.policy.bindings[model.id]?.evidence.kind ?? "unknown"
      })) : view.models };
  };

  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const deadLetters = new InMemoryDeadLetterStore();
  let summaryModel = summaryConfig.mode === "model"
    ? buildFastProvider(config, { ...contextBudget, fastOutputTokens: summaryConfig.maxTokens }, thinking) : undefined;
  if (summaryModel && dispatch) {
    const entry = catalog.models.find(e => e.provider === config.fast.provider && e.model === config.fast.model);
    if (!entry) throw new Error("Catalog summary binding must be curated");
    summaryModel = dispatch.wrapSummary(summaryModel, entryBindingId(entry), summaryConfig.maxTokens);
  }
  const summaryProvider = summaryModel ? new ModelContextSummarizer(summaryModel,
    contextBudget.windowTokens, summaryConfig.maxTokens, contextBudget.safetyTokens) : undefined;
  const contextManager = new ContextManager(timeline, contextBudget, { config: summaryConfig, summarizer: summaryProvider });
  const trustedFactsProvider = () => ({
    fastProvider: config.fast.provider,
    fastModel: config.fast.model,
    deepProvider: config.deep.provider,
    deepModel: config.deep.model,
    generatedAtIso: new Date().toISOString()
  });
  const orchestrator = new ChatOrchestrator(providers.fastProvider, queue, timeline, adaptiveRouting, contextManager, trustedFactsProvider, dispatch);
  const worker = new DeepWorker(queue, providers.deepProvider, timeline, 2, deadLetters, adaptiveRouting, dispatch);
  const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters, adaptiveRouting);

  const saveTelemetry = () => telemetryStore.save({ ...adaptiveRouting.snapshotState(), dispatch: dispatch?.telemetry() });

  const autoRunConfig = resolveDeepWorkerAutoRunConfig(process.env);

  const runDeepWorkerTick = async () => {
    try {
      await service.runDeepWorkerOnce();
    } catch (error) {
      console.warn(`Deep worker auto-run failed: ${(error as Error).message}`);
    }
  };

  const runtimeMode = resolveRuntimeModeInfo(config);
  const documentTasks = process.env.DOC_TASK_PYTHON ? new PythonDocumentTasks(
    process.env.DOC_TASK_PYTHON, resolve("experiments/doc-agent/chat_bridge.py"),
    resolve(process.env.DOC_TASK_ROOT ?? "data/document-tasks"), process.env.DOC_TASK_MODEL ?? "gemma4:26b"
  ) : undefined;


  const server = createChatServer(service, {
    documentTasks, runtimeMode: dispatch ? { mode: "unknown" } : runtimeMode, modelCatalog: buildCatalogResponse,
    dispatchTelemetry: () => dispatch?.telemetry() ?? { attempts: [], reservations: [] },
    contextTelemetry: () => contextManager.getSummaryTelemetry()
  });
  // Do not report success or start background work until the port is bound.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      documentTasks?.close();
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
    void saveTelemetry().catch(() => console.warn("Telemetry save failed"));
  }, telemetrySaveIntervalMs);

  const deepWorkerTimer = autoRunConfig.enabled
    ? setInterval(() => {
        void runDeepWorkerTick();
      }, autoRunConfig.intervalMs)
    : undefined;

  // Refresh asynchronously so a slow/unreachable provider never delays startup
  // reporting success; failures retain prior observations (see InventoryStore).
  void inventoryStore.refreshAll(connections).catch((error) => {
    console.warn(`Model discovery refresh failed: ${(error as Error).message}`);
  });
  const discoveryTimer = setInterval(() => {
    void inventoryStore.refreshAll(connections).catch((error) => {
      console.warn(`Model discovery refresh failed: ${(error as Error).message}`);
    });
  }, discoveryConfig.intervalMs);

  const stopBackground = () => {
    clearInterval(timer);
    if (deepWorkerTimer) clearInterval(deepWorkerTimer);
    clearInterval(discoveryTimer);
    inventoryStore.shutdown();
  };
  const runtime = createRuntimeHandle(server, service, {
    config: shutdownConfig, stopBackground,
    stopInternal: () => contextManager.shutdown(), persist: saveTelemetry
  });
  server.once("close", stopBackground);

  // Safe to log: describeProviderConfig() never includes secret values
  // (e.g. AZURE_OPENAI_API_KEY), only provider/model names, endpoints, and
  // region — see its docstring in ./config/providerConfig.
  const autoRunLabel = autoRunConfig.enabled ? `on/${autoRunConfig.intervalMs}ms` : "off";
  console.log(`Chat server listening on port ${runtime.address.port} (${describeProviderConfig(config)}; deep-worker auto=${autoRunLabel})`);
  return runtime;
}
