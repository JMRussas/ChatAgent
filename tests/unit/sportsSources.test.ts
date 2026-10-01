import { describe, expect, it } from "vitest";
import games from "../../data/sports/games.fixture.json";
import news from "../../data/sports/news.fixture.json";
import availability from "../../data/sports/availability.fixture.json";
import { FixtureSportsSource, type SourceQuery } from "../../src/sports/sources";
const query: SourceQuery = {
  kind: "games",
  team: null,
  window: games.window,
  now: games.capturedAt,
  limit: 20,
  maxAgeMs: 60 * 60 * 1000
};
describe("sports source evidence", () => {
  it("returns attributable synthetic evidence for all three operations without inventing update times", async () => {
    for (const fixture of [games, news, availability]) {
      const result = await new FixtureSportsSource(fixture).read({
        ...query,
        kind: fixture.kind as SourceQuery["kind"]
      });
      expect(result.mode).toBe("synthetic");
      expect(result.records).toEqual(fixture.records);
      expect(result.records[0].provenance.updatedAt).toBeNull();
      expect(result.source.retrievedAt).toBe(fixture.capturedAt);
      expect(result.canAdvanceCheckpoint).toBe(true);
    }
  });
  it("filters by qualified team and inclusive/exclusive time bounds", async () => {
    const source = new FixtureSportsSource(news);
    expect(
      (await source.read({ ...query, kind: "news", team: games.supportedTeams[1] })).records
    ).toEqual([]);
    const result = await source.read({
      ...query,
      kind: "news",
      window: { ...query.window, toExclusive: news.records[0].publishedAt }
    });
    expect(result.records).toEqual([]);
    expect(
      (
        await source.read({
          ...query,
          kind: "news",
          window: { ...query.window, fromInclusive: news.records[0].publishedAt }
        })
      ).records
    ).toHaveLength(1);
    await expect(
      source.read({
        ...query,
        kind: "news",
        team: { ...games.supportedTeams[0], provider: "other" }
      })
    ).rejects.toThrow("SPORTS_TEAM_UNRESOLVED");
  });
  it("never refreshes old evidence merely by rereading it", async () => {
    const source = new FixtureSportsSource(games);
    const result = await source.read({ ...query, now: "2026-09-30T14:00:00Z" });
    expect(result.freshness).toBe("stale");
    expect(result.source.retrievedAt).toBe(games.capturedAt);
    expect(result.canAdvanceCheckpoint).toBe(false);
    const unknown = await new FixtureSportsSource({ ...games, dataAsOf: null }).read(query);
    expect(unknown.freshness).toBe("unknown");
    expect(unknown.canAdvanceCheckpoint).toBe(false);
  });
  it("distinguishes a covered empty result from partial and failed coverage", async () => {
    const empty = await new FixtureSportsSource({ ...games, records: [] }).read(query);
    expect(empty.coverage).toBe("complete");
    expect(empty.canAdvanceCheckpoint).toBe(true);
    const partial = await new FixtureSportsSource({
      ...games,
      records: [],
      coverage: "partial"
    }).read(query);
    expect(partial.coverage).toBe("partial");
    expect(partial.canAdvanceCheckpoint).toBe(false);
    const failed = await new FixtureSportsSource({
      ...games,
      records: [],
      coverage: "unavailable",
      errorCode: "RATE_LIMITED"
    }).read(query);
    expect(failed.coverage).toBe("unavailable");
    expect(failed.errorCode).toBe("RATE_LIMITED");
    expect(failed.canAdvanceCheckpoint).toBe(false);
  });
  it("does not advance coverage past a source's available window, result limit or data time", async () => {
    const source = new FixtureSportsSource({
      ...games,
      records: [games.records[0], { ...games.records[0], id: "game-2" }]
    });
    const limited = await source.read({ ...query, limit: 1 });
    expect(limited.records).toHaveLength(1);
    expect(limited.limitations).toContain("RESULT_LIMIT");
    expect(limited.canAdvanceCheckpoint).toBe(false);
    const wider = await source.read({
      ...query,
      window: { ...query.window, fromInclusive: "2026-09-29T00:00:00Z" }
    });
    expect(wider.limitations).toContain("WINDOW_NOT_COVERED");
    expect(wider.canAdvanceCheckpoint).toBe(false);
    const behind = await new FixtureSportsSource({
      ...games,
      dataAsOf: "2026-09-30T11:59:00Z"
    }).read(query);
    expect(behind.freshness).toBe("fresh");
    expect(behind.canAdvanceCheckpoint).toBe(false);
  });
  it("preserves live versus final scores and rejects invalid final or pregame records", async () => {
    const live = await new FixtureSportsSource({
      ...games,
      records: [{ ...games.records[0], status: "live" }]
    }).read(query);
    expect(live.records[0]).toMatchObject({ status: "live", score: { home: 101, away: 98 } });
    expect(
      () => new FixtureSportsSource({ ...games, records: [{ ...games.records[0], score: null }] })
    ).toThrow();
    expect(
      () =>
        new FixtureSportsSource({
          ...games,
          records: [{ ...games.records[0], status: "scheduled" }]
        })
    ).toThrow();
    expect(
      () => new FixtureSportsSource({ ...games, records: [...games.records, ...games.records] })
    ).toThrow();
  });
  it("rejects future capture, mismatched operations and cancelled requests without returning evidence", async () => {
    const source = new FixtureSportsSource(games);
    await expect(source.read({ ...query, now: "2026-09-30T11:00:00Z" })).rejects.toThrow(
      "SPORTS_FUTURE_CAPTURE"
    );
    await expect(source.read({ ...query, kind: "news" })).rejects.toThrow(
      "SPORTS_SOURCE_KIND_MISMATCH"
    );
    await expect(source.read(query, AbortSignal.abort())).rejects.toThrow();
  });
  it("isolates stored fixtures from consumer mutation", async () => {
    const value = structuredClone(games),
      source = new FixtureSportsSource(value);
    value.records.length = 0;
    const first = await source.read(query);
    first.records[0].provenance.sourceId = "changed";
    expect((await source.read(query)).records[0].provenance.sourceId).toBe(games.sourceId);
  });
});
