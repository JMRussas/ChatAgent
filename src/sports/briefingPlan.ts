import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const checkpoint = timestamp.nullable().default(null);
const requestSchema = z.object({
  now: timestamp,
  timezone: z.string().min(1).refine(value => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
    catch { return false; }
  }, "Invalid timezone"),
  // Provider-qualified identity; display names or ambiguous aliases are not IDs.
  team: z.object({ provider: z.string().trim().min(1), id: z.string().trim().min(1), name: z.string().trim().min(1) }).strict().nullable().default(null),
  lastSuccessful: z.object({ league: checkpoint, team: checkpoint }).strict().default({ league: null, team: null })
}).strict();

export type BriefingRequest = z.input<typeof requestSchema>;
const HOUR = 60 * 60 * 1000;

/** Planning only: no fetching, model calls, persisted preferences, or success writes. */
export function planNbaBriefing(input: BriefingRequest) {
  const request = requestSchema.parse(input);
  const now = Date.parse(request.now);
  for (const value of Object.values(request.lastSuccessful)) {
    if (value !== null && Date.parse(value) > now) throw new Error("Briefing checkpoint is in the future");
  }
  const windowFor = (lastSuccessful: string | null) => {
    const requestedStart = lastSuccessful === null ? now - 24 * HOUR : Date.parse(lastSuccessful);
    const start = Math.max(requestedStart, now - 7 * 24 * HOUR);
    return {
      fromInclusive: new Date(start).toISOString(), toExclusive: new Date(now).toISOString(),
      basis: lastSuccessful === null ? "initial-24-hours" as const : "since-last-success" as const,
      truncated: start !== requestedStart
    };
  };
  return {
    schemaVersion: "chatagent-nba-briefing-plan-v1" as const,
    league: "NBA" as const, plannedAt: new Date(now).toISOString(), timezone: request.timezone,
    execution: "not-started" as const,
    tasks: [
      { id: "league-briefing", scope: "league" as const, title: "NBA briefing", state: "ready" as const,
        team: null, window: windowFor(request.lastSuccessful.league),
        requiredSources: ["games", "news"] },
      { id: "team-briefing", scope: "team" as const, title: request.team ? request.team.name + " briefing" : "Choose your NBA team",
        state: request.team ? "ready" as const : "needs-input" as const,
        team: request.team, window: windowFor(request.lastSuccessful.team),
        requiredSources: ["games", "news", "availability"] }
    ],
    questions: request.team ? [] : ["Which NBA team should your briefing focus on?"]
  };
}
