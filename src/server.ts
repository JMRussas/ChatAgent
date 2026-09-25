import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { InMemoryDeadLetterStore } from "./app/deadLetterStore";
import { ChatOrchestrator, DeepWorker } from "./app/orchestrator";
import { InMemoryConversationTimelineStore } from "./app/timelineStore";
import { ChatService } from "./app/chatService";
import { loadRuntimeProviderConfigFromEnv } from "./config/providerConfig";
import type { UserMessage } from "./domain/types";
import { InMemoryTaskQueue } from "./providers/interfaces";
import { buildProviderPair } from "./providers/providerFactory";
import { AdaptiveRoutingCoordinator } from "./routing/adaptiveRouting";
import { InMemoryLatencyEstimator } from "./telemetry/latencyEstimator";
import { FileLatencyTelemetryStore } from "./telemetry/latencyTelemetryStore";

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

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createChatServer(service: ChatService) {
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");

      if (method === "POST" && url.pathname === "/messages") {
        const body = (await parseJsonBody(req)) as Partial<UserMessage>;

        if (!body.conversationId || !body.userId || !body.text) {
          return json(res, 400, { error: "conversationId, userId, and text are required" });
        }

        const response = await service.submitMessage({
          conversationId: body.conversationId,
          userId: body.userId,
          text: body.text,
          timestampIso: body.timestampIso ?? new Date().toISOString()
        });

        return json(res, 200, response);
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

      if (method === "GET" && url.pathname === "/telemetry/latency") {
        const telemetry = service.getRoutingTelemetry();
        return json(res, 200, telemetry);
      }

      if (method === "POST" && url.pathname === "/routing/policy/tune") {
        const body = (await parseJsonBody(req)) as { queueDepth?: number };
        const policy = service.tuneRoutingPolicy(body.queueDepth ?? 0);
        return json(res, 200, { policy });
      }

      if (method === "GET" && url.pathname.startsWith("/conversations/") && url.pathname.endsWith("/events")) {
        const parts = url.pathname.split("/");
        const conversationId = parts[2];
        const events = await service.getTimeline(conversationId);
        return json(res, 200, { events });
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });
}

export async function startServer(port: number): Promise<void> {
  const config = loadRuntimeProviderConfigFromEnv();
  const providers = buildProviderPair(config);
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
    maxFastP95Ms: Number(process.env.ROUTING_MAX_FAST_P95_MS ?? "1000")
  });

  const telemetryStore = new FileLatencyTelemetryStore(process.env.TELEMETRY_STORE_PATH ?? "data/latency-telemetry.json");
  const existingSnapshot = await telemetryStore.load();
  if (existingSnapshot) {
    adaptiveRouting.hydrateEstimator(existingSnapshot);
  }

  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const deadLetters = new InMemoryDeadLetterStore();
  const orchestrator = new ChatOrchestrator(providers.fastProvider, queue, timeline, adaptiveRouting);
  const worker = new DeepWorker(queue, providers.deepProvider, timeline, 2, deadLetters, adaptiveRouting);
  const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters, adaptiveRouting);

  const saveTelemetry = async () => {
    await telemetryStore.save(adaptiveRouting.snapshotEstimator());
  };

  const telemetrySaveIntervalMs = Number(process.env.TELEMETRY_SAVE_INTERVAL_MS ?? "5000");
  const timer = setInterval(() => {
    void saveTelemetry();
  }, telemetrySaveIntervalMs);

  const server = createChatServer(service);
  server.listen(port);

  server.on("close", () => {
    clearInterval(timer);
    void saveTelemetry();
  });

  console.log(`Chat server listening on port ${port}`);
}
