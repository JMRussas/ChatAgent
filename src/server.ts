import { rolePlannerEngine } from "./app/rolePlanner";
import { loadRoleCatalog } from "./app/roleCatalog";
import { referenceSelectionsSchema, selectReferences } from "./app/referenceSelection";
import { runControlsSchema } from "./app/runControls";
import type { BriefingHttp } from "./sports/briefingHttp";
import { CapabilityChat } from "./app/capabilityChat";
import { loadLiveBriefingFromEnv } from "./sports/liveBriefing";
import { startEvaluationRecording } from "./eval/recording/startup";
import { cliLimits } from "./providers/cli/runner";
import { digest } from "./eval/recording/contract";
import { platform, arch } from "node:os";
import { createRuntimeHandle, loadShutdownConfig, type RuntimeHandle } from "./app/runtimeHandle";
import { loadDispatchConfig } from "./config/dispatchConfig";
import { CatalogDispatch } from "./routing/catalogDispatch";
import { ModelSelectionError } from "./routing/modelSelector";
import { buildProviderRegistry, entryBindingId } from "./providers/providerRegistry";
import { connectHekateClaude } from "./providers/cli/hekateClaude";
import { rejectUnsupportedInputs } from "./providers/interfaces";
import { resolve } from "node:path";
import { PythonDocumentTasks, DocumentTaskError, type DocumentTasks } from "./app/documentTasks";
import {
  DocumentTaskControlError,
  DocumentTaskSupervisor,
  type DocumentTaskControl
} from "./app/documentTaskSupervisor";
import { createProtocolV1Handler } from "./app/protocolV1";
import { renderPairingPageHtml } from "./ui/pairingPage";
import { EventStreamRegistry, StreamCapacityError, sseFrame } from "./app/eventStreams";
import {
  LocalAuthenticator,
  ownerBelongsToPrincipal,
  scopedOwnerKey,
  type Authenticator
} from "./auth/authenticator";
import { loadOrCreateIdentity } from "./auth/localIdentity";
import { PairingController } from "./auth/pairing";
import { checkExactOrigin, extractCredentials, SESSION_COOKIE } from "./auth/credentials";
import { classifyRoute, decideAccess } from "./auth/routePolicy";
import { SESSION_MAX_AGE_SECONDS } from "./auth/authenticator";
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
import {
  describeProviderConfig,
  loadRuntimeProviderConfigFromEnv,
  type RuntimeProviderConfig
} from "./config/providerConfig";
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
import {
  checkLocalRequest,
  DEFAULT_MAX_BODY_BYTES,
  loadHttpBoundaryConfig
} from "./config/httpBoundary";
import { loadTurnAdmissionConfig } from "./config/turnAdmission";
import {
  DEFAULT_MAX_EVENT_STREAMS,
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  assertStreamAdmission,
  loadStreamAdmissionConfig
} from "./config/streamAdmission";
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

/** Browser pairing: an operator-visible code exchanged once for a session cookie. */
export interface PairingOptions {
  controller: PairingController;
  /** Signs a session for the installation owner (LocalAuthenticator.issueSession). */
  issueSession(): string;
  /** Shows a newly issued code to the operator. Never written to an HTTP response. */
  announce(code: string): void;
}

interface ServerOptions {
  /** Required: every request is resolved to a principal or refused before routing. */
  auth: Authenticator;
  /** Without it, /pair answers 404 PAIRING_DISABLED. */
  pairing?: PairingOptions;
  briefings?: BriefingHttp;
  documentTasks?: DocumentTasks;
  /** Operator status and restart of the document sidecar; absent when it is disabled. */
  documentTaskControl?: DocumentTaskControl;
  // A function, not a static value: discovery observations change over the
  // process lifetime, so each request must recompute readiness from current data.
  modelCatalog?: () => Omit<ReturnType<typeof describeModelCatalog>, "routingMode"> & {
    routingMode: "catalog" | "fixed-fast-deep";
    discoveryRefresh?: ReturnType<InventoryStore["refreshStatuses"]>;
  };
  runtimeMode?: RuntimeModeInfo;
  shutdown?: () => Promise<void>;
  dispatchTelemetry?: () => ReturnType<CatalogDispatch["telemetry"]>;
  evaluationStatus?: () => unknown;
  contextTelemetry?: () => ReturnType<ContextManager["getSummaryTelemetry"]>;
  /** Limit on a request body in bytes, enforced while reading. */
  maxBodyBytes?: number;
  /** Open event streams across both stream routes; a further one is refused with 429. */
  maxEventStreams?: number;
  /** A stream unable to accept writes for this long is disconnected. */
  streamStallTimeoutMs?: number;
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

const pairBodySchema = z.object({ code: z.string().max(64) }).strict();
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const recoveryTarget = {
  expectedGeneration: generation,
  conversationId: z.string().min(1).max(200),
  taskId: z.string().regex(/^[0-9a-f]{32}$/)
};
const inspectTaskBodySchema = z.object(recoveryTarget).strict();
const abandonTaskBodySchema = z
  .object({
    ...recoveryTarget,
    operationId: z.string().uuid(),
    expectedDigest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();
const persistedTaskStatus = z.enum([
  "queued",
  "running",
  "paused",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "abandoned"
]);
/** A real instant: the format check alone admits offsets such as +99:99. */
const instant = z
  .string()
  .max(64)
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const receiptSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
    previousStatus: z.enum(["running", "cancel_requested"]),
    abandonedAt: instant,
    externalOutcome: z.literal("unknown")
  })
  .strict();
const count = z.number().int().nonnegative().max(1e9);
/** The sidecar's bounded operator view of one task; nothing else is passed on. */
export const taskViewSchema = z
  .object({
    taskId: z.string().regex(/^[0-9a-f]{32}$/),
    persistedStatus: persistedTaskStatus,
    effectiveStatus: z.union([persistedTaskStatus, z.literal("uncertain")]),
    ownerActive: z.boolean(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: instant,
    updatedAt: instant,
    modelCalls: count,
    toolCalls: count,
    abandonment: receiptSchema.nullable()
  })
  .strict()
  .refine((v) => {
    const orphanable = v.persistedStatus === "running" || v.persistedStatus === "cancel_requested";
    // Effective differs only as an orphan's derived uncertainty; a live owner keeps it.
    const statuses = orphanable
      ? v.effectiveStatus === (v.ownerActive ? v.persistedStatus : "uncertain")
      : v.effectiveStatus === v.persistedStatus && !v.ownerActive;
    return statuses && (v.persistedStatus === "abandoned") === (v.abandonment !== null);
  });
export const abandonResultSchema = z
  .object({ receipt: receiptSchema, task: taskViewSchema })
  .strict();
const restartBodySchema = z
  .object({ expectedGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

/**
 * The userId rule each client route applies, so a label is only turned into an
 * owner key when the route itself would have accepted it (MessageBodySchema,
 * briefingHttp's trimmed userId, and the 1-200 rule of the other routes).
 */
const DEFAULT_LABEL = z.string().min(1).max(200);
const LABEL_CONTRACTS: Record<string, z.ZodType<string>> = {
  "POST /messages": z.string().min(1),
  "POST /briefings": z.string().trim().min(1).max(200),
  "POST /sports/chat": z.string().trim().min(1).max(200)
};

/**
 * The failure categories normalizeGenerationError produces; any other dead-letter
 * error text, even one shaped like a code, is reported as OTHER.
 */
const PUBLIC_DEAD_LETTER_CODES = new Set([
  "CANCELLED",
  "CONTEXT_TOO_LARGE",
  "PROVIDER_AUTH",
  "PROVIDER_ERROR",
  "PROVIDER_REQUEST_INVALID",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE"
]);

class HttpRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    /** The request body was not fully read, so the connection cannot be reused. */
    public readonly closeConnection = false
  ) {
    super(message);
  }
}

const bodyTooLarge = () =>
  new HttpRequestError(413, "Request body too large", "REQUEST_BODY_TOO_LARGE", true);

const MessageBodySchema = z.object({
  referenceSelections: referenceSelectionsSchema.optional(),
  runControls: runControlsSchema.optional(),
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

// Counts bytes as they arrive, so chunked input is bounded without a declared
// length. Listeners are used instead of async iteration because leaving a
// `for await` early destroys the socket before the rejection can be sent.
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  // A declared length over the limit is refused before any body byte is read.
  if (Number(req.headers["content-length"]) > maxBytes) return Promise.reject(bodyTooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (finish: () => void) => {
      req.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose);
      finish();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) return void chunks.push(chunk);
      settle(() => {
        req.pause();
        reject(bodyTooLarge());
      });
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks, size)));
    const onError = (error: Error) => settle(() => reject(error));
    const onClose = () =>
      settle(() => reject(new HttpRequestError(400, "Request body incomplete")));
    req.on("data", onData).on("end", onEnd).on("error", onError).on("close", onClose);
  });
}

async function parseJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = (await readBody(req, maxBytes)).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpRequestError(400, "Invalid JSON body");
  }
}

export function createChatServer(service: ChatService, options: ServerOptions) {
  // No default: a server built without an authenticator would answer everyone.
  if (!options?.auth) throw new Error("createChatServer requires an authenticator (options.auth).");
  service.resolveReferences = (selections, userId, conversationId) => {
    const store = options.briefings?.directory?.results;
    if (!store) throw Error("REFERENCES_UNAVAILABLE");
    return selectReferences(store, selections, userId, conversationId);
  };
  const eventStreams = new EventStreamRegistry(
    assertStreamAdmission({
      maxEventStreams: options.maxEventStreams ?? DEFAULT_MAX_EVENT_STREAMS,
      streamStallTimeoutMs: options.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS
    })
  );
  const protocolV1 = createProtocolV1Handler(service, eventStreams);
  const conversationNotFound = (res: ServerResponse) =>
    json(res, 404, { code: "CONVERSATION_NOT_FOUND", error: "No such conversation" });
  /**
   * Whether a legacy read may show these events to this principal: a claimed
   * conversation only to its owner's principal, an unclaimed one only while empty.
   * Clients may subscribe before their first message; once anyone claims the
   * conversation, the check is decided by ownership again.
   */
  const visibleTo = (conversationId: string, principalId: string, eventCount: number) => {
    const owner = service.conversationOwner(conversationId);
    return owner === undefined ? eventCount === 0 : ownerBelongsToPrincipal(owner, principalId);
  };

  /** /pair and /pair/reissue. Codes travel only in a request body or the console. */
  const handlePairing = async (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    readBody: () => Promise<unknown>
  ) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const pairing = options.pairing;
    if (!pairing) return json(res, 404, { code: "PAIRING_DISABLED", error: "Pairing is disabled" });
    if (path === "/pair/reissue") {
      // Operator only (route table). The new code goes to the console, never here.
      pairing.announce(pairing.controller.issue());
      return json(res, 202, { issued: true });
    }
    if (method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPairingPageHtml());
      return;
    }
    // Bootstrap is public, so it proves its own origin: another site cannot pair a
    // browser into this server, and a local tool has no reason to pair at all.
    if (checkExactOrigin(req.headersDistinct) !== "same-origin")
      return json(res, 403, { code: "ORIGIN_REQUIRED", error: "Pair from this server's page" });
    const body = pairBodySchema.safeParse(await readBody());
    const result = pairing.controller.attempt(body.success ? body.data.code : undefined);
    if (result === "no-code")
      return json(res, 409, {
        code: "PAIRING_NOT_ACTIVE",
        error: "No pairing code is active. Ask the operator for a new one."
      });
    if (result !== "paired")
      return json(res, 401, { code: "PAIRING_FAILED", error: "That code is not valid" });
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${pairing.issueSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
    );
    return json(res, 200, { paired: true });
  };
  // Evidence bound to a retired conversation goes with it; ownership is released last.
  service.addRetirementParticipant({
    forget: (conversationId) => {
      const removed = options.briefings?.directory?.forgetConversation?.(conversationId) ?? [];
      options.briefings?.gameOperations?.forgetResults?.(removed);
    }
  });
  // The sidecar keeps durable tasks and its own owner table. Abandonment keeps the
  // task, its binding and owner, so a conversation with any document task, abandoned
  // ones included, is still not retired.
  if (options.documentTasks)
    service.addRetirementParticipant({
      blockers: async (conversationId, ownerUserId) => {
        if (ownerUserId === undefined) return ["DOCUMENT_TASKS_UNKNOWN"];
        try {
          const tasks = await options.documentTasks!.request({
            op: "list",
            conversationId,
            userId: ownerUserId
          });
          return Array.isArray(tasks) && !tasks.length ? [] : ["DOCUMENT_TASKS"];
        } catch {
          return ["DOCUMENT_TASKS_UNKNOWN"];
        }
      },
      forget: () => undefined
    });
  const responses = new Set<ServerResponse>();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer(async (req, res) => {
    responses.add(res);
    res.once("close", () => responses.delete(res));
    // Every route reads its body through this limit.
    const readBody = () => parseJsonBody(req, maxBodyBytes);
    let parseBody = readBody;
    try {
      const rejection = checkLocalRequest(req.headersDistinct);
      if (rejection)
        return json(res, 403, {
          code: rejection,
          error:
            rejection === "HOST_NOT_ALLOWED"
              ? "This server only answers requests addressed to a loopback host"
              : "Cross-origin requests are not allowed"
        });
      if (service.isShuttingDown)
        return json(res, 503, { code: "SHUTTING_DOWN", error: "Runtime is shutting down" });
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");

      // Access is decided from the route table before any handler runs. A path that
      // is not in the table never reaches a handler.
      const rule = classifyRoute(method, url.pathname);
      const principal = options.auth.resolve(extractCredentials(req.headersDistinct));
      const access = decideAccess(rule, principal);
      if (!access.allow)
        return json(res, access.status, {
          code: access.code,
          error:
            access.status === 401
              ? "Authentication required"
              : access.status === 403
                ? "This credential cannot use this route"
                : "Not found"
        });
      // Another application on this host at a different port is same-site, so the
      // browser sends it this host's cookies even with SameSite=Strict. A cookie may
      // only authorize a change when the request provably comes from this origin.
      if (
        principal?.via === "session" &&
        method !== "GET" &&
        checkExactOrigin(req.headersDistinct) !== "same-origin"
      )
        return json(res, 403, {
          code: "ORIGIN_REQUIRED",
          error: "Changes made with a browser session must come from this page"
        });

      if (method === "GET" && url.pathname === "/auth/session") {
        res.setHeader("Cache-Control", "no-store");
        return json(res, 200, {
          authenticated: !!principal,
          ...(principal ? { roles: [...principal.roles].sort(), via: principal.via } : {})
        });
      }
      if (url.pathname === "/pair" || url.pathname === "/pair/reissue")
        // Awaited so a rejected body read reaches the shared error handler below.
        return await handlePairing(req, res, method, url.pathname, readBody);

      if (url.pathname.startsWith("/v1/")) {
        // Every /v1 route is a client route, so a principal is present here.
        if (await protocolV1(req, res, url, parseBody, principal!.principalId)) return;
      } else if (rule?.access === "client") {
        // Legacy client routes take conversation ids from the path or the body; none
        // of them may name a conversation the v1 protocol allocated internally.
        // Operator routes (retention, retirement) work on internal ids by design.
        const pathId = /^\/conversations\/([^/]+)\//.exec(url.pathname)?.[1];
        if (pathId !== undefined) {
          const id = decodeURIComponent(pathId);
          const owner = service.conversationOwner(id);
          // Reads and cancellation carry no owner, so a claimed conversation's owner
          // must belong to this principal. An unclaimed one may be read (it must still
          // be empty; see visibleTo) but has nothing to cancel.
          if (
            protocolV1.isProtocolConversation(id) ||
            (owner !== undefined && !ownerBelongsToPrincipal(owner, principal!.principalId)) ||
            (owner === undefined && method !== "GET")
          )
            return conversationNotFound(res);
        }
        // The body is read and checked here, before any handler, so the refusal does
        // not depend on whether or when a handler reads it.
        if (method === "POST") {
          const body = await readBody();
          const id = (body as { conversationId?: unknown } | null)?.conversationId;
          if (typeof id === "string" && protocolV1.isProtocolConversation(id))
            return conversationNotFound(res);
          // Ownership is per principal: the userId label is replaced by the owner key
          // scoped to the authenticated principal before any handler or store sees it.
          // A missing or invalid label is left for the route's own validation.
          // The label is checked against the route's own contract first and derived
          // from its normalized value; anything else is left for the route to reject
          // exactly as before.
          const userId = (body as { userId?: unknown } | null)?.userId;
          const label = (LABEL_CONTRACTS[rule!.name] ?? DEFAULT_LABEL).safeParse(userId);
          if (label.success)
            (body as { userId: string }).userId = scopedOwnerKey(principal!.principalId, [
              label.data
            ]);
          parseBody = async () => body;
        }
      }

      if (method === "GET" && url.pathname === "/telemetry/evaluation")
        return json(res, 200, options.evaluationStatus?.() ?? { enabled: false });
      if (method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHomePageHtml(options.runtimeMode, Boolean(options.documentTasks)));
        return;
      }

      if (method === "POST" && url.pathname === "/briefings/config/reload") {
        if (!options.briefings?.reload) return json(res, 404, { code: "BRIEFING_RELOAD_DISABLED" });
        z.object({})
          .strict()
          .parse(requireObjectBody(await parseBody()));
        try {
          return json(res, 200, await options.briefings.reload());
        } catch {
          return json(res, 400, {
            code: "SPORTS_BRIEFING_RELOAD_FAILED",
            error: "Configuration unchanged; check the configured file"
          });
        }
      }

      if (method === "POST" && url.pathname === "/briefings") {
        if (!options.briefings)
          return json(res, 404, { code: "BRIEFINGS_DISABLED", error: "Briefings are disabled" });
        const result = options.briefings.request(requireObjectBody(await parseBody()));
        return json(res, result.status, result.body);
      }

      if (method === "POST" && url.pathname === "/document-tasks") {
        if (!options.documentTasks)
          return json(res, 404, { error: "Documentation tasks are disabled" });
        const body = z
          .object({
            op: z.enum(["start", "list", "status", "resume", "cancel"]),
            conversationId: z.string().min(1).max(200),
            userId: z.string().min(1).max(200),
            requestId: z.string().uuid().optional(),
            taskId: z
              .string()
              .regex(/^[0-9a-f]{32}$/)
              .optional(),
            question: z.string().trim().min(1).max(2000).optional()
          })
          .parse(requireObjectBody(await parseBody()));
        if (body.op === "start" && (!body.requestId || !body.question))
          throw new HttpRequestError(400, "Start requires requestId and question");
        if (!["start", "list"].includes(body.op) && !body.taskId)
          throw new HttpRequestError(400, "Task ID required");
        service.claimConversation(body.conversationId, body.userId, body.op === "start");
        const releaseHistory =
          body.op === "start" ? service.retainConversationWork(body.conversationId) : undefined;
        try {
          const result = await options.documentTasks.request(body);
          return json(res, body.op === "start" || body.op === "resume" ? 202 : 200, result);
        } finally {
          releaseHistory?.();
        }
      }

      if (method === "POST" && url.pathname === "/sports/games") {
        const body = z
          .object({
            userId: z.string().min(1).max(200),
            conversationId: z.string().min(1).max(200),
            operation: z.enum(["search", "details"]),
            input: z.unknown()
          })
          .strict()
          .parse(requireObjectBody(await parseBody()));
        const games = options.briefings?.gameOperations;
        if (!games) return json(res, 404, { error: "Game operations disabled" });
        service.claimConversation(body.conversationId, body.userId);
        const releaseHistory = service.retainConversationWork(body.conversationId);
        const controller = new AbortController(),
          cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          return json(
            res,
            200,
            body.operation === "search"
              ? await games.search(body.input, body.userId, body.conversationId, controller.signal)
              : games.details(body.input, body.userId, body.conversationId)
          );
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          return json(res, 409, {
            error: "Game operation unavailable. Check scope, references and configured limits."
          });
        } finally {
          res.removeListener("close", cancel);
          releaseHistory();
        }
      }
      if (method === "GET" && url.pathname === "/sports/team-directories") {
        return json(res, 200, {
          leagues: options.briefings?.directory?.leagues() ?? [],
          topics: options.briefings?.directory?.topics() ?? [],
          gameLeagues: options.briefings?.gameOperations?.leagues() ?? []
        });
      }
      if (method === "POST" && url.pathname === "/conversation-context/detach") {
        const body = z
          .object({
            userId: z.string().min(1).max(200),
            conversationId: z.string().min(1).max(200)
          })
          .strict()
          .parse(requireObjectBody(await parseBody()));
        return json(res, 200, {
          context: service.detachTeamReference(body.conversationId, body.userId) ?? null
        });
      }
      if (method === "POST" && url.pathname === "/conversation-context") {
        const body = z
          .object({
            userId: z.string().min(1).max(200),
            conversationId: z.string().min(1).max(200)
          })
          .strict()
          .parse(requireObjectBody(await parseBody()));
        return json(res, 200, {
          context: service.getSelectedContext(body.conversationId, body.userId) ?? null
        });
      }
      if (method === "POST" && url.pathname === "/sports/conversations") {
        const body = z
          .object({
            userId: z.string().min(1).max(200),
            conversationId: z.string().min(1).max(200),
            resultId: z.string().uuid(),
            row: z.number().int().min(0).max(999),
            attachReference: z.boolean()
          })
          .strict()
          .parse(requireObjectBody(await parseBody()));
        const directory = options.briefings?.directory;
        if (!directory) return json(res, 404, { error: "Directories disabled" });
        service.claimConversation(body.conversationId, body.userId, false);
        try {
          const scope = directory.selectTopic(
            body.resultId,
            body.row,
            body.userId,
            body.conversationId,
            body.attachReference
          );
          return json(res, 201, service.openScopedConversation(body.userId, scope));
        } catch {
          return json(res, 409, {
            error:
              "Cannot open topic. Refresh the directory; the reference may have expired or conversation capacity may be full."
          });
        }
      }
      if (method === "POST" && ["/sports/teams", "/sports/results"].includes(url.pathname)) {
        const directory = options.briefings?.directory;
        if (!directory) return json(res, 404, { error: "Team directories are disabled" });
        const body = z
          .object({
            userId: z.string().min(1).max(200),
            conversationId: z.string().min(1).max(200),
            league: z.enum(["NBA", "NFL"]).optional(),
            resultId: z.string().uuid().optional()
          })
          .strict()
          .parse(requireObjectBody(await parseBody()));
        service.claimConversation(
          body.conversationId,
          body.userId,
          url.pathname === "/sports/teams"
        );
        if (url.pathname === "/sports/results") {
          if (!body.resultId) throw new HttpRequestError(400, "Result ID required");
          try {
            return json(
              res,
              200,
              directory.results.get(body.resultId, body.userId, body.conversationId)
            );
          } catch {
            return json(res, 404, { error: "Result unavailable or expired" });
          }
        }
        if (!body.league) throw new HttpRequestError(400, "League required");
        const releaseHistory = service.retainConversationWork(body.conversationId);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          return json(
            res,
            200,
            await directory.list(
              { league: body.league },
              body.userId,
              body.conversationId,
              controller.signal
            )
          );
        } catch {
          return json(res, 503, {
            error: "Directory unavailable. No complete team list was retrieved."
          });
        } finally {
          res.removeListener("close", cancel);
          releaseHistory();
        }
      }

      if (method === "POST" && url.pathname === "/sports/chat") {
        if (!options.briefings)
          return json(res, 404, { error: "Sports retrieval is not enabled on this server." });
        const body = requireObjectBody(await parseBody());
        try {
          return json(res, 202, options.briefings.startChat(body));
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          return json(res, 400, {
            error:
              "Cannot start this scope. Check the configured league, source, team ID and date window."
          });
        }
      }

      if (method === "POST" && url.pathname === "/messages") {
        const raw = requireObjectBody(await parseBody());
        rejectUnsupportedInputs(raw);
        const body = MessageBodySchema.parse(raw);
        const response = await service.submitMessage({
          messageId: body.messageId,
          conversationId: body.conversationId,
          userId: body.userId,
          text: body.text,
          runControls: body.runControls,
          referenceSelections: body.referenceSelections,
          timestampIso: body.timestampIso ?? new Date().toISOString()
        });

        return json(res, 200, response);
      }

      const cancelPath = url.pathname.match(
        /^\/conversations\/([^/]+)\/messages\/([^/]+)\/cancel$/
      );
      if (method === "POST" && cancelPath) {
        const state = await service.cancelMessage(
          decodeURIComponent(cancelPath[1]),
          decodeURIComponent(cancelPath[2])
        );
        return state ? json(res, 200, state) : json(res, 404, { error: "Message not found" });
      }

      if (method === "GET" && url.pathname === "/workers/document-tasks/status") {
        if (!options.documentTaskControl)
          return json(res, 404, { error: "Documentation tasks are disabled" });
        return json(res, 200, { status: options.documentTaskControl.status() });
      }

      if (method === "POST" && url.pathname === "/workers/document-tasks/restart") {
        if (!options.documentTaskControl)
          return json(res, 404, { error: "Documentation tasks are disabled" });
        const body = restartBodySchema.parse(requireObjectBody(await parseBody()));
        const status = await options.documentTaskControl.restart(body.expectedGeneration);
        return json(res, 200, { status });
      }

      if (
        method === "POST" &&
        (url.pathname === "/workers/document-tasks/inspect" ||
          url.pathname === "/workers/document-tasks/abandon")
      ) {
        if (!options.documentTaskControl)
          return json(res, 404, { error: "Documentation tasks are disabled" });
        const abandon = url.pathname.endsWith("/abandon");
        const body = (abandon ? abandonTaskBodySchema : inspectTaskBodySchema).parse(
          requireObjectBody(await parseBody())
        );
        // The sidecar resolves the owner from its own durable binding and owner rows,
        // never from the request. When this server also knows the owner (it may not,
        // after a restart), the stored owner must be that one. Nothing is claimed or
        // adopted here: this server's owner and history maps are not written. No await
        // separates this lookup from the dispatch below.
        const owner = service.conversationOwner(body.conversationId);
        const { generation, result } = await options.documentTaskControl.operate(
          body.expectedGeneration,
          {
            op: abandon ? "recover_abandon" : "recover_inspect",
            conversationId: body.conversationId,
            ...(owner === undefined ? {} : { expectedOwner: owner }),
            taskId: body.taskId,
            ...(abandon
              ? {
                  operationId: (body as z.infer<typeof abandonTaskBodySchema>).operationId,
                  expectedDigest: (body as z.infer<typeof abandonTaskBodySchema>).expectedDigest
                }
              : {})
          }
        );
        // Only the fields this contract defines are returned. A malformed inspection
        // is unavailable; a malformed abandonment reply leaves its outcome uncertain,
        // because the change may already be committed.
        const parsed = (abandon ? abandonResultSchema : taskViewSchema).safeParse(result);
        // A well-formed reply about another task or operation is not this answer.
        const task = parsed.success
          ? abandon
            ? (parsed.data as z.infer<typeof abandonResultSchema>).task
            : (parsed.data as z.infer<typeof taskViewSchema>)
          : undefined;
        const receipt =
          parsed.success && abandon
            ? (parsed.data as z.infer<typeof abandonResultSchema>).receipt
            : undefined;
        const correlated =
          task?.taskId === body.taskId &&
          (!abandon ||
            (receipt!.operationId === (body as z.infer<typeof abandonTaskBodySchema>).operationId &&
              receipt!.expectedDigest ===
                (body as z.infer<typeof abandonTaskBodySchema>).expectedDigest &&
              task.persistedStatus === "abandoned" &&
              JSON.stringify(task.abandonment) === JSON.stringify(receipt)));
        if (!parsed.success || !correlated)
          throw new DocumentTaskError(
            abandon ? "BRIDGE_UNCERTAIN" : "TASK_UNAVAILABLE",
            abandon ? "recover_abandon" : "recover_inspect"
          );
        // The generation the request was sent to; it may have changed since.
        return json(
          res,
          200,
          abandon
            ? {
                generation,
                receipt: (parsed.data as z.infer<typeof abandonResultSchema>).receipt,
                task: (parsed.data as z.infer<typeof abandonResultSchema>).task
              }
            : { generation, task: parsed.data }
        );
      }

      if (method === "POST" && url.pathname === "/workers/deep/run-once") {
        const result = await service.runDeepWorkerOnce();
        return json(res, 200, { result: result ?? null });
      }

      if (method === "GET" && url.pathname === "/workers/deep/dead-letters") {
        // Operator view as an explicit allowlist: no prompt, context snapshot or any
        // conversation, message or dispatch identity, and only a known failure category.
        // The task id is enough to delete or replay a record.
        const records = (await service.listDeadLetters()).map(
          ({ task, errorMessage, failedAtIso }) => ({
            task: {
              taskId: task.taskId,
              createdAtIso: task.createdAtIso,
              ...(task.sizeBand ? { sizeBand: task.sizeBand } : {})
            },
            errorCode: PUBLIC_DEAD_LETTER_CODES.has(errorMessage) ? errorMessage : "OTHER",
            failedAtIso
          })
        );
        return json(res, 200, { records, capacity: service.deadLetterCapacity() ?? null });
      }

      const deadLetterPath = url.pathname.match(/^\/workers\/deep\/dead-letters\/([^/]+)$/);
      if (method === "DELETE" && deadLetterPath) {
        const taskId = decodeURIComponent(deadLetterPath[1]);
        return (await service.discardDeadLetter(taskId))
          ? json(res, 200, { discarded: true, taskId })
          : json(res, 404, { error: "Dead-letter task not found" });
      }

      if (
        method === "POST" &&
        url.pathname.startsWith("/workers/deep/dead-letters/") &&
        url.pathname.endsWith("/replay")
      ) {
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

      if (method === "GET" && url.pathname === "/run-controls")
        return json(res, 200, service.runControlOptions());
      if (method === "GET" && url.pathname === "/run-controls/thinking") {
        try {
          return json(
            res,
            200,
            await service.thinkingOptions(url.searchParams.get("bindingId") ?? undefined)
          );
        } catch {
          return json(res, 200, {
            options: ["configured"],
            limitation: "Thinking options could not be verified"
          });
        }
      }
      if (method === "GET" && url.pathname === "/models") {
        return json(
          res,
          200,
          options.modelCatalog?.() ?? {
            version: 1,
            routingMode: "fixed-fast-deep",
            models: [],
            discovered: [],
            unlistedSelections: []
          }
        );
      }

      if (method === "POST" && url.pathname === "/routing/policy/tune") {
        const body = QueueDepthBodySchema.parse(requireObjectBody(await parseBody()));
        const policy = service.tuneRoutingPolicy(body.queueDepth ?? 0);
        return json(res, 200, { policy });
      }

      if (method === "POST" && url.pathname === "/routing/policy/set") {
        const body = RoutingPolicyBodySchema.parse(requireObjectBody(await parseBody()));
        const policy = service.setRoutingPolicy({
          maxFastP95Ms: body.maxFastP95Ms
        });
        return json(res, 200, { policy });
      }

      if (method === "GET" && url.pathname === "/conversations/retention")
        return json(res, 200, service.conversationRetention());

      const identityPath = url.pathname.match(/^\/conversations\/([^/]+)\/identity$/);
      if (method === "DELETE" && identityPath) {
        const conversationId = decodeURIComponent(identityPath[1]);
        const result = await service.retireConversation(conversationId);
        if (result.status === "retired") return json(res, 200, { retired: true, conversationId });
        if (result.status === "not_found")
          return json(res, 404, {
            code: "CONVERSATION_NOT_FOUND",
            error: "No retained identity for this conversation"
          });
        return json(res, 409, {
          code: "CONVERSATION_RETIREMENT_BLOCKED",
          error: "Conversation identity is still referenced",
          blockers: result.blockers
        });
      }

      if (
        method === "GET" &&
        url.pathname.startsWith("/conversations/") &&
        url.pathname.endsWith("/events")
      ) {
        const parts = url.pathname.split("/");
        const conversationId = parts[2];
        const events = await service.getTimeline(conversationId);
        if (!visibleTo(conversationId, principal!.principalId, events.length))
          return conversationNotFound(res);
        return json(res, 200, { events });
      }

      if (
        method === "GET" &&
        url.pathname.startsWith("/conversations/") &&
        url.pathname.endsWith("/events/stream")
      ) {
        const parts = url.pathname.split("/");
        const conversationId = parts[2];

        // Admitted before any timeline read, header or timer; refused at capacity.
        const stream = eventStreams.open(res);
        let boundVersion: symbol | undefined;
        try {
          boundVersion = service.conversationVersion(conversationId);
          // Expired history returns 410 before SSE headers.
          const initial = await stream.read(() => service.getTimeline(conversationId));
          if (!visibleTo(conversationId, principal!.principalId, initial.length)) {
            stream.close();
            return conversationNotFound(res);
          }
        } catch (error) {
          stream.close();
          throw error;
        }
        if (!stream.open) return;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        // The last snapshot the response accepted, including one buffered by a full write.
        let lastSerializedEvents: string | undefined;

        // An EventSource cannot read the 410 its reconnect would get, so say why first.
        const endStream = (error: unknown) =>
          stream.finish(
            error instanceof GenerationError && error.code === "CONVERSATION_EXPIRED"
              ? sseFrame("conversation-expired", JSON.stringify({ code: error.code }))
              : undefined
          );

        await stream.start(async () => {
          const events = await service.getTimeline(conversationId);
          // A retired id reused by new work ends the stream as expired, first.
          const currentVersion = service.conversationVersion(conversationId);
          if (boundVersion && currentVersion !== boundVersion)
            throw new GenerationError("CONVERSATION_EXPIRED", false);
          // Re-checked on every read: a stream opened before the first message must
          // not follow a conversation that another principal then claims.
          if (!visibleTo(conversationId, principal!.principalId, events.length))
            throw new Error("CONVERSATION_NOT_VISIBLE");
          boundVersion = currentVersion;
          const serialized = JSON.stringify(events);
          if (serialized === lastSerializedEvents) return;
          // One frame per write, so a full buffer never splits an event from its data.
          const written = stream.write(sseFrame("timeline", `{"events":${serialized}}`));
          if (written === "ok" || written === "full") lastSerializedEvents = serialized;
        }, endStream);
        stream.every(350, () => void stream.pump());
        stream.heartbeat(15_000);
        return;
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof DocumentTaskControlError)
        // A replacement that failed to become ready is 503. Stale, not-failed and
        // not-exited refusals are 409 and spawned nothing; CLOSED is also 409, but
        // shutdown may have overtaken a replacement that was already starting.
        return json(res, error.code === "STARTUP_FAILED" ? 503 : 409, {
          error: "Documentation task control request refused",
          code: error.code,
          status: error.status
        });
      if (error instanceof DocumentTaskError && error.code === "BRIDGE_UNCERTAIN")
        // No Retry-After and no retry advice. A new start's owner, task and binding
        // commit atomically, so resending its requestId returns that one task, but the
        // outcome of resume or cancel, and whether a model call ran, stay unknown.
        return json(res, 503, {
          code: error.code,
          op: error.op,
          uncertain: true,
          error:
            error.op === "start"
              ? "The task may have been accepted. Its outcome is unknown; inspect task state before submitting more work."
              : error.op === "abandon_task" || error.op === "recover_abandon"
                ? "The abandonment may have been recorded. Resending the same operationId and expectedDigest returns the recorded outcome."
                : "The outcome is unknown. Check the task's status before acting."
        });
      if (error instanceof DocumentTaskError && error.code === "BRIDGE_BUSY") {
        // Refused before anything was written to the sidecar; resending is safe.
        res.setHeader("Retry-After", "1");
        return json(res, 503, { error: "Documentation task request failed", code: error.code });
      }
      if (error instanceof DocumentTaskError && error.code === "REQUEST_TOO_LARGE")
        return json(res, 413, {
          error: "Documentation task request is too large",
          code: error.code
        });
      if (error instanceof DocumentTaskError) {
        const status =
          error.code === "CAPACITY_FULL"
            ? 429
            : [
                  "OWNER_MISMATCH",
                  "OWNER_UNSCOPED",
                  "REQUEST_CONFLICT",
                  "NOT_RESUMABLE",
                  "TASK_OWNER_ACTIVE",
                  "NOT_ABANDONABLE",
                  "TASK_CHANGED",
                  "ALREADY_ABANDONED",
                  "OPERATION_CONFLICT"
                ].includes(error.code)
              ? 409
              : error.code === "TASK_NOT_FOUND"
                ? 404
                : error.code.startsWith("INVALID_")
                  ? 400
                  : 503;
        return json(res, status, { error: "Documentation task request failed", code: error.code });
      }
      if (error instanceof ModelSelectionError)
        return json(res, 503, {
          error: error.message,
          code: error.code,
          exclusions: error.exclusions
        });
      if (error instanceof DuplicateMessageError)
        return json(res, 409, { error: error.message, code: error.code });
      if (error instanceof StreamCapacityError) {
        // Refused before any read, header, listener or timer; retrying is safe.
        res.setHeader("Retry-After", "1");
        return json(res, 429, { error: error.message, code: error.code });
      }
      if (error instanceof GenerationError && error.code === "TURN_CAPACITY") {
        // Nothing was claimed or appended; the same body may be resent as is.
        res.setHeader("Retry-After", "1");
        return json(res, 429, { error: error.message, code: error.code });
      }
      if (error instanceof GenerationError && error.code === "CAPABILITY_PLAN_TRUNCATED")
        return json(res, 502, {
          code: error.code,
          error:
            "Planning output reached its token limit. Increase the fast-model output allowance or use a model that can plan within the configured budget."
        });
      if (
        error instanceof GenerationError &&
        [
          "CONVERSATION_EXPIRED",
          "CONVERSATION_CAPACITY",
          "CONVERSATION_HISTORY_CAPACITY",
          "DEAD_LETTER_CAPACITY",
          "DEEP_QUEUE_CAPACITY"
        ].includes(error.code)
      )
        return json(
          res,
          error.code === "CONVERSATION_EXPIRED"
            ? 410
            : error.code === "CONVERSATION_HISTORY_CAPACITY"
              ? 413
              : 503,
          { error: error.code, code: error.code }
        );
      if (error instanceof GenerationError && error.code === "CANCELLED")
        // The caller (or shutdown) cancelled the turn; this is not a provider failure.
        return json(res, 409, { error: "Generation cancelled", code: error.code });
      if (error instanceof GenerationError)
        return json(
          res,
          error.code === "SHUTTING_DOWN"
            ? 503
            : error.code === "CONTEXT_TOO_LARGE"
              ? 413
              : error.code === "CAPABILITY_UNSUPPORTED"
                ? 400
                : 502,
          { error: "Generation failed", code: error.code }
        );
      if (error instanceof HttpRequestError) {
        if (error.closeConnection) res.setHeader("Connection", "close");
        return json(res, error.statusCode, {
          error: error.message,
          ...(error.code ? { code: error.code } : {})
        });
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
    if (!shutdown) {
      options.documentTasks?.close();
      options.briefings?.close();
    }
    shutdown ??= options.shutdown?.() ?? Promise.resolve();
    close((error) => {
      void shutdown!.then(
        () => callback?.(error),
        (failure) => callback?.(failure)
      );
    });
    return server;
  }) as typeof server.close;
  return Object.assign(server, {
    // Releases each stream's timers and listeners now; blocked streams are destroyed.
    closeStreams: () => eventStreams.closeAll(),
    retentionStats: () => ({
      responses: responses.size,
      ...eventStreams.stats(),
      wireConversations: protocolV1.retentionStats().conversations
    })
  });
}

export async function startServer(
  port: number,
  extensions: { briefings?: BriefingHttp } = {}
): Promise<RuntimeHandle> {
  const boundary = loadHttpBoundaryConfig();
  const turnAdmission = loadTurnAdmissionConfig();
  const streamAdmission = loadStreamAdmissionConfig();
  const briefings = extensions.briefings ?? (await loadLiveBriefingFromEnv(process.env));
  const shutdownConfig = loadShutdownConfig();
  const config = loadRuntimeProviderConfigFromEnv();
  const summaryConfig = loadSummaryConfig();
  if (summaryConfig.mode === "model" && process.env.CONTEXT_SUMMARY_MODEL_BINDING !== "fast")
    throw new Error(
      "CONTEXT_SUMMARY_MODE=model requires CONTEXT_SUMMARY_MODEL_BINDING=fast (explicit extra model calls)"
    );
  const catalog = await loadModelCatalog(process.env.MODEL_CATALOG_PATH);
  const dispatchConfig = await loadDispatchConfig();
  const contextBudget: ContextBudgetConfig = loadContextBudgetConfigFromEnv(
    process.env,
    dispatchConfig.mode === "fixed" ? { config, catalog } : undefined
  );
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

  seedPriorsForProfile(
    estimator,
    fastProfile,
    "direct",
    baseP95ByProvider(fastProfile.provider, "direct")
  );
  seedPriorsForProfile(
    estimator,
    fastProfile,
    "clarify",
    baseP95ByProvider(fastProfile.provider, "clarify")
  );
  seedPriorsForProfile(
    estimator,
    fastProfile,
    "deep",
    baseP95ByProvider(fastProfile.provider, "deep")
  );
  seedPriorsForProfile(
    estimator,
    deepProfile,
    "deep",
    baseP95ByProvider(deepProfile.provider, "deep")
  );

  const adaptiveRouting = new AdaptiveRoutingCoordinator(estimator, fastProfile, deepProfile, {
    maxFastP95Ms: parseBoundedNumberEnv(process.env.ROUTING_MAX_FAST_P95_MS, 1000, 400, 5000)
  });

  const telemetryStore = new FileLatencyTelemetryStore(
    process.env.TELEMETRY_STORE_PATH ?? "data/latency-telemetry.json"
  );
  const existingSnapshot = await telemetryStore.load();
  if (existingSnapshot) {
    adaptiveRouting.hydrateState(existingSnapshot);
  }
  if (process.env.ROUTING_MAX_FAST_P95_MS !== undefined) {
    adaptiveRouting.setMaxFastP95Ms(
      parseBoundedNumberEnv(process.env.ROUTING_MAX_FAST_P95_MS, 1000, 400, 5000)
    );
  }

  const discoveryConfig = loadDiscoveryConfigFromEnv();
  const connections: Connection[] = defaultConnectionsFromEnv(
    config,
    process.env,
    dispatchConfig.mode === "catalog"
      ? catalog.models.flatMap((e) => (e.provider === "cli" ? [] : [e.provider]))
      : []
  );
  const discoveryAdapters: Partial<Record<Connection["apiKind"], DiscoveryAdapter>> = {
    mock: {
      discover: async (connection) =>
        catalog.models
          .filter((e) => e.provider === "mock")
          .map((entry) => ({
            bindingId: entryBindingId(entry),
            connectionId: connection.connectionId,
            model: entry.model,
            observedAtIso: new Date().toISOString(),
            source: "synthetic-mock-adapter",
            installed: "yes" as const,
            access: "allowed" as const,
            health: "reachable" as const,
            apiCompatibility: ["mock"]
          }))
    },
    "ollama-chat": new OllamaDiscoveryAdapter(),
    "azure-openai-chat": new AzureDiscoveryAdapter(),
    "bedrock-converse": new BedrockDiscoveryAdapter()
  };
  const registry =
    dispatchConfig.mode === "catalog"
      ? await buildProviderRegistry(catalog, connections, config, contextBudget)
      : undefined;
  const claudeBridge = connectHekateClaude(catalog, registry, contextBudget);
  connections.push(...claudeBridge.connections);
  if (claudeBridge.discovery) discoveryAdapters.cli = claudeBridge.discovery;
  const inventoryStore = new InventoryStore(discoveryAdapters, discoveryConfig);
  const dispatch = registry
    ? new CatalogDispatch(catalog, registry, dispatchConfig.policy, contextBudget, () =>
        inventoryStore.listObservations()
      )
    : undefined;
  const buildCatalogResponse = () => {
    const view = describeModelCatalog(catalog, config, {
      connections,
      observations: inventoryStore.listObservations(),
      implementedBindingIds: claudeBridge.bindingIds
    });
    return {
      ...view,
      // Latest completed refresh per connection: no URLs, credentials or raw errors.
      discoveryRefresh: inventoryStore.refreshStatuses(),
      routingMode: dispatch ? ("catalog" as const) : ("fixed-fast-deep" as const),
      models: dispatch
        ? view.models.map((model) => ({
            ...model,
            selectedRoles: [],
            resourceFacts: dispatch.policy.bindings[model.id]?.facts ?? model.resourceFacts,
            resourceEvidenceKind: dispatch.policy.bindings[model.id]?.evidence.kind ?? "unknown"
          }))
        : view.models
    };
  };

  const recorder = await startEvaluationRecording({
    routingMode: dispatchConfig.mode,
    orchestration: "fast-deep",
    fast: config.fast,
    deep: config.deep,
    budget: contextBudget,
    thinking,
    summary: summaryConfig,
    hardware: { platform: platform(), arch: arch() },
    endpointDigests: [config.azure?.endpoint, config.ollama?.baseUrl, config.bedrock?.region].map(
      (value) => (value ? digest(value) : null)
    ),
    catalog: catalog.models.map(
      ({ id, provider, model, enabled, roles, tasks, capabilities, limits, routingPriority }) => ({
        id,
        provider,
        model,
        enabled,
        roles,
        tasks,
        capabilities,
        limits,
        routingPriority
      })
    ),
    dispatchPolicyDigest: digest(JSON.stringify(dispatchConfig.policy)),
    resourcePolicy: {
      allowedExecutionScopes: dispatchConfig.policy.allowedExecutionScopes,
      allowedBillingComponents: dispatchConfig.policy.allowedBillingComponents,
      maxIncrementalUsd: dispatchConfig.policy.maxIncrementalUsd,
      unknownCostAction: dispatchConfig.policy.unknownCostAction,
      quotaExhaustionAction: dispatchConfig.policy.quotaExhaustionAction,
      waitTimeoutMs: dispatchConfig.policy.waitTimeoutMs,
      bindings: Object.fromEntries(
        Object.entries(dispatchConfig.policy.bindings).map(([id, resource]) => [
          id,
          {
            facts: resource.facts,
            quotaAdmission: resource.quotaAdmission ?? null,
            maxInvocationUsd: resource.incremental?.maxInvocationUsd ?? null,
            quota: resource.quota
              ? {
                  unit: resource.quota.unit,
                  remaining: resource.quota.remaining,
                  poolDigest: digest(resource.quota.poolId)
                }
              : null,
            concurrency: resource.compute?.concurrency ?? null
          }
        ])
      )
    },
    cliLimits: process.env.HEKATE_CLI_ROOT ? cliLimits() : null,
    worker: resolveDeepWorkerAutoRunConfig(process.env),
    generation: Object.fromEntries(
      [
        "CLI_TIMEOUT_MS",
        "CLI_MAX_OUTPUT_BYTES",
        "CLI_MAX_CONCURRENCY",
        "HEKATE_CLAUDE_USAGE_POLICY",
        "CHAT_FAST_MAX_OUTPUT_TOKENS",
        "CHAT_DEEP_MAX_OUTPUT_TOKENS",
        "DEEP_WORKER_AUTO_RUN",
        "DEEP_WORKER_INTERVAL_MS"
      ].map((key) => [key, process.env[key] ?? null])
    )
  });
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore(recorder?.record);
  const deadLetters = new InMemoryDeadLetterStore();
  let summaryModel =
    summaryConfig.mode === "model"
      ? buildFastProvider(
          config,
          { ...contextBudget, fastOutputTokens: summaryConfig.maxTokens },
          thinking
        )
      : undefined;
  if (summaryModel && dispatch) {
    const entry = catalog.models.find(
      (e) => e.provider === config.fast.provider && e.model === config.fast.model
    );
    if (!entry) throw new Error("Catalog summary binding must be curated");
    summaryModel = dispatch.wrapSummary(
      summaryModel,
      entryBindingId(entry),
      summaryConfig.maxTokens
    );
  }
  const summaryProvider = summaryModel
    ? new ModelContextSummarizer(
        summaryModel,
        contextBudget.windowTokens,
        summaryConfig.maxTokens,
        contextBudget.safetyTokens
      )
    : undefined;
  const contextManager = new ContextManager(timeline, contextBudget, {
    config: summaryConfig,
    summarizer: summaryProvider
  });
  const trustedFactsProvider = () => ({
    fastProvider: config.fast.provider,
    fastModel: config.fast.model,
    deepProvider: config.deep.provider,
    deepModel: config.deep.model,
    generatedAtIso: new Date().toISOString()
  });
  const plannerEngine = rolePlannerEngine();
  const roleCatalog = await loadRoleCatalog(process.env.ROLE_CATALOG_PATH);
  const orchestrator =
    config.fast.provider === "mock" && config.deep.provider === "mock" && !dispatch
      ? new ChatOrchestrator(
          providers.fastProvider,
          queue,
          timeline,
          adaptiveRouting,
          contextManager,
          trustedFactsProvider,
          undefined,
          deadLetters
        )
      : new CapabilityChat(
          providers.fastProvider,
          queue,
          timeline,
          contextManager,
          trustedFactsProvider,
          () => briefings?.tools() ?? [],
          dispatch,
          roleCatalog,
          plannerEngine,
          () => briefings?.directory?.results
        );
  const worker = new DeepWorker(
    queue,
    providers.deepProvider,
    timeline,
    2,
    deadLetters,
    adaptiveRouting,
    dispatch
  );
  const service = new ChatService(
    orchestrator,
    worker,
    timeline,
    queue,
    deadLetters,
    adaptiveRouting,
    turnAdmission
  );

  const saveTelemetry = () =>
    telemetryStore.save({ ...adaptiveRouting.snapshotState(), dispatch: dispatch?.telemetry() });

  const autoRunConfig = resolveDeepWorkerAutoRunConfig(process.env);

  const runDeepWorkerTick = async () => {
    try {
      await service.runDeepWorkerOnce();
    } catch (error) {
      console.warn(`Deep worker auto-run failed: ${(error as Error).message}`);
    }
  };

  // The installation identity is loaded, or created once, after configuration has
  // been validated (a misconfigured start creates no credentials), before the
  // document sidecar starts and before the port is bound. An identity that is not
  // private to this user stops startup, releasing what was already opened.
  let auth: LocalAuthenticator;
  try {
    auth = new LocalAuthenticator(await loadOrCreateIdentity());
  } catch (error) {
    briefings?.close();
    recorder?.invalidate("EVAL_STARTUP_FAILED");
    throw error;
  }
  const runtimeMode = resolveRuntimeModeInfo(config);
  // Each generation is a fresh child on the same store; only an operator restarts one.
  // The configuration is fixed here, so a later change to the environment or working
  // directory cannot point a replacement at another store or script.
  const documentTaskConfig = process.env.DOC_TASK_PYTHON
    ? ([
        process.env.DOC_TASK_PYTHON,
        resolve("experiments/doc-agent/chat_bridge.py"),
        resolve(process.env.DOC_TASK_ROOT ?? "data/document-tasks"),
        process.env.DOC_TASK_MODEL ?? "gemma4:26b"
      ] as const)
    : undefined;
  const documentTasks = documentTaskConfig
    ? new DocumentTaskSupervisor(() => new PythonDocumentTasks(...documentTaskConfig))
    : undefined;

  const pairing = new PairingController();
  const urlHost = boundary.host.includes(":") ? `[${boundary.host}]` : boundary.host;
  let pairUrl = "";
  const announcePairing = (code: string) =>
    console.log(
      `Pair a browser: open ${pairUrl} and enter ${code} (one use, valid for 10 minutes).`
    );
  const server = createChatServer(service, {
    briefings,
    documentTasks,
    documentTaskControl: documentTasks,
    runtimeMode: dispatch ? { mode: "unknown" } : runtimeMode,
    modelCatalog: buildCatalogResponse,
    dispatchTelemetry: () => dispatch?.telemetry() ?? { attempts: [], reservations: [] },
    evaluationStatus: () =>
      recorder ? { enabled: true, ...recorder.status() } : { enabled: false },
    contextTelemetry: () => contextManager.getSummaryTelemetry(),
    maxBodyBytes: boundary.maxBodyBytes,
    ...streamAdmission,
    auth,
    pairing: {
      controller: pairing,
      issueSession: () => auth.issueSession(),
      announce: announcePairing
    }
  });
  // Do not report success or start background work until the port is bound.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      documentTasks?.close();
      briefings?.close();
      recorder?.invalidate("EVAL_STARTUP_FAILED");
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use. This server did not start. Stop the existing server or choose a different PORT.`
            )
          : error
      );
    };
    server.once("error", onError);
    server.listen(port, boundary.host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const telemetrySaveIntervalMs = parsePositiveIntEnv(
    process.env.TELEMETRY_SAVE_INTERVAL_MS,
    5000,
    250,
    60_000
  );
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
    briefings?.close();
    clearInterval(timer);
    if (deepWorkerTimer) clearInterval(deepWorkerTimer);
    clearInterval(discoveryTimer);
    inventoryStore.shutdown();
  };
  const runtime = createRuntimeHandle(server, service, {
    config: shutdownConfig,
    stopBackground,
    onTimeout: () => recorder?.invalidate("EVAL_RUNTIME_SHUTDOWN_TIMEOUT"),
    stopInternal: () => contextManager.shutdown(),
    persist: async () => {
      const results = await Promise.allSettled([saveTelemetry(), recorder?.finish()]);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          "RUNTIME_PERSISTENCE_FAILED"
        );
    }
  });
  server.once("close", stopBackground);
  server.once("close", () => pairing.clear());

  // Safe to log: describeProviderConfig() never includes secret values
  // (e.g. AZURE_OPENAI_API_KEY), only provider/model names, endpoints, and
  // region — see its docstring in ./config/providerConfig.
  const autoRunLabel = autoRunConfig.enabled ? `on/${autoRunConfig.intervalMs}ms` : "off";
  console.log(
    `Chat server listening on ${boundary.host} port ${runtime.address.port} (${describeProviderConfig(config)}; deep-worker auto=${autoRunLabel})`
  );
  // The code is shown once, on this console only; a new one needs a restart or an
  // operator request to POST /pair/reissue.
  pairUrl = `http://${urlHost}:${runtime.address.port}/pair`;
  announcePairing(pairing.issue());
  return runtime;
}
