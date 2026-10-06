import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStore } from "../models/inventory";
import { discoveryLimitsSchema } from "../config/discoveryLimits";
import { UNKNOWN_RESOURCE_FACTS, type Connection } from "../models/connections";
import { FileLatencyTelemetryStore } from "../telemetry/latencyTelemetryStore";
/**
 * Assembled-runtime sustained-memory gate; run with --expose-gc. Provider-free.
 *
 * Two runtimes are built in one process from the same classes `startServer` wires
 * and driven over loopback HTTP: the live shape (`CapabilityChat` with catalog
 * dispatch, inline retrieval and the sports registry) and the queue shape
 * (`ChatOrchestrator` with the deep worker and dead letters). Each round takes a
 * sample with large payload histories retained, one with the identity table at
 * its limit and one after idle expiry and identity retirement. Registry sizes are asserted; heap samples are recorded as evidence.
 * The limits are deliberately small: this shows that retained state plateaus
 * under stated settings, not an absolute bound at the defaults.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { CapabilityChat, type CapabilityTool } from "../app/capabilityChat";
import { ChatService } from "../app/chatService";
import { ContextManager } from "../app/contextManager";
import { InMemoryDeadLetterStore } from "../app/deadLetterStore";
import { generationLifecycle } from "../app/generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "../app/orchestrator";
import { createRuntimeHandle } from "../app/runtimeHandle";
import { InMemoryConversationTimelineStore } from "../app/timelineStore";
import { conversationRetentionSchema } from "../config/conversationRetention";
import { bindingResourcesSchema, dispatchPolicySchema } from "../config/dispatchConfig";
import { modelEntrySchema, type ModelCatalog } from "../config/modelCatalog";
import { GenerationError } from "../domain/generation";
import type { ChatTimelineEvent } from "../domain/types";
import type { ModelObservation } from "../models/inventory";
import {
  InMemoryTaskQueue,
  type DeepModelProvider,
  type FastModelProvider
} from "../providers/interfaces";
import { MockFastProvider } from "../providers/mockProviders";
import { ProviderRegistry, entryBindingId } from "../providers/providerRegistry";
import { AdaptiveRoutingCoordinator } from "../routing/adaptiveRouting";
import { CatalogDispatch } from "../routing/catalogDispatch";
import { AdmissionError, ResourceAdmission } from "../routing/resourceAdmission";
import { createChatServer } from "../server";
import { createLiveBriefing } from "../sports/liveBriefing";
import { InMemoryLatencyEstimator } from "../telemetry/latencyEstimator";

if (!global.gc) throw Error("Run Node with --expose-gc");
const collect = global.gc;

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const heapOnly = process.argv.includes("--heap-only");
const settings = {
  // --measured N runs a longer soak; the recorded evidence uses the default.
  rounds: { warmup: 3, measured: Number(flag("--measured") ?? 12) },
  live: {
    conversationsPerRound: 24,
    concurrency: 8,
    // Twice the driver's concurrency: a pooled conversation can occupy one active
    // turn plus its previous turn's detached retrieval, so the workload itself is
    // never refused. The admission probe fills every slot deliberately and needs
    // one leased history per slot, which conversation.maxHistories must allow.
    maxConcurrentTurns: 16,
    payloadRows: 150,
    payloadCellChars: 180
  },
  conversation: {
    maxIdentities: 40,
    maxHistories: 16,
    idleTtlMs: 600000,
    maxEvents: 400,
    maxBytes: 1048576
  },
  execution: { maxCompleted: 20, completedTtlMs: 300000, maxMetrics: 50 },
  deadLetters: { maxRecords: 6, maxBytes: 1048576 },
  quotaPools: 3,
  scarceQuotaRequests: 25,
  dispatchWaitTimeoutMs: 500,
  sportsSnapshots: 20,
  slowWriteEvery: 7,
  slowWriteMs: 2,
  ledger: { maxPools: 50, batches: 6, callsPerBatch: 5000, renamedPoolsPerBatch: 2000 },
  heapPlateauTolerance: 0.05
};
if (!Number.isSafeInteger(settings.rounds.measured) || settings.rounds.measured < 3)
  throw Error("--measured must be an integer of at least 3 rounds");
// Construction-time settings that the assembled runtime reads from the environment.
process.env.EXECUTION_RETENTION_MAX_COMPLETED = String(settings.execution.maxCompleted);
process.env.EXECUTION_RETENTION_TTL_MS = String(settings.execution.completedTtlMs);
process.env.EXECUTION_RETENTION_MAX_METRICS = String(settings.execution.maxMetrics);
process.env.ADMISSION_MAX_QUOTA_POOLS = String(settings.quotaPools);
process.env.TOOL_RESULT_MAX_BYTES = "1048576";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const assertions = new Map<string, { checked: number; failed: number; firstFailure?: string }>();
function check(name: string, ok: boolean, detail: () => unknown = () => "") {
  const entry = assertions.get(name) ?? { checked: 0, failed: 0 };
  entry.checked++;
  if (!ok) {
    entry.failed++;
    entry.firstFailure ??= JSON.stringify(detail());
  }
  assertions.set(name, entry);
}
const outcomes = new Map<string, number>();
const tally = (label: string, result: string | number) =>
  outcomes.set(`${label}:${result}`, (outcomes.get(`${label}:${result}`) ?? 0) + 1);

async function request(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Non-JSON bodies are reported by status only. */
  }
  return { status: response.status, json, code: String(json?.code ?? response.status) };
}
/** Opens an event stream, reads until the first frame arrives, then disconnects. */
async function touchStream(url: string) {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.ok) await response.body!.getReader().read();
    else await response.text();
    return response.status;
  } finally {
    controller.abort();
  }
}
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      let next: T | undefined;
      while ((next = queue.shift()) !== undefined) await work(next);
    })
  );
}
async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(5);
  return condition();
}
async function listen(server: ReturnType<typeof createChatServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Every Nth append is delayed, so terminal writes overlap later submissions. */
class SlowTimeline extends InMemoryConversationTimelineStore {
  appends = 0;
  delayed = 0;
  async appendEvent(conversationId: string, event: ChatTimelineEvent) {
    if (++this.appends % settings.slowWriteEvery === 0) {
      this.delayed++;
      await sleep(settings.slowWriteMs);
    }
    return super.appendEvent(conversationId, event);
  }
}
const retention = conversationRetentionSchema.parse(settings.conversation);
const budget = {
  windowTokens: 32768,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 2048
};
const facts = () => ({
  fastProvider: "mock",
  fastModel: "scripted",
  deepProvider: "none",
  deepModel: "none",
  generatedAtIso: new Date().toISOString()
});

// ---------------------------------------------------------------- live runtime
function buildLiveRuntime() {
  let skewMs = 0;
  const clock = () => Date.now() + skewMs;
  const evidence = {
    source: "sustained-memory-gate",
    kind: "configured" as const,
    checkedAtIso: new Date(Date.now() - 60000).toISOString(),
    expiresAtIso: new Date(Date.now() + 86400000).toISOString()
  };
  const resources = (quota: { poolId: string; unit: "requests" | "tokens"; remaining: number }) =>
    bindingResourcesSchema.parse({
      facts: { executionScope: "local-device", billingComponents: ["owned-compute"] },
      evidence,
      incremental: { currency: "USD", maxInvocationUsd: 0, evidence },
      quota: { ...quota, evidence },
      compute: {
        poolId: quota.poolId === "pool-shared" ? "gpu-shared" : "gpu-single",
        concurrency: 2
      }
    });
  const shared = { poolId: "pool-shared", unit: "requests" as const, remaining: 1e9 };
  const pools = {
    alpha: shared,
    beta: shared,
    gamma: {
      poolId: "pool-scarce",
      unit: "requests" as const,
      remaining: settings.scarceQuotaRequests
    },
    delta: { poolId: "pool-tokens", unit: "tokens" as const, remaining: 1e12 }
  };
  const ids = Object.keys(pools) as (keyof typeof pools)[];
  const entries = ids.map((id) =>
    modelEntrySchema.parse({
      id,
      provider: "mock",
      model: id,
      enabled: true,
      roles: ["fast"],
      tasks: ["conversation", "coding", "reasoning", "summarization", "extraction"],
      capabilities: {
        thinking: "unknown",
        tools: "unsupported",
        vision: "unsupported",
        structuredOutput: "supported"
      },
      limits: { contextTokens: budget.windowTokens, maxOutputTokens: 2048 },
      deployment: "unknown"
    })
  );
  const catalog: ModelCatalog = { version: 1, models: entries };
  const policy = dispatchPolicySchema.parse({
    quotaExhaustionAction: "wait",
    waitTimeoutMs: settings.dispatchWaitTimeoutMs,
    bindings: Object.fromEntries(ids.map((id) => [id, resources(pools[id])]))
  });
  const observations: ModelObservation[] = entries.map((e) => ({
    bindingId: entryBindingId(e),
    connectionId: `default-${e.provider}`,
    model: e.model,
    installed: "yes",
    access: "allowed",
    health: "reachable",
    apiCompatibility: ["mock"],
    observedAtIso: evidence.checkedAtIso,
    expiresAtIso: evidence.expiresAtIso,
    revision: "rev-1",
    source: "fixture"
  }));
  const calls: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const answer = "Scripted answer. " + "x".repeat(6000);
  const plan = (text: string): unknown => {
    const call = (tool: string, args: unknown = {}) => ({
      action: "retrieve",
      calls: [{ tool, arguments: args }]
    });
    if (text.startsWith("payload")) return call("bench:payload");
    if (text.startsWith("tool-fail")) return call("bench:fail");
    if (text.startsWith("hold")) return call("bench:hold");
    if (text.startsWith("games"))
      return call("sports:find-games", {
        league: "NFL",
        from: new Date(clock() - 3 * 86400000).toISOString(),
        to: new Date(clock()).toISOString()
      });
    return { action: "answer", message: text.startsWith("tiny") ? "ok" : answer };
  };
  const provider = (id: string): FastModelProvider => ({
    metadata: { provider: "mock", model: id },
    createProvisionalReply: async (input, control) => {
      calls[id]++;
      await sleep(1);
      control?.signal.throwIfAborted();
      const text = input.message.text;
      if (text.startsWith("provider-error")) throw new GenerationError("PROVIDER_ERROR", false);
      if (text.startsWith("bad-plan")) return { text: "not a plan", finishReason: "stop" };
      return { text: JSON.stringify(plan(text)), finishReason: "stop" };
    }
  });
  const registry = new ProviderRegistry();
  for (const e of entries)
    registry.register({
      bindingId: entryBindingId(e),
      entry: e,
      connection: {
        connectionId: `default-${e.provider}`,
        apiKind: "mock",
        resourceFacts: resources(shared).facts,
        quota: {},
        compute: { ownedOrRented: "unknown" }
      },
      fast: provider(e.id),
      capabilities: ["structuredOutput"]
    });
  const dispatch = new CatalogDispatch(catalog, registry, policy, budget, () => observations);
  // The policy check runs at construction: one pool too many must not start.
  let startupRejected = false;
  try {
    new ResourceAdmission(
      dispatchPolicySchema.parse({
        bindings: {
          ...policy.bindings,
          extra: resources({ poolId: "pool-extra", unit: "requests", remaining: 1 })
        }
      })
    );
  } catch {
    startupRejected = true;
  }
  check("quota.startup rejects a policy with more pools than the limit", startupRejected);

  const sportsConfig = JSON.parse(
    readFileSync("data/sports/nfl-live-briefing.example.json", "utf8")
  );
  const sportsVariant = (maxResults: number) => ({
    ...sportsConfig,
    directories: { maxSnapshots: settings.sportsSnapshots },
    gameSearch: { maxSnapshots: settings.sportsSnapshots, maxResults }
  });
  const transport = (async (url: string | URL | Request) =>
    String(url).includes("/games")
      ? Response.json({
          data: Array.from({ length: 12 }, (_, n) => ({
            id: 100 + n,
            datetime: new Date(clock() - (n + 1) * 3600000).toISOString(),
            status_state: "final",
            home_team: { id: 1, full_name: "Harbor Comets" },
            visitor_team: { id: 2, full_name: "Visitor Stars" },
            home_team_score: 20 + n,
            visitor_team_score: 17
          })),
          meta: { next_cursor: null }
        })
      : Response.json({
          data: [
            {
              id: 1,
              full_name: "Harbor Comets",
              name: "Comets",
              abbreviation: "HC",
              city: "Harbor"
            },
            {
              id: 2,
              full_name: "Visitor Stars",
              name: "Stars",
              abbreviation: "VS",
              city: "Visitor"
            }
          ]
        })) as typeof fetch;
  const sports = createLiveBriefing(sportsVariant(50), "fixture-key", transport, clock);
  let reloads = 0;
  sports.http.reload = async () => sports.apply(sportsVariant(++reloads % 2 ? 49 : 50));

  const cell = "c".repeat(settings.live.payloadCellChars);
  const benchTools: CapabilityTool[] = [
    {
      id: "bench:payload",
      description: "Returns a large table payload.",
      inputSchema: { type: "object" },
      validate: (v) => v,
      execute: async (_args, userId, _requestId, _signal, conversationId) =>
        sports.http.directory!.results.put(userId, conversationId!, {
          version: "tool-result-v1",
          context: {
            status: "ready",
            summary: "Large fixture table",
            expiresAt: new Date(clock() + 300000).toISOString(),
            scope: "sustained-memory gate",
            coverage: "partial",
            limitations: []
          },
          payload: {
            kind: "table",
            title: "Fixture",
            columns: ["a", "b", "c", "d", "e", "f"],
            rows: Array.from({ length: settings.live.payloadRows }, () => Array(6).fill(cell))
          },
          evidence: {
            sourceUrl: "https://fixture.invalid/table",
            observedAt: new Date(clock()).toISOString(),
            revision: "fixture"
          }
        })
    },
    {
      id: "bench:fail",
      description: "Always fails.",
      inputSchema: { type: "object" },
      validate: (v) => v,
      execute: async () => {
        throw new Error("fixture failure");
      }
    },
    {
      id: "bench:hold",
      description: "Runs until cancelled.",
      inputSchema: { type: "object" },
      validate: (v) => v,
      execute: (_args, _userId, _requestId, signal) =>
        new Promise((_, reject) => {
          const abort = () => reject(new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        })
    }
  ];

  const timeline = new SlowTimeline(undefined, retention, clock);
  const queue = new InMemoryTaskQueue(
    settings.deadLetters.maxRecords,
    settings.deadLetters.maxBytes
  );
  const deadLetters = new InMemoryDeadLetterStore(settings.deadLetters);
  const context = new ContextManager(timeline, budget);
  const chat = new CapabilityChat(
    provider("unrouted"),
    queue,
    timeline,
    context,
    facts,
    () => [...sports.http.tools(), ...benchTools],
    dispatch,
    undefined,
    "native",
    () => sports.http.directory?.results
  );
  const unusedDeep: DeepModelProvider = {
    resolveDeepTask: async () => {
      throw new GenerationError("PROVIDER_ERROR", false);
    }
  };
  const worker = new DeepWorker(queue, unusedDeep, timeline, 2, deadLetters, undefined, dispatch);
  const service = new ChatService(chat, worker, timeline, queue, deadLetters, undefined, {
    maxConcurrentTurns: settings.live.maxConcurrentTurns
  });
  const server = createChatServer(service, {
    briefings: sports.http,
    dispatchTelemetry: () => dispatch.telemetry(),
    contextTelemetry: () => context.getSummaryTelemetry()
  });
  const stats = () => ({
    timeline: timeline.retentionStats(),
    service: service.retentionStats(),
    lifecycle: generationLifecycle(queue).retentionStats(),
    dispatch: dispatch.retentionStats(),
    admission: dispatch.admission.retentionStats(),
    chat: chat.retentionStats(),
    server: server.retentionStats(),
    queue: queue.size(),
    queueRetention: queue.retentionStats(),
    deadLetters: deadLetters.retentionStats(),
    context: context.retentionStats(),
    sports: {
      ...sports.http.directory!.retentionStats(),
      ...sports.http.gameOperations!.retentionStats(),
      coordinator: sports.coordinator.retentionStats()
    }
  });
  return {
    server,
    service,
    chat,
    timeline,
    queue,
    dispatch,
    context,
    sports,
    calls,
    stats,
    bindingIds: entries.map(entryBindingId),
    scarceBindingId: entryBindingId(entries[2]),
    advance: (ms: number) => {
      skewMs += ms;
    },
    quiesce: async () => {
      await service.whenIdle();
      await waitFor(() => server.retentionStats().streams === 0);
    }
  };
}
type LiveRuntime = ReturnType<typeof buildLiveRuntime>;

async function liveRound(live: LiveRuntime, base: string, round: number) {
  const variants = ["tool-fail", "provider-error", "bad-plan", "hold"];
  const conversation = async (i: number) => {
    const conversationId = `a${round}-${i}`,
      userId = `user-${i % 3}`;
    const send = async (label: string, text: string, extra: Record<string, unknown> = {}) => {
      const messageId = (extra.messageId as string) ?? randomUUID();
      const response = await request(base, "POST", "/messages", {
        conversationId,
        userId,
        text,
        ...extra,
        messageId
      });
      tally(`live.${label}`, response.status === 200 ? 200 : response.code);
      return { ...response, messageId };
    };
    const first = await send("answer", "answer please " + i);
    if (first.status !== 200) return;
    const pinned = live.bindingIds[i % live.bindingIds.length];
    const payload = await send("payload", "payload table", {
      runControls: { bindingId: pinned, mode: "chat", thinking: "configured" }
    });
    if (pinned !== live.scarceBindingId)
      check(
        "live.pinned payload turn is accepted or expired under pressure",
        [200, 410].includes(payload.status),
        () => payload
      );
    await send("games", "games this week");
    const variant = variants[Math.floor(i / 4) % variants.length];
    const failing = await send(variant, variant + " turn");
    if (variant === "hold" && failing.status === 200) {
      const cancelled = await request(
        base,
        "POST",
        `/conversations/${conversationId}/messages/${failing.messageId}/cancel`
      );
      tally("live.cancel", cancelled.status);
      check("live.cancelling held retrieval succeeds", cancelled.status === 200, () => cancelled);
    }
    const duplicate = await send("duplicate", "answer again", { messageId: first.messageId });
    check(
      "live.reused message ID is rejected while history is retained",
      [409, 410].includes(duplicate.status),
      () => duplicate
    );
    await send("answer", "answer once more");
    if (i % 8 === 0)
      tally(
        "live.stream",
        await touchStream(`${base}/conversations/${conversationId}/events/stream`)
      );
    if (i % 8 === 4)
      tally(
        "live.context",
        (await request(base, "POST", "/conversation-context", { conversationId, userId })).status
      );
  };
  const wire = async (n: number) => {
    const path = `/v1/conversations/${randomUUID()}`,
      scope = { accountId: `account-${n}`, projectId: "gate" };
    for (const text of ["answer over v1", "payload over v1"])
      tally(
        "live.v1",
        (
          await request(base, "POST", `${path}/messages`, {
            ...scope,
            protocolVersion: "1.0",
            messageId: randomUUID(),
            text,
            clientTimestampIso: new Date().toISOString()
          })
        ).status
      );
    tally(
      "live.v1-stream",
      await touchStream(`${base}${path}/events/stream?accountId=${scope.accountId}&projectId=gate`)
    );
  };
  const scoped = async (n: number) => {
    const owner = { userId: "user-0", conversationId: `a${round}-browse-${n}` };
    const teams = await request(base, "POST", "/sports/teams", { ...owner, league: "NFL" });
    tally("live.directory", teams.status);
    const resultId = teams.json?.context?.resultId;
    if (!resultId) return;
    const opened = await request(base, "POST", "/sports/conversations", {
      ...owner,
      resultId,
      row: 0,
      attachReference: true
    });
    tally("live.scoped-conversation", opened.status);
    if (opened.status === 201)
      tally(
        "live.scoped-turn",
        (
          await request(base, "POST", "/messages", {
            conversationId: opened.json!.conversationId,
            userId: owner.userId,
            messageId: randomUUID(),
            text: "answer in scope"
          })
        ).status
      );
  };
  const reload = async () => {
    tally("live.reload", (await request(base, "POST", "/briefings/config/reload", {})).status);
  };

  const work: (() => Promise<void>)[] = Array.from(
    { length: settings.live.conversationsPerRound },
    (_, i) => () => conversation(i)
  );
  // Configuration churn, protocol v1 and scoped conversations overlap ordinary turns.
  work.splice(
    18,
    0,
    reload,
    () => wire(1),
    () => scoped(1)
  );
  work.splice(
    6,
    0,
    reload,
    () => wire(0),
    () => scoped(0)
  );
  await pool(work, settings.live.concurrency, (task) => task());
  await live.chat.whenIdle();

  // One conversation takes payload turns until its history limit rejects a write.
  let historyFull = false;
  for (let turn = 0; turn < 16 && !historyFull; turn++) {
    const response = await request(base, "POST", "/messages", {
      conversationId: `a${round}-long`,
      userId: "user-0",
      messageId: randomUUID(),
      text: "payload until full"
    });
    tally("live.history-fill", response.status === 200 ? 200 : response.code);
    historyFull = response.code === "CONVERSATION_HISTORY_CAPACITY";
    await live.chat.whenIdle();
  }
  check("live.history limit rejects with CONVERSATION_HISTORY_CAPACITY", historyFull);
}

/** Fills the identity table, then confirms backpressure leaves live work usable. */
async function identityFill(base: string, round: number) {
  let identityFull = false,
    lastAdmitted = "";
  for (let n = 0; n <= settings.conversation.maxIdentities && !identityFull; n++) {
    const conversationId = `a${round}-fill-${n}`;
    const response = await request(base, "POST", "/messages", {
      conversationId,
      userId: "user-1",
      messageId: randomUUID(),
      text: "tiny"
    });
    tally("live.identity-fill", response.status === 200 ? 200 : response.code);
    identityFull = response.code === "CONVERSATION_CAPACITY";
    if (!identityFull) {
      check("live.identity fill turn succeeds", response.status === 200, () => response);
      lastAdmitted = conversationId;
    }
  }
  check("live.identity limit rejects with CONVERSATION_CAPACITY", identityFull);
  const stillLive = await request(base, "POST", "/messages", {
    conversationId: lastAdmitted,
    userId: "user-1",
    messageId: randomUUID(),
    text: "tiny"
  });
  check(
    "live.existing conversation continues at identity capacity",
    stillLive.status === 200,
    () => stillLive
  );
}

/** Idle expiry, then operator retirement of every expired identity. */
async function retireAll(base: string, label: string) {
  for (let pass = 0; pass < 10; pass++) {
    const listing = (await request(base, "GET", "/conversations/retention")).json!;
    if (!listing.expiredCount) return;
    for (const { conversationId } of listing.expired as { conversationId: string }[]) {
      const response = await request(
        base,
        "DELETE",
        `/conversations/${encodeURIComponent(conversationId)}/identity`
      );
      tally(`${label}.retire`, response.status === 200 ? 200 : response.code);
      check(
        `${label}.expired identity retires once nothing references it`,
        response.status === 200,
        () => response
      );
    }
  }
}

// --------------------------------------------------------------- queue runtime
function buildQueueRuntime() {
  let skewMs = 0;
  const clock = () => Date.now() + skewMs;
  const timeline = new InMemoryConversationTimelineStore(undefined, retention, clock);
  const queue = new InMemoryTaskQueue(
    settings.deadLetters.maxRecords,
    settings.deadLetters.maxBytes
  );
  const deadLetters = new InMemoryDeadLetterStore(settings.deadLetters);
  const context = new ContextManager(timeline, budget);
  const adaptive = new AdaptiveRoutingCoordinator(
    new InMemoryLatencyEstimator(),
    { provider: "mock", model: "mock-v1" },
    { provider: "mock", model: "mock-v1" }
  );
  const state = { failing: true, deepCalls: 0 };
  const deep: DeepModelProvider = {
    metadata: { provider: "mock", model: "scripted-deep" },
    resolveDeepTask: async (task, control) => {
      state.deepCalls++;
      control?.signal.throwIfAborted();
      if (state.failing && task.normalizedPrompt.includes("doomed"))
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      return {
        taskId: task.taskId,
        finishReason: "stop",
        finalReply: "Refined. " + "y".repeat(4000),
        confidence: 1,
        citations: [],
        totalLatencyMs: 1
      };
    }
  };
  const orchestrator = new ChatOrchestrator(
    new MockFastProvider(),
    queue,
    timeline,
    adaptive,
    context,
    facts,
    undefined,
    deadLetters
  );
  const worker = new DeepWorker(queue, deep, timeline, 2, deadLetters, adaptive);
  const service = new ChatService(orchestrator, worker, timeline, queue, deadLetters, adaptive);
  const server = createChatServer(service, {
    contextTelemetry: () => context.getSummaryTelemetry()
  });
  const stats = () => ({
    timeline: timeline.retentionStats(),
    service: service.retentionStats(),
    lifecycle: generationLifecycle(queue).retentionStats(),
    worker: worker.retentionStats(),
    server: server.retentionStats(),
    queue: queue.size(),
    queueRetention: queue.retentionStats(),
    deadLetters: deadLetters.retentionStats(),
    context: context.retentionStats()
  });
  return {
    server,
    service,
    timeline,
    queue,
    context,
    state,
    stats,
    advance: (ms: number) => {
      skewMs += ms;
    },
    quiesce: async () => {
      await service.whenIdle();
      await waitFor(() => context.getSummaryTelemetry().activeJobs === 0);
    }
  };
}
type QueueRuntime = ReturnType<typeof buildQueueRuntime>;

async function queueRound(runtime: QueueRuntime, base: string, round: number) {
  const send = (conversationId: string, text: string) =>
    request(base, "POST", "/messages", {
      conversationId,
      userId: "user-q",
      messageId: randomUUID(),
      text
    });
  const drain = async () => {
    for (let n = 0; n < 500 && runtime.queue.size(); n++)
      await request(base, "POST", "/workers/deep/run-once", {});
    check("queue.worker drains the queue", runtime.queue.size() === 0);
  };
  const doomed = "What is the latest news about the doomed item?";
  const admitted: { conversationId: string; messageId: string }[] = [];
  for (let k = 0; k < settings.deadLetters.maxRecords; k++) {
    const conversationId = `b${round}-${k}`;
    const response = await send(conversationId, doomed);
    tally("queue.deep-admitted", response.status === 200 ? 200 : response.code);
    check(
      "queue.deep task is admitted below the dead-letter limit",
      !!response.json?.deepTask,
      () => response
    );
    admitted.push({ conversationId, messageId: response.json?.messageId });
  }
  const rejected = await send(`b${round}-over`, doomed);
  tally("queue.deep-over-limit", rejected.code);
  check(
    "queue.full dead-letter store rejects deep work",
    rejected.code === "DEAD_LETTER_CAPACITY",
    () => rejected
  );
  const direct = await send(`b${round}-0`, "Explain how event loops schedule callbacks.");
  check(
    "queue.direct turns continue at dead-letter capacity",
    direct.status === 200 && !direct.json?.deepTask,
    () => direct
  );
  const last = admitted.at(-1)!;
  const cancelled = await request(
    base,
    "POST",
    `/conversations/${last.conversationId}/messages/${last.messageId}/cancel`
  );
  check("queue.cancelling a queued task succeeds", cancelled.status === 200, () => cancelled);
  await drain();
  const failed = settings.deadLetters.maxRecords - 1;
  const listed = (await request(base, "GET", "/workers/deep/dead-letters")).json!;
  check(
    "queue.failed tasks become dead letters and the cancelled one frees its slot",
    listed.records.length === failed && listed.capacity.reservations === 0,
    () => listed.capacity
  );
  const taskIds: string[] = listed.records.map((r: { task: { taskId: string } }) => r.task.taskId);
  runtime.state.failing = false;
  for (const taskId of taskIds.slice(0, 2))
    tally(
      "queue.replay",
      (await request(base, "POST", `/workers/deep/dead-letters/${taskId}/replay`, {})).status
    );
  await drain();
  runtime.state.failing = true;
  tally(
    "queue.replay",
    (await request(base, "POST", `/workers/deep/dead-letters/${taskIds[2]}/replay`, {})).status
  );
  await drain();
  check(
    "queue.successful replays leave the store and a failed replay returns to it",
    runtime.stats().deadLetters.records === failed - 2,
    () => runtime.stats().deadLetters
  );
  for (let turn = 0; turn < 14; turn++)
    tally(
      "queue.direct",
      (await send(`b${round}-long`, `Explain topic number ${turn} in detail please.`)).status
    );
  for (let k = 0; k < 3; k++)
    tally("queue.deep", (await send(`b${round}-ok-${k}`, "What is the latest news today?")).status);
  await drain();
  await runtime.quiesce();
}

async function queueCleanup(runtime: QueueRuntime, base: string, label: string) {
  runtime.advance(settings.conversation.idleTtlMs + 1);
  const records = (await request(base, "GET", "/workers/deep/dead-letters")).json!.records as {
    task: { taskId: string; conversationId: string };
  }[];
  for (const { task } of records) {
    const blocked = await request(base, "DELETE", `/conversations/${task.conversationId}/identity`);
    check(
      "queue.dead letter blocks retirement of its conversation",
      blocked.status === 409 && blocked.json?.blockers?.includes("DEAD_LETTERS"),
      () => blocked
    );
    const replay = await request(
      base,
      "POST",
      `/workers/deep/dead-letters/${task.taskId}/replay`,
      {}
    );
    check(
      "queue.replay into an expired conversation is refused",
      replay.code === "CONVERSATION_EXPIRED",
      () => replay
    );
    const discard = await request(base, "DELETE", `/workers/deep/dead-letters/${task.taskId}`);
    check("queue.operator discard removes the record", discard.status === 200, () => discard);
  }
  await retireAll(base, label);
}

// ------------------------------------------------------------------- sampling
async function heap() {
  for (let pass = 0; pass < 3; pass++) {
    collect();
    await sleep(5);
  }
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers };
}
function assertLive(
  point: "payload" | "identityCap" | "idle",
  s: ReturnType<LiveRuntime["stats"]>
) {
  const c = (name: string, ok: boolean) => check(`live.${point}.${name}`, ok, () => s);
  const emergency = settings.conversation.maxEvents * 1024;
  c("no history lease outlives its work", s.timeline.pins === 0);
  c("queue byte accounting drains", s.queueRetention.bytes === 0 && s.queueRetention.queued === 0);
  c("histories within limit", s.timeline.histories <= settings.conversation.maxHistories);
  c("identities within limit", s.timeline.identities <= settings.conversation.maxIdentities);
  c(
    "history bytes within per-history limits",
    s.timeline.bytes <= s.timeline.histories * (settings.conversation.maxBytes + emergency)
  );
  c("owners match identities", s.service.owners === s.timeline.identities);
  c("scopes belong to live histories", s.service.scopes <= s.timeline.histories);
  c("wire mappings belong to identities", s.server.wireConversations <= s.timeline.identities);
  c("no in-flight request", s.service.inFlight === 0);
  c("no occupied turn", s.service.activeTurns === 0 && s.service.detachedTurns === 0);
  c("no summary job", s.context.jobs === 0 && s.context.pending === 0);
  c("no open stream", s.server.streams === 0);
  c("no inline retrieval work", s.chat.pending === 0);
  c("no lifecycle consumer or task pin", s.lifecycle.consumers === 0 && s.lifecycle.tasks === 0);
  c("settled attempt buffers released", s.lifecycle.answerBytes === 0);
  c(
    "completed turns within limit and indexes agree",
    s.lifecycle.turns <= settings.execution.maxCompleted &&
      s.lifecycle.retained === s.lifecycle.turns &&
      s.lifecycle.claimed === s.lifecycle.turns
  );
  c(
    "dispatch phases within limit and all completed",
    s.dispatch.phases <= settings.execution.maxCompleted &&
      s.dispatch.retained === s.dispatch.phases
  );
  c("dispatch metrics within limit", s.dispatch.metrics <= settings.execution.maxMetrics);
  c(
    "no active reservation or compute key",
    s.admission.active === 0 && s.admission.computePools === 0
  );
  c("admission diagnostics within limit", s.admission.recent <= settings.execution.maxCompleted);
  c("quota pools within limit", s.admission.quotaPools <= settings.quotaPools);
  c(
    "deep queue and dead letters unused",
    s.queue === 0 && s.deadLetters.records + s.deadLetters.reservations === 0
  );
  c(
    "tool results within count and byte limits",
    s.sports.records <= settings.sportsSnapshots && s.sports.bytes <= s.sports.maxBytes
  );
  c("ranking context copies released", s.dispatch.rankingContextCopies === 0);
  c(
    "team and game snapshots within limit",
    s.sports.snapshots <= settings.sportsSnapshots && s.sports.games <= settings.sportsSnapshots
  );
  c(
    "briefing runs within limit with no job or waiter",
    s.sports.coordinator.runs <= 20 &&
      s.sports.coordinator.jobs === 0 &&
      s.sports.coordinator.waiters === 0
  );
  if (point === "identityCap") {
    c(
      "identity table is at its limit",
      s.timeline.identities === settings.conversation.maxIdentities
    );
    c("history count is at its limit", s.timeline.histories === settings.conversation.maxHistories);
  } else if (point === "idle") {
    c(
      "nothing identity-keyed survives expiry and retirement",
      s.timeline.identities === 0 &&
        s.timeline.events === 0 &&
        s.timeline.bytes === 0 &&
        s.service.owners === 0 &&
        s.service.scopes === 0 &&
        s.server.wireConversations === 0 &&
        s.context.sources === 0 &&
        s.context.summaries === 0
    );
  }
}
function assertQueue(point: "payload" | "idle", s: ReturnType<QueueRuntime["stats"]>) {
  const c = (name: string, ok: boolean) => check(`queue.${point}.${name}`, ok, () => s);
  c("no history lease outlives its work", s.timeline.pins === 0);
  c("queue byte accounting drains", s.queueRetention.bytes === 0 && s.queueRetention.queued === 0);
  c(
    "histories and identities within limits",
    s.timeline.histories <= settings.conversation.maxHistories &&
      s.timeline.identities <= settings.conversation.maxIdentities
  );
  c("owners match identities", s.service.owners === s.timeline.identities);
  c(
    "no in-flight request, occupied turn, queued task, retry counter or summary job",
    s.service.inFlight === 0 &&
      s.service.activeTurns === 0 &&
      s.service.detachedTurns === 0 &&
      s.queue === 0 &&
      s.worker.retryCounters === 0 &&
      s.context.jobs === 0 &&
      s.context.pending === 0
  );
  c("no lifecycle consumer or task pin", s.lifecycle.consumers === 0 && s.lifecycle.tasks === 0);
  c("settled attempt buffers released", s.lifecycle.answerBytes === 0);
  c(
    "completed turns within limit",
    s.lifecycle.turns <= settings.execution.maxCompleted &&
      s.lifecycle.retained === s.lifecycle.turns
  );
  c(
    "dead letters within limit with no reservation",
    s.deadLetters.records <= settings.deadLetters.maxRecords &&
      s.deadLetters.reservations === 0 &&
      s.deadLetters.reservedBytes === 0
  );
  if (point === "idle")
    c(
      "nothing identity-keyed or dead-lettered survives cleanup",
      s.timeline.identities === 0 &&
        s.timeline.bytes === 0 &&
        s.service.owners === 0 &&
        s.deadLetters.records === 0 &&
        s.deadLetters.bytes === 0 &&
        s.context.sources === 0 &&
        s.context.summaries === 0
    );
}
function plateau(samples: number[]) {
  const third = Math.max(1, Math.floor(samples.length / 3));
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const first = median(samples.slice(0, third)),
    last = median(samples.slice(-third));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const slope =
    samples.reduce((sum, y, x) => sum + (x - (samples.length - 1) / 2) * (y - mean), 0) /
    samples.reduce((sum, _, x) => sum + (x - (samples.length - 1) / 2) ** 2, 0);
  return {
    samples,
    min: Math.min(...samples),
    max: Math.max(...samples),
    firstThirdMedian: first,
    lastThirdMedian: last,
    growthBytes: last - first,
    growthRatio: (last - first) / first,
    slopeBytesPerRound: Math.round(slope),
    withinTolerance: (last - first) / first <= settings.heapPlateauTolerance
  };
}

// ------------------------------------------------- quota-pool cardinality ledger
/** Many pool identifiers against one ledger, independent of the assembled runtime. */
async function quotaCardinality() {
  const now = Date.now();
  const evidence = {
    source: "sustained-memory-gate",
    kind: "configured" as const,
    checkedAtIso: new Date(now - 1000).toISOString(),
    expiresAtIso: new Date(now + 3600000).toISOString()
  };
  const pooled = (poolId: string) =>
    bindingResourcesSchema.parse({
      facts: { executionScope: "local-device", billingComponents: ["owned-compute"] },
      evidence,
      incremental: { currency: "USD", maxInvocationUsd: 0, evidence },
      quota: { poolId, unit: "requests", remaining: 1000000, evidence },
      fixedCostNote: "x".repeat(8000)
    });
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({}),
    () => now,
    { maxCompleted: 100, completedTtlMs: 300000, maxMetrics: 100 },
    Date.now,
    { maxPools: settings.ledger.maxPools }
  );
  const retained = Array.from({ length: settings.ledger.maxPools }, (_, n) => pooled(`pool-${n}`));
  const signal = new AbortController().signal;
  const samples: (Awaited<ReturnType<typeof heap>> &
    ReturnType<ResourceAdmission["retentionStats"]> & { admitted: number; rejected: number })[] =
    [];
  let admitted = 0,
    rejected = 0,
    unexpected = 0;
  for (let batch = 0; batch < settings.ledger.batches; batch++) {
    for (let i = 0; i < settings.ledger.callsPerBatch; i++) {
      const [id] = ledger.reserve([
        { resources: retained[i % retained.length], inputTokens: 100, outputTokens: 50 }
      ]);
      await ledger.begin(id, signal);
      ledger.finish(id);
      admitted++;
    }
    for (let i = 0; i < settings.ledger.renamedPoolsPerBatch; i++) {
      try {
        ledger.reserve([
          { resources: pooled(`renamed-${batch}-${i}`), inputTokens: 100, outputTokens: 50 }
        ]);
        unexpected++;
      } catch (error) {
        if (error instanceof AdmissionError && error.code === "QUOTA_POOL_CAPACITY") rejected++;
        else unexpected++;
      }
    }
    samples.push({ admitted, rejected, ...(await heap()), ...ledger.retentionStats() });
  }
  const accounting = ledger.accounting();
  const units = accounting.quotaPools.reduce((sum, p) => sum + (p.units ?? 0), 0);
  check(
    "ledger.pool count stays at the limit",
    samples.every((s) => s.quotaPools === settings.ledger.maxPools),
    () => samples
  );
  check(
    "ledger.every renamed pool is rejected with QUOTA_POOL_CAPACITY",
    unexpected === 0 && rejected === settings.ledger.batches * settings.ledger.renamedPoolsPerBatch,
    () => ({ rejected, unexpected })
  );
  check(
    "ledger.retained pools keep exact consumption",
    units === admitted && accounting.unsettledCount === admitted,
    () => ({ units, admitted })
  );
  check(
    "ledger.no reservation or diagnostic growth",
    samples.every((s) => s.active === 0 && s.recent <= 100 && s.computePools === 0),
    () => samples
  );
  return {
    scope: "ResourceAdmission only; pool identifiers churn beyond the configured limit",
    settings: settings.ledger,
    samples,
    heap: plateau(samples.map((s) => s.heapUsed)),
    distinctPoolsRetained: accounting.quotaPools.length,
    unitsRetained: units
  };
}

// Discovery churn and physically stalled file writes: deterministic ownership gates.
async function retainedOwners() {
  const dir = await mkdtemp(join(tmpdir(), "sustained-retention-"));
  const limits = discoveryLimitsSchema.parse({
    maxModelsPerConnection: 8,
    maxObservations: 16,
    maxBytes: 65536
  });
  let modelRound = 0;
  const inventory = new InventoryStore(
    {
      "ollama-chat": {
        discover: async (connection) =>
          Array.from({ length: 8 }, (_, n) => ({
            bindingId: `${connection.connectionId}-${modelRound}-${n}`,
            connectionId: connection.connectionId,
            model: `model-${modelRound}-${n}`,
            observedAtIso: new Date().toISOString(),
            source: "gate",
            installed: "yes" as const,
            access: "allowed" as const,
            health: "reachable" as const,
            apiCompatibility: ["ollama-chat"]
          }))
      }
    },
    { intervalMs: 1000, ttlMs: 600000, timeoutMs: 1000, maxConcurrentRequests: 4 },
    () => new Date(),
    limits
  );
  const connections: Connection[] = ["first", "second"].map((connectionId) => ({
    connectionId,
    apiKind: "ollama-chat",
    baseUrl: "http://fixture.invalid",
    resourceFacts: UNKNOWN_RESOURCE_FACTS,
    quota: {},
    compute: { ownedOrRented: "unknown" }
  }));
  let release!: () => void;
  let held = Promise.resolve();
  class StalledTelemetry extends FileLatencyTelemetryStore {
    protected async writeSnapshot(serialized: string) {
      await held;
      await super.writeSnapshot(serialized);
    }
  }
  const telemetry = new StalledTelemetry(join(dir, "telemetry.json"));
  const samples = [];
  try {
    for (modelRound = 0; modelRound < 20; modelRound++) {
      await inventory.refreshAll(connections);
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const snapshot = (n: number) => ({
        estimator: { priors: [], samples: [] },
        policy: { maxFastP95Ms: n }
      });
      const first = telemetry.save(snapshot(1));
      const pending = telemetry.save(snapshot(2));
      for (let n = 3; n <= 1000; n++) telemetry.save(snapshot(n));
      check(
        "owners.telemetry holds one write and one replacement while stalled",
        telemetry.retentionStats().writing === 1 && telemetry.retentionStats().queued === 1,
        () => telemetry.retentionStats()
      );
      release();
      await Promise.all([first, pending]);
      check(
        "owners.final telemetry snapshot is persisted",
        (await telemetry.load())?.policy.maxFastP95Ms === 1000
      );
      check("owners.telemetry drains every snapshot", telemetry.retentionStats().bytes === 0);
      const stats = inventory.retentionStats();
      check(
        "owners.discovery churn replaces observations without tombstones",
        stats.observations === 16 && stats.bytes <= limits.maxBytes && stats.inFlight === 0,
        () => stats
      );
      samples.push({ inventory: stats, telemetry: telemetry.retentionStats(), heap: await heap() });
    }
    inventory.shutdown();
    return {
      scope:
        "actual InventoryStore with scripted complete listings; file telemetry with held writes",
      samples
    };
  } finally {
    release?.();
    inventory.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------- main
const live = buildLiveRuntime();
const queued = buildQueueRuntime();
const liveBase = await listen(live.server);
const queueBase = await listen(queued.server);
const rounds = [];
let previousUnits = 0;
for (let round = 0; round < settings.rounds.warmup + settings.rounds.measured; round++) {
  await liveRound(live, liveBase, round);
  await queueRound(queued, queueBase, round);
  await live.quiesce();
  await queued.quiesce();
  // Large payload histories, retained dead letters and completed-work caches at their limits.
  const payload = { heap: await heap(), live: live.stats(), queue: queued.stats() };
  assertLive("payload", payload.live);
  assertQueue("payload", payload.queue);

  await identityFill(liveBase, round);
  await live.quiesce();
  const identityCap = { heap: await heap(), live: live.stats() };
  assertLive("identityCap", identityCap.live);

  live.advance(settings.conversation.idleTtlMs + 1);
  await retireAll(liveBase, "live");
  await queueCleanup(queued, queueBase, "queue");
  await live.quiesce();
  await queued.quiesce();
  const idle = { heap: await heap(), live: live.stats(), queue: queued.stats() };
  assertLive("idle", idle.live);
  assertQueue("idle", idle.queue);

  const accounting = live.dispatch.admission.accounting();
  const unitsOf = (poolId: string) =>
    accounting.quotaPools.find((p) => p.poolId === poolId)?.units ?? 0;
  check(
    "quota.shared pool consumption equals the provider calls of both bindings",
    unitsOf("pool-shared") === live.calls.alpha + live.calls.beta,
    () => ({ accounting, calls: live.calls })
  );
  check(
    "quota.scarce pool never exceeds its allowance",
    unitsOf("pool-scarce") === live.calls.gamma && live.calls.gamma <= settings.scarceQuotaRequests,
    () => ({ accounting, calls: live.calls })
  );
  check("quota.consumption is never refunded", unitsOf("pool-shared") >= previousUnits);
  previousUnits = unitsOf("pool-shared");
  rounds.push({
    round,
    phase: round < settings.rounds.warmup ? "warmup" : "measured",
    // --heap-only keeps a long soak from measuring its own per-round report.
    payload: heapOnly ? { heap: payload.heap } : payload,
    identityCap: heapOnly ? { heap: identityCap.heap } : identityCap,
    idle: heapOnly ? { heap: idle.heap } : idle,
    quota: accounting.quotaPools
  });
}
// Bounds alone can pass when a route is broken and never creates retained state.
// Require the advertised workloads to have actually run before judging retention.
for (const outcome of [
  "live.answer:200",
  "live.payload:200",
  "live.games:200",
  "live.directory:200",
  "live.scoped-conversation:201",
  "live.scoped-turn:200",
  "live.reload:200",
  "live.v1:200",
  "live.v1-stream:200",
  "live.stream:200",
  "live.cancel:200",
  "live.provider-error:PROVIDER_ERROR",
  "live.bad-plan:CAPABILITY_PLAN_FAILED",
  "queue.direct:200",
  "queue.deep:200",
  "queue.replay:200"
])
  check(`workload.${outcome} is exercised`, (outcomes.get(outcome) ?? 0) > 0, () =>
    Object.fromEntries(outcomes)
  );
check(
  "workload.summary publication is exercised",
  queued.context.getSummaryTelemetry().published > 0,
  () => queued.context.getSummaryTelemetry()
);
check(
  "quota.scarce pool is exhausted exactly",
  live.calls.gamma === settings.scarceQuotaRequests,
  () => live.calls
);

// Admission probe (inventory finding 1): fill every turn slot with held retrieval,
// whose response has returned while its inline work still runs, and confirm the
// next submission is refused before anything is claimed, then drained by cancel.
{
  const limit = settings.live.maxConcurrentTurns;
  const probes: Array<{ conversationId: string; messageId: string; status: number; code: string }> =
    [];
  for (let n = 0; n <= limit; n++) {
    const conversationId = `admission-${n}`,
      messageId = randomUUID();
    const response = await request(liveBase, "POST", "/messages", {
      conversationId,
      userId: "user-0",
      messageId,
      text: "hold for admission"
    });
    probes.push({ conversationId, messageId, ...response });
  }
  const admitted = probes.filter((p) => p.status === 200);
  const refused = probes.filter((p) => p.code === "TURN_CAPACITY");
  const full = live.stats();
  check(
    "admission.exactly the configured number of turns is admitted",
    admitted.length === limit && refused.length === 1 && refused[0] === probes[limit],
    () => probes.map((p) => [p.conversationId, p.status, p.code])
  );
  check(
    "admission.held turns occupy every slot as detached inline work",
    full.service.activeTurns === 0 &&
      full.service.detachedTurns === limit &&
      full.chat.pending === limit,
    () => full.service
  );
  check(
    "admission.the refused turn claimed no owner or history",
    !live.service.hasConversationIdentity(`admission-${limit}`) &&
      (await live.timeline.getEvents(`admission-${limit}`)).length === 0,
    () => full
  );
  for (const p of admitted)
    tally(
      "live.admission-cancel",
      (
        await request(
          liveBase,
          "POST",
          `/conversations/${p.conversationId}/messages/${p.messageId}/cancel`
        )
      ).status
    );
  await live.quiesce();
  const drained = live.stats();
  check(
    "admission.cancelled turns free their slots",
    drained.service.detachedTurns === 0 && drained.service.activeTurns === 0,
    () => drained.service
  );
  const retried = await request(liveBase, "POST", "/messages", {
    conversationId: `admission-${limit}`,
    userId: "user-0",
    messageId: probes[limit].messageId,
    text: "answer after refusal"
  });
  check(
    "admission.the refused body is accepted once a slot frees",
    retried.status === 200,
    () => retried
  );
  await live.quiesce();
}

// Shutdown with work in flight: held retrieval, an open stream and queued deep tasks.
const held = [];
for (let n = 0; n < 3; n++)
  held.push(
    await request(liveBase, "POST", "/messages", {
      conversationId: `shutdown-${n}`,
      userId: "user-0",
      messageId: randomUUID(),
      text: "hold until shutdown"
    })
  );
const openStream = new AbortController();
const streaming = fetch(`${liveBase}/conversations/shutdown-0/events/stream`, {
  signal: openStream.signal
}).then(async (response) => {
  const reader = response.body!.getReader();
  while (!(await reader.read()).done);
});
await waitFor(() => live.server.retentionStats().streams === 1);
for (let n = 0; n < 2; n++)
  await request(queueBase, "POST", "/messages", {
    conversationId: `shutdown-q-${n}`,
    userId: "user-q",
    messageId: randomUUID(),
    text: "What is the latest news before shutdown?"
  });
const beforeShutdown = { live: live.stats(), queue: queued.stats() };
check(
  "shutdown.work is in flight beforehand",
  beforeShutdown.live.chat.pending === 3 && beforeShutdown.queue.queue === 2,
  () => beforeShutdown
);
const shutdownHooks = (stopInternal: () => Promise<void>, stopBackground: () => void) => ({
  config: { graceMs: 100, timeoutMs: 10000 },
  stopBackground,
  stopInternal,
  persist: async () => {}
});
const shutdownStarted = Date.now();
let shutdownError: string | null = null;
try {
  await Promise.all([
    createRuntimeHandle(
      live.server,
      live.service,
      shutdownHooks(
        () => live.context.shutdown(),
        () => live.sports.http.close()
      )
    ).shutdown(),
    createRuntimeHandle(
      queued.server,
      queued.service,
      shutdownHooks(
        () => queued.context.shutdown(),
        () => undefined
      )
    ).shutdown()
  ]);
} catch (error) {
  shutdownError = String(error);
}
await streaming.catch(() => undefined);
openStream.abort();
const afterShutdown = { live: live.stats(), queue: queued.stats() };
check("shutdown.completes without error", shutdownError === null, () => shutdownError);
check(
  "shutdown.live runtime drains held work, streams, leases and reservations",
  afterShutdown.live.chat.pending === 0 &&
    afterShutdown.live.server.streams === 0 &&
    afterShutdown.live.timeline.pins === 0 &&
    afterShutdown.live.lifecycle.consumers === 0 &&
    afterShutdown.live.lifecycle.tasks === 0 &&
    afterShutdown.live.admission.active === 0 &&
    afterShutdown.live.service.inFlight === 0,
  () => afterShutdown.live
);
check(
  "shutdown.queue runtime discards queued tasks and frees their slots and leases",
  afterShutdown.queue.queue === 0 &&
    afterShutdown.queue.deadLetters.reservations === 0 &&
    afterShutdown.queue.timeline.pins === 0 &&
    afterShutdown.queue.lifecycle.tasks === 0,
  () => afterShutdown.queue
);
const refused = await request(liveBase, "GET", "/conversations/retention").then(
  (response) => response.status,
  () => "connection refused"
);
check(
  "shutdown.no request is served afterwards",
  refused === "connection refused" || refused === 503,
  () => refused
);

const ledger = await quotaCardinality();
const owners = await retainedOwners();
const measured = rounds.filter((r) => r.phase === "measured");
const heapSeries = {
  payload: plateau(measured.map((r) => r.payload.heap.heapUsed)),
  identityCap: plateau(measured.map((r) => r.identityCap.heap.heapUsed)),
  idle: plateau(measured.map((r) => r.idle.heap.heapUsed))
};
const failures = [...assertions].filter(([, a]) => a.failed);
const report = {
  scope:
    "In-process assembled runtimes over loopback HTTP with scripted providers and fixture sports transport. Registry assertions are the gate; heap samples are supporting evidence under these settings only.",
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  settings,
  roundDetail: heapOnly
    ? "heap samples only (--heap-only)"
    : "registry statistics and heap samples",
  workload: {
    perRoundLive: `${settings.live.conversationsPerRound} conversations of 6 turns at concurrency ${settings.live.concurrency}: large direct answers, pinned-binding payload retrieval (${settings.live.payloadRows}x6 cells of ${settings.live.payloadCellChars} chars), sports game search, one of tool failure / provider error / invalid plan / held retrieval with cancellation, a reused message ID; 2 configuration reloads, 2 protocol-v1 conversations with streams, 2 scoped conversations, legacy streams; one conversation filled to its history limit; identity table filled to its limit; then idle expiry and retirement of every identity`,
    perRoundQueue: `${settings.deadLetters.maxRecords} failing deep tasks to the dead-letter limit, a rejected over-limit task, a queued cancellation, 3 retries per failure, 2 successful replays, 1 failed replay, 14 direct turns in one conversation (extractive summary), 3 successful deep tasks; then blocked retirement, refused replay, operator discard and retirement`,
    shutdown: "3 held retrievals, 1 open stream and 2 queued deep tasks at shutdown",
    slowWrites: `every ${settings.slowWriteEvery}th live timeline append delayed ${settings.slowWriteMs} ms`
  },
  exclusions: [
    "Live provider adapters, CLI runner, evaluation recorder and the Python document sidecar are not constructed; InventoryStore and file telemetry run separately with scripted discovery and stalled writes",
    "The three startServer interval timers are not run; the deep worker is driven through its HTTP endpoint",
    "Execution-cache TTL expiry is not exercised (wall-clock); completed turns, phases and diagnostics are bounded here by count only",
    `Concurrent-turn admission is probed once with ${settings.live.maxConcurrentTurns} held turns, not under the round workload, whose concurrency stays below the limit by construction`,
    "Request bodies, stream backpressure and connection counts are not stressed (step 2)",
    "Limits are scaled down; no claim is made about absolute memory at default limits",
    "Role catalog, evidence-answer and review modes, and model summarization are not exercised",
    "Disk-backed history does not exist; only the in-memory stores are measured"
  ],
  totals: {
    liveTimelineAppends: live.timeline.appends,
    liveDelayedAppends: live.timeline.delayed,
    providerCalls: live.calls,
    deepProviderCalls: queued.state.deepCalls,
    queueSummaries: queued.context.getSummaryTelemetry(),
    outcomes: Object.fromEntries([...outcomes].sort())
  },
  rounds,
  heap: heapSeries,
  shutdown: {
    elapsedMs: Date.now() - shutdownStarted,
    error: shutdownError,
    before: beforeShutdown,
    after: afterShutdown
  },
  quotaPoolCardinality: ledger,
  retainedOwners: owners,
  assertions: Object.fromEntries(assertions),
  verdict: {
    registryAssertions: failures.length ? "fail" : "pass",
    failedAssertions: failures.map(([name]) => name),
    heapWithinTolerance:
      heapSeries.payload.withinTolerance &&
      heapSeries.identityCap.withinTolerance &&
      heapSeries.idle.withinTolerance &&
      ledger.heap.withinTolerance
  }
};
const output = JSON.stringify(report, null, 2);
const outPath = flag("--out");
if (outPath) writeFileSync(outPath, output + "\n");
else console.log(output);
console.error(
  `sustained-memory gate: ${failures.length ? "FAIL" : "pass"} (${assertions.size} assertions, ${failures.length} failed); heap within tolerance: ${report.verdict.heapWithinTolerance}`
);
for (const [name, entry] of failures) console.error(`  FAILED ${name}: ${entry.firstFailure}`);
process.exitCode = failures.length || !report.verdict.heapWithinTolerance ? 1 : 0;
