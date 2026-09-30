import "../config/loadEnv";
import { z } from "zod";
import { BalldontlieGamesSource } from "./balldontlie";
async function main() {
  if (process.argv.length > 4) throw new Error("Usage: npm run sports:games -- [lookback-hours] [balldontlie-team-id]");
  const hours = z.coerce.number().int().min(1).max(744).parse(process.argv[2] ?? 24);
  const teamId = process.argv[3] ? z.string().regex(/^[1-9][0-9]*$/).parse(process.argv[3]) : null;
  const now = Date.now();
  const source = new BalldontlieGamesSource(process.env.BALLDONTLIE_API_KEY);
  const result = await source.read({ kind: "games", now: new Date(now).toISOString(),
    window: { fromInclusive: new Date(now - hours * 3600000).toISOString(), toExclusive: new Date(now).toISOString() },
    team: teamId ? { provider: "balldontlie", id: teamId, name: "Requested team " + teamId } : null,
    limit: 50, maxAgeMs: 900000 });
  console.log(JSON.stringify(result, null, 2));
  // Unknown freshness/partial results are not a successful full briefing.
  if (result.coverage !== "complete" || result.freshness !== "fresh") process.exitCode = 1;
}
main().catch(() => { console.error("Sports request failed; verify arguments and configuration."); process.exitCode = 1; });
