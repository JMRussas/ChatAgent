import { randomBytes, randomUUID } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import { PairingController } from "../../src/auth/pairing";
import { ROUTES } from "../../src/auth/routePolicy";
import type { LocalIdentity } from "../../src/auth/localIdentity";

// Real authentication end to end: LocalAuthenticator, the route table, pairing and
// the cookie rules, over real HTTP. Other suites inject a test authenticator.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const secret = () => randomBytes(32).toString("base64url");
const newIdentity = (): LocalIdentity => ({
  version: 1,
  principalId: `local:${randomUUID()}`,
  sessionKey: secret(),
  clientToken: secret(),
  operatorToken: secret(),
  epoch: 0
});

async function start(identity = newIdentity()) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const auth = new LocalAuthenticator(identity);
  const pairing = new PairingController();
  const announced: string[] = [];
  const server = createChatServer(service, {
    auth,
    pairing: {
      controller: pairing,
      issueSession: () => auth.issueSession(),
      announce: (code) => announced.push(code)
    },
    maxBodyBytes: 4096
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `http://${host}`;
  cleanups.push(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = { authorization: `Bearer ${identity.clientToken}` };
  const operator = { authorization: `Bearer ${identity.operatorToken}` };
  const sameOrigin = { origin: base };
  return { service, auth, pairing, announced, base, host, identity, client, operator, sameOrigin };
}
type Harness = Awaited<ReturnType<typeof start>>;

/** A concrete request for each route in the table. */
const PROBES: [string, string][] = ROUTES.map((r) => [
  r.method,
  r.name
    .split(" ")[1]
    .replace(/:conversationId/g, "probe-c")
    .replace(/:messageId/g, randomUUID())
    .replace(/:taskId/g, "probe-t")
    .replace("/v1/conversations/probe-c", `/v1/conversations/${randomUUID()}`)
]);

async function call(
  h: Harness,
  method: string,
  path: string,
  headers: Record<string, string> = {}
) {
  const controller = new AbortController();
  const query = path.startsWith("/v1/") ? "?accountId=a&projectId=p" : "";
  const response = await fetch(h.base + path + query, {
    method,
    headers: { ...(method === "GET" ? {} : { "Content-Type": "application/json" }), ...headers },
    body: method === "GET" ? undefined : "{}",
    signal: controller.signal
  });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : undefined;
  controller.abort();
  return { status: response.status, body, headers: response.headers };
}

describe("route enforcement over real HTTP", () => {
  it("refuses every protected route without credentials, before any handler", async () => {
    const h = await start();
    const spy = vi.spyOn(h.service, "getTimeline");
    for (const [method, path] of PROBES) {
      const rule = ROUTES.find((r) => r.method === method && r.pattern.test(path.split("?")[0]))!;
      if (rule.access === "public") continue;
      const r = await call(h, method, path);
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body).toMatchObject({ code: "UNAUTHENTICATED" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses operator routes to the client token and admits the operator token everywhere", async () => {
    const h = await start();
    for (const [method, path] of PROBES) {
      const rule = ROUTES.find((r) => r.method === method && r.pattern.test(path))!;
      if (rule.access === "public") continue;
      const asClient = await call(h, method, path, h.client);
      if (rule.access === "operator") {
        expect(asClient.status, `${method} ${path}`).toBe(403);
        expect(asClient.body).toMatchObject({ code: "OPERATOR_REQUIRED" });
      } else expect(asClient.status, `${method} ${path}`).not.toBe(401);
      // Coverage probe: every table entry reaches a handler (no generic 404, no 401/403).
      const asOperator = await call(h, method, path, h.operator);
      expect([401, 403], `${method} ${path}`).not.toContain(asOperator.status);
      expect(asOperator.body?.code, `${method} ${path}`).not.toBe("NOT_FOUND");
      expect(asOperator.body, `${method} ${path}`).not.toEqual({ error: "Not found" });
    }
  });

  it("answers unknown and loosely matching paths 401 unauthenticated and 404 authenticated", async () => {
    const h = await start();
    const spy = vi.spyOn(h.service, "getTimeline");
    for (const path of [
      "/admin",
      "/conversations/a/b/events",
      "/conversations/a/events/",
      "/models/"
    ]) {
      expect((await call(h, "GET", path)).status).toBe(401);
      const r = await call(h, "GET", path, h.operator);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a server built without an authenticator", () => {
    const queue = new InMemoryTaskQueue(),
      timeline = new InMemoryConversationTimelineStore();
    const service = new ChatService(
      new ChatOrchestrator(new MockFastProvider(), queue, timeline),
      new DeepWorker(queue, new MockDeepProvider(), timeline),
      timeline,
      queue
    );
    expect(() => createChatServer(service, {} as never)).toThrow(/authenticator/);
  });
});

describe("pairing and browser sessions", () => {
  it("pairs once with the console code and issues a strict session cookie", async () => {
    const h = await start();
    const page = await fetch(h.base + "/pair");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('method="post"');
    expect(html).not.toMatch(/name="code"/);

    const code = h.pairing.issue();
    const pair = (body: unknown, headers: Record<string, string> = h.sameOrigin) =>
      fetch(h.base + "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
      });
    // The bootstrap proves its own origin, independently of credentials.
    expect((await pair({ code }, {})).status).toBe(403);
    expect((await pair({ code }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await pair({ code }, { origin: "http://127.0.0.1:1" })).status).toBe(403);
    const wrong = await pair({ code: "WRONG-CODE0" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: "PAIRING_FAILED", error: "That code is not valid" });

    const ok = await pair({ code });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^ca_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/
    );
    expect(JSON.stringify(await ok.json())).not.toContain(code);
    // Single use.
    expect((await pair({ code })).status).toBe(409);

    const session = { cookie: cookie.split(";")[0] };
    const status = await call(h, "GET", "/auth/session", session);
    expect(status.body).toEqual({
      authenticated: true,
      roles: ["client", "operator"],
      via: "session"
    });
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect((await call(h, "GET", "/auth/session")).body).toEqual({ authenticated: false });
    expect((await call(h, "GET", "/auth/session", h.client)).body).toEqual({
      authenticated: true,
      roles: ["client"],
      via: "bearer"
    });
  });

  it("answers malformed and oversized pairing bodies with structured errors", async () => {
    const h = await start();
    h.pairing.issue();
    const pair = (body: string) =>
      fetch(h.base + "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...h.sameOrigin },
        body
      });
    const malformed = await pair("{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "Invalid JSON body" });
    const oversized = await pair(JSON.stringify({ code: "x".repeat(5000) }));
    expect(oversized.status).toBe(413);
    expect((await pair(JSON.stringify({ code: 7 }))).status).toBe(401);
    expect((await pair(JSON.stringify({ code: "A", extra: 1 }))).status).toBe(401);
  });

  it("re-issues a code only for the operator, never in the response", async () => {
    const h = await start();
    const first = h.pairing.issue();
    expect((await call(h, "POST", "/pair/reissue", h.client)).status).toBe(403);
    const reissued = await call(h, "POST", "/pair/reissue", h.operator);
    expect(reissued.status).toBe(202);
    expect(reissued.body).toEqual({ issued: true });
    expect(h.announced).toHaveLength(1);
    expect(h.announced[0]).not.toBe(first);
    expect(h.pairing.attempt(first)).not.toBe("paired");
  });

  it("lets a cookie change state only with this exact origin; bearer tokens need none", async () => {
    const h = await start();
    const session = { cookie: `ca_session=${h.auth.issueSession()}` };
    const send = (headers: Record<string, string>) =>
      fetch(h.base + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ conversationId: "c", userId: "u", text: "hello" })
      });
    const noOrigin = await send(session);
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ code: "ORIGIN_REQUIRED" });
    // A hostile Origin is refused by the local boundary for every credential.
    expect((await send({ ...session, origin: "http://evil.example" })).status).toBe(403);
    expect((await send({ ...h.client, origin: "http://evil.example" })).status).toBe(403);
    expect((await send({ ...session, ...h.sameOrigin })).status).toBe(200);
    expect((await send(h.client)).status).toBe(200);
    // Reads with the cookie need no Origin.
    expect((await call(h, "GET", "/conversations/c/events", session)).status).toBe(200);
  });

  it("treats duplicate session cookies as no session", async () => {
    const h = await start();
    const token = h.auth.issueSession();
    const r = await call(h, "GET", "/models", {
      cookie: `ca_session=${token}; ca_session=${token}`
    });
    expect(r.status).toBe(401);
  });

  // Two servers built from the same identity object: server reconstruction, not a
  // process restart. Reloading from disk is covered by localIdentity.test.ts.
  it("keeps a session valid on a reconstructed server with the same identity, until rotation", async () => {
    const identity = newIdentity();
    const before = await start(identity);
    const token = before.auth.issueSession();
    const after = await start(identity);
    expect((await call(after, "GET", "/models", { cookie: `ca_session=${token}` })).status).toBe(
      200
    );
    after.auth.useIdentity({
      ...identity,
      sessionKey: secret(),
      clientToken: secret(),
      operatorToken: secret(),
      epoch: 1
    });
    expect((await call(after, "GET", "/models", { cookie: `ca_session=${token}` })).status).toBe(
      401
    );
    expect((await call(after, "GET", "/models", after.client)).status).toBe(401);
  });
});

describe("boundary refusals that apply to every credential", () => {
  async function raw(h: Harness, headers: string) {
    const port = Number(h.host.split(":")[1]);
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.write(`GET /models HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`);
    });
  }

  it("refuses a repeated Host or Origin even with a valid bearer token", async () => {
    const h = await start();
    const auth = `Authorization: Bearer ${h.identity.operatorToken}\r\n`;
    expect(await raw(h, `Host: ${h.host}\r\n${auth}`)).toMatch(/^HTTP\/1\.1 200/);
    expect(await raw(h, `Host: ${h.host}\r\nHost: evil.example\r\n${auth}`)).toMatch(
      /^HTTP\/1\.1 403[\s\S]*HOST_NOT_ALLOWED/
    );
    expect(
      await raw(
        h,
        `Host: ${h.host}\r\nOrigin: http://${h.host}\r\nOrigin: http://${h.host}\r\n${auth}`
      )
    ).toMatch(/^HTTP\/1\.1 403[\s\S]*ORIGIN_NOT_ALLOWED/);
  });
});

describe("no bypass of protocol v1 scoping", () => {
  it("legacy routes cannot reach a conversation that v1 allocated internally", async () => {
    const h = await start();
    const submit = vi.spyOn(h.service, "submitMessage");
    const wire = randomUUID();
    const v1 = await fetch(`${h.base}/v1/conversations/${wire}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...h.client },
      body: JSON.stringify({
        protocolVersion: "1.0",
        accountId: "a",
        projectId: "p",
        messageId: randomUUID(),
        text: "hello",
        clientTimestampIso: new Date().toISOString()
      })
    });
    expect(v1.status).toBe(200);
    const internal = submit.mock.calls[0][0].conversationId;
    expect(internal).not.toBe(wire);
    const legacy = [
      ["GET", `/conversations/${internal}/events`],
      ["GET", `/conversations/${internal}/events/stream`],
      ["POST", `/conversations/${internal}/messages/${randomUUID()}/cancel`]
    ];
    for (const [method, path] of legacy) {
      const r = await call(h, method, path, h.operator);
      expect(r.status, path).toBe(404);
      expect(r.body).toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    }
    // Every legacy body route, including features disabled in this harness: the
    // check runs before any handler.
    for (const path of [
      "/messages",
      "/conversation-context",
      "/conversation-context/detach",
      "/sports/teams",
      "/sports/results",
      "/sports/games",
      "/sports/conversations",
      "/sports/chat",
      "/document-tasks",
      "/briefings"
    ]) {
      const r = await fetch(h.base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...h.operator },
        body: JSON.stringify({ conversationId: internal, userId: "a", text: "x", league: "NBA" })
      });
      expect(r.status, path).toBe(404);
      expect(await r.json()).toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    }
    // Operator retention routes work on internal ids by design: retiring this live
    // conversation is refused because it is in use, not hidden.
    const retire = await call(h, "DELETE", `/conversations/${internal}/identity`, h.operator);
    expect(retire.status).toBe(409);
    expect(retire.body).toMatchObject({ code: "CONVERSATION_RETIREMENT_BLOCKED" });
    // The protocol itself still works.
    const stream = await fetch(
      `${h.base}/v1/conversations/${wire}/events/stream?accountId=a&projectId=p`,
      { headers: h.client }
    );
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });

  it("the operator dead-letter view omits prompts and conversation identity", async () => {
    const h = await start();
    vi.spyOn(h.service, "listDeadLetters").mockResolvedValue([
      {
        task: {
          taskId: "t1",
          conversationId: "secret-conversation",
          normalizedPrompt: "secret prompt",
          messageId: "secret-message",
          dispatchId: "secret-dispatch",
          providerHint: "secret-hint",
          context: {
            conversationId: "secret-conversation",
            messages: [{ text: "secret history" }]
          },
          sizeBand: "small",
          createdAtIso: "2026-10-06T00:00:00.000Z"
        },
        errorMessage: "PROVIDER_TIMEOUT",
        failedAtIso: "2026-10-06T00:00:01.000Z"
      },
      {
        task: { taskId: "t2", conversationId: "x", normalizedPrompt: "y", createdAtIso: "z" },
        errorMessage: "upstream said: secret request body",
        failedAtIso: "2026-10-06T00:00:02.000Z"
      },
      {
        task: { taskId: "t3", conversationId: "x", normalizedPrompt: "y", createdAtIso: "z" },
        // Shaped like a code, but not a known public category.
        errorMessage: "SECRET_CUSTOMER_123",
        failedAtIso: "2026-10-06T00:00:03.000Z"
      }
    ] as never);
    const r = await call(h, "GET", "/workers/deep/dead-letters", h.operator);
    expect(r.status).toBe(200);
    expect(r.body.records).toEqual([
      {
        task: { taskId: "t1", createdAtIso: "2026-10-06T00:00:00.000Z", sizeBand: "small" },
        errorCode: "PROVIDER_TIMEOUT",
        failedAtIso: "2026-10-06T00:00:01.000Z"
      },
      {
        task: { taskId: "t2", createdAtIso: "z" },
        errorCode: "OTHER",
        failedAtIso: "2026-10-06T00:00:02.000Z"
      },
      {
        task: { taskId: "t3", createdAtIso: "z" },
        errorCode: "OTHER",
        failedAtIso: "2026-10-06T00:00:03.000Z"
      }
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/secret/);
  });
});
