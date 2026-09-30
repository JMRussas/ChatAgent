import { readFile } from "node:fs/promises";
import { planNbaBriefing } from "./briefingPlan";

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("Usage: npm run sports:plan -- <request.json>");
  console.log(JSON.stringify(planNbaBriefing(JSON.parse(await readFile(path, "utf8"))), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Planning failed"); process.exitCode = 1; });
