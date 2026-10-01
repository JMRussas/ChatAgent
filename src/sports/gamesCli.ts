import "../config/loadEnv";
import { z } from "zod";
import { createBalldontlieSources } from "./sharedSources";
async function main() {
  const args = process.argv.slice(2);
  const league = args[0] === "nfl" ? (args.shift(), "NFL" as const) : ("NBA" as const);
  if (args.length > 2)
    throw new Error("Usage: npm run sports:games -- [nfl] [lookback-hours] [balldontlie-team-id]");
  const hours = z.coerce
    .number()
    .int()
    .min(1)
    .max(744)
    .parse(args[0] ?? (league === "NFL" ? 168 : 24));
  const teamId = args[1]
    ? z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .parse(args[1])
    : null;
  const now = Date.now();
  const source = createBalldontlieSources(process.env.BALLDONTLIE_API_KEY).get(
    league.toLowerCase() + "-games"
  )!;
  const result = await source.read({
    league,
    kind: "games",
    now: new Date(now).toISOString(),
    window: {
      fromInclusive: new Date(now - hours * 3600000).toISOString(),
      toExclusive: new Date(now).toISOString()
    },
    team: teamId
      ? {
          provider: league === "NFL" ? "balldontlie-nfl" : "balldontlie",
          id: teamId,
          name: "Requested team " + teamId
        }
      : null,
    limit: 50,
    maxAgeMs: 900000
  });
  console.log(JSON.stringify(result, null, 2));
  // Unknown freshness/partial results are not a successful full briefing.
  if (result.coverage !== "complete" || result.freshness !== "fresh") process.exitCode = 1;
}
main().catch(() => {
  console.error("Sports request failed; verify arguments and configuration.");
  process.exitCode = 1;
});
