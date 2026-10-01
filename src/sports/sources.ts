import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const id = z.string().trim().min(1).max(200);
const url = z
  .string()
  .url()
  .refine(
    (value) => ["https:", "http:"].includes(new URL(value).protocol),
    "Expected HTTP source URL"
  );
export const teamIdentitySchema = z
  .object({ provider: id, id, name: z.string().trim().min(1).max(200) })
  .strict();
const windowSchema = z
  .object({ fromInclusive: timestamp, toExclusive: timestamp })
  .strict()
  .refine((w) => Date.parse(w.fromInclusive) <= Date.parse(w.toExclusive), "Reversed window");
export const sourceQuerySchema = z
  .object({
    league: z.enum(["NBA", "NFL"]).optional(),
    kind: z.enum(["games", "news", "availability"]),
    team: teamIdentitySchema.nullable(),
    window: windowSchema,
    now: timestamp,
    limit: z.number().int().min(1).max(100),
    maxAgeMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60 * 1000)
  })
  .strict();
const provenance = z
  .object({
    sourceId: id,
    publisher: z.string().trim().min(1).max(200).optional(),
    url,
    updatedAt: timestamp.nullable()
  })
  .strict();
const common = { id, provenance };
export const sportsRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("games"),
      startsAt: timestamp,
      home: teamIdentitySchema,
      away: teamIdentitySchema,
      status: z.enum(["scheduled", "live", "final", "postponed", "cancelled"]),
      score: z
        .object({ home: z.number().int().nonnegative(), away: z.number().int().nonnegative() })
        .strict()
        .nullable()
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("news"),
      publishedAt: timestamp,
      teams: z.array(teamIdentitySchema).max(30),
      headline: z.string().trim().min(1).max(500),
      summary: z.string().trim().max(4000)
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("availability"),
      reportedAt: timestamp,
      team: teamIdentitySchema,
      playerId: id,
      playerName: id,
      status: z.enum(["available", "out", "doubtful", "questionable", "probable", "unknown"]),
      detail: z.string().max(2000)
    })
    .strict()
]);
export type SportsRecord = z.infer<typeof sportsRecordSchema>;
export type SourceQuery = z.infer<typeof sourceQuerySchema>;
export const fixtureSourceSchema = z
  .object({
    schemaVersion: z.literal("chatagent-sports-fixture-v1"),
    mode: z.literal("synthetic"),
    sourceId: id,
    sourceUrl: url,
    kind: z.enum(["games", "news", "availability"]),
    supportedTeams: z.array(teamIdentitySchema).min(1).max(100),
    capturedAt: timestamp,
    dataAsOf: timestamp.nullable(),
    window: windowSchema,
    coverage: z.enum(["complete", "partial", "unavailable"]),
    errorCode: z.enum(["UNAVAILABLE", "RATE_LIMITED", "ACCESS_DENIED"]).nullable(),
    records: z.array(sportsRecordSchema).max(1000)
  })
  .strict()
  .superRefine((feed, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (feed.dataAsOf && Date.parse(feed.dataAsOf) > Date.parse(feed.capturedAt))
      bad("Data timestamp exceeds capture");
    if (feed.coverage === "unavailable" && (feed.records.length || !feed.errorCode))
      bad("Unavailable source requires an error and no records");
    if (feed.coverage !== "unavailable" && feed.errorCode)
      bad("Available source cannot have a transport error");
    if (new Set(feed.records.map((r) => r.id)).size !== feed.records.length)
      bad("Duplicate record identity");
    for (const record of feed.records) {
      const teams =
        record.kind === "games"
          ? [record.home, record.away]
          : record.kind === "news"
            ? record.teams
            : [record.team];
      if (teams.some((team) => !feed.supportedTeams.some((known) => sameTeam(known, team))))
        bad("Unknown record team");
      const time = recordTime(record);
      if (
        time < Date.parse(feed.window.fromInclusive) ||
        time >= Date.parse(feed.window.toExclusive)
      )
        bad("Record outside declared window");
      if (record.kind !== "games" && time > Date.parse(feed.capturedAt))
        bad("Publication after capture");
      if (record.kind !== feed.kind || record.provenance.sourceId !== feed.sourceId)
        bad("Record source/kind mismatch");
      if (
        record.provenance.updatedAt &&
        Date.parse(record.provenance.updatedAt) > Date.parse(feed.capturedAt)
      )
        bad("Future source update");
      if (record.kind === "games") {
        if (sameTeam(record.home, record.away)) bad("Game requires different teams");
        if (record.status === "final" && !record.score) bad("Final game requires score");
        if (["scheduled", "postponed", "cancelled"].includes(record.status) && record.score)
          bad("Non-playing game cannot carry a score");
      }
    }
  });
export type FixtureSource = z.infer<typeof fixtureSourceSchema>;
export interface SourceResult {
  schemaVersion: "chatagent-sports-source-result-v1";
  mode: "synthetic" | "live";
  query: SourceQuery;
  source: { id: string; url: string; retrievedAt: string; dataAsOf: string | null };
  freshness: "fresh" | "stale" | "unknown";
  coverage: "complete" | "partial" | "unavailable";
  limitations: string[];
  errorCode: FixtureSource["errorCode"];
  records: SportsRecord[];
  // Complete means this configured source/query only, never all news in the world.
  canAdvanceCheckpoint: boolean;
}
export interface SportsSource {
  read(query: SourceQuery, signal?: AbortSignal): Promise<SourceResult>;
}
function sameTeam(a: z.infer<typeof teamIdentitySchema>, b: z.infer<typeof teamIdentitySchema>) {
  return a.provider === b.provider && a.id === b.id;
}
function recordTime(record: SportsRecord) {
  return Date.parse(
    record.kind === "games"
      ? record.startsAt
      : record.kind === "news"
        ? record.publishedAt
        : record.reportedAt
  );
}

/** Offline adapter. Re-reading a fixture never refreshes its evidence timestamps. */
export class FixtureSportsSource implements SportsSource {
  private readonly feed: FixtureSource;
  constructor(value: unknown) {
    this.feed = fixtureSourceSchema.parse(value);
  }
  async read(input: SourceQuery, signal?: AbortSignal): Promise<SourceResult> {
    signal?.throwIfAborted();
    const query = sourceQuerySchema.parse(input),
      feed = this.feed;
    if ((query.league ?? "NBA") !== "NBA") throw new Error("SPORTS_LEAGUE_MISMATCH");
    if (query.kind !== feed.kind) throw new Error("SPORTS_SOURCE_KIND_MISMATCH");
    if (query.team && !feed.supportedTeams.some((team) => sameTeam(team, query.team!)))
      throw new Error("SPORTS_TEAM_UNRESOLVED");
    const now = Date.parse(query.now),
      captured = Date.parse(feed.capturedAt);
    if (captured > now) throw new Error("SPORTS_FUTURE_CAPTURE");
    const freshness =
      feed.dataAsOf === null
        ? "unknown"
        : now - Date.parse(feed.dataAsOf) > query.maxAgeMs
          ? "stale"
          : "fresh";
    const start = Date.parse(query.window.fromInclusive),
      end = Date.parse(query.window.toExclusive);
    const matches = feed.records.filter((record) => {
      const time = recordTime(record);
      const teams =
        record.kind === "games"
          ? [record.home, record.away]
          : record.kind === "news"
            ? record.teams
            : [record.team];
      return (
        time >= start &&
        time < end &&
        (!query.team || teams.some((team) => sameTeam(team, query.team!)))
      );
    });
    const limitations: string[] = [];
    if (feed.coverage === "partial") limitations.push("SOURCE_PARTIAL");
    if (start < Date.parse(feed.window.fromInclusive) || end > Date.parse(feed.window.toExclusive))
      limitations.push("WINDOW_NOT_COVERED");
    if (matches.length > query.limit) limitations.push("RESULT_LIMIT");
    if (freshness !== "fresh")
      limitations.push(freshness === "stale" ? "STALE_EVIDENCE" : "UNKNOWN_FRESHNESS");
    const coverage =
      feed.coverage === "unavailable"
        ? "unavailable"
        : limitations.some((v) =>
              ["SOURCE_PARTIAL", "WINDOW_NOT_COVERED", "RESULT_LIMIT"].includes(v)
            )
          ? "partial"
          : "complete";
    return {
      schemaVersion: "chatagent-sports-source-result-v1",
      mode: "synthetic",
      query,
      source: {
        id: feed.sourceId,
        url: feed.sourceUrl,
        retrievedAt: feed.capturedAt,
        dataAsOf: feed.dataAsOf
      },
      freshness,
      coverage,
      limitations,
      errorCode: feed.errorCode,
      records: structuredClone(
        matches
          .sort((a, b) => recordTime(b) - recordTime(a) || a.id.localeCompare(b.id))
          .slice(0, query.limit)
      ),
      canAdvanceCheckpoint:
        coverage === "complete" && freshness === "fresh" && end <= Date.parse(feed.dataAsOf!)
    };
  }
}
