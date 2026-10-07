import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import type { LocalIdentity } from "../../src/auth/localIdentity";
import { dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { CatalogDispatch } from "../../src/routing/catalogDispatch";
import type { QuotaEnvelope } from "../../src/routing/quotaEnvelope";
import type { GenerationControl } from "../../src/domain/generation";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { digest } from "../../src/eval/recording/contract";
import { budget, entry, now, resources, runtime } from "../helpers/dispatchFixtures";

// GET /routing/quota-envelopes over real HTTP, real local authentication and a real
// dispatch ledger. Nothing is persisted and no provider is called.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const ROUTE = "/routing/quota-envelopes";
// Identifiers an operator might use for real accounts; none may appear in the view.
const POOL = "acct-secret-pool";
const CREDENTIAL = "cred-secret-1";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const envelope = (n: number, over: Partial<QuotaEnvelope> = {}): QuotaEnvelope => ({
  poolId: POOL,
  windowId: `win-secret-${n}`,
  sequence: n + 1,
  startsAt: at(T0 + n * 24 * HOUR),
  resetsAt: at(T0 + (n + 1) * 24 * HOUR),
  allowance: 100_000,
  unit: "tokens",
  scope: { kind: "single-credential", credentialId: CREDENTIAL },
  evidence: { checkedAtIso: at(T0 - HOUR), expiresAtIso: at(T0 + 100 * HOUR) },
  ...over
});
const secret = () => randomBytes(32).toString("base64url");

const RETENTION_TTL = 1000;

async function start(
  options: { dispatch?: boolean; first?: QuotaEnvelope; envelopes?: QuotaEnvelope[] } = {}
) {
  let clock = Date.parse(now);
  // Completed-entry retention runs on its own clock, so tests can step past its TTL.
  let retentionClock = 0;
  const r = runtime([entry("a")]);
  const envelopes = options.envelopes ?? [options.first ?? envelope(0)];
  const policy = dispatchPolicySchema.parse({
    quotaEnvelopes: envelopes,
    bindings: {
      a: envelopes.some((e) => e.poolId === POOL)
        ? resources({ quotaEnvelope: { poolId: POOL, unit: "tokens" } })
        : resources()
    }
  });
  policy.fallbackBindingIds.fast = r.catalog.models.map(entryBindingId);
  const dispatch = new CatalogDispatch(
    r.catalog,
    r.registry,
    policy,
    budget,
    () => r.observations,
    () => new Date(clock),
    { maxCompleted: 100, completedTtlMs: RETENTION_TTL, maxMetrics: 100 },
    () => retentionClock
  );
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const identity: LocalIdentity = {
    version: 1,
    principalId: `local:${randomUUID()}`,
    sessionKey: secret(),
    clientToken: secret(),
    operatorToken: secret(),
    epoch: 0
  };
  const server = createChatServer(service, {
    auth: new LocalAuthenticator(identity),
    maxBodyBytes: 4096,
    ...(options.dispatch === false
      ? {}
      : {
          declareQuotaEnvelope: (raw: unknown) => dispatch.admission.declareQuotaEnvelope(raw),
          quotaEnvelopes: () => dispatch.admission.quotaEnvelopeProjection()
        })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const operator = { authorization: `Bearer ${identity.operatorToken}` };
  return {
    dispatch,
    setClock: (ms: number) => {
      clock = ms;
    },
    setRetentionClock: (ms: number) => {
      retentionClock = ms;
    },
    operator,
    client: { authorization: `Bearer ${identity.clientToken}` },
    async read(headers: Record<string, string> = operator) {
      const response = await fetch(base + ROUTE, { headers });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
    },
    async declare(body: unknown) {
      const response = await fetch(base + ROUTE + "/declare", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operator },
        body: JSON.stringify(body)
      });
      return response.status;
    },
    /** Prepares one direct turn: its fast ticket is reserved. */
    prepare: () =>
      dispatch.prepare(r.manager, {
        conversationId: "c",
        currentMessageId: `turn-${randomUUID()}`,
        currentUserText: "Explain code",
        trustedFacts: {
          fastProvider: "mock",
          fastModel: "mock",
          deepProvider: "mock",
          deepModel: "mock",
          generatedAtIso: now
        },
        routeDecision: "direct"
      })
  };
}
type Harness = Awaited<ReturnType<typeof start>>;
const control = (): GenerationControl => ({
  signal: new AbortController().signal,
  attemptId: "attempt",
  onDelta: async () => {}
});
/** Completes one call whose only evidence is an observed lower bound of `tokens`. */
async function observed(h: Harness, tokens: number) {
  const plan = await h.prepare();
  await h.dispatch.execute(plan.fast, control(), "medium", async () => ({
    text: "ok",
    finishReason: "stop",
    usageLowerBound: { source: "observed-lower-bound", inputTokens: tokens, outputTokens: 0 }
  }));
}
const ledger = (h: Harness) =>
  JSON.stringify(
    (h.dispatch.admission as unknown as { envelopes: { snapshot(): unknown } }).envelopes.snapshot()
  );
// Read directly: retentionStats() would prune the map it reports on.
const recent = (h: Harness) =>
  (h.dispatch.admission as unknown as { recent: Map<string, unknown> }).recent;

describe("GET /routing/quota-envelopes", () => {
  it("admits only the operator", async () => {
    const h = await start();
    expect((await h.read({})).status).toBe(401);
    const client = await h.read(h.client);
    expect(client.status).toBe(403);
    expect(client.body).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect((await h.read()).status).toBe(200);
  });

  it("is disabled without catalog dispatch", async () => {
    const h = await start({ dispatch: false });
    const r = await h.read();
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      code: "QUOTA_ENVELOPES_DISABLED",
      error: "Catalog dispatch is not configured"
    });
  });

  it("answers an empty list when catalog dispatch declares no envelope pools", async () => {
    const h = await start({ envelopes: [] });
    const r = await h.read();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      source: "local-declared-window-accounting",
      asOf: now,
      unsettledEnvelopeLinks: 0,
      pools: []
    });
  });

  it("orders pools by digest, whatever order configuration declares them in", async () => {
    const ids = ["pool-secret-c", "pool-secret-a", "pool-secret-b"];
    const declared = ids.map((poolId) => envelope(0, { poolId }));
    const forward = await (await start({ envelopes: declared })).read();
    const reversed = await (await start({ envelopes: [...declared].reverse() })).read();
    const digests = forward.body.pools.map((p: { poolDigest: string }) => p.poolDigest);
    expect(digests).toEqual(ids.map(digest).sort());
    expect(reversed.text).toBe(forward.text);
    for (const id of ids) expect(forward.text).not.toContain(id);
  });

  it("shows the configured pool as local accounting, with identifiers only as digests", async () => {
    const h = await start();
    const r = await h.read();
    expect(r.body).toEqual({
      source: "local-declared-window-accounting",
      asOf: now,
      unsettledEnvelopeLinks: 0,
      pools: [
        {
          poolDigest: digest(POOL),
          unit: "tokens",
          highWater: 1,
          availability: {
            status: "available",
            windowSequence: 1,
            windowDigest: digest("win-secret-0"),
            remaining: "100000"
          },
          windows: [
            {
              sequence: 1,
              windowDigest: digest("win-secret-0"),
              phase: "current",
              startsAt: at(T0),
              resetsAt: at(T0 + 24 * HOUR),
              allowance: "100000",
              finalUsed: "0",
              evidence: { checkedAt: at(T0 - HOUR), expiresAt: at(T0 + 100 * HOUR) }
            }
          ],
          open: { reserved: 0, started: 0, unsettled: 0, units: "0" }
        }
      ]
    });
    for (const value of [POOL, "win-secret", CREDENTIAL, "single-credential", "scope"])
      expect(r.text).not.toContain(value);
  });

  it("counts open charges at their effective debit, with links and debt", async () => {
    const h = await start();
    const plan = await h.prepare();
    const reserved = (await h.read()).body.pools[0].open;
    expect(reserved).toMatchObject({ reserved: 1, started: 0, unsettled: 0 });
    h.dispatch.release(plan.fast);
    // An observed minimum above the estimate is the open charge's debit.
    await observed(h, 60_000);
    let view = (await h.read()).body;
    expect(view.pools[0].open).toEqual({
      reserved: 0,
      started: 0,
      unsettled: 1,
      units: "60000"
    });
    expect(view.pools[0].availability).toMatchObject({ remaining: "40000" });
    expect(view.unsettledEnvelopeLinks).toBe(1);
    await observed(h, 50_000);
    view = (await h.read()).body;
    expect(view.pools[0].open).toMatchObject({ unsettled: 2, units: "110000" });
    expect(view.pools[0].availability).toEqual({
      status: "available",
      windowSequence: 1,
      windowDigest: digest("win-secret-0"),
      remaining: "0",
      debt: "10000"
    });
    expect(view.unsettledEnvelopeLinks).toBe(2);
  });

  it("counts a charge as started while its call is executing", async () => {
    const h = await start();
    const plan = await h.prepare();
    const reserved = (await h.read()).body.pools[0].open;
    let during: unknown;
    await h.dispatch.execute(plan.fast, control(), "medium", async () => {
      during = (await h.read()).body.pools[0].open;
      return {
        text: "ok",
        finishReason: "stop",
        usageLowerBound: { source: "observed-lower-bound", inputTokens: 1, outputTokens: 0 }
      };
    });
    expect(during).toEqual({ reserved: 0, started: 1, unsettled: 0, units: reserved.units });
    expect((await h.read()).body.pools[0].open).toMatchObject({ started: 0, unsettled: 1 });
  });

  it("follows a declared successor across the boundary, carrying unresolved charges", async () => {
    const h = await start();
    await observed(h, 30_000);
    expect(await h.declare(envelope(1))).toBe(200);
    let view = (await h.read()).body;
    expect(view.pools[0].highWater).toBe(2);
    expect(view.pools[0].windows.map((w: { phase: string }) => w.phase)).toEqual([
      "current",
      "future"
    ]);
    h.setClock(T0 + 24 * HOUR);
    view = (await h.read()).body;
    expect(view.pools[0].windows.map((w: { phase: string }) => w.phase)).toEqual([
      "ended",
      "current"
    ]);
    expect(view.pools[0].availability).toEqual({
      status: "available",
      windowSequence: 2,
      windowDigest: digest("win-secret-1"),
      remaining: "70000"
    });
  });

  it.each([
    ["the only window has ended", T0 + 24 * HOUR, envelope(0)],
    [
      "its evidence has expired",
      T0 + 13 * HOUR,
      envelope(0, { evidence: { checkedAtIso: at(T0 - HOUR), expiresAtIso: at(T0 + 12 * HOUR) } })
    ],
    // Configured pools always come from a declaration; before it starts, none is active.
    ["its first window has not started", T0 + 12 * HOUR, envelope(1)]
  ])("reports the pool unavailable when %s", async (_label, time, first) => {
    const h = await start({ first });
    h.setClock(time);
    const view = (await h.read()).body;
    expect(view.pools[0].availability).toEqual({
      status: "unavailable",
      reason: "QUOTA_UNKNOWN_OR_STALE"
    });
  });

  it("reads without changing the ledger or committing the admission clock", async () => {
    const h = await start();
    await observed(h, 30_000);
    const before = ledger(h);
    h.setClock(T0 + 20 * HOUR);
    const later = await h.read();
    expect((await h.read()).text).toBe(later.text);
    expect(later.body.asOf).toBe(at(T0 + 20 * HOUR));
    expect(ledger(h)).toBe(before);
    // Had the read committed its sample, an earlier clock would be held at it.
    h.setClock(Date.parse(now));
    expect((await h.read()).body.asOf).toBe(now);
  });

  it("does not prune completed requests past their retention TTL", async () => {
    const h = await start();
    await observed(h, 30_000);
    const kept = recent(h).size;
    expect(kept).toBeGreaterThan(0);
    h.setRetentionClock(RETENTION_TTL * 10);
    expect((await h.read()).status).toBe(200);
    expect(recent(h).size).toBe(kept);
    // The same clock does expire them once something that prunes runs.
    expect(h.dispatch.admission.retentionStats().recent).toBe(0);
  });

  it("answers an unusable clock with unavailable entries instead of an error", async () => {
    const h = await start();
    const before = ledger(h);
    h.setClock(Number.NaN);
    const r = await h.read();
    expect(r.status).toBe(200);
    expect(r.body.asOf).toBeNull();
    expect(r.body.pools[0].availability).toEqual({
      status: "unavailable",
      reason: "CLOCK_UNAVAILABLE"
    });
    expect(r.body.pools[0].windows[0].phase).toBe("unknown");
    expect(ledger(h)).toBe(before);
  });
});
