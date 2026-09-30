import { readFile } from "node:fs/promises";
import { z } from "zod";
import { briefingProfileSchema, bindBriefingSources } from "./briefingConfig";
import { BriefingCoordinator, briefingCoordinatorOptionsSchema } from "./briefingCoordinator";
import { BriefingHttp } from "./briefingHttp";
import { RssNewsSource, rssConfigSchema } from "./rssNews";
import { createBalldontlieSources, sportsSourceOptionsSchema } from "./sharedSources";

export const liveBriefingConfigSchema = z.object({
  schemaVersion: z.literal("chatagent-live-briefing-v1"),
  profile: briefingProfileSchema,
  feeds: z.array(rssConfigSchema).max(20).default([]),
  games: sportsSourceOptionsSchema.default({}),
  coordinator: briefingCoordinatorOptionsSchema.default({})
}).strict().superRefine((config, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  const feeds = new Map(config.feeds.map(feed => [feed.id, feed]));
  if (feeds.size !== config.feeds.length) invalid("Duplicate feed ID");
  if (config.feeds.some(feed => ["nba-games", "nfl-games"].includes(feed.id))) invalid("Reserved adapter ID");
  for (const task of config.profile.tasks) for (const source of task.sources) {
    const feed = feeds.get(source.adapterId);
    if (feed) {
      if (source.kind !== "news" || feed.league !== config.profile.league) invalid("News adapter scope mismatch");
      if ((task.scope === "team") !== (feed.team !== null)) invalid("News feed must match task scope");
    } else if (source.kind !== "games" || source.adapterId !== config.profile.league.toLowerCase() + "-games") {
      invalid("Unsupported live adapter binding");
    }
  }
  if (config.profile.tasks.some(task => task.sources.some(source => source.kind === "games")) && config.profile.maxCatchupHours > 31 * 24) {
    invalid("Games catch-up window exceeds adapter limit");
  }
});

/** One server-owned registry/account budget per runtime. Construction performs no I/O. */
export function createLiveBriefing(configuration: unknown, apiKey?: string,
  transport: typeof fetch = fetch, clock: () => number = Date.now) {
  const config = liveBriefingConfigSchema.parse(configuration);
  const registry = new Map(createBalldontlieSources(apiKey, config.games, transport, clock));
  for (const feed of config.feeds) registry.set(feed.id, new RssNewsSource(feed, transport, clock));
  bindBriefingSources(config.profile, registry);
  const coordinator = new BriefingCoordinator(registry, config.coordinator);
  return { coordinator, http: new BriefingHttp(coordinator, config.profile), profile: config.profile };
}

/** Explicit opt-in. Errors omit configuration values, URLs and credentials. */
export async function loadLiveBriefingFromEnv(env: NodeJS.ProcessEnv): Promise<BriefingHttp | undefined> {
  const path = env.SPORTS_BRIEFING_CONFIG_PATH?.trim();
  if (!path) return undefined;
  try {
    return createLiveBriefing(JSON.parse(await readFile(path, "utf8")), env.BALLDONTLIE_API_KEY).http;
  } catch { throw new Error("SPORTS_BRIEFING_CONFIG_INVALID: check the configured live briefing file"); }
}
