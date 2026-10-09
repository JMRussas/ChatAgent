import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { createEphemeralAuth } from "../../src/auth/ephemeral";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import {
  READY,
  ROOT,
  RUNNING,
  SECRETS,
  claude,
  planBody,
  traceRecords,
  upstreamBodies
} from "../helpers/attemptProgressFixtures";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function service() {
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  return new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline
  );
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const records = traceRecords([
  {
    text: claude.assistant([
      { type: "thinking", thinking: SECRETS.thinking },
      claude.text("Reading the test.")
    ])
  },
  { text: claude.assistant([claude.tool("Read")]) },
  { stream: "stderr", text: SECRETS.stderr }
]);

/** A fake Hekate plan API serving the fixture observation and recording every request. */
async function upstream(answer = upstreamBodies({ records, plan: planBody() }), status = 200) {
  const requests: string[] = [];
  const url = await listen(
    createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const body = answer(req.url ?? "");
      if (body === undefined || status !== 200) {
        res.writeHead(status === 200 ? 404 : status, { "content-type": "application/json" });
        res.end(`${SECRETS.hekate} upstream refusal`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    })
  );
  return { url, requests };
}

type ServerOptions = Parameters<typeof createChatServer>[1];
async function app(options: Partial<ServerOptions> = {}) {
  const ephemeral = createEphemeralAuth();
  const base = await listen(createChatServer(service(), { auth: ephemeral.auth, ...options }));
  return { base, headers: ephemeral.headers };
}
const route = (node = RUNNING, root = ROOT) => `/development/plans/${root}/nodes/${node}/progress`;

describe("read-only attempt progress HTTP", () => {
  it("answers an operator with the allowlisted projection from exactly four plan-API GETs", async () => {
    const remote = await upstream();
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    const response = await fetch(base + route(), { headers: headers("operator") });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    for (const [name, secret] of Object.entries(SECRETS))
      expect([name, text.includes(secret)]).toEqual([name, false]);
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      schema: "attempt-progress/v1",
      rootId: ROOT,
      nodeId: RUNNING,
      assessment: { workerLiveness: "unknown", usefulProgress: "unknown" },
      selectedAttempt: { scope: "current" },
      activity: { trust: "untrusted_inert_unverified_worker_claims" }
    });
    expect(body.activity.items.map((i: { kind: string }) => i.kind)).toEqual(["text", "tool_use"]);
    expect(remote.requests.every((r) => r.startsWith("GET /api/plan-contract/v1/"))).toBe(true);
    expect(remote.requests.length).toBe(4);
    expect(remote.requests.length).toBeLessThanOrEqual(8);
  });

  it("refuses missing and client-only credentials before contacting the plan API", async () => {
    const remote = await upstream();
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    expect((await fetch(base + route())).status).toBe(401);
    const client = await fetch(base + route(), { headers: headers("client") });
    expect(client.status).toBe(403);
    expect(await client.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(remote.requests).toEqual([]);
  });

  it("offers no write method", async () => {
    const remote = await upstream();
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(base + route(), {
        method,
        headers: headers("operator"),
        body: method === "DELETE" ? undefined : "{}"
      });
      expect([method, response.status]).toEqual([method, 404]);
    }
    expect(remote.requests).toEqual([]);
  });

  it("is disabled without the opt-in or without a plan API, with the home page unchanged", async () => {
    const remote = await upstream();
    const noOptIn = await app({ planApiUrl: remote.url });
    const a = await fetch(noOptIn.base + route(), { headers: noOptIn.headers("operator") });
    expect(a.status).toBe(404);
    expect(await a.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_DISABLED" });
    const noPlan = await app({ attemptProgress: true });
    const b = await fetch(noPlan.base + route(), { headers: noPlan.headers("operator") });
    expect(b.status).toBe(404);
    expect(await b.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_DISABLED" });
    expect(remote.requests).toEqual([]);
    const page = (origin: string) => fetch(origin + "/").then((r) => r.text());
    expect(await page(noOptIn.base)).not.toContain("attemptProgress");
    expect(await page(noPlan.base)).not.toContain("attemptProgress");
    const plain = await app({ planApiUrl: remote.url, attemptProgress: true });
    const enabled = await page(plain.base);
    expect(enabled).toContain('id="attemptProgress"');
    expect(enabled).toContain("Read attempt progress");
  });

  it("checks the query and both identities before any upstream I/O", async () => {
    const remote = await upstream();
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    const get = (path: string) => fetch(base + path, { headers: headers("operator") });
    expect((await get(`${route()}?afterSeq=1`)).status).toBe(400);
    expect(await (await get(`${route()}?x=1`)).json()).toMatchObject({ code: "INVALID_QUERY" });
    expect(await (await get(route("NOT-A-GUID"))).json()).toMatchObject({ code: "INVALID_NODE" });
    expect(await (await get(route(RUNNING, "NOT-A-GUID"))).json()).toMatchObject({
      code: "INVALID_ROOT"
    });
    expect(await (await get(route(RUNNING.toUpperCase()))).json()).toMatchObject({
      code: "INVALID_NODE"
    });
    expect(remote.requests).toEqual([]);
  });

  it("maps a node that is not in the plan to 404 and another root to a coded 503", async () => {
    const remote = await upstream();
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    const missing = await fetch(base + route("00000000-0000-4000-8000-000000000000"), {
      headers: headers("operator")
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "NODE_NOT_FOUND" });
    const other = await fetch(base + route(RUNNING, READY), { headers: headers("operator") });
    expect(other.status).toBe(503);
    expect(await other.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_UNAVAILABLE" });
  });

  it("reports a backend refusal as unavailable and never echoes the upstream body", async () => {
    const remote = await upstream(upstreamBodies({ records }), 500);
    const { base, headers } = await app({ planApiUrl: remote.url, attemptProgress: true });
    const response = await fetch(base + route(), { headers: headers("operator") });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      code: "ATTEMPT_PROGRESS_UNAVAILABLE",
      reason: "HTTP_ERROR"
    });
    expect(text).not.toContain(SECRETS.hekate);
    expect(remote.requests).toHaveLength(1);
  });

  it("reports a closed plan API as unavailable without restarting or retrying it", async () => {
    const closed = createServer();
    const url = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { base, headers } = await app({ planApiUrl: url, attemptProgress: true });
    const response = await fetch(base + route(), { headers: headers("operator") });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "ATTEMPT_PROGRESS_UNAVAILABLE",
      reason: "UNAVAILABLE"
    });
  });

  it("uses an injected observer factory once per request", async () => {
    const remote = await upstream();
    let created = 0;
    const { base, headers } = await app({
      planApiUrl: remote.url,
      attemptProgress: {
        createObserver: () => {
          created++;
          return {
            observe: async () => {
              throw new Error(`never ${SECRETS.toolInput}`);
            }
          };
        }
      }
    });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + route(), { headers: headers("operator") });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(SECRETS.toolInput);
    }
    expect(created).toBe(2);
    expect(remote.requests).toEqual([]);
  });
});
