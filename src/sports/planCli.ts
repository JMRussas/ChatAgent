import { readFile } from "node:fs/promises";
import { defaultNbaProfile } from "./briefingConfig";
import { planBriefing } from "./briefingPlan";

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length > 4)
    throw new Error("Usage: npm run sports:plan -- <request.json> [profile.json]");
  const profile = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], "utf8"))
    : defaultNbaProfile();
  console.log(
    JSON.stringify(planBriefing(JSON.parse(await readFile(path, "utf8")), profile), null, 2)
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Planning failed");
  process.exitCode = 1;
});
