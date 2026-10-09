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
import { BASE_REF, makeRecord, RUN_ID, STAMP } from "../helpers/checkpointFixtures";

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
    expect(body.schema).toBe("executive-overview/v3");
    expect(body.attention).toMatchObject({ items: [], registeredRecordsUnavailable: 2 });
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

  it("serves v4 phases from explicitly configured continuation files only", async () => {
    // The fixture's `git:` prefix is dropped: a recorded candidate is a bare commit hash.
    const bare = plan.split(`git:${"a".repeat(40)}`).join("a".repeat(40));
    const requests: string[] = [];
    const remote = await listen(
      createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(bare);
      })
    );
    const dir = await mkdtemp(join(tmpdir(), "ckpt-http-cont-"));
    dirs.push(dir);
    const SOURCE = "a".repeat(40);
    const nodes = [
      { id: "49262a8f-dcae-4e0e-a900-9a1870d38ecb", attempt: "fixture-attempt-1" },
      { id: "be0e3cab-738e-4cfb-bb2a-49fa2196a9ba", attempt: "fixture-attempt-2" },
      { id: "f253b776-0375-4eea-9bd4-3df2003d039a", attempt: "fixture-attempt-3" }
    ];
    const runs = nodes.map((_, i) => `00000${i + 1}00-0000-4000-8000-000000000000`);
    const check = (name: string, result: string) => ({
      name,
      result,
      ran: result !== "unavailable",
      exitCode: result === "pass" ? 0 : null,
      signal: null,
      timedOut: false,
      outputLimited: false,
      outputBytes: 9,
      outputSha256: "f".repeat(64),
      startedAt: STAMP,
      endedAt: STAMP
    });
    const sourced = { sourceRef: SOURCE, finish: "confirmed", gate: "written", endedAt: STAMP };
    const phases = [
      { phase: "running" },
      {
        ...sourced,
        phase: "needs_operator",
        reason: "check_failed",
        checks: [
          check("prettier", "pass"),
          check("typescript", "fail"),
          check("vitest", "unavailable")
        ]
      },
      {
        ...sourced,
        phase: "review_pending",
        reason: "checks_passed",
        checks: ["prettier", "typescript", "vitest"].map((n) => check(n, "pass"))
      }
    ];
    const registry = [];
    for (let i = 0; i < nodes.length; i++) {
      const identity = {
        rootId: ROOT,
        nodeId: nodes[i].id,
        attemptId: nodes[i].attempt,
        attemptEpoch: 1,
        contentRevision: 1,
        observedStateRevision: 1,
        executorRef: "fixture:worker"
      };
      await writeFile(
        budgetRecordPath(dir, runs[i]),
        JSON.stringify(makeRecord({ runId: runs[i], identity }))
      );
      const record = {
        schema: "checkpoint-continuation/v1",
        runId: runs[i],
        identity,
        baseRef: BASE_REF,
        phase: "running",
        reason: "in_progress",
        startedAt: STAMP,
        updatedAt: STAMP,
        endedAt: null,
        sourceRef: null,
        worker: null,
        finish: "not_attempted",
        checkRole: "mimir_external_checks",
        checks: [],
        gate: "not_written",
        failureAttribution: "unattributed",
        leadAcceptance: "pending",
        semanticReview: "not_performed",
        delivery: "not_sent",
        wake: "none",
        acknowledgment: "none",
        recordTrust: "supplied_not_authenticated",
        writerLiveness: "unknown",
        ...phases[i]
      };
      const path = join(dir, `${runs[i]}.continuation.json`);
      await writeFile(path, JSON.stringify(record));
      registry.push({
        rootId: ROOT,
        nodeId: nodes[i].id,
        recordPath: budgetRecordPath(dir, runs[i]),
        continuationRecordPath: path
      });
    }
    const base = await listen(
      createChatServer(service(), {
        auth: allowAllTestAuth,
        planApiUrl: remote,
        executiveOverview: { roots },
        checkpointRecords: registry
      })
    );
    const response = await fetch(base + OVERVIEW);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.schema).toBe("executive-overview/v4");
    const byNode = new Map(
      (body.roots[0].tasks as { nodeId: string; continuation: unknown }[]).map((t) => [
        t.nodeId,
        t.continuation
      ])
    );
    expect(byNode.get(nodes[0].id)).toMatchObject({ phase: "running", attention: "none" });
    expect(byNode.get(nodes[1].id)).toMatchObject({
      phase: "needs_operator",
      attention: "needs_operator",
      checks: [{ result: "pass" }, { result: "fail" }, { result: "unavailable" }]
    });
    // The accepted task's earlier review_pending phase is settled history, not a pending review.
    expect(byNode.get(nodes[2].id)).toMatchObject({
      phase: "review_pending",
      relevance: "settled",
      attention: "none"
    });
    expect(body.continuation).toMatchObject({
      configured: 3,
      settled: 1,
      unavailable: 0,
      phases: { running: 1, needs_operator: 1, review_pending: 0 }
    });
    expect(body.continuation.items.map((i: { phase: string }) => i.phase)).toEqual([
      "needs_operator",
      "running"
    ]);
    expect(text).not.toContain(dir);
    expect(text).not.toContain("f".repeat(64));
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
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
