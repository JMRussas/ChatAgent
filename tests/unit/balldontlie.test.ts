import { describe, expect, it, vi } from "vitest";
import { BalldontlieGamesSource } from "../../src/sports/balldontlie";
import type { SourceQuery } from "../../src/sports/sources";
const query: SourceQuery = { kind: "games", team: null, now: "2026-09-30T12:00:00Z", window: { fromInclusive: "2026-09-29T12:00:00Z", toExclusive: "2026-09-30T12:00:00Z" }, limit: 10, maxAgeMs: 10000 };
const game = { id: 1, datetime: "2026-09-29T23:00:00Z", status_state: "final", home_team: { id: 1, full_name: "Test A" }, visitor_team: { id: 2, full_name: "Test B" }, home_team_score: 101, visitor_team_score: 98 };
const payload = (data: unknown[] = [game], next_cursor: number | null = null) => ({ data, meta: { next_cursor } });
const mock = (data: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(data)));
describe("BALLDONTLIE games adapter", () => {
  it("requires a key without making a request", async () => {
    const transport = mock(payload());
    expect((await new BalldontlieGamesSource(undefined, {}, transport).read(query)).limitations).toContain("API_KEY_MISSING");
    expect(transport).not.toHaveBeenCalled();
  });
  it("normalizes supported games, preserving unknown freshness and partial coverage", async () => {
    const transport = mock(payload());
    const result = await new BalldontlieGamesSource("test-secret", {}, transport).read(query);
    expect(result.records[0]).toMatchObject({ status: "final", score: { home: 101, away: 98 }, home: { provider: "balldontlie", id: "1" } });
    expect(result.source.dataAsOf).toBeNull(); expect(result.freshness).toBe("unknown");
    expect(result.coverage).toBe("partial"); expect(result.canAdvanceCheckpoint).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "test-secret" } });
  });
  it("filters exact bounds and team IDs, and exposes unsupported records and pagination", async () => {
    const transport = mock(payload([game, { ...game, id: 2, datetime: query.window.toExclusive }, { ...game, id: 3, status_state: "unknown" }], 42));
    const result = await new BalldontlieGamesSource("test", {}, transport).read({ ...query, team: { provider: "balldontlie", id: "1", name: "A" } });
    expect(result.records).toHaveLength(1);
    expect(result.limitations).toContain("UNSUPPORTED_GAME_RECORD"); expect(result.limitations).toContain("PAGINATION_NOT_EXHAUSTED");
    const url = new URL(String(transport.mock.calls[0][0])); expect(url.searchParams.get("team_ids[]")).toBe("1");
  });
  it("does not turn pregame zeros into scores or accept final games with missing scores", async () => {
    const result = await new BalldontlieGamesSource("test", {}, mock(payload([
      { ...game, status_state: "scheduled", home_team_score: 0, visitor_team_score: 0 },
      { ...game, id: 2, home_team_score: null }
    ]))).read(query);
    expect(result.records).toHaveLength(1); expect(result.records[0]).toMatchObject({ status: "scheduled", score: null });
    expect(result.limitations).toContain("FINAL_SCORE_MISSING");
  });
  it("bounds responses and translates errors without exposing provider bodies", async () => {
    for (const [status, errorCode] of [[401, "ACCESS_DENIED"], [429, "RATE_LIMITED"], [500, "UNAVAILABLE"]] as const) {
      const transport = vi.fn<typeof fetch>(async () => new Response("secret response", { status }));
      const result = await new BalldontlieGamesSource("test", {}, transport).read(query);
      expect(result.errorCode).toBe(errorCode); expect(JSON.stringify(result)).not.toContain("secret response");
    }
    const result = await new BalldontlieGamesSource("test", { maxBytes: 1024 }, mock("x".repeat(2000))).read(query);
    expect(result.limitations).toContain("RESPONSE_TOO_LARGE");
  });
  it("shares the local rate budget across reads without retries", async () => {
    const transport = mock(payload()); const source = new BalldontlieGamesSource("test", {}, transport);
    await source.read(query); expect((await source.read(query)).errorCode).toBe("RATE_LIMITED");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("honors abort and timeout", async () => {
    const transport: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const source = new BalldontlieGamesSource("test", { timeoutMs: 5 }, transport);
    expect((await source.read(query)).limitations).toContain("SOURCE_TIMEOUT");
    await expect(source.read(query, AbortSignal.abort())).rejects.toThrow();
  });
});
