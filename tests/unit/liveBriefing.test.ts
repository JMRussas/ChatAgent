import { describe, expect, it, vi } from "vitest";
import example from "../../data/sports/nfl-live-briefing.example.json";
import { createLiveBriefing, liveBriefingConfigSchema, loadLiveBriefingFromEnv } from "../../src/sports/liveBriefing";
import type { BriefingRun } from "../../src/sports/briefingCoordinator";

const now = "2026-09-30T12:00:00Z";
const request = { now, timezone: "America/New_York", team: null };
const rss = '<rss version="2.0"><channel><item><title>Test report</title><link>https://example.invalid/story</link><pubDate>Wed, 30 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>';
const transport = () => vi.fn<typeof fetch>(async url => String(url).includes("api.balldontlie.io")
  ? new Response(JSON.stringify({ data: [], meta: { next_cursor: null } })) : new Response(rss));

describe("live briefing composition", () => {
  it("collects separate games/news evidence through HTTP commands without startup fetches", async () => {
    const read = transport(), runtime = createLiveBriefing(example, "test-secret", read, () => Date.parse(now));
    try {
      expect(read).not.toHaveBeenCalled();
      const started = runtime.http.request({ op: "start", userId: "user", requestId: "one", request });
      expect(started.status).toBe(202);
      const run = await runtime.coordinator.wait("user", (started.body as BriefingRun).id);
      expect(run.tasks.map(task => task.status)).toEqual(["partial", "partial", "needs-input"]);
      expect(run.tasks[1].results[0].evidence.records[0]).toMatchObject({ headline: "Test report", provenance: { publisher: "ESPN" } });
      expect(run.tasks.every(task => task.checkpointCandidate === null)).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(run)).not.toContain("test-secret");
      runtime.http.request({ op: "start", userId: "user", requestId: "one", request });
      expect(read).toHaveBeenCalledTimes(2);
    } finally { runtime.http.close(); }
  });
  it("keeps news available when the games key is absent", async () => {
    const read = transport(), runtime = createLiveBriefing(example, undefined, read, () => Date.parse(now));
    try {
      const started = runtime.coordinator.start("u", "r", request, runtime.profile);
      const run = await runtime.coordinator.wait("u", started.id);
      expect(run.tasks[0].results[0].evidence.limitations).toContain("API_KEY_MISSING");
      expect(run.tasks[1].results[0].evidence.records).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { runtime.http.close(); }
  });
  it("shares game admission across league/team tasks without charging RSS to that budget", async () => {
    const read = transport(), runtime = createLiveBriefing(example, "test", read, () => Date.parse(now));
    try {
      const started = runtime.coordinator.start("u", "r", { ...request, team: { provider: "balldontlie-nfl", id: "1", name: "Test" } }, runtime.profile);
      const run = await runtime.coordinator.wait("u", started.id);
      expect(read.mock.calls.filter(([url]) => String(url).includes("api.balldontlie.io"))).toHaveLength(2);
      expect(run.tasks[2].errors).toEqual([]);
      expect(run.tasks[2].status).toBe("partial");
      expect(run.tasks[1].results[0].evidence.records).toHaveLength(1);
    } finally { runtime.http.close(); }
  });
  it("rejects unsupported, duplicate, cross-league and wrongly scoped bindings before I/O", () => {
    const mutations = [
      (c: typeof example) => { c.feeds.push(c.feeds[0]); },
      (c: typeof example) => { c.feeds[0].id = "nfl-games"; },
      (c: typeof example) => { c.feeds[0].league = "NBA"; },
      (c: typeof example) => { c.profile.tasks[1].scope = "team"; },
      (c: typeof example) => { c.profile.tasks[1].sources[0].adapterId = "unknown"; },
      (c: typeof example) => { c.profile.tasks[0].sources[0].kind = "availability"; },
      (c: typeof example) => { c.profile.maxCatchupHours = 1000; },
      (c: typeof example) => { c.games.requestsPerMinute = 6; }
    ];
    for (const mutate of mutations) {
      const config = structuredClone(example); mutate(config);
      expect(liveBriefingConfigSchema.safeParse(config).success).toBe(false);
    }
  });
  it("loads only explicit configuration and reports safe startup errors", async () => {
    expect(await loadLiveBriefingFromEnv({})).toBeUndefined();
    await expect(loadLiveBriefingFromEnv({ SPORTS_BRIEFING_CONFIG_PATH: "missing-secret-path" })).rejects.toThrow("SPORTS_BRIEFING_CONFIG_INVALID: check the configured live briefing file");
    const http = await loadLiveBriefingFromEnv({ SPORTS_BRIEFING_CONFIG_PATH: "data/sports/nfl-live-briefing.example.json" });
    expect(http).toBeDefined(); http!.close();
    expect(http!.request({ op: "start", userId: "u", requestId: "r", request }).status).toBe(503);
  });
  it("cancels both active transports when the runtime closes", async () => {
    const signals: AbortSignal[] = [];
    const read: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      signals.push(init!.signal!);
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const runtime = createLiveBriefing(example, "test", read, () => Date.parse(now));
    try {
      const started = runtime.coordinator.start("u", "r", request, runtime.profile);
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      runtime.http.close();
      const run = await runtime.coordinator.wait("u", started.id);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(run.tasks.slice(0, 2).every(task => task.status === "cancelled")).toBe(true);
    } finally { runtime.http.close(); }
  });
});
