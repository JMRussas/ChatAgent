import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkContracts,
  markdownAnchors,
  testTitles,
  type Manifest
} from "../../src/docs/contracts";
import {
  brokenLinks,
  linkFrom,
  renderSource,
  rewriteSourceLinks,
  SOURCE_SENTINEL
} from "../../src/docs/build";
import { importGraph, unresolvedRelative } from "../../src/docs/graph";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "docs-tooling-"));
  roots.push(root);
  copyFileSync(resolve("tsdoc.json"), join(root, "tsdoc.json"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const manifest: Manifest = {
  version: 1,
  components: [{ file: "src/owner.ts", symbols: [{ name: "Owner", decision: true }] }]
};
const testFile = `import { it } from "vitest";
it("keeps work pinned", () => {});
it.each([1, 2])("handles %s", () => {});
it.each("ghost")("real title", () => {});
`;
const decisionFile = "# Decisions\n\n## Retention\n\nText.\n\n```md\n# Sample only\n```\n";
const comment = (tags: string) => `/**
 * Owns pinned work.
 *
${tags
  .trim()
  .split("\n")
  .map((line) => ` * ${line}`)
  .join("\n")}
 */
export class Owner {}
`;
const valid = `@lifetime Created on start; released once settled.

@invariant pins-hold-work — A pin keeps the turn until it is released.
@test tests/owner.test.ts :: keeps work pinned

@decision docs/decisions.md#retention`;
const check = (tags: string, extra: Record<string, string> = {}) =>
  checkContracts(
    workspace({
      "src/owner.ts": comment(tags),
      "tests/owner.test.ts": testFile,
      "docs/decisions.md": decisionFile,
      ...extra
    }),
    manifest
  );

describe("documentation contract checks", () => {
  it("accepts a complete contract and resolves its test line", () => {
    const report = check(valid);
    expect(report.problems).toEqual([]);
    expect(report.symbols[0]).toMatchObject({
      name: "Owner",
      summary: "Owns pinned work.",
      lifetime: "Created on start; released once settled.",
      invariants: [
        {
          id: "pins-hold-work",
          claim: "A pin keeps the turn until it is released.",
          tests: [{ file: "tests/owner.test.ts", title: "keeps work pinned", line: 2 }]
        }
      ],
      decisions: [{ file: "docs/decisions.md", anchor: "retention" }]
    });
  });

  it.each([
    ["a removed @lifetime", valid.replace(/@lifetime .*\n/, ""), "requires one @lifetime"],
    [
      "no invariant",
      "@lifetime Kept.\n@decision docs/decisions.md#retention",
      "requires at least one @invariant"
    ],
    [
      "an invariant without a test",
      valid.replace(/@test .*\n/, ""),
      "invariant pins-hold-work has no @test"
    ],
    [
      "a malformed invariant id",
      valid.replace("pins-hold-work", "Pins_Hold"),
      "malformed @invariant"
    ],
    [
      "an undeclared test title",
      valid.replace("keeps work pinned", "never written"),
      'test not declared in tests/owner.test.ts: "never written"'
    ],
    [
      "a data argument used as a title",
      valid.replace("keeps work pinned", "ghost"),
      'test not declared in tests/owner.test.ts: "ghost"'
    ],
    [
      "a missing test file",
      valid.replace("tests/owner.test.ts", "tests/missing.test.ts"),
      "test file not found tests/missing.test.ts"
    ],
    [
      "a missing decision section",
      valid.replace("#retention", "#nowhere"),
      "no section #nowhere in docs/decisions.md"
    ],
    [
      "a heading that exists only inside a code block",
      valid.replace("#retention", "#sample-only"),
      "no section #sample-only in docs/decisions.md"
    ],
    [
      "no decision where one is required",
      valid.replace(/@decision .*/, ""),
      "requires a @decision"
    ],
    ["malformed TSDoc syntax", `${valid}\n\nSee {@link`, "malformed comment"]
  ])("rejects %s", (_, tags, problem) => {
    expect(check(tags).problems.join("\n")).toContain(problem);
  });

  it("rejects a duplicate invariant id and a missing symbol", () => {
    const duplicated = `${valid}\n\n@invariant pins-hold-work — Again.\n@test tests/owner.test.ts :: keeps work pinned`;
    expect(check(duplicated).problems.join("\n")).toContain(
      "duplicate invariant id pins-hold-work"
    );
    const root = workspace({ "src/owner.ts": "export class Other {}\n" });
    expect(checkContracts(root, manifest).problems.join("\n")).toContain(
      "src/owner.ts Owner: symbol not found"
    );
  });

  it.each([
    ["an empty manifest", { version: 1, components: [] }],
    [
      "a component without symbols",
      { version: 1, components: [{ file: "src/owner.ts", symbols: [] }] }
    ],
    ["another version", { ...manifest, version: 2 }],
    ["a cast-only shape", { version: 1, components: [{ file: "src/owner.ts" }] }],
    [
      "duplicate symbols",
      {
        version: 1,
        components: [{ file: "src/owner.ts", symbols: [{ name: "Owner" }, { name: "Owner" }] }]
      }
    ],
    [
      "duplicate components",
      { version: 1, components: [manifest.components[0], manifest.components[0]] }
    ],
    ["an unknown field", { version: 1, components: [{ ...manifest.components[0], extra: true }] }],
    [
      "a malformed symbol name",
      { version: 1, components: [{ file: "src/owner.ts", symbols: [{ name: "Owner..x" }] }] }
    ]
  ])("rejects %s before checking anything", (_, bad) => {
    const report = checkContracts(workspace({ "src/owner.ts": comment(valid) }), bad);
    expect(report.symbols).toEqual([]);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems[0]).toMatch(/^docs\/contracts\/pilot\.json: /);
  });

  it("checks the repository's own pilot cleanly", async () => {
    const { loadManifest } = await import("../../src/docs/contracts");
    expect(checkContracts(resolve("."), loadManifest(resolve("."))).problems).toEqual([]);
  });
});

describe("test titles", () => {
  it("finds declarations only, with their lines", () => {
    const titles = testTitles(`import { it, test } from "vitest";
it("direct", () => {});
it.skip("skipped", () => {});
test.only("only", function () {});
it.each([[1]])("each %s", () => {});
it.each("ghost")("after ghost", () => {});
it(\`template\`, () => {});
it("no callback");
it("data, not a test", options);
it(name, () => {});
describe("group", () => {});
`);
    expect([...titles]).toEqual([
      ["direct", 2],
      ["skipped", 3],
      ["only", 4],
      ["each %s", 5],
      ["after ghost", 6],
      ["template", 7]
    ]);
  });
});

describe("Markdown anchors", () => {
  it("follows GitHub slugs, numbers duplicates and skips fenced code", () => {
    expect([
      ...markdownAnchors(
        "# Implemented coordinator slice — 2026-09-30\n## Admission and selection (04)\n## Admission and selection (04)\n~~~\n## Fenced\n~~~\n````md\n```\n# Still fenced\n```` trailing\n# Still fenced too\n`````\n## After\n"
      )
    ]).toEqual([
      "implemented-coordinator-slice--2026-09-30",
      "admission-and-selection-04",
      "admission-and-selection-04-1",
      "after"
    ]);
  });
});

describe("generated pages", () => {
  const meta = { sourceRevision: "abc123", dirty: true, generatedAt: "2026-10-06T00:00:00.000Z" };

  it("escapes source and anchors lines and real headings", () => {
    const html = renderSource("docs/a.md", "# Title\n<script>x</script>\n```\n# Not\n```", meta);
    expect(html).toContain('id="L2"');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain('id="title"');
    expect(html).not.toContain('id="not"');
    expect(html).toContain("with uncommitted changes");
  });

  it("rewrites TypeDoc source links relative to each page", () => {
    expect(linkFrom("reference/classes/A.html", "source/src/a.ts.html")).toBe(
      "../../source/src/a.ts.html"
    );
    expect(
      rewriteSourceLinks(
        `<a href="${SOURCE_SENTINEL}src/a.ts#L7">a</a>`,
        "reference/classes/A.html"
      )
    ).toBe('<a href="../../source/src/a.ts.html#L7">a</a>');
  });

  it("reports missing files, missing fragments and leftover source links", () => {
    const parent = workspace({});
    writeFileSync(join(parent, "outside.html"), "<p>not in the artifact</p>");
    const out = join(parent, "out");
    mkdirSync(join(out, "source"), { recursive: true });
    const pages: Record<string, string> = {
      "index.html": `<a href="../outside.html">escape</a><a href="source/x.html#L2">ok</a><a href="source/x.html#L9">bad anchor</a><a href="gone.html">missing</a><a href="https://example.com/">external</a><a href="#top">self</a>`,
      "source/x.html": `<span id="L1"></span><span id="L2"></span><a href="${SOURCE_SENTINEL}x#L1">left</a>`
    };
    for (const [path, html] of Object.entries(pages)) writeFileSync(join(out, path), html);
    expect(brokenLinks(out).sort()).toEqual(
      [
        "index.html: leaves the artifact ../outside.html",
        "index.html: missing gone.html",
        "index.html: no #L9 in source/x.html",
        "index.html: no #top in index.html",
        "source/x.html: unrewritten source link"
      ].sort()
    );
  });
});

describe("import graph", () => {
  it("fails on an unresolved relative import and reports resolved edges", async () => {
    const root = workspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }
      }),
      "src/a.ts": `import { b } from "./b";\nimport { c } from "./missing";\nexport const a = b + c;\n`,
      "src/b.ts": "export const b = 1;\n"
    });
    const graph = await importGraph(root);
    expect(graph.modules["a.ts"]).toEqual(["b.ts"]);
    expect(unresolvedRelative(graph)).toEqual(["./missing"]);
  }, 60_000);
});
