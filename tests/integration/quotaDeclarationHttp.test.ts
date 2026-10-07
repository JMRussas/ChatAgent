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
import { ResourceAdmission } from "../../src/routing/resourceAdmission";
import type { QuotaEnvelope } from "../../src/routing/quotaEnvelope";

// POST /routing/quota-envelopes/declare over real HTTP, real local authentication and
// a real admission ledger. Nothing is persisted and no provider is called.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const ROUTE = "/routing/quota-envelopes/declare";
const T0 = Date.parse("2026-10-07T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const envelope = (n: number, over: Partial<QuotaEnvelope> = {}): QuotaEnvelope => ({
  poolId: "env",
  windowId: `w${n}`,
  sequence: n + 1,
  startsAt: at(T0 + n * HOUR),
  resetsAt: at(T0 + (n + 1) * HOUR),
  allowance: 10,
  unit: "requests",
  scope: { kind: "account" },
  evidence: { checkedAtIso: at(T0 - HOUR), expiresAtIso: at(T0 + 100 * HOUR) },
  ...over
});
const secret = () => randomBytes(32).toString("base64url");

async function start(withDispatch = true) {
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
  const auth = new LocalAuthenticator(identity);
  const admission = new ResourceAdmission(
    dispatchPolicySchema.parse({ quotaEnvelopes: [envelope(0)] }),
    () => T0
  );
  const server = createChatServer(service, {
    auth,
    maxBodyBytes: 4096,
    ...(withDispatch
      ? { declareQuotaEnvelope: (raw: unknown) => admission.declareQuotaEnvelope(raw) }
      : {})
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    admission,
    auth,
    base,
    operator: { authorization: `Bearer ${identity.operatorToken}` },
    client: { authorization: `Bearer ${identity.clientToken}` }
  };
}
type Harness = Awaited<ReturnType<typeof start>>;

async function declare(h: Harness, body: unknown, headers: Record<string, string> = h.operator) {
  const response = await fetch(h.base + ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
}
/** The ledger's windows: what a declaration changed, if anything. */
const windows = (h: Harness) =>
  JSON.stringify(
    (h.admission as unknown as { envelopes: { snapshot(): unknown } }).envelopes.snapshot()
  );

describe("POST /routing/quota-envelopes/declare", () => {
  it("admits only the operator", async () => {
    const h = await start();
    const before = windows(h);
    const anonymous = await declare(h, envelope(1), {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ code: "UNAUTHENTICATED" });
    const client = await declare(h, envelope(1), h.client);
    expect(client.status).toBe(403);
    expect(client.body).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(windows(h)).toBe(before);
    const operator = await declare(h, envelope(1));
    expect(operator).toMatchObject({ status: 200, body: { outcome: "declared" } });
  });

  it("requires the exact origin for a browser session", async () => {
    const h = await start();
    const cookie = { cookie: `ca_session=${h.auth.issueSession()}` };
    const before = windows(h);
    const crossSite = await declare(h, envelope(1), cookie);
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toMatchObject({ code: "ORIGIN_REQUIRED" });
    expect(windows(h)).toBe(before);
    const sameOrigin = await declare(h, envelope(1), { ...cookie, origin: h.base });
    expect(sameOrigin).toMatchObject({ status: 200, body: { outcome: "declared" } });
  });

  it("is disabled without catalog dispatch", async () => {
    const h = await start(false);
    const r = await declare(h, envelope(1));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "QUOTA_ENVELOPES_DISABLED" });
  });

  it("declares, then reports identical and refreshed declarations", async () => {
    const h = await start();
    expect((await declare(h, envelope(1))).body).toEqual({ outcome: "declared" });
    expect((await declare(h, envelope(1))).body).toEqual({ outcome: "unchanged" });
    const newer = { checkedAtIso: at(T0), expiresAtIso: at(T0 + 200 * HOUR) };
    expect((await declare(h, envelope(1, { evidence: newer }))).body).toEqual({
      outcome: "refreshed"
    });
  });

  it.each([
    ["an array body", [envelope(1)], 400, undefined],
    ["malformed JSON", "{", 400, undefined],
    [
      "an observation-shaped payload",
      { poolId: "env", windowId: "w1", measure: { kind: "headroom", usedPercentage: 5 } },
      400,
      "QUOTA_DECLARATION_INVALID"
    ],
    ["an unknown pool", envelope(1, { poolId: "other" }), 404, "QUOTA_DECLARATION_POOL_UNKNOWN"],
    [
      "an overlapping successor",
      envelope(1, { startsAt: at(T0 + HOUR / 2) }),
      409,
      "QUOTA_DECLARATION_CONFLICT"
    ],
    [
      "a changed scope",
      envelope(1, { scope: { kind: "single-credential", credentialId: "cred-secret-1" } }),
      409,
      "QUOTA_DECLARATION_CONFLICT"
    ]
  ] as [string, unknown, number, string | undefined][])(
    "refuses %s without change or echo",
    async (_label, payload, status, code) => {
      const h = await start();
      const before = windows(h);
      const r = await declare(h, payload);
      expect(r.status).toBe(status);
      if (code) expect(Object.keys(r.body).sort()).toEqual(["code", "error"]);
      if (code) expect(r.body.code).toBe(code);
      expect(windows(h)).toBe(before);
      // Fixed messages only: no pool, window or credential identifier is echoed.
      for (const value of ["cred-secret-1", "other", "w1"]) expect(r.text).not.toContain(value);
    }
  );

  it("refuses an oversized body before declaring", async () => {
    const h = await start();
    const before = windows(h);
    const r = await declare(h, { ...envelope(1), padding: "x".repeat(5000) });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
    expect(windows(h)).toBe(before);
  });

  it("accepts exactly one of two concurrent conflicting declarations", async () => {
    const h = await start();
    const results = await Promise.all(
      [5, 7].map((allowance) => declare(h, envelope(1, { allowance })))
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const accepted = results.findIndex((r) => r.status === 200);
    expect(windows(h)).toContain(`"allowance":"${[5, 7][accepted]}"`);
    expect(windows(h)).not.toContain(`"allowance":"${[5, 7][1 - accepted]}"`);
  });
});
