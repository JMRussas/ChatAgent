import { describe, expect, it, vi } from "vitest";
import { BalldontlieGamesSource } from "../../src/sports/balldontlie";
import { FixtureSportsSource, type SourceQuery } from "../../src/sports/sources";
import { planBriefing } from "../../src/sports/briefingPlan";
import profile from "../../data/sports/nfl-games-profile.example.json";
import nbaFixture from "../../data/sports/games.fixture.json";
const query: SourceQuery = {
  league: "NFL",
  kind: "games",
  team: null,
  now: "2026-09-30T12:00:00Z",
  window: { fromInclusive: "2026-09-23T12:00:00Z", toExclusive: "2026-09-30T12:00:00Z" },
  limit: 50,
  maxAgeMs: 900000
};
const game = {
  id: 100,
  date: "2026-09-27T17:00:00Z",
  status_state: "final",
  home_team: { id: 1, full_name: "Fictional Home" },
  visitor_team: { id: 2, full_name: "Fictional Away" },
  home_team_score: 21,
  visitor_team_score: 14
};
describe("NFL-specific source support", () => {
  it("uses NFL endpoint, dates filters, date field and namespaced teams", async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: [game], meta: { next_cursor: null } }))
    );
    const source = new BalldontlieGamesSource("test", { league: "NFL" }, transport);
    const result = await source.read({
      ...query,
      team: { provider: "balldontlie-nfl", id: "1", name: "Home" }
    });
    const url = new URL(String(transport.mock.calls[0][0]));
    expect(url.pathname).toBe("/nfl/v1/games");
    expect(url.searchParams.has("start_date")).toBe(false);
    expect(url.searchParams.getAll("dates[]")).toContain("2026-09-27");
    expect(result.records[0]).toMatchObject({
      startsAt: "2026-09-27T17:00:00.000Z",
      score: { home: 21, away: 14 },
      home: { provider: "balldontlie-nfl" }
    });
    expect(result.source.id).toBe("balldontlie-nfl-games");
    expect(result.coverage).toBe("partial");
    expect(result.canAdvanceCheckpoint).toBe(false);
  });
  it("rejects cross-league requests and colliding team identities before fetching", async () => {
    const transport = vi.fn<typeof fetch>();
    const source = new BalldontlieGamesSource("test", { league: "NFL" }, transport);
    await expect(source.read({ ...query, league: "NBA" })).rejects.toThrow(
      "SPORTS_LEAGUE_MISMATCH"
    );
    await expect(
      source.read({ ...query, team: { provider: "balldontlie", id: "1", name: "NBA team" } })
    ).rejects.toThrow("SPORTS_TEAM_UNRESOLVED");
    await expect(new FixtureSportsSource(nbaFixture).read(query)).rejects.toThrow(
      "SPORTS_LEAGUE_MISMATCH"
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("plans NFL windows and NFL clarification from the games-only profile", () => {
    const plan = planBriefing({ now: query.now, timezone: "UTC" }, profile);
    expect(plan.league).toBe("NFL");
    expect(plan.questions[0]).toContain("NFL");
    expect(plan.tasks[0].window.fromInclusive).toBe("2026-09-23T12:00:00.000Z");
    expect(plan.tasks[1].state).toBe("needs-input");
  });
});
