import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import type { Authenticator } from "../../src/auth/authenticator";
import type { ExecutiveRoot } from "../../src/config/executiveOverviewConfig";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { renderHomePageHtml } from "../../src/ui/homePage";
import { allowAllTestAuth } from "../helpers/testAuth";

const servers: Server[] = [];
const FIXTURE_ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const raw = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
const rootOf = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const plan = (rootId: string) => raw.split(FIXTURE_ROOT).join(rootId);
const OVERVIEW = "/development/executive/overview";
const PRIVATE = "PRIVATE-UPSTREAM-BODY";

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
type Answer = { status: number; body: string | Buffer };
async function upstream(answers: Record<string, Answer>) {
  const requests: string[] = [];
  const url = await listen(
    createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const answer = answers[(req.url ?? "").split("/").pop() ?? ""] ?? {
        status: 404,
        body: PRIVATE
      };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    })
  );
  return { url, requests };
}
const inventory = (count: number): ExecutiveRoot[] =>
  Array.from({ length: count }, (_, i) => ({
    rootId: rootOf(i + 1),
    label: `Root ${i + 1}`,
    goal: "Configured goal"
  }));
async function app(
  planApiUrl: string | undefined,
  roots: ExecutiveRoot[] | undefined,
  auth: Authenticator = allowAllTestAuth
) {
  return listen(
    createChatServer(service(), {
      auth,
      ...(planApiUrl === undefined ? {} : { planApiUrl }),
      ...(roots === undefined ? {} : { executiveOverview: { roots } })
    })
  );
}
const principal = (roles: string[]): Authenticator => ({
  resolve: () => ({ principalId: "p", roles: new Set(roles), via: "bearer" }) as never
});

describe("executive overview HTTP", () => {
  it("answers 200 with every configured root in order despite mixed outcomes", async () => {
    const invalid = JSON.parse(plan(rootOf(2)));
    invalid.readiness.errors = [{ code: "CYCLE", message: PRIVATE, nodeId: null, relatedId: null }];
    const remote = await upstream({
      [rootOf(1)]: { status: 200, body: plan(rootOf(1)) },
      [rootOf(2)]: { status: 200, body: JSON.stringify(invalid) },
      [rootOf(3)]: { status: 500, body: PRIVATE },
      [rootOf(4)]: { status: 200, body: Buffer.alloc(2 * 1024 * 1024 + 1024, 120) },
      [rootOf(5)]: { status: 200, body: `{"schema": "${PRIVATE}"` }
    });
    const base = await app(remote.url, inventory(5));
    const response = await fetch(base + OVERVIEW);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ schema: "executive-overview/v1", atomic: false });
    expect(body.roots.map((r: { rootId: string }) => r.rootId)).toEqual(
      inventory(5).map((r) => r.rootId)
    );
    expect(
      body.roots.map((r: { status: string; reason: string | null }) => [r.status, r.reason])
    ).toEqual([
      ["ok", null],
      ["invalid", null],
      ["unavailable", "HTTP_ERROR"],
      ["unavailable", "RESPONSE_TOO_LARGE"],
      ["unavailable", "INVALID_RESPONSE"]
    ]);
    expect(body.roots[1].invalidCodes).toEqual([{ code: "CYCLE", nodeId: null }]);
    expect(body.roots[0].goal).toBe("Configured goal");
    expect(body.roots[0].tasks.length).toBeGreaterThan(0);
    // Failures never leak upstream bodies, messages, addresses or ports.
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
    // One read per root and nothing but GETs of the plan contract.
    expect([...remote.requests].sort()).toEqual(
      inventory(5)
        .map((r) => `GET /api/plan-contract/v1/plans/${r.rootId}`)
        .sort()
    );
  });

  it("still answers 200 with unavailable cards when the plan API is down", async () => {
    const base = await app("http://127.0.0.1:9", inventory(3));
    const response = await fetch(base + OVERVIEW);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.roots).toHaveLength(3);
    expect(body.roots.every((r: { status: string }) => r.status === "unavailable")).toBe(true);
    expect(body.roots.every((r: { tasks: unknown[] }) => r.tasks.length === 0)).toBe(true);
  });

  it("projects an allowlist of task fields with the current gate and no budget claim", async () => {
    const remote = await upstream({ [rootOf(1)]: { status: 200, body: plan(rootOf(1)) } });
    const base = await app(remote.url, inventory(1));
    const body = await (await fetch(base + OVERVIEW)).json();
    const root = body.roots[0];
    expect(root.status).toBe("ok");
    expect(root.acceptedCounts.total).toBe(root.tasks.length);
    expect(Object.keys(root.tasks[0]).sort()).toEqual(
      [
        "acceptance",
        "attemptEpoch",
        "attemptId",
        "attemptPins",
        "artifactRef",
        "blockers",
        "blockersOmitted",
        "budgetEvidence",
        "checkpointGate",
        "contentRevision",
        "executionAcknowledged",
        "executorRef",
        "gatesHold",
        "name",
        "nodeId",
        "prod",
        "scope",
        "state",
        "stateRevision",
        "upstreamChanged",
        ...(root.tasks[0].acceptanceHistorical ? ["acceptanceHistorical"] : [])
      ].sort()
    );
    expect(
      root.tasks.every((t: { budgetEvidence: string }) => t.budgetEvidence === "not_reported")
    ).toBe(true);
    const running = root.tasks.find((t: { state: string }) => t.state === "in_progress");
    expect(running).toMatchObject({
      prod: "confirm_worker_liveness",
      checkpointGate: "not_verified",
      executionAcknowledged: "unknown"
    });
  });

  it("keeps v1 and v3 byte-compatible without a continuation path and never opens v4 by itself", async () => {
    const root = rootOf(1);
    const remote = await upstream({ [root]: { status: 200, body: plan(root) } });
    const plain = await (await fetch((await app(remote.url, inventory(1))) + OVERVIEW)).json();
    expect(plain.schema).toBe("executive-overview/v1");
    const node = plain.roots[0].tasks[0].nodeId as string;
    const registered = await listen(
      createChatServer(service(), {
        auth: allowAllTestAuth,
        planApiUrl: remote.url,
        executiveOverview: { roots: inventory(1) },
        checkpointRecords: [{ rootId: root, nodeId: node, recordPath: "/absent/r.budget.json" }]
      })
    );
    const body = await (await fetch(registered + OVERVIEW)).json();
    expect(body.schema).toBe("executive-overview/v3");
    expect("continuation" in body).toBe(false);
    expect(body.roots[0].tasks.every((t: object) => !("continuation" in t))).toBe(true);
    // A configured continuation path whose file is absent opens v4 with explicit unavailability.
    const phased = await listen(
      createChatServer(service(), {
        auth: allowAllTestAuth,
        planApiUrl: remote.url,
        executiveOverview: { roots: inventory(1) },
        checkpointRecords: [
          {
            rootId: root,
            nodeId: node,
            recordPath: "/absent/r.budget.json",
            continuationRecordPath: "/absent/11111111-1111-4111-8111-111111111111.continuation.json"
          }
        ]
      })
    );
    const v4 = await (await fetch(phased + OVERVIEW)).json();
    expect(v4.schema).toBe("executive-overview/v4");
    expect(v4.continuation).toMatchObject({
      configured: 1,
      unavailable: 1,
      items: [],
      phases: { running: 0, needs_operator: 0 }
    });
    const task = v4.roots[0].tasks.find((t: { nodeId: string }) => t.nodeId === node);
    expect(task.continuation).toEqual({ state: "unavailable", reason: "missing" });
  });

  it("enforces operator-only access before any upstream read", async () => {
    const remote = await upstream({ [rootOf(1)]: { status: 200, body: plan(rootOf(1)) } });
    const unauth = await app(remote.url, inventory(1), { resolve: () => undefined });
    const guest = await fetch(unauth + OVERVIEW);
    expect(guest.status).toBe(401);
    expect(await guest.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    const client = await app(remote.url, inventory(1), principal(["client"]));
    const denied = await fetch(client + OVERVIEW);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(remote.requests).toEqual([]);
    const operator = await app(remote.url, inventory(1), principal(["client", "operator"]));
    expect((await fetch(operator + OVERVIEW)).status).toBe(200);
    expect(remote.requests).toHaveLength(1);
  });

  it("offers no mutation, sibling path or request-supplied input", async () => {
    const remote = await upstream({ [rootOf(1)]: { status: 200, body: plan(rootOf(1)) } });
    const base = await app(remote.url, inventory(1));
    for (const method of ["POST", "DELETE"]) {
      const response = await fetch(base + OVERVIEW, {
        method,
        body: method === "POST" ? "{}" : undefined
      });
      expect(response.status, method).toBe(404);
    }
    for (const path of [OVERVIEW + "/", OVERVIEW + "/x", "/development/executive"])
      expect((await fetch(base + path)).status, path).toBe(404);
    const query = await fetch(base + OVERVIEW + `?root=${rootOf(9)}&url=http://evil.example`);
    expect(query.status).toBe(400);
    expect(await query.json()).toMatchObject({ code: "INVALID_QUERY" });
    expect(remote.requests).toEqual([]);
  });

  it("is disabled, with the home page unchanged, unless configured", async () => {
    const remote = await upstream({});
    const off = await app(remote.url, undefined);
    const response = await fetch(off + OVERVIEW);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "EXECUTIVE_OVERVIEW_DISABLED" });
    expect(await (await fetch(off + "/")).text()).toBe(
      renderHomePageHtml(undefined, false, true, false, false)
    );
    const noPlan = await app(undefined, undefined);
    expect(await (await fetch(noPlan + "/")).text()).toBe(renderHomePageHtml());
    const on = await app(remote.url, inventory(1));
    const html = await (await fetch(on + "/")).text();
    expect(html).toBe(renderHomePageHtml(undefined, false, true, false, false, true));
    expect(html).toContain('id="execRefresh"');
    expect(remote.requests).toEqual([]);
  });

  it("refuses unsafe or incomplete configuration at construction without echoing it", () => {
    const build = (planApiUrl: string | undefined, roots: unknown) => () =>
      createChatServer(service(), {
        auth: allowAllTestAuth,
        ...(planApiUrl === undefined ? {} : { planApiUrl }),
        executiveOverview: { roots } as never
      });
    expect(build(undefined, inventory(1))).toThrow("INVALID_EXECUTIVE_ROOTS");
    expect(build("http://127.0.0.1:1", [])).toThrow("INVALID_EXECUTIVE_ROOTS");
    expect(build("http://127.0.0.1:1", inventory(9))).toThrow("INVALID_EXECUTIVE_ROOTS");
    expect(build("http://127.0.0.1:1", [{ ...inventory(1)[0], url: "http://x" }])).toThrow(
      "INVALID_EXECUTIVE_ROOTS"
    );
    expect(build("http://127.0.0.1:1", [...inventory(1), ...inventory(1)])).toThrow(
      "INVALID_EXECUTIVE_ROOTS"
    );
    expect(build("https://example.com", inventory(1))).toThrow("INVALID_URL");
    expect(build("http://localhost:5111", inventory(1))).toThrow("INVALID_URL");
  });
});
