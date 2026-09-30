import { z } from "zod";
import example from "../../data/sports/nba-profile.example.json";
import type { SportsSource } from "./sources";

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/);
export const briefingProfileSchema = z.object({
  schemaVersion: z.literal("chatagent-briefing-profile-v1"), id,
  // Other leagues need verified source/identity support, not just a new label.
  league: z.literal("NBA"),
  initialLookbackHours: z.number().int().min(1).max(8760),
  maxCatchupHours: z.number().int().min(1).max(8760),
  tasks: z.array(z.object({
    id, scope: z.enum(["league", "team"]), title: z.string().trim().min(1).max(200),
    sources: z.array(z.object({
      adapterId: id, kind: z.enum(["games", "news", "availability"]),
      limit: z.number().int().min(1).max(100), maxAgeMs: z.number().int().min(0).max(604800000)
    }).strict()).min(1).max(10)
  }).strict()).min(1).max(10)
}).strict().superRefine((profile, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (profile.initialLookbackHours > profile.maxCatchupHours) bad("Initial lookback exceeds catch-up cap");
  if (new Set(profile.tasks.map(task => task.id)).size !== profile.tasks.length) bad("Duplicate task ID");
  for (const task of profile.tasks) {
    if (new Set(task.sources.map(source => source.adapterId)).size !== task.sources.length) bad("Duplicate task adapter ID");
  }
});
export type BriefingProfile = z.infer<typeof briefingProfileSchema>;
export function defaultNbaProfile(): BriefingProfile { return briefingProfileSchema.parse(example); }

/** Resolve injected adapters before execution. No fixture construction or network calls. */
export function bindBriefingSources(value: unknown, registry: ReadonlyMap<string, SportsSource>) {
  const profile = briefingProfileSchema.parse(value);
  return profile.tasks.map(task => ({ ...task, sources: task.sources.map(source => {
    const adapter = registry.get(source.adapterId);
    if (!adapter || typeof adapter.read !== "function") throw new Error("SPORTS_ADAPTER_MISSING: " + source.adapterId);
    return { ...source, adapter };
  }) }));
}
