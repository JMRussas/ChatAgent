import { join } from "node:path";
import { brokenLinks, build, metadata, OUT } from "./build";
import { checkContracts, loadManifest } from "./contracts";
import { importGraph, unresolvedRelative, writeGraph } from "./graph";

/** docs:check, docs:build and docs:graph. Exits non-zero on any contract problem. */
const root = process.cwd();
const command = process.argv[2];

/** Writes the import graph; false when a relative import is unresolved. */
async function graph(meta = metadata(root)) {
  const graph = await importGraph(root);
  writeGraph(root, graph, meta);
  const unresolved = unresolvedRelative(graph);
  console.log(
    `Import graph: ${Object.keys(graph.modules).length} modules, ${graph.circular.length} cycles, ${graph.skipped.length} unresolved.`
  );
  if (unresolved.length)
    console.error(`Unresolved relative imports:\n${unresolved.map((m) => `  ${m}`).join("\n")}`);
  return !unresolved.length;
}

async function main() {
  if (command === "graph") {
    if (!(await graph())) process.exitCode = 1;
    return;
  }
  if (command !== "check" && command !== "build") {
    console.error("Usage: tsx src/docs/cli.ts check|build|graph");
    process.exitCode = 2;
    return;
  }
  const report = checkContracts(root, loadManifest(root));
  if (report.problems.length) {
    console.error(`Documentation contracts: ${report.problems.length} problem(s)`);
    for (const problem of report.problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const invariants = report.symbols.reduce((n, s) => n + s.invariants.length, 0);
  console.log(
    `Documentation contracts: ${report.symbols.length} symbols, ${invariants} invariants, no problems.`
  );
  if (command !== "build") return;
  const meta = metadata(root);
  build(root, report, meta);
  if (!(await graph(meta))) process.exitCode = 1;
  const broken = brokenLinks(join(root, OUT));
  if (broken.length) {
    console.error(`Generated documentation: ${broken.length} broken link(s)`);
    for (const problem of broken.slice(0, 50)) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else console.log("Generated documentation: every relative link resolves inside the artifact.");
}

void main();
