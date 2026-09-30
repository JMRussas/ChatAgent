import { z } from "zod";
import { sourceQuerySchema, sportsRecordSchema, type SourceQuery, type SourceResult, type SportsSource } from "./sources";
const endpoints = { NBA: "https://api.balldontlie.io/v1/games", NFL: "https://api.balldontlie.io/nfl/v1/games" };
const team = z.object({ id: z.number().int().positive(), full_name: z.string().trim().min(1).max(200) });
const game = z.object({ id: z.number().int().positive(), datetime: z.string().datetime({ offset: true }),
  status_state: z.enum(["scheduled", "in_progress", "final", "postponed", "canceled"]),
  home_team: team, visitor_team: team,
  home_team_score: z.number().int().nonnegative().nullable(), visitor_team_score: z.number().int().nonnegative().nullable()
});
const nflGame = game.omit({ datetime: true }).extend({ date: z.string().datetime({ offset: true }) })
  .transform(({ date, ...rest }) => ({ ...rest, datetime: date }));
const pageSchema = z.object({ data: z.array(z.unknown()).max(100), meta: z.object({ next_cursor: z.number().int().nonnegative().nullable().optional() }) });
const settings = z.object({ league: z.enum(["NBA", "NFL"]).default("NBA"), timeoutMs: z.number().int().min(1).max(30000).default(10000),
  maxBytes: z.number().int().min(1024).max(2000000).default(1000000),
  minRequestIntervalMs: z.number().int().min(0).max(60000).default(12000)
}).strict();

/** One page per read, no automatic retries. Share one instance across league/team tasks. */
export class BalldontlieGamesSource implements SportsSource {
  private readonly config: z.infer<typeof settings>;
  private readonly key: string;
  private nextRequestAt = 0;
  constructor(apiKey: string | undefined, config: z.input<typeof settings> = {},
    private readonly transport: typeof fetch = fetch, private readonly clock: () => number = Date.now) {
    this.key = (apiKey ?? "").trim(); this.config = settings.parse(config);
  }
  async read(input: SourceQuery, signal?: AbortSignal): Promise<SourceResult> {
    signal?.throwIfAborted();
    const query = sourceQuerySchema.parse(input);
    const league = this.config.league, endpoint = endpoints[league];
    const teamProvider = league === "NFL" ? "balldontlie-nfl" : "balldontlie";
    if ((query.league ?? "NBA") !== league) throw new Error("SPORTS_LEAGUE_MISMATCH");
    if (query.kind !== "games") throw new Error("SPORTS_SOURCE_KIND_MISMATCH");
    if (query.team && (query.team.provider !== teamProvider || !/^[1-9][0-9]*$/.test(query.team.id))) throw new Error("SPORTS_TEAM_UNRESOLVED");
    const start = Date.parse(query.window.fromInclusive), end = Date.parse(query.window.toExclusive);
    if (end - start > 31 * 86400000) throw new Error("SPORTS_WINDOW_TOO_LARGE");
    const result: SourceResult = { schemaVersion: "chatagent-sports-source-result-v1", mode: "live", query,
      source: { id: "balldontlie-" + league.toLowerCase() + "-games", url: endpoint, retrievedAt: new Date(this.clock()).toISOString(), dataAsOf: null },
      coverage: "unavailable", freshness: "unknown", limitations: ["UNKNOWN_FRESHNESS"],
      errorCode: null, records: [], canAdvanceCheckpoint: false };
    const fail = (code: NonNullable<SourceResult["errorCode"]>, reason: string) => {
      result.errorCode = code; result.limitations.push(reason); return result;
    };
    if (!this.key) return fail("ACCESS_DENIED", "API_KEY_MISSING");
    if (this.clock() < this.nextRequestAt) return fail("RATE_LIMITED", "LOCAL_RATE_LIMIT");
    this.nextRequestAt = this.clock() + this.config.minRequestIntervalMs;
    const url = new URL(endpoint);
    // Provider filters calendar dates; overfetch a day on each side, then apply exact UTC bounds.
    if (league === "NFL") {
      // NFL documents dates[], not NBA's start_date/end_date filters.
      const firstDay = Math.floor(start / 86400000) * 86400000 - 86400000;
      const lastDay = Math.floor(end / 86400000) * 86400000 + 86400000;
      for (let day = firstDay; day <= lastDay; day += 86400000)
        url.searchParams.append("dates[]", new Date(day).toISOString().slice(0, 10));
    } else {
      url.searchParams.set("start_date", new Date(start - 86400000).toISOString().slice(0, 10));
      url.searchParams.set("end_date", new Date(end + 86400000).toISOString().slice(0, 10));
    }
    url.searchParams.set("per_page", "100");
    if (query.team) url.searchParams.append("team_ids[]", query.team.id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.config.timeoutMs);
    try {
      const response = await this.transport(url, { headers: { Authorization: this.key }, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        return fail(response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "ACCESS_DENIED" : "UNAVAILABLE", "HTTP_" + response.status);
      }
      if (!response.body) return fail("UNAVAILABLE", "EMPTY_RESPONSE");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > this.config.maxBytes) { await reader.cancel(); return fail("UNAVAILABLE", "RESPONSE_TOO_LARGE"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const page = pageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const ids = new Set<string>();
      // The unfiltered endpoint excludes preseason according to the provider contract.
      result.coverage = "partial"; result.limitations.push("PRESEASON_NOT_INCLUDED");
      if (page.meta.next_cursor != null) result.limitations.push("PAGINATION_NOT_EXHAUSTED");
      for (const item of page.data) {
        const parsed = (league === "NFL" ? nflGame : game).safeParse(item);
        if (!parsed.success) { result.limitations.push("UNSUPPORTED_GAME_RECORD"); continue; }
        const g = parsed.data, time = Date.parse(g.datetime);
        if (time < start || time >= end) continue;
        if (query.team && ![g.home_team.id, g.visitor_team.id].some(id => String(id) === query.team!.id)) continue;
        if (g.home_team.id === g.visitor_team.id || ids.has(String(g.id))) { result.limitations.push("INVALID_GAME_IDENTITY"); continue; }
        ids.add(String(g.id));
        const status = g.status_state === "in_progress" ? "live" : g.status_state === "canceled" ? "cancelled" : g.status_state;
        const score = ["live", "final"].includes(status) && g.home_team_score !== null && g.visitor_team_score !== null
          ? { home: g.home_team_score, away: g.visitor_team_score } : null;
        if (status === "final" && !score) { result.limitations.push("FINAL_SCORE_MISSING"); continue; }
        result.records.push(sportsRecordSchema.parse({ kind: "games", id: String(g.id), startsAt: new Date(time).toISOString(), status, score,
          home: { provider: teamProvider, id: String(g.home_team.id), name: g.home_team.full_name },
          away: { provider: teamProvider, id: String(g.visitor_team.id), name: g.visitor_team.full_name },
          provenance: { sourceId: result.source.id, url: endpoint + "/" + g.id, updatedAt: null } }));
      }
      result.records.sort((a, b) => (b.kind === "games" ? b.startsAt : "").localeCompare(a.kind === "games" ? a.startsAt : ""));
      if (result.records.length > query.limit) result.limitations.push("RESULT_LIMIT");
      result.records = result.records.slice(0, query.limit);
      result.limitations = [...new Set(result.limitations)];
      result.source.retrievedAt = new Date(this.clock()).toISOString();
      return result;
    } catch {
      signal?.throwIfAborted();
      return fail("UNAVAILABLE", controller.signal.aborted ? "SOURCE_TIMEOUT" : "INVALID_OR_UNAVAILABLE_RESPONSE");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
