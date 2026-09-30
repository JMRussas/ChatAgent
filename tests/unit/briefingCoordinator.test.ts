import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefingCoordinator } from "../../src/sports/briefingCoordinator";
import { defaultNbaProfile } from "../../src/sports/briefingConfig";
import { FixtureSportsSource, type SportsSource, type SourceResult } from "../../src/sports/sources";
import games from "../../data/sports/games.fixture.json";
import news from "../../data/sports/news.fixture.json";
import availability from "../../data/sports/availability.fixture.json";
const request = { now: games.capturedAt, timezone: "UTC", team: games.supportedTeams[0] };
const registry = () => new Map<string, SportsSource>([
  ["games", new FixtureSportsSource(games)], ["news", new FixtureSportsSource(news)],
  ["availability", new FixtureSportsSource(availability)]
]);
function gate() {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const fixture = new FixtureSportsSource(games);
  const read = vi.fn(async (q: Parameters<SportsSource["read"]>[0]) => { await barrier; return fixture.read(q); });
  return { release, adapter: { read } };
}
const coordinators: BriefingCoordinator[] = [];
function coordinator(sources = registry(), options = {}) {
  const instance = new BriefingCoordinator(sources, options); coordinators.push(instance); return instance;
}
afterEach(() => { for (const c of coordinators.splice(0)) c.close(); vi.useRealTimers(); });
describe("briefing coordinator", () => {
  it("publishes one task while another is held and preserves source attribution", async () => {
    const held = gate(), sources = registry(); sources.set("held", held.adapter);
    const profile = defaultNbaProfile(); profile.tasks[0].sources = [{ ...profile.tasks[0].sources[0], adapterId: "held" }];
    const c = coordinator(sources), run = c.start("user", "request", request, profile);
    await vi.waitFor(() => expect(c.snapshot("user", run.id).tasks[1].status).toBe("complete"));
    expect(c.snapshot("user", run.id).tasks[0].status).toBe("running");
    held.release(); const final = await c.wait("user", run.id);
    expect(final.tasks.map(t => t.status)).toEqual(["complete", "complete"]);
    expect(final.tasks[0].results[0].adapterId).toBe("held");
    expect(final.tasks[0].checkpointCandidate).toBe("2026-09-30T12:00:00.000Z");
  });
  it("deduplicates identical starts, rejects conflicting reuse and isolates users", async () => {
    const c = coordinator(), profile = defaultNbaProfile();
    const first = c.start("a", "request", request, profile);
    expect(c.start("a", "request", request, profile).id).toBe(first.id);
    expect(() => c.start("a", "request", { ...request, timezone: "America/New_York" }, profile)).toThrow("BRIEFING_REQUEST_CONFLICT");
    expect(c.start("b", "request", request, profile).id).not.toBe(first.id);
    expect(() => c.cancel("b", first.id)).toThrow("BRIEFING_NOT_FOUND");
    const final = await c.wait("a", first.id); final.tasks[0].results.length = 0;
    expect(c.snapshot("a", first.id).tasks[0].results.length).toBeGreaterThan(0);
  });
  it("cancels a queued task without cancelling the running task", async () => {
    const held = gate(), sources = registry(); sources.set("games", held.adapter);
    const c = coordinator(sources, { maxConcurrentTasks: 1 });
    const run = c.start("user", "request", request, defaultNbaProfile());
    expect(run.tasks.map(t => t.status)).toEqual(["running", "queued"]);
    c.cancel("user", run.id, run.tasks[1].id);
    expect(c.snapshot("user", run.id).tasks[0].status).toBe("running");
    held.release(); const final = await c.wait("user", run.id);
    expect(final.tasks.map(t => t.status)).toEqual(["complete", "cancelled"]);
    expect(held.adapter.read).toHaveBeenCalledTimes(1);
  });
  it("bounds deadline waiting even when an adapter ignores abort, without freeing its physical slot", async () => {
    vi.useFakeTimers();
    const held = gate(), sources = registry(); sources.set("games", held.adapter);
    const c = coordinator(sources, { maxConcurrentTasks: 1, taskTimeoutMs: 50 });
    const run = c.start("user", "request", request, defaultNbaProfile());
    await vi.advanceTimersByTimeAsync(51);
    expect((await c.wait("user", run.id)).tasks.map(t => t.status)).toEqual(["deadline", "deadline"]);
    const next = c.start("user", "next", request, defaultNbaProfile());
    expect(next.tasks[0].status).toBe("queued");
    expect(held.adapter.read).toHaveBeenCalledTimes(1);
    held.release(); await vi.advanceTimersByTimeAsync(1);
    expect(c.snapshot("user", run.id).tasks[0].results).toEqual([]);
    expect((await c.wait("user", next.id)).tasks.every(t => t.status === "complete")).toBe(true);
  });
  it("retains partial and failed outcomes and never advances their checkpoints", async () => {
    const sources = registry(); sources.set("news", { read: async () => { throw new Error("private provider detail"); } });
    sources.set("availability", new FixtureSportsSource({ ...availability, coverage: "unavailable", records: [], errorCode: "ACCESS_DENIED" }));
    const c = coordinator(sources), run = c.start("user", "request", request, defaultNbaProfile());
    const final = await c.wait("user", run.id);
    expect(final.tasks.every(t => t.status === "partial" && t.checkpointCandidate === null)).toBe(true);
    expect(JSON.stringify(final)).not.toContain("private provider detail");
    const profile = defaultNbaProfile(); profile.tasks = [profile.tasks[0]]; profile.tasks[0].sources = [profile.tasks[0].sources[1]];
    const failed = await c.wait("user", c.start("user", "failed", request, profile).id);
    expect(failed.tasks[0].status).toBe("failed");
  });
  it("leaves unknown team awaiting input, validates bindings and enforces capacity/close", async () => {
    const c = coordinator(registry(), { maxRuns: 1 });
    const run = c.start("user", "request", { ...request, team: null }, defaultNbaProfile());
    expect((await c.wait("user", run.id)).tasks[1].status).toBe("needs-input");
    expect(() => c.start("user", "new", request, defaultNbaProfile())).toThrow("BRIEFING_CAPACITY");
    expect(() => coordinator(new Map()).start("user", "request", request, defaultNbaProfile())).toThrow("SPORTS_ADAPTER_MISSING");
    c.close(); expect(() => c.start("user", "request", request, defaultNbaProfile())).toThrow("BRIEFING_CLOSED");
  });
  it("discards late results after cancellation and rejects mismatched result queries", async () => {
    const held = gate(), sources = registry(); sources.set("games", held.adapter);
    const profile = defaultNbaProfile(); profile.tasks = [profile.tasks[0]];
    const c = coordinator(sources), run = c.start("user", "request", request, profile);
    c.cancel("user", run.id); expect((await c.wait("user", run.id)).tasks[0].status).toBe("cancelled");
    held.release(); await Promise.resolve(); await Promise.resolve();
    expect(c.snapshot("user", run.id).tasks[0].results).toEqual([]);
    const wrong = registry(); wrong.set("games", { read: async q => {
      const result: SourceResult = await new FixtureSportsSource(games).read(q); result.query.limit = 1; return result;
    } });
    const other = coordinator(wrong); const result = await other.wait("user", other.start("user", "request", request, profile).id);
    expect(result.tasks[0].status).toBe("partial");
    expect(result.tasks[0].errors).toEqual([{ adapterId: "games", code: "SOURCE_READ_FAILED" }]);
  });
});
