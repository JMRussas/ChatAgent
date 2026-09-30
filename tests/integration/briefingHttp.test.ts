import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";
import { BriefingCoordinator, type BriefingRun } from "../../src/sports/briefingCoordinator";
import { BriefingHttp } from "../../src/sports/briefingHttp";
import { defaultNbaProfile } from "../../src/sports/briefingConfig";
import { FixtureSportsSource, type SportsSource } from "../../src/sports/sources";
import games from "../../data/sports/games.fixture.json";
const request = { now: games.capturedAt, timezone: "UTC", team: games.supportedTeams[0] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function app(enabled = true) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const signals: AbortSignal[] = [];
  const read = vi.fn<SportsSource["read"]>(async (query, signal) => {
    signals.push(signal!); await gate; return new FixtureSportsSource(games).read(query);
  });
  const profile = defaultNbaProfile(); profile.tasks.forEach(task => { task.sources = [task.sources[0]]; });
  const coordinator = new BriefingCoordinator(new Map([["games", { read }]]), { maxConcurrentTasks: 1, taskTimeoutMs: 3000, maxRuns: 2 });
  const timeline = new InMemoryConversationTimelineStore(), queue = new InMemoryTaskQueue();
  const service = new ChatService(new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline), timeline, queue);
  const server = createChatServer(service, { briefings: enabled ? new BriefingHttp(coordinator, profile) : undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    coordinator.close(); release();
  };
  cleanups.push(close);
  async function post(body: unknown, path = "/briefings") {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  }
  return { post, release, close, read, signals, coordinator, service };
}
describe("briefing HTTP integration", () => {
  it("accepts background work promptly and answers foreground chat before source completion", async () => {
    const a = await app();
    const start = await a.post({ op: "start", userId: "user", requestId: "request", request });
    expect(start.status).toBe(202);
    const run = start.body as BriefingRun;
    expect(run.tasks.map(t => t.status)).toEqual(["running", "queued"]);
    const chat = await a.post({ conversationId: "foreground", userId: "user", text: "Hello there" }, "/messages");
    expect(chat.status).toBe(200); expect(chat.body.fastResponse.provisionalReply).toContain("Quick answer:");
    const status = await a.post({ op: "status", userId: "user", runId: run.id });
    expect(status.body.tasks[0].status).toBe("running");
    const cancelled = await a.post({ op: "cancel", userId: "user", runId: run.id, taskId: run.tasks[1].id });
    expect(cancelled.body.tasks.map((t: { status: string }) => t.status)).toEqual(["running", "cancelled"]);
    a.release(); await a.coordinator.wait("user", run.id);
    const final = await a.post({ op: "status", userId: "user", runId: run.id });
    expect(final.body.tasks[0].status).toBe("complete");
    expect(final.body.tasks[0].results[0].evidence.mode).toBe("synthetic");
    expect(a.read).toHaveBeenCalledTimes(1);
  });
  it("enforces ownership, idempotency, conflict and capacity across HTTP", async () => {
    const a = await app(), body = { op: "start", userId: "user", requestId: "request", request };
    const first = await a.post(body); expect((await a.post(body)).body.id).toBe(first.body.id);
    expect(a.read).toHaveBeenCalledTimes(1);
    expect((await a.post({ ...body, request: { ...request, timezone: "America/New_York" } })).status).toBe(409);
    for (const op of ["status", "cancel"]) expect((await a.post({ op, userId: "other", runId: first.body.id })).status).toBe(404);
    expect((await a.post({ ...body, requestId: "second" })).status).toBe(202);
    expect((await a.post({ ...body, requestId: "third" })).status).toBe(429);
  });
  it("rejects malformed input, profile overrides and future checkpoints", async () => {
    const a = await app(), body = { op: "start", userId: "user", requestId: "request", request };
    expect((await a.post({ ...body, profile: defaultNbaProfile() })).status).toBe(400);
    expect((await a.post({ ...body, request: { ...request, timezone: "invalid" } })).status).toBe(400);
    expect((await a.post({ op: "cancel", userId: "user", runId: "wrong" })).status).toBe(400);
    expect((await a.post({ ...body, request: { ...request, lastSuccessful: { league: "2027-01-01T00:00:00Z" } } })).body.code).toBe("INVALID_CHECKPOINT");
    expect(a.read).not.toHaveBeenCalled();
  });
  it("disables the route without injection and rejects admission during shutdown", async () => {
    const off = await app(false);
    expect((await off.post({ op: "start" })).body.code).toBe("BRIEFINGS_DISABLED");
    const a = await app(); a.service.stopAccepting();
    expect((await a.post({ op: "start", userId: "user", requestId: "request", request })).body.code).toBe("SHUTTING_DOWN");
    expect(a.read).not.toHaveBeenCalled();
  });
  it("closes without waiting forever on a source that ignores abort and suppresses its late result", async () => {
    const a = await app();
    const start = await a.post({ op: "start", userId: "user", requestId: "request", request });
    await a.close();
    expect(a.signals[0].aborted).toBe(true);
    const run = await a.coordinator.wait("user", start.body.id);
    expect(run.tasks.every(t => t.status === "cancelled" && t.results.length === 0)).toBe(true);
  });
});
