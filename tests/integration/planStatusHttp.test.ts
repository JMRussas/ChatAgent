import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { allowAllTestAuth } from "../helpers/testAuth";

const servers: Server[] = [];
const root = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const route = `/development/plans/${root}/status`;
const raw = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
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
async function upstream(status = 200, body = raw) {
  const requests: string[] = [];
  const url = await listen(
    createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    })
  );
  return { url, requests };
}
async function app(planApiUrl?: string, auth = allowAllTestAuth) {
  const options = { auth, planApiUrl };
  return listen(createChatServer(service(), options));
}

describe("read-only development plan status HTTP", () => {
  it("keeps all allowed implementation and contract files formatted", () => {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/prettier/bin/prettier.cjs",
        "--check",
        "src/server.ts",
        "src/auth/routePolicy.ts",
        "docs/implementation/13-hekate-plan-node-integration.md",
        "docs/implementation/14-local-authentication.md"
      ],
      { encoding: "utf8", timeout: 30000, windowsHide: true }
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it("projects real plan states with unknown liveness using one upstream GET", async () => {
    const remote = await upstream();
    const base = await app(remote.url);
    const response = await fetch(base + route);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.leaves.some((leaf: { state: string }) => leaf.state === "in_progress")).toBe(true);
    expect(
      body.leaves.every(
        (leaf: { executionAcknowledged: string }) => leaf.executionAcknowledged === "unknown"
      )
    ).toBe(true);
    expect(remote.requests).toEqual([`GET /api/plan-contract/v1/plans/${root}`]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("is explicitly disabled when no URL is configured", async () => {
    const response = await fetch((await app()) + route);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PLAN_STATUS_DISABLED" });
  });
  it("refuses an invalid root before contacting Hekate", async () => {
    const remote = await upstream();
    const response = await fetch((await app(remote.url)) + "/development/plans/not-a-guid/status");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ROOT" });
    expect(remote.requests).toEqual([]);
  });
  it("rejects request-supplied URL overrides rather than forwarding them", async () => {
    const remote = await upstream();
    const response = await fetch((await app(remote.url)) + route + "?url=http://example.com");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_QUERY" });
    expect(remote.requests).toEqual([]);
  });
  it("refuses unsafe configured URLs at construction", () => {
    for (const planApiUrl of [
      "https://example.com",
      "http://localhost:5111",
      "http://user:secret@127.0.0.1:5111"
    ]) {
      const options = { auth: allowAllTestAuth, planApiUrl };
      expect(() => createChatServer(service(), options)).toThrow("INVALID_URL");
    }
  });
  it("reports unavailable upstream without echoing its body", async () => {
    const remote = await upstream(500, "private-upstream-detail");
    const response = await fetch((await app(remote.url)) + route);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "PLAN_STATUS_UNAVAILABLE",
      reason: "HTTP_ERROR"
    });
  });
  it("keeps global development plans operator-only", async () => {
    const remote = await upstream();
    const unauth = await app(remote.url, { resolve: () => undefined });
    expect((await fetch(unauth + route)).status).toBe(401);
    const client = await app(remote.url, {
      resolve: () => ({ principalId: "client:test", roles: new Set(["client"]), via: "bearer" })
    });
    expect((await fetch(client + route)).status).toBe(403);
    expect(remote.requests).toEqual([]);
  });
  it("does not turn POST into a plan mutation or launch", async () => {
    const remote = await upstream();
    const response = await fetch((await app(remote.url)) + route, { method: "POST" });
    expect(response.status).toBe(404);
    expect(remote.requests).toEqual([]);
  });
});
