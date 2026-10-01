import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RssNewsSource, rssConfigSchema } from "./rssNews";
async function main() {
  if (!process.argv[2] || process.argv.length > 4)
    throw new Error("Usage: sports:news <feed.json> [lookback-hours]");
  const config = rssConfigSchema.parse(JSON.parse(await readFile(process.argv[2], "utf8")));
  const hours = z.coerce
      .number()
      .int()
      .min(1)
      .max(744)
      .parse(process.argv[3] ?? 24),
    now = Date.now();
  const evidence = await new RssNewsSource(config).read({
    league: config.league,
    kind: "news",
    team: config.team,
    now: new Date(now).toISOString(),
    window: {
      fromInclusive: new Date(now - hours * 3600000).toISOString(),
      toExclusive: new Date(now).toISOString()
    },
    limit: 50,
    maxAgeMs: 3600000
  });
  console.log(JSON.stringify({ publisher: config.publisher, evidence }, null, 2));
  if (evidence.coverage !== "complete" || evidence.freshness !== "fresh") process.exitCode = 1;
}
main().catch(() => {
  console.error("News read failed; check feed configuration.");
  process.exitCode = 1;
});
