import { describe, expect, it, vi } from "vitest";
import { SharedSportsSource, SportsRequestBudget, createBalldontlieSources } from "../../src/sports/sharedSources";
import { FixtureSportsSource, type SourceQuery, type SportsSource } from "../../src/sports/sources";
import games from "../../data/sports/games.fixture.json";
const query: SourceQuery = { kind: "games", team: null, now: games.capturedAt, window: games.window, limit: 10, maxAgeMs: 1000 };
describe("shared sports admission and cache", () => {
  it("allows five simultaneous starts, rejects the sixth, and expires reservations individually", () => {
    let now = 0;
    const budget = new SportsRequestBudget(5, 0, () => now);
    expect(budget.reserve()).toBe(true);
    now = 10000;
    for (let i = 0; i < 4; i++) expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false);
    now = 59999; expect(budget.reserve()).toBe(false);
    now = 60000; expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false);
    now = 70000;
    for (let i = 0; i < 4; i++) expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false);
  });
  it("enforces spacing and the rolling minute across source instances", async () => {
    let now = Date.parse(games.capturedAt);
    const clock = () => now, budget = new SportsRequestBudget(5, 12000, clock);
    const first = new SharedSportsSource(new FixtureSportsSource(games), budget, { cacheTtlMs: 0 }, clock);
    const second = new SharedSportsSource(new FixtureSportsSource(games), budget, { cacheTtlMs: 0 }, clock);
    await first.read(query); await expect(second.read(query)).rejects.toThrow("SPORTS_SHARED_RATE_LIMIT");
    for (let i = 0; i < 4; i++) { now += 12000; await second.read(query); }
    now += 11999; await expect(first.read(query)).rejects.toThrow("SPORTS_SHARED_RATE_LIMIT");
    now++; await first.read(query);
  });
  it("reuses evidence without refreshing timestamps or leaking consumer mutation", async () => {
    let now = Date.parse(games.capturedAt);
    const fixture = new FixtureSportsSource(games), read = vi.fn<SportsSource["read"]>((q, s) => fixture.read(q, s));
    const source = new SharedSportsSource({ read }, new SportsRequestBudget(5, 12000, () => now), {}, () => now);
    const first = await source.read(query); first.records.length = 0; now += 2000;
    const next = await source.read({ ...query, now: new Date(now).toISOString() });
    expect(read).toHaveBeenCalledTimes(1); expect(next.records).toHaveLength(1);
    expect(next.source.retrievedAt).toBe(games.capturedAt); expect(next.freshness).toBe("stale");
    expect(next.canAdvanceCheckpoint).toBe(false);
    now += 14000; await source.read(query); expect(read).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent identical reads while one caller can cancel independently", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let observed: AbortSignal | undefined;
    const read = vi.fn<SportsSource["read"]>(async (q, s) => { observed = s; await gate; return new FixtureSportsSource(games).read(q); });
    const source = new SharedSportsSource({ read }, new SportsRequestBudget());
    const controller = new AbortController(); const first = source.read(query, controller.signal);
    const rejected = expect(first).rejects.toThrow(); const second = source.read(query);
    await Promise.resolve(); controller.abort(); await rejected;
    expect(observed?.aborted).toBe(false); release(); expect((await second).records).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("aborts on last waiter cancellation and bounds noncooperative pending reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let observed: AbortSignal | undefined;
    const read: SportsSource["read"] = async (q, s) => { observed = s; await gate; return new FixtureSportsSource(games).read(q); };
    const source = new SharedSportsSource({ read }, new SportsRequestBudget(), { maxPendingReads: 1 });
    const controller = new AbortController(), first = source.read(query, controller.signal);
    const rejected = expect(first).rejects.toThrow(); await Promise.resolve(); controller.abort(); await rejected;
    expect(observed?.aborted).toBe(true);
    await expect(source.read({ ...query, limit: 1 })).rejects.toThrow("SPORTS_PENDING_CAPACITY");
    release();
  });
  it("does not cache failures and applies provider rate-limit cooldown across sources", async () => {
    let now = Date.parse(games.capturedAt); const clock = () => now, budget = new SportsRequestBudget(5, 12000, clock);
    const fail = new FixtureSportsSource({ ...games, records: [], coverage: "unavailable", errorCode: "RATE_LIMITED" });
    const first = new SharedSportsSource(fail, budget, {}, clock);
    await first.read(query); now += 12000;
    const second = new SharedSportsSource(new FixtureSportsSource(games), budget, {}, clock);
    await expect(second.read(query)).rejects.toThrow("SPORTS_SHARED_RATE_LIMIT");
    now += 48001; expect((await second.read(query)).errorCode).toBeNull();
  });
  it("factory shares NBA/NFL admission and isolates cache scopes", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [], meta: { next_cursor: null } })));
    const registry = createBalldontlieSources("test-key", {}, transport);
    await registry.get("nba-games")!.read(query);
    await registry.get("nfl-games")!.read({ ...query, league: "NFL" });
    await registry.get("nba-games")!.read({ ...query, team: { provider: "balldontlie", id: "1", name: "Test team" } });
    await registry.get("nba-games")!.read({ ...query, limit: 11 });
    await registry.get("nfl-games")!.read({ ...query, league: "NFL", limit: 12 });
    await expect(registry.get("nba-games")!.read({ ...query, limit: 13 })).rejects.toThrow("SPORTS_SHARED_RATE_LIMIT");
    // Exact cache hits still work when new network requests are exhausted.
    await registry.get("nba-games")!.read(query);
    expect(transport).toHaveBeenCalledTimes(5);
  });
});
