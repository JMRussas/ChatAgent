import { readFile } from "node:fs/promises";
import { defaultNbaProfile } from "./briefingConfig";
import { BriefingCoordinator } from "./briefingCoordinator";
import { FixtureSportsSource, type SportsSource } from "./sources";
import games from "../../data/sports/games.fixture.json";
import news from "../../data/sports/news.fixture.json";
import availability from "../../data/sports/availability.fixture.json";

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length > 4)
    throw new Error("Usage: npm run sports:fixture -- <request.json> [profile.json]");
  const request = JSON.parse(await readFile(path, "utf8"));
  const profile = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], "utf8"))
    : defaultNbaProfile();
  // This CLI is explicitly synthetic; the coordinator itself has no fixture dependency.
  const sources = new Map<string, SportsSource>([
    ["games", new FixtureSportsSource(games)],
    ["news", new FixtureSportsSource(news)],
    ["availability", new FixtureSportsSource(availability)]
  ]);
  const coordinator = new BriefingCoordinator(sources);
  try {
    const run = coordinator.start("fixture-user", "fixture-request", request, profile);
    const result = await coordinator.wait("fixture-user", run.id);
    console.log(JSON.stringify(result, null, 2));
    if (result.tasks.some((task) => task.status !== "complete")) process.exitCode = 1;
  } finally {
    coordinator.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Fixture run failed");
  process.exitCode = 1;
});
