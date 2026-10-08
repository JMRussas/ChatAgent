import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// README.md must explain, briefly and with links, how development work runs: a
// "### Development workflow" subsection inside "## Architecture", linking the existing
// workflow documents. The runtime architecture content already there must remain.
const README = resolve("README.md");
const text = readFileSync(README, "utf8");
const LINKS = [
  "docs/development-workflow-uml.md",
  "docs/agent-bridge-development-workflow.md",
  "docs/implementation/13-hekate-plan-node-integration.md",
  "docs/implementation/15-stall-detection.md"
];

/** The text from a heading line to the next heading of the same or a higher level. */
function section(heading: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return undefined;
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("README development workflow", () => {
  it("has a Development workflow subsection inside Architecture, before the NBA prototype", () => {
    const architecture = text.indexOf("\n## Architecture\n");
    const workflow = text.indexOf("\n### Development workflow\n");
    const nba = text.indexOf("\n## NBA briefing prototype\n");
    expect(architecture).toBeGreaterThanOrEqual(0);
    expect(workflow).toBeGreaterThan(architecture);
    expect(nba).toBeGreaterThan(workflow);
  });

  it("links the four workflow documents, each of which exists", () => {
    const body = section("### Development workflow") ?? "";
    const targets = [...body.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    for (const link of LINKS) {
      expect(targets).toContain(link);
      expect(existsSync(resolve(dirname(README), link))).toBe(true);
    }
  });

  it("says how work runs: plan, worker, review and integration", () => {
    const body = (section("### Development workflow") ?? "").toLowerCase();
    for (const word of ["plan", "worker", "review"]) expect(body).toContain(word);
    expect(body).toMatch(/integrat(ed|ion)/);
  });

  it("keeps the existing runtime architecture diagram and class map link", () => {
    const architecture = section("## Architecture") ?? "";
    expect(architecture).toContain("```mermaid");
    expect(architecture).toContain("[docs/10-class-map.html](docs/10-class-map.html)");
  });
});
