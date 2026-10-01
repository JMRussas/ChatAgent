import { GameOperations, gameOperationsOptionsSchema } from "./gameOperations";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { briefingProfileSchema, bindBriefingSources } from "./briefingConfig";
import { BriefingCoordinator, briefingCoordinatorOptionsSchema } from "./briefingCoordinator";
import { BriefingHttp } from "./briefingHttp";
import { RssNewsSource, rssConfigSchema } from "./rssNews";
import {
  createBalldontlieSources,
  sportsSourceOptionsSchema,
  SportsRequestBudget
} from "./sharedSources";

import { TeamDirectory, directoryOptionsSchema } from "./teamDirectory";

export const liveBriefingConfigSchema = z
  .object({
    schemaVersion: z.literal("chatagent-live-briefing-v1"),
    profile: briefingProfileSchema,
    feeds: z.array(rssConfigSchema).max(20).default([]),
    games: sportsSourceOptionsSchema.default({}),
    directories: directoryOptionsSchema.default({}),
    gameSearch: gameOperationsOptionsSchema.default({}),
    coordinator: briefingCoordinatorOptionsSchema.default({})
  })
  .strict()
  .superRefine((config, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
    const feeds = new Map(config.feeds.map((feed) => [feed.id, feed]));
    if (feeds.size !== config.feeds.length) invalid("Duplicate feed ID");
    if (config.feeds.some((feed) => ["nba-games", "nfl-games"].includes(feed.id)))
      invalid("Reserved adapter ID");
    for (const task of config.profile.tasks)
      for (const source of task.sources) {
        const feed = feeds.get(source.adapterId);
        if (feed) {
          if (source.kind !== "news" || feed.league !== config.profile.league)
            invalid("News adapter scope mismatch");
          if ((task.scope === "team") !== (feed.team !== null))
            invalid("News feed must match task scope");
        } else if (
          source.kind !== "games" ||
          source.adapterId !== config.profile.league.toLowerCase() + "-games"
        ) {
          invalid("Unsupported live adapter binding");
        }
      }
    if (
      config.profile.tasks.some((task) => task.sources.some((source) => source.kind === "games")) &&
      config.profile.maxCatchupHours > 31 * 24
    ) {
      invalid("Games catch-up window exceeds adapter limit");
    }
  });

/** One server-owned registry/account budget per runtime. Construction performs no I/O. */
export function createLiveBriefing(
  configuration: unknown,
  apiKey?: string,
  transport: typeof fetch = fetch,
  clock: () => number = Date.now
) {
  let config = liveBriefingConfigSchema.parse(configuration);
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let version = digest(config),
    closed = false;
  const budget = new SportsRequestBudget(
    config.games.requestsPerMinute,
    config.games.minIntervalMs,
    clock
  );
  const sources = (value: typeof config) => {
    const registry = new Map(
      createBalldontlieSources(apiKey, value.games, transport, clock, budget)
    );
    for (const feed of value.feeds)
      registry.set(feed.id, new RssNewsSource(feed, transport, clock));
    bindBriefingSources(value.profile, registry);
    return registry;
  };
  const registry = sources(config);
  const coordinator = new BriefingCoordinator(registry, config.coordinator, clock);
  coordinator.configure(registry, config.coordinator, version);
  const http = new BriefingHttp(coordinator, config.profile);
  let directory = new TeamDirectory(apiKey, budget, config.directories, version, transport, clock);
  http.directory = directory;
  let games = new GameOperations(directory, registry, config.gameSearch, version, clock);
  http.gameOperations = games;
  http.additionalTools = () => [...directory.tools(), ...games.tools()];
  http.close = () => {
    closed = true;
    games.close();
    directory.close();
    coordinator.close();
  };
  return {
    coordinator,
    http,
    get profile() {
      return structuredClone(config.profile);
    },
    get version() {
      return version;
    },
    apply(configuration: unknown) {
      if (closed) throw new Error("BRIEFING_CLOSED");
      const next = liveBriefingConfigSchema.parse(configuration),
        nextVersion = digest(next);
      if (nextVersion === version) return { version, changed: false };
      const nextRegistry = sources(next);
      // No await between validation and publication. Old adapters retain this same budget.
      budget.configure(next.games.requestsPerMinute, next.games.minIntervalMs);
      coordinator.configure(nextRegistry, next.coordinator, nextVersion);
      http.setProfile(next.profile);
      games.close();
      directory.close();
      directory = new TeamDirectory(
        apiKey,
        budget,
        next.directories,
        nextVersion,
        transport,
        clock
      );
      games = new GameOperations(directory, nextRegistry, next.gameSearch, nextVersion, clock);
      http.gameOperations = games;
      http.directory = directory;
      config = next;
      version = nextVersion;
      return { version, changed: true };
    }
  };
}

/** Explicit opt-in. Errors omit configuration values, URLs and credentials. */
export async function loadLiveBriefingFromEnv(
  env: NodeJS.ProcessEnv
): Promise<BriefingHttp | undefined> {
  const configuredPath = env.SPORTS_BRIEFING_CONFIG_PATH?.trim();
  if (!configuredPath) return undefined;
  const path = resolve(configuredPath);
  try {
    const runtime = createLiveBriefing(
      JSON.parse(await readFile(path, "utf8")),
      env.BALLDONTLIE_API_KEY
    );
    let pending: Promise<unknown> = Promise.resolve();
    runtime.http.reload = () => {
      const attempt = pending.then(async () => {
        try {
          return runtime.apply(JSON.parse(await readFile(path, "utf8")));
        } catch {
          throw new Error("SPORTS_BRIEFING_RELOAD_FAILED");
        }
      });
      pending = attempt.catch(() => undefined);
      return attempt;
    };
    return runtime.http;
  } catch {
    throw new Error("SPORTS_BRIEFING_CONFIG_INVALID: check the configured live briefing file");
  }
}
