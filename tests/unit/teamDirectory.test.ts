import { describe, it, expect, vi } from "vitest";
import { TeamDirectory } from "../../src/sports/teamDirectory";
import { SportsRequestBudget } from "../../src/sports/sharedSources";
const team = (id: number, name: string, city = "Harbor") => ({
  id,
  name,
  full_name: `${city} ${name}`,
  abbreviation: `H${id}`,
  city
});
const signal = () => new AbortController().signal;
function setup(
  responder: (url: string) => Response = () => Response.json({ data: [team(1, "Comets")] }),
  options = {}
) {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const clock = () => now,
    budget = new SportsRequestBudget(5, 0, clock);
  const transport = vi.fn(async (url: unknown) =>
    responder(String(url))
  ) as unknown as typeof fetch;
  const directory = new TeamDirectory("secret", budget, options, "v1", transport, clock);
  return {
    directory,
    budget,
    transport,
    advance: (ms: number) => {
      now += ms;
    }
  };
}
describe("provider-backed team directories", () => {
  it("matches provider aliases, canonicalizes scope and caches reads", async () => {
    const s = setup();
    const result = await s.directory.lookup({ query: "H-1", league: "nfl" }, "u", "c", signal());
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw Error();
    expect(result.snapshot.candidates[0].team.name).toBe("Harbor Comets");
    expect(
      s.directory.select(
        { snapshotId: result.snapshot.snapshotId, candidateId: result.candidateId },
        "u",
        "c"
      ).scope.league
    ).toBe("NFL");
    await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(() =>
      s.directory.select(
        { snapshotId: result.snapshot.snapshotId, candidateId: result.candidateId },
        "u",
        "other"
      )
    ).toThrow("RESOLUTION_NOT_FOUND");
    s.advance(600001);
    expect(() =>
      s.directory.select(
        { snapshotId: result.snapshot.snapshotId, candidateId: result.candidateId },
        "u",
        "c"
      )
    ).toThrow("RESOLUTION_STALE");
  });
  it("discovers cross-league ambiguity without defaulting to profile league", async () => {
    const s = setup();
    const r = await s.directory.lookup({ query: "Comets" }, "u", "c", signal());
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous")
      expect(r.snapshot.candidates.map((c) => c.scope.league)).toEqual(["NBA", "NFL"]);
  });
  it("retains same-city ambiguity and rejects unsupported scope without I/O", async () => {
    const s = setup(() => Response.json({ data: [team(1, "Comets"), team(2, "Moons")] }));
    expect(
      (await s.directory.lookup({ query: "Harbor", league: "NFL" }, "u", "c", signal())).status
    ).toBe("ambiguous");
    expect(
      (await s.directory.lookup({ query: "Comets", league: "MLB" }, "u", "c", signal())).status
    ).toBe("unsupported");
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it("does not turn a failed directory into a unique match or absence", async () => {
    const s = setup((url) =>
      url.includes("nfl/")
        ? new Response("", { status: 403 })
        : Response.json({ data: [team(1, "Comets")] })
    );
    const r = await s.directory.lookup({ query: "Comets" }, "u", "c", signal());
    expect(r.status).toBe("partial");
    expect(
      (await s.directory.lookup({ query: "Unknown", league: "NFL" }, "u", "c", signal())).status
    ).toBe("unavailable");
  });
  it("shares admission with games and applies provider cooldown", async () => {
    const s = setup(() => new Response("", { status: 429 }));
    expect(
      await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal())
    ).toMatchObject({ status: "unavailable", reason: "admission" });
    expect(s.budget.reserve()).toBe(false);
    s.advance(60000);
    expect(s.budget.reserve()).toBe(true);
    for (let i = 0; i < 4; i++) s.budget.reserve();
    expect(
      await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal())
    ).toMatchObject({ reason: "admission" });
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete or malformed directories and honors cancellation", async () => {
    for (const body of [
      { data: [team(1, "Comets")], meta: { next_cursor: 2 } },
      { data: [team(1, "Comets"), team(1, "Comets")] },
      { data: [] }
    ]) {
      const s = setup(() => Response.json(body));
      expect(
        await s.directory.lookup({ query: "Unknown", league: "NFL" }, "u", "c", signal())
      ).toMatchObject({ status: "unavailable", reason: "transport" });
    }
    const s = setup(),
      controller = new AbortController();
    controller.abort();
    expect(
      await s.directory.lookup({ query: "Comets" }, "u", "c", controller.signal)
    ).toMatchObject({ status: "unavailable", reason: "cancelled" });
    expect(s.transport).not.toHaveBeenCalled();
  });
  it("keeps a league-scoped selection valid when another league is read", async () => {
    const s = setup();
    const r = await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    if (r.status !== "matched") throw Error();
    await s.directory.lookup({ query: "Comets", league: "NBA" }, "u", "c", signal());
    expect(
      s.directory.select(
        { snapshotId: r.snapshot.snapshotId, candidateId: r.candidateId },
        "u",
        "c"
      ).scope.league
    ).toBe("NFL");
  });
  it("aborts active requests on close without publishing a snapshot", async () => {
    const budget = new SportsRequestBudget();
    let active: AbortSignal | undefined;
    const transport = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          active = init.signal;
          active!.addEventListener("abort", () => reject(Error("aborted")), { once: true });
        })
    ) as unknown as typeof fetch;
    const directory = new TeamDirectory("secret", budget, {}, "v", transport);
    const pending = directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    directory.close();
    expect(active?.aborted).toBe(true);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "stale_directory" });
  });
  it("refuses to publish cached lists after close", async () => {
    const s = setup();
    await s.directory.list({ league: "NBA" }, "u", "c", signal());
    const pending = s.directory.list({ league: "NBA" }, "u", "c", signal());
    s.directory.close();
    await expect(pending).rejects.toThrow("CAPABILITIES_CHANGED");
  });
  it("invalidates issued tools after reload/close", async () => {
    const s = setup();
    const tool = s.directory.tools().find((t) => t.id === "sports:resolve-team")!;
    s.directory.close();
    await expect(tool.execute({ query: "Comets" }, "u", "r", signal(), "c")).rejects.toThrow(
      "CAPABILITIES_CHANGED"
    );
  });
});

describe("league-scoped resolution revisions", () => {
  const isNfl = (url: string) => url.includes("/nfl/");
  const pick = (
    s: ReturnType<typeof setup>,
    r: Awaited<ReturnType<TeamDirectory["lookup"]>>,
    candidateId?: string
  ) => {
    if (!("snapshot" in r) || !r.snapshot) throw Error(r.status);
    return s.directory.select(
      {
        snapshotId: r.snapshot.snapshotId,
        candidateId: candidateId ?? r.snapshot.candidates[0].candidateId
      },
      "u",
      "c"
    );
  };

  it("an NBA selection survives NFL being populated and later refreshed", async () => {
    let nflName = "Comets";
    const s = setup((url) =>
      Response.json({ data: [team(isNfl(url) ? 2 : 1, isNfl(url) ? nflName : "Comets")] })
    );
    await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    // Late in NFL's cache life, NBA is read; then NFL expires and is re-read changed.
    s.advance(3_600_000 - 60_000);
    const nba = await s.directory.lookup({ query: "Comets", league: "NBA" }, "u", "c", signal());
    expect(nba.status).toBe("matched");
    s.advance(60_001);
    nflName = "Rockets";
    await s.directory.lookup({ query: "Rockets", league: "NFL" }, "u", "c", signal());
    expect(s.transport).toHaveBeenCalledTimes(3);
    expect(pick(s, nba).scope.league).toBe("NBA");
  });

  it("an unscoped snapshot depends on both leagues", async () => {
    let nflUp = false;
    const s = setup((url) =>
      isNfl(url) && !nflUp
        ? new Response("down", { status: 500 })
        : Response.json({ data: [team(isNfl(url) ? 2 : 1, "Comets")] })
    );
    // NFL could not be read: a partial snapshot that records NFL as unavailable.
    const partial = await s.directory.lookup({ query: "Comets" }, "u", "c", signal());
    expect(partial.status).toBe("partial");
    expect(pick(s, partial).scope.league).toBe("NBA");
    // Once NFL becomes readable, the partial snapshot no longer describes it.
    nflUp = true;
    const both = await s.directory.lookup({ query: "Comets" }, "u", "c", signal());
    expect(both.status).toBe("ambiguous");
    expect(() => pick(s, partial)).toThrow("RESOLUTION_STALE");
    expect(pick(s, both).scope.league).toBeDefined();
  });

  it("a partial snapshot stays selectable when a league's expired directory fails to refresh", async () => {
    let nflUp = true;
    const s = setup((url) =>
      isNfl(url) && !nflUp
        ? new Response("down", { status: 500 })
        : Response.json({ data: [team(isNfl(url) ? 2 : 1, "Comets")] })
    );
    await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    s.advance(3_600_001); // NFL's cached directory is now expired but still held.
    nflUp = false;
    const partial = await s.directory.lookup({ query: "Comets" }, "u", "c", signal());
    expect(partial.status).toBe("partial");
    expect(pick(s, partial).scope.league).toBe("NBA");
    // A later successful NFL refresh, even with identical content, invalidates it.
    nflUp = true;
    await s.directory.lookup({ query: "Comets", league: "NFL" }, "u", "c", signal());
    expect(() => pick(s, partial)).toThrow("RESOLUTION_STALE");
  });

  it("does not issue a snapshot when a league read earlier expires while another is awaited", async () => {
    let releaseNfl!: () => void;
    const held = new Promise<void>((resolve) => (releaseNfl = resolve));
    let now = Date.parse("2026-09-30T12:00:00Z");
    const clock = () => now;
    const transport = vi.fn(async (url: unknown) => {
      if (isNfl(String(url))) await held;
      return Response.json({ data: [team(isNfl(String(url)) ? 2 : 1, "Comets")] });
    }) as unknown as typeof fetch;
    const directory = new TeamDirectory(
      "secret",
      new SportsRequestBudget(5, 0, clock),
      { cacheTtlMs: 60_000 },
      "v1",
      transport,
      clock
    );
    const pending = directory.lookup({ query: "Comets" }, "u", "c", signal());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    now += 60_000; // NBA's directory expires while NFL is still being read.
    releaseNfl();
    expect(await pending).toMatchObject({ status: "unavailable", reason: "stale_directory" });
    expect(directory.retentionStats().snapshots).toBe(0);
  });

  it("selection uses the server's dependencies, not anything in a returned snapshot", async () => {
    const s = setup();
    const r = await s.directory.lookup({ query: "Comets", league: "NBA" }, "u", "c", signal());
    if (r.status !== "matched") throw Error();
    const original = structuredClone(r.snapshot.candidates[0]);
    r.snapshot.directoryRevision = "forged";
    r.snapshot.candidates[0].team.id = "999";
    expect(pick(s, r, r.candidateId)).toEqual(original);
  });

  it("keeps the snapshot store bounded", async () => {
    const s = setup(undefined, { maxSnapshots: 3 });
    for (let n = 0; n < 10; n++)
      await s.directory.lookup(
        { query: "Comets", league: n % 2 ? "NBA" : "NFL" },
        "u",
        "c",
        signal()
      );
    expect(s.directory.retentionStats().snapshots).toBe(3);
    expect(s.directory.retentionStats().directories).toBe(2);
  });
});
