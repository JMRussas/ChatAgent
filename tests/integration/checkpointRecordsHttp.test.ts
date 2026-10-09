import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { budgetRecordPath } from "../../src/checkpoint/checkpointRecord";
import { CheckpointRecordsConfigError } from "../../src/config/checkpointRecordsConfig";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { allowAllTestAuth } from "../helpers/testAuth";
import { makeRecord, RUN_ID } from "../helpers/checkpointFixtures";

const servers: Server[] = [];
const dirs: string[] = [];
const FIXTURE_ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const raw = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
const ROOT = "00000001-0000-4000-8000-000000000000";
const plan = raw.split(FIXTURE_ROOT).join(ROOT);
const OVERVIEW = "/development/executive/overview";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
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
async function upstream() {
  const requests: string[] = [];
  const url = await listen(
    createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(plan);
    })
  );
  return { url, requests };
}
const roots = [{ rootId: ROOT, label: "Root", goal: "Configured goal" }];
async function app(planApiUrl: string, extra: Record<string, unknown> = {}) {
  return listen(
    createChatServer(service(), {
      auth: allowAllTestAuth,
      planApiUrl,
      executiveOverview: { roots },
      ...extra
    })
  );
}

describe("checkpoint records over the executive overview route", () => {
  it("serves v2 with typed unavailable reasons, only GETs, and quarantines a stale record", async () => {
    const remote = await upstream();
    const plain = await (await fetch((await app(remote.url)) + OVERVIEW)).json();
    expect(plain.schema).toBe("executive-overview/v1");
    const tasks = plain.roots[0].tasks as { nodeId: string }[];
    expect(tasks.length).toBeGreaterThan(1);

    const dir = await mkdtemp(join(tmpdir(), "ckpt-http-"));
    dirs.push(dir);
    const stalePath = budgetRecordPath(dir, RUN_ID);
    await writeFile(
      stalePath,
      JSON.stringify(
        makeRecord({
          identity: {
            ...makeRecord().identity,
            rootId: ROOT,
            nodeId: tasks[0].nodeId,
            attemptId: "stale-attempt"
          }
        })
      )
    );
    remote.requests.length = 0;
    const registry = [
      { rootId: ROOT, nodeId: tasks[0].nodeId, recordPath: stalePath },
      { rootId: ROOT, nodeId: tasks[1].nodeId, recordPath: join(dir, "absent.budget.json") }
    ];
    const base = await app(remote.url, { checkpointRecords: registry });
    const response = await fetch(base + OVERVIEW);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.schema).toBe("executive-overview/v2");
    const byNode = new Map(
      (
        body.roots[0].tasks as {
          nodeId: string;
          budgetEvidence: string;
          checkpointBudget?: unknown;
        }[]
      ).map((t) => [t.nodeId, t])
    );
    expect(byNode.get(tasks[0].nodeId)).toMatchObject({
      budgetEvidence: "unavailable",
      checkpointBudget: { state: "unavailable", reason: "stale_identity" }
    });
    expect(byNode.get(tasks[1].nodeId)).toMatchObject({
      checkpointBudget: { state: "unavailable", reason: "missing" }
    });
    for (const node of tasks.slice(2)) {
      expect(byNode.get(node.nodeId)).toMatchObject({ budgetEvidence: "not_reported" });
      expect("checkpointBudget" in byNode.get(node.nodeId)!).toBe(false);
    }
    // A stale record's numbers, and the configured paths, never reach the response.
    expect(text).not.toContain("987654321");
    expect(text).not.toContain(dir);
    expect(remote.requests.every((r) => r.startsWith("GET "))).toBe(true);
    // No execution surface is added: the overview route still has no mutating method.
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await fetch(base + OVERVIEW, { method })).status).not.toBe(200);
  });

  it("refuses an invalid registry at startup with a stable code", () => {
    const factory =
      (extra: Record<string, unknown>, withOverview = true) =>
      () =>
        createChatServer(service(), {
          auth: allowAllTestAuth,
          planApiUrl: "http://127.0.0.1:5100",
          ...(withOverview ? { executiveOverview: { roots } } : {}),
          ...extra
        });
    const entry = {
      rootId: ROOT,
      nodeId: "00000064-0000-4000-8000-000000000001",
      recordPath: join(tmpdir(), "r.json")
    };
    expect(factory({ checkpointRecords: [entry] }, false)).toThrow(CheckpointRecordsConfigError);
    expect(
      factory({ checkpointRecords: [{ ...entry, rootId: "00000009-0000-4000-8000-000000000000" }] })
    ).toThrow(CheckpointRecordsConfigError);
    expect(factory({ checkpointRecords: [{ ...entry, recordPath: "relative.json" }] })).toThrow(
      CheckpointRecordsConfigError
    );
    expect(factory({ checkpointRecords: [entry] })).not.toThrow();
  });
});
