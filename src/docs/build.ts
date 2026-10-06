import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { markdownLineAnchors, type ContractReport } from "./contracts";

/** Where every generated page lives; gitignored, never committed. */
export const OUT = "dist/docs";
/** TypeDoc writes source links with this prefix; they are rewritten to bundled pages. */
export const SOURCE_SENTINEL = "https://source.invalid/";

export interface BuildMetadata {
  sourceRevision: string;
  dirty: boolean;
  generatedAt: string;
}

export function metadata(root: string, now = new Date()): BuildMetadata {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    sourceRevision: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    generatedAt: now.toISOString()
  };
}

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The bundled page for a repository file, relative to the output root. */
export const sourcePage = (file: string) => `source/${file}.html`;

/** Relative link from one generated page to another, both under the output root. */
export function linkFrom(fromPage: string, toPage: string) {
  const link = posix.relative(posix.dirname(fromPage), toPage);
  return link || posix.basename(toPage);
}

function stamp(meta: BuildMetadata) {
  return `<p class="meta">Source revision <code>${escapeHtml(meta.sourceRevision)}</code>${
    meta.dirty ? " with uncommitted changes (pages show the working tree)" : ""
  }; generated ${escapeHtml(meta.generatedAt)}.</p>`;
}
const STYLE = `<style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}
code,pre{font-family:ui-monospace,monospace}.meta{color:#555}pre{line-height:1.4}
.line{display:block;white-space:pre}.line:target{background:#fff3b0}.n{display:inline-block;width:4em;color:#888;user-select:none}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .5rem;vertical-align:top;text-align:left}</style>`;

/** An escaped, line-anchored copy of a file; Markdown headings also get their anchors. */
export function renderSource(file: string, content: string, meta: BuildMetadata) {
  const page = sourcePage(file);
  // The same anchors the checker accepts, so a decision link lands on its heading.
  const anchors = file.endsWith(".md") ? markdownLineAnchors(content) : [];
  const lines = content.split(/\r?\n/).map((line, index) => {
    const anchor = anchors[index];
    const extra = anchor ? ` id="${escapeHtml(anchor)}"` : "";
    const n = index + 1;
    return `<span class="line" id="L${n}"><span${extra}></span><a class="n" href="#L${n}">${n}</a>${escapeHtml(line)}</span>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    file
  )}</title>${STYLE}</head><body><p><a href="${linkFrom(page, "index.html")}">Documented components</a></p><h1><code>${escapeHtml(
    file
  )}</code></h1>${stamp(meta)}<pre>${lines.join("")}</pre></body></html>`;
}

/** The consolidated index of documented components, invariants, lifetimes and links. */
export function renderIndex(report: ContractReport, meta: BuildMetadata) {
  const sections = report.symbols.map((symbol) => {
    const source = `${sourcePage(symbol.file)}#L${symbol.line}`;
    const invariants = symbol.invariants
      .map(
        (invariant) =>
          `<tr><td><code id="${escapeHtml(invariant.id)}">${escapeHtml(invariant.id)}</code></td><td>${escapeHtml(
            invariant.claim
          )}</td><td>${invariant.tests
            .map(
              (test) =>
                `<a href="${escapeHtml(`${sourcePage(test.file)}#L${test.line ?? 1}`)}">${escapeHtml(
                  test.title
                )}</a> <span class="meta">(${escapeHtml(test.file)})</span>`
            )
            .join("<br>")}</td></tr>`
      )
      .join("");
    const decisions = symbol.decisions
      .map(
        (decision) =>
          `<li><a href="${escapeHtml(`${sourcePage(decision.file)}#${decision.anchor}`)}">${escapeHtml(
            decision.target
          )}</a></li>`
      )
      .join("");
    return `<section><h2><a href="${escapeHtml(source)}"><code>${escapeHtml(symbol.name)}</code></a> <span class="meta">${escapeHtml(
      symbol.file
    )}:${symbol.line}</span></h2><p>${escapeHtml(symbol.summary)}</p><p><strong>Lifetime.</strong> ${escapeHtml(
      symbol.lifetime
    )}</p><table><thead><tr><th>Invariant</th><th>Claim</th><th>Tests</th></tr></thead><tbody>${invariants}</tbody></table>${
      decisions ? `<p><strong>Decisions</strong></p><ul>${decisions}</ul>` : ""
    }</section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Documented components</title>${STYLE}</head><body><h1>Documented components</h1>${stamp(
    meta
  )}<p>Invariants, lifetimes and decisions for the components in <code>docs/contracts/pilot.json</code>. API reference: <a href="reference/index.html">TypeDoc</a>. Imports: <a href="import-graph.html">import graph</a>. Every link opens a copy bundled with these pages.</p>${sections.join(
    ""
  )}</body></html>`;
}

function htmlFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? htmlFiles(path) : name.endsWith(".html") ? [path] : [];
  });
}

/** Matches a sentinel source link: group 1 is the path, group 2 the line. */
const sentinelLinks = () =>
  new RegExp(`${SOURCE_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^"#]+)#L(\\d+)`, "g");

/** Rewrites TypeDoc's sentinel source links to the bundled pages, relative to each page. */
export function rewriteSourceLinks(html: string, pageFromOut: string) {
  return html.replace(
    sentinelLinks(),
    (_, path: string, line: string) => `${linkFrom(pageFromOut, sourcePage(path))}#L${line}`
  );
}

/** Writes the index, bundled source pages and TypeDoc output into OUT. */
export function build(root: string, report: ContractReport, meta: BuildMetadata) {
  const out = join(root, OUT);
  mkdirSync(out, { recursive: true });
  // TypeDoc HTML and JSON from the same entry points the manifest documents.
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typedoc/bin/typedoc"), "--options", "typedoc.json"],
    { cwd: root, stdio: "inherit" }
  );
  const files = new Set<string>();
  for (const symbol of report.symbols) {
    files.add(symbol.file);
    for (const invariant of symbol.invariants)
      for (const test of invariant.tests) files.add(test.file);
    for (const decision of symbol.decisions) files.add(decision.file);
  }
  // Every file a TypeDoc page links to is bundled too, so no link leaves the artifact.
  for (const page of htmlFiles(join(out, "reference")))
    for (const match of readFileSync(page, "utf8").matchAll(sentinelLinks())) files.add(match[1]);
  for (const file of [...files].sort()) {
    const page = join(out, sourcePage(file));
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, renderSource(file, readFileSync(join(root, file), "utf8"), meta));
  }
  for (const page of htmlFiles(join(out, "reference"))) {
    const fromOut = relative(out, page).split(sep).join("/");
    writeFileSync(page, rewriteSourceLinks(readFileSync(page, "utf8"), fromOut));
  }
  const json = join(out, "reference/typedoc.json");
  writeFileSync(json, rewriteSourceLinks(readFileSync(json, "utf8"), "reference/typedoc.json"));
  writeFileSync(join(out, "index.html"), renderIndex(report, meta));
  writeFileSync(
    join(out, "index.json"),
    JSON.stringify({ ...meta, components: report.symbols }, null, 2) + "\n"
  );
}

/**
 * Every relative link in the generated pages must reach a bundled file and, when it
 * names one, an element id there; no sentinel source link may remain. External
 * links (for example TypeDoc's own footer) are not followed.
 */
export function brokenLinks(out: string): string[] {
  const pages = htmlFiles(out);
  const ids = new Map<string, Set<string>>();
  const idsOf = (page: string) => {
    if (!ids.has(page))
      ids.set(
        page,
        new Set(
          [...readFileSync(page, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))
        )
      );
    return ids.get(page)!;
  };
  const problems: string[] = [];
  for (const json of ["reference/typedoc.json", "index.json"])
    if (
      existsSync(join(out, json)) &&
      readFileSync(join(out, json), "utf8").includes(SOURCE_SENTINEL)
    )
      problems.push(`${json}: unrewritten source link`);
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    const from = relative(out, page).split(sep).join("/");
    if (html.includes(SOURCE_SENTINEL)) problems.push(`${from}: unrewritten source link`);
    for (const [, raw] of html.matchAll(/\shref="([^"]+)"/g)) {
      const href = decode(raw);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
      const [path, anchor] = href.split("#");
      const target = path ? join(dirname(page), decodeURI(path)) : page;
      // A link must stay inside the artifact, even if the file exists in a checkout.
      const inside = relative(out, target);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        problems.push(`${from}: leaves the artifact ${href}`);
        continue;
      }
      if (path && !existsSync(target)) {
        problems.push(`${from}: missing ${href}`);
        continue;
      }
      if (anchor && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(anchor)))
        problems.push(`${from}: no #${anchor} in ${path || from}`);
    }
  }
  return problems;
}
const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
