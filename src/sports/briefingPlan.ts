import { z } from "zod";
import { briefingProfileSchema, defaultNbaProfile } from "./briefingConfig";
import { createHash } from "node:crypto";

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
export function planBriefing(input: BriefingRequest, configuration: unknown) {
  const profile = briefingProfileSchema.parse(configuration);
  const request = requestSchema.parse(input);
  const now = Date.parse(request.now);
  for (const value of Object.values(request.lastSuccessful)) {
    if (value !== null && Date.parse(value) > now) throw new Error("Briefing checkpoint is in the future");
  }
  const windowFor = (lastSuccessful: string | null) => {
    const requestedStart = lastSuccessful === null ? now - profile.initialLookbackHours * HOUR : Date.parse(lastSuccessful);
    const start = Math.max(requestedStart, now - profile.maxCatchupHours * HOUR);
    return {
      fromInclusive: new Date(start).toISOString(), toExclusive: new Date(now).toISOString(),
      basis: lastSuccessful === null ? "initial-lookback" as const : "since-last-success" as const,
      truncated: start !== requestedStart
    };
  };
  return {
    schemaVersion: "chatagent-briefing-plan-v2" as const,
    profileId: profile.id,
    profileDigest: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
    league: profile.league, plannedAt: new Date(now).toISOString(), timezone: request.timezone,
    execution: "not-started" as const,
    tasks: profile.tasks.map(task => ({
      id: task.id, scope: task.scope, title: task.title,
      state: task.scope === "team" && !request.team ? "needs-input" as const : "ready" as const,
      team: task.scope === "team" ? request.team : null,
      window: windowFor(request.lastSuccessful[task.scope]),
      sources: task.sources
    })),
    questions: profile.tasks.some(task => task.scope === "team") && !request.team
      ? ["Which NBA team should your briefing focus on?"] : []
  };
}

/** Convenience entrypoint; all defaults live in the validated NBA example profile. */
export function planNbaBriefing(input: BriefingRequest) {
  return planBriefing(input, defaultNbaProfile());
}
