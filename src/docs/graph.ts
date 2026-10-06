import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import madge from "madge";
import { escapeHtml, OUT, type BuildMetadata } from "./build";

/** Static import edges only: not runtime ownership, call flow or task flow. */
export interface ImportGraph {
  modules: Record<string, string[]>;
  /** Imports that could not be resolved, as Madge reports them. */
  skipped: string[];
  circular: string[][];
}

export async function importGraph(root: string, directory = "src"): Promise<ImportGraph> {
  const result = await madge(join(root, directory), {
    fileExtensions: ["ts"],
    tsConfig: join(root, "tsconfig.json"),
    detectiveOptions: { ts: { skipTypeImports: false } }
  });
  const modules = result.obj();
  return {
    modules: Object.fromEntries(
      Object.keys(modules)
        .sort()
        .map((name) => [name, [...modules[name]].sort()])
    ),
    skipped: [...result.warnings().skipped].sort(),
    circular: result.circular()
  };
}

/** Unresolved relative imports are errors; unresolved packages are reported only. */
export function unresolvedRelative(graph: ImportGraph) {
  return graph.skipped.filter((name) => name.startsWith("."));
}

/** A self-contained page: per-module imports and importers, filterable, no scripts fetched. */
export function renderGraph(graph: ImportGraph, meta: BuildMetadata) {
  const importers = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(graph.modules))
    for (const target of targets) importers.set(target, [...(importers.get(target) ?? []), from]);
  const list = (items: string[]) =>
    items.length
      ? items.map((m) => `<a href="#${escapeHtml(m)}">${escapeHtml(m)}</a>`).join("<br>")
      : "—";
  const rows = Object.entries(graph.modules)
    .map(
      ([module, targets]) =>
        `<tr id="${escapeHtml(module)}" data-name="${escapeHtml(module.toLowerCase())}"><td><code>${escapeHtml(
          module
        )}</code></td><td>${list(targets)}</td><td>${list((importers.get(module) ?? []).sort())}</td></tr>`
    )
    .join("");
  const cycles = graph.circular.length
    ? `<h2>Import cycles (${graph.circular.length})</h2><ul>${graph.circular
        .map((cycle) => `<li><code>${escapeHtml(cycle.join(" → "))}</code></li>`)
        .join("")}</ul>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Import graph</title><style>body{font-family:system-ui,sans-serif;max-width:80rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.3rem .5rem;vertical-align:top;text-align:left}tr:target{background:#fff3b0}.meta{color:#555}</style></head><body><p><a href="index.html">Documented components</a></p><h1>Import graph</h1><p><strong>Static imports only.</strong> An edge means one module imports another; it does not describe runtime ownership, call order or task flow.</p><p class="meta">Source revision <code>${escapeHtml(
    meta.sourceRevision
  )}</code>${meta.dirty ? " with uncommitted changes" : ""}; generated ${escapeHtml(meta.generatedAt)}. ${
    Object.keys(graph.modules).length
  } modules; unresolved: ${graph.skipped.length ? escapeHtml(graph.skipped.join(", ")) : "none"}.</p><p><label>Filter modules <input id="filter" type="search"></label></p>${cycles}<table><thead><tr><th>Module</th><th>Imports</th><th>Imported by</th></tr></thead><tbody>${rows}</tbody></table><script>document.getElementById("filter").addEventListener("input",function(e){var q=e.target.value.toLowerCase();document.querySelectorAll("tbody tr").forEach(function(r){r.hidden=q&&r.dataset.name.indexOf(q)<0});});</script></body></html>`;
}

export function writeGraph(root: string, graph: ImportGraph, meta: BuildMetadata) {
  const out = join(root, OUT);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "import-graph.json"),
    JSON.stringify({ ...meta, ...graph }, null, 2) + "\n"
  );
  writeFileSync(join(out, "import-graph.html"), renderGraph(graph, meta));
}
