import { describe, expect, it, vi } from "vitest";
import example from "../../data/sports/nfl-live-briefing.example.json";
import { createLiveBriefing } from "../../src/sports/liveBriefing";
import { ToolResultStore, type ToolResult } from "../../src/app/toolResult";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const signal = () => new AbortController().signal;
const rss = '<rss version="2.0"><channel></channel></rss>';
const teams = {
  data: [{ id: 1, full_name: "Harbor Comets", name: "Comets", abbreviation: "HC" }]
};
const games = {
  data: [
    {
      id: 42,
      date: "2026-09-28T00:00:00Z",
      status_state: "final",
      home_team: { id: 1, full_name: "Harbor Comets" },
      visitor_team: { id: 2, full_name: "Other" },
      home_team_score: 21,
      visitor_team_score: 14
    }
  ],
  meta: { next_cursor: null }
};
type Config = typeof example & Record<string, unknown>;
/** The example configuration with some sections replaced. */
const changed = (patch: Record<string, unknown>): Config =>
  ({ ...structuredClone(example), ...patch }) as Config;
const variants = {
  profile: () =>
    changed({ profile: { ...structuredClone(example.profile), initialLookbackHours: 167 } }),
  news: () => changed({ feeds: [{ ...structuredClone(example.feeds[0]), maxItems: 99 }] }),
  coordinator: () => changed({ coordinator: { ...example.coordinator, maxRuns: 21 } }),
  gameSearch: () => changed({ gameSearch: { maxResults: 40 } }),
  games: () => changed({ games: { ...example.games, cacheTtlMs: 16000 } }),
  directories: () => changed({ directories: { cacheTtlMs: 7_200_000 } })
};
const gameArgs = { league: "NFL", from: "2026-09-27T00:00:00Z", to: "2026-09-30T00:00:00Z" };

/** A fake provider; reads of a URL fragment can be held until released. */
function setup(config: Config = changed({})) {
  const holds = new Map<string, Promise<void>>();
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const text = String(url);
    for (const [fragment, held] of holds)
      if (text.includes(fragment))
        await new Promise<void>((resolve, reject) => {
          void held.then(resolve);
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        });
    if (text.includes("/teams")) return Response.json(teams);
    if (text.includes("/games")) return Response.json(games);
    return new Response(rss);
  });
  const runtime = createLiveBriefing(config, "key", transport, () => NOW);
  const hold = (fragment: string) => {
    let release!: () => void;
    holds.set(fragment, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      holds.delete(fragment);
      release();
    };
  };
  const directory = () => runtime.http.directory!;
  const ops = () => runtime.http.gameOperations!;
  const lookup = async () =>
    (await directory().lookup({ query: "Comets", league: "NFL" }, "u", "c", signal())) as Matched;
  const search = async () => (await ops().search(gameArgs, "u", "c", signal())) as ToolResult;
  const tools = () => runtime.http.additionalTools!();
  return { runtime, transport, hold, directory, ops, lookup, search, tools };
}
type Setup = ReturnType<typeof setup>;
type Matched = { status: string; snapshot: { snapshotId: string }; candidateId: string };
async function seed(s: Setup) {
  const resolution = await s.lookup();
  expect(resolution.status).toBe("matched");
  const parent = await s.search();
  const detail = s.ops().details({ resultId: parent.context.resultId, row: 0 }, "u", "c");
  const listed = await s.directory().list({ league: "NFL" }, "u", "c", signal());
  return { resolution, parent, detail, listed };
}
const selects = (s: Setup, r: Matched) =>
  s.directory().select({ snapshotId: r.snapshot.snapshotId, candidateId: r.candidateId }, "u", "c");
const findGames = (s: Setup, tools = s.tools()) => tools.find((t) => t.id === "sports:find-games")!;
const stored = (s: Setup, id: string) => s.directory().results.get(id, "u", "c").context.resultId;

describe("component-level briefing reload", () => {
  it.each(["profile", "news", "coordinator"] as const)(
    "a %s-only change keeps the directory, game operations, results and tools",
    async (kind) => {
      const s = setup();
      try {
        const before = await seed(s);
        const [directory, ops, version, tools] = [
          s.directory(),
          s.ops(),
          s.runtime.version,
          s.tools()
        ];
        expect(s.runtime.apply(variants[kind]())).toMatchObject({ changed: true });
        expect(s.runtime.version).not.toBe(version);
        expect(s.directory()).toBe(directory);
        expect(s.ops()).toBe(ops);
        expect(selects(s, before.resolution).team.id).toBe("1");
        for (const r of [before.parent, before.detail, before.listed])
          expect(stored(s, r.context.resultId)).toBe(r.context.resultId);
        // Kept components still deny other users and conversations.
        expect(() =>
          s.directory().results.get(before.parent.context.resultId, "other", "c")
        ).toThrow("RESULT_NOT_FOUND");
        expect(() =>
          s.directory().results.get(before.listed.context.resultId, "u", "elsewhere")
        ).toThrow("RESULT_NOT_FOUND");
        expect(() =>
          s.directory().select(
            {
              snapshotId: before.resolution.snapshot.snapshotId,
              candidateId: before.resolution.candidateId
            },
            "u",
            "elsewhere"
          )
        ).toThrow("RESOLUTION_NOT_FOUND");
        // A previously issued directory tool still runs.
        const resolveTeam = tools.find((t) => t.id === "sports:resolve-team")!;
        expect(
          await resolveTeam.execute({ query: "Comets", league: "NFL" }, "u", "r", signal(), "c")
        ).toMatchObject({ status: "matched" });
        // Previously issued tools still run, and results keep the same component revision.
        const again = (await findGames(s, tools).execute(
          gameArgs,
          "u",
          "r",
          signal(),
          "c"
        )) as ToolResult;
        expect(again.evidence.revision).toBe(before.parent.evidence.revision);
      } finally {
        s.runtime.http.close();
      }
    }
  );

  it.each(["gameSearch", "games"] as const)(
    "a %s change replaces only game operations and drops only their results",
    async (kind) => {
      const s = setup();
      try {
        const before = await seed(s);
        const [directory, ops, tools] = [s.directory(), s.ops(), s.tools()];
        s.runtime.apply(variants[kind]());
        expect(s.directory()).toBe(directory);
        expect(s.ops()).not.toBe(ops);
        // The directory's own snapshot and results survive.
        expect(selects(s, before.resolution).team.id).toBe("1");
        expect(stored(s, before.listed.context.resultId)).toBe(before.listed.context.resultId);
        // Search and detail results of the replaced game operations are gone.
        for (const r of [before.parent, before.detail])
          expect(() => stored(s, r.context.resultId)).toThrow("RESULT_NOT_FOUND");
        await expect(
          findGames(s, tools).execute(gameArgs, "u", "r", signal(), "c")
        ).rejects.toThrow("CAPABILITIES_CHANGED");
        // The new instance works with the retained directory.
        const fresh = await s.search();
        expect(fresh.evidence.revision).not.toBe(before.parent.evidence.revision);
      } finally {
        s.runtime.http.close();
      }
    }
  );

  it("a directories change replaces both components", async () => {
    const s = setup();
    try {
      const before = await seed(s);
      const [directory, ops] = [s.directory(), s.ops()];
      const resolveTeam = s.tools().find((t) => t.id === "sports:resolve-team")!;
      s.runtime.apply(variants.directories());
      await expect(
        resolveTeam.execute({ query: "Comets", league: "NFL" }, "u", "r", signal(), "c")
      ).rejects.toThrow("CAPABILITIES_CHANGED");
      expect(s.directory()).not.toBe(directory);
      expect(s.ops()).not.toBe(ops);
      expect(() =>
        directory.select(
          {
            snapshotId: before.resolution.snapshot.snapshotId,
            candidateId: before.resolution.candidateId
          },
          "u",
          "c"
        )
      ).toThrow("CAPABILITIES_CHANGED");
      expect(() => selects(s, before.resolution)).toThrow("RESOLUTION_NOT_FOUND");
      expect(() => stored(s, before.listed.context.resultId)).toThrow("RESULT_NOT_FOUND");
    } finally {
      s.runtime.http.close();
    }
  });

  it("lets held compatible reads finish after a reload", async () => {
    const s = setup();
    try {
      const releaseTeams = s.hold("/nfl/v1/teams");
      const pendingLookup = s.lookup();
      await vi.waitFor(() => expect(s.transport).toHaveBeenCalledTimes(1));
      s.runtime.apply(variants.gameSearch()); // the directory is retained
      releaseTeams();
      const resolution = await pendingLookup;
      expect(resolution.status).toBe("matched");
      expect(selects(s, resolution).team.id).toBe("1");

      const releaseGames = s.hold("/nfl/v1/games");
      const pendingSearch = s.search();
      await vi.waitFor(() => expect(s.transport).toHaveBeenCalledTimes(2));
      // Game operations are retained: game search stays as it now is.
      s.runtime.apply(
        changed({
          gameSearch: { maxResults: 40 },
          coordinator: { ...example.coordinator, maxRuns: 21 }
        })
      );
      releaseGames();
      const result = await pendingSearch;
      expect(stored(s, result.context.resultId)).toBe(result.context.resultId);
    } finally {
      s.runtime.http.close();
    }
  });

  it("aborts held incompatible game work, which never publishes", async () => {
    const s = setup();
    try {
      const release = s.hold("/nfl/v1/games");
      const pending = s.search();
      await vi.waitFor(() => expect(s.transport).toHaveBeenCalledTimes(1));
      s.runtime.apply(variants.gameSearch());
      release();
      await expect(pending).rejects.toThrow();
      expect(s.directory().results.retentionStats().records).toBe(0);
    } finally {
      s.runtime.http.close();
    }
  });

  it("keeps the original components usable when a configuration is invalid or unchanged", async () => {
    const s = setup();
    try {
      const before = await seed(s);
      const [directory, ops, version] = [s.directory(), s.ops(), s.runtime.version];
      expect(() => s.runtime.apply({ ...example, gameSearch: { maxResults: 0 } })).toThrow();
      expect(s.runtime.apply(structuredClone(example))).toEqual({ version, changed: false });
      expect([s.directory(), s.ops(), s.runtime.version]).toEqual([directory, ops, version]);
      expect(selects(s, before.resolution).team.id).toBe("1");
      expect(stored(s, before.parent.context.resultId)).toBe(before.parent.context.resultId);
      await expect(s.search()).resolves.toBeDefined();
    } finally {
      s.runtime.http.close();
    }
  });

  it("keeps one request budget, and its usage, across reloads", async () => {
    const limited = (patch: Record<string, unknown> = {}) =>
      changed({ games: { ...example.games, requestsPerMinute: 2 }, ...patch });
    const s = setup(limited());
    try {
      await s.lookup(); // one request
      s.runtime.apply(limited({ coordinator: { ...example.coordinator, maxRuns: 21 } }));
      await s.search(); // two requests
      s.runtime.apply(limited({ gameSearch: { maxResults: 40 } }));
      // The shared budget is spent: an NBA directory read is refused for admission.
      const nba = await s
        .directory()
        .lookup({ query: "Comets", league: "NBA" }, "u", "c", signal());
      expect(nba).toMatchObject({ status: "unavailable", reason: "admission" });
      expect(s.transport).toHaveBeenCalledTimes(2);
    } finally {
      s.runtime.http.close();
    }
  });

  it("retires a conversation's results and snapshots across retained instances", async () => {
    const s = setup();
    try {
      const before = await seed(s);
      s.runtime.apply(variants.coordinator());
      const removed = s.directory().forgetConversation("c");
      s.ops().forgetResults(removed);
      expect(removed.sort()).toEqual(
        [before.parent, before.detail, before.listed].map((r) => r.context.resultId).sort()
      );
      expect(s.directory().retentionStats()).toMatchObject({ records: 0, snapshots: 0 });
      expect(s.ops().retentionStats().games).toBe(0);
    } finally {
      s.runtime.http.close();
    }
  });

  it("stays bounded under repeated game-only reload churn", async () => {
    const s = setup();
    try {
      const listed = await s.directory().list({ league: "NFL" }, "u", "c", signal());
      // Four rounds stay within the five-request budget.
      for (let n = 0; n < 4; n++) {
        await s.search();
        s.runtime.apply(changed({ gameSearch: { maxResults: 40 + (n % 2) } }));
        // Only the directory's own list remains after each replacement.
        expect(s.directory().results.retentionStats().records).toBe(1);
      }
      expect(stored(s, listed.context.resultId)).toBe(listed.context.resultId);
    } finally {
      s.runtime.http.close();
    }
  });
});

describe("ToolResultStore owners", () => {
  const value = (n: number) => ({
    version: "tool-result-v1" as const,
    context: {
      status: "ready" as const,
      summary: `result ${n}`,
      scope: "fixture",
      coverage: "complete" as const,
      limitations: [],
      expiresAt: new Date(NOW + 60_000).toISOString()
    },
    payload: null,
    evidence: {
      sourceUrl: "https://example.invalid",
      observedAt: new Date(NOW).toISOString(),
      revision: "r"
    }
  });

  it("forgets only the owner's records and keeps byte accounting exact", () => {
    const store = new ToolResultStore(() => NOW, 10);
    const owner = {},
      other = {};
    const mine = [1, 2, 3].map((n) => store.put("u", "c", value(n), owner).context.resultId);
    const theirs = store.put("u", "c", value(4), other).context.resultId;
    const plain = store.put("u", "c", value(5)).context.resultId;
    expect(store.forgetOwner(owner).sort()).toEqual(mine.sort());
    expect(store.retentionStats().records).toBe(2);
    expect(store.get(theirs, "u", "c")).toBeDefined();
    expect(store.get(plain, "u", "c")).toBeDefined();
    const remaining = new ToolResultStore(() => NOW, 10);
    remaining.put("u", "c", value(4));
    remaining.put("u", "c", value(5));
    expect(store.retentionStats().bytes).toBe(remaining.retentionStats().bytes);
    expect(store.forgetOwner(owner)).toEqual([]);
  });
});

describe("game sources across a compatible reload", () => {
  const request = { now: new Date(NOW).toISOString(), timezone: "America/New_York", team: null };
  /** League games with the same limit game search uses, so both read the same scope. */
  const sameScope = () => {
    const profile = structuredClone(example.profile);
    profile.tasks[0].sources[0].limit = 100;
    return changed({ profile });
  };
  const gameCalls = (s: Setup) =>
    s.transport.mock.calls.filter(([url]) => String(url).includes("/games")).length;

  it("lets a reloaded coordinator reuse what kept game operations already read", async () => {
    // The coordinator's planned window, from an identical runtime.
    const scout = setup(sameScope());
    let window: { fromInclusive: string; toExclusive: string };
    try {
      const started = scout.runtime.coordinator.start("u", "r", request, scout.runtime.profile);
      window = (await scout.runtime.coordinator.wait("u", started.id)).plan.tasks[0].window;
    } finally {
      scout.runtime.http.close();
    }
    const s = setup(sameScope());
    try {
      await s
        .ops()
        .search(
          { league: "NFL", from: window.fromInclusive, to: window.toExclusive },
          "u",
          "c",
          signal()
        );
      expect(gameCalls(s)).toBe(1);
      s.runtime.apply({
        ...sameScope(),
        coordinator: { ...example.coordinator, maxRuns: 21 }
      });
      const started = s.runtime.coordinator.start("u", "r", request, s.runtime.profile);
      const run = await s.runtime.coordinator.wait("u", started.id);
      expect(run.tasks[0].results[0].evidence.records).toHaveLength(1);
      // Served from the shared source cache: no second provider read.
      expect(gameCalls(s)).toBe(1);
    } finally {
      s.runtime.http.close();
    }
  });
});
