import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import {
  TSDocConfiguration,
  TSDocParser,
  TSDocTagDefinition,
  TSDocTagSyntaxKind,
  type DocBlock,
  type DocNode
} from "@microsoft/tsdoc";

/**
 * Documentation contracts for a deliberately small set of components.
 *
 * The manifest names each checked symbol explicitly; nothing is inferred from a
 * Map, Set or array. Tags are ordinary TSDoc block tags declared in tsdoc.json, so
 * TypeDoc and this checker read the same definitions.
 */

/** Validated at run time: an empty or malformed manifest checks nothing, so it fails. */
export const manifestSchema = z
  .object({
    version: z.literal(1),
    components: z
      .array(
        z
          .object({
            file: z.string().regex(/^[\w./-]+\.ts$/),
            symbols: z
              .array(
                z
                  .object({
                    /** `Class` or `Class.member`. */
                    name: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/),
                    /** Whether the symbol must link a decision record. */
                    decision: z.boolean().optional()
                  })
                  .strict()
              )
              .min(1)
              .refine((s) => new Set(s.map((x) => x.name)).size === s.length, "Duplicate symbol")
          })
          .strict()
      )
      .min(1)
      .refine((c) => new Set(c.map((x) => x.file)).size === c.length, "Duplicate component file")
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestSymbol = Manifest["components"][number]["symbols"][number];

export interface Invariant {
  id: string;
  claim: string;
  tests: TestLink[];
}
export interface TestLink {
  file: string;
  title: string;
  /** 1-based line of the test declaration, once resolved. */
  line?: number;
}
export interface DocumentedSymbol {
  file: string;
  name: string;
  line: number;
  summary: string;
  lifetime: string;
  invariants: Invariant[];
  decisions: { target: string; file: string; anchor: string }[];
}
export interface ContractReport {
  symbols: DocumentedSymbol[];
  problems: string[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUSTOM_TAGS = ["@invariant", "@lifetime", "@decision", "@test"];

/** A TSDoc parser that knows exactly the tags tsdoc.json declares. */
function parser(root: string) {
  const declared = JSON.parse(readFileSync(join(root, "tsdoc.json"), "utf8")) as {
    tagDefinitions: { tagName: string; syntaxKind: string; allowMultiple?: boolean }[];
  };
  const configuration = new TSDocConfiguration();
  for (const tag of declared.tagDefinitions)
    configuration.addTagDefinition(
      new TSDocTagDefinition({
        tagName: tag.tagName,
        syntaxKind: TSDocTagSyntaxKind.BlockTag,
        allowMultiple: tag.allowMultiple ?? false
      })
    );
  return new TSDocParser(configuration);
}

function render(node: DocNode): string {
  const excerpt = (node as { content?: { toString(): string } }).content;
  if (excerpt && typeof excerpt.toString === "function" && node.kind === "Excerpt")
    return excerpt.toString();
  return node.getChildNodes().map(render).join("");
}
const text = (block: DocNode) => render(block).replace(/\s+/g, " ").trim();

/**
 * GitHub-compatible heading anchors for each line of a Markdown file, or undefined
 * for lines that are not headings. Lines inside fenced code blocks are never headings.
 */
export function markdownLineAnchors(markdown: string): (string | undefined)[] {
  const seen = new Map<string, number>();
  // An open fence: its character and length. Only a fence of the same character,
  // at least as long and with nothing after it, closes it.
  let fence: { char: string; length: number } | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      return undefined;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return undefined;
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) return undefined;
    const base = heading[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}
/** The set of heading anchors in a Markdown file. */
export function markdownAnchors(markdown: string): Set<string> {
  return new Set(markdownLineAnchors(markdown).filter((a): a is string => !!a));
}

const MODIFIERS = new Set(["skip", "only", "concurrent", "sequential", "fails"]);
/** it, test, it.skip/only/…, or it.each(table) and its modifiers: a declaring callee. */
function declaresTest(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "it" || callee.text === "test";
  if (ts.isPropertyAccessExpression(callee))
    return MODIFIERS.has(callee.name.text) && declaresTest(callee.expression);
  // it.each(table)(title, fn): the inner call supplies data, never a title.
  if (ts.isCallExpression(callee))
    return (
      ts.isPropertyAccessExpression(callee.expression) &&
      callee.expression.name.text === "each" &&
      declaresTest(callee.expression.expression)
    );
  return false;
}

/**
 * Test titles and their lines, from declarations only: a declaring callee called
 * with a literal title and a test function. Data arguments are never titles.
 */
export function testTitles(source: string, fileName = "test.ts"): Map<string, number> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const titles = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && declaresTest(node.expression)) {
      const [title, body] = node.arguments;
      if (
        title &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) &&
        body &&
        (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
      )
        titles.set(title.text, file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
}

/** The declaration for `Class` or `Class.member` in a source file. */
function findDeclaration(file: ts.SourceFile, name: string): ts.Node | undefined {
  const [owner, member] = name.split(".");
  let found: ts.Node | undefined;
  file.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== owner) return;
    if (!member) found = node;
    else
      found = node.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === member);
  });
  return found;
}

/** Parses and validates the manifest's symbols. Never throws on content problems. */
export function checkContracts(root: string, input: unknown): ContractReport {
  const parsedManifest = manifestSchema.safeParse(input);
  if (!parsedManifest.success)
    return {
      symbols: [],
      problems: parsedManifest.error.issues.map(
        (issue) =>
          `docs/contracts/pilot.json: ${issue.path.join(".") || "manifest"}: ${issue.message}`
      )
    };
  const manifest = parsedManifest.data;
  const tsdoc = parser(root);
  const problems: string[] = [];
  const symbols: DocumentedSymbol[] = [];
  const ids = new Map<string, string>();
  const testCache = new Map<string, Map<string, number> | null>();
  const anchorCache = new Map<string, Set<string> | null>();
  const tests = (file: string) => {
    if (!testCache.has(file)) {
      const path = join(root, file);
      testCache.set(file, existsSync(path) ? testTitles(readFileSync(path, "utf8"), file) : null);
    }
    return testCache.get(file)!;
  };
  const anchors = (file: string) => {
    if (!anchorCache.has(file)) {
      const path = join(root, file);
      anchorCache.set(file, existsSync(path) ? markdownAnchors(readFileSync(path, "utf8")) : null);
    }
    return anchorCache.get(file)!;
  };

  for (const component of manifest.components) {
    const path = join(root, component.file);
    if (!existsSync(path)) {
      problems.push(`${component.file}: file not found`);
      continue;
    }
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(component.file, source, ts.ScriptTarget.Latest, true);
    for (const wanted of component.symbols) {
      const where = `${component.file} ${wanted.name}`;
      const declaration = findDeclaration(file, wanted.name);
      if (!declaration) {
        problems.push(`${where}: symbol not found`);
        continue;
      }
      const ranges = ts.getLeadingCommentRanges(source, declaration.getFullStart()) ?? [];
      const range = ranges.reverse().find((r) => source.slice(r.pos, r.pos + 3) === "/**");
      if (!range) {
        problems.push(`${where}: no documentation comment`);
        continue;
      }
      const parsed = tsdoc.parseString(source.slice(range.pos, range.end));
      for (const message of parsed.log.messages)
        problems.push(`${where}: malformed comment (${message.messageId})`);
      const blocks = parsed.docComment.customBlocks as readonly DocBlock[];
      const of = (tag: string) => blocks.filter((b) => b.blockTag.tagName === tag);
      const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
      const documented: DocumentedSymbol = {
        file: component.file,
        name: wanted.name,
        line,
        summary: text(parsed.docComment.summarySection),
        lifetime: "",
        invariants: [],
        decisions: []
      };
      if (!documented.summary) problems.push(`${where}: missing summary`);
      const lifetime = of("@lifetime").map((b) => text(b.content));
      if (lifetime.length !== 1 || !lifetime[0]) problems.push(`${where}: requires one @lifetime`);
      else documented.lifetime = lifetime[0];

      // Each @test belongs to the @invariant written before it.
      let current: Invariant | undefined;
      for (const block of blocks) {
        const tag = block.blockTag.tagName,
          body = text(block.content);
        if (!CUSTOM_TAGS.includes(tag)) continue;
        if (tag === "@invariant") {
          const [id, ...rest] = body.split(" ");
          const claim = rest.join(" ").replace(/^[—-]\s*/, "");
          if (!ID.test(id ?? "") || !claim) {
            problems.push(`${where}: malformed @invariant "${body.slice(0, 60)}"`);
            current = undefined;
            continue;
          }
          if (ids.has(id))
            problems.push(`${where}: duplicate invariant id ${id} (also ${ids.get(id)})`);
          ids.set(id, where);
          current = { id, claim, tests: [] };
          documented.invariants.push(current);
        } else if (tag === "@test") {
          const match = /^(\S+\.test\.ts) :: (.+)$/.exec(body);
          if (!match) {
            problems.push(`${where}: malformed @test "${body.slice(0, 60)}"`);
            continue;
          }
          if (!current) {
            problems.push(`${where}: @test before any @invariant`);
            continue;
          }
          const [, testFile, title] = match;
          const titles = tests(testFile);
          if (!titles) problems.push(`${where}: test file not found ${testFile}`);
          else if (!titles.has(title))
            problems.push(`${where}: test not declared in ${testFile}: "${title}"`);
          current.tests.push({ file: testFile, title, line: titles?.get(title) });
        } else if (tag === "@decision") {
          const match = /^(\S+\.md)#([a-z0-9-]+)$/.exec(body);
          if (!match) {
            problems.push(`${where}: malformed @decision "${body.slice(0, 60)}"`);
            continue;
          }
          const [, target, anchor] = match;
          const known = anchors(target);
          if (!known) problems.push(`${where}: decision file not found ${target}`);
          else if (!known.has(anchor))
            problems.push(`${where}: no section #${anchor} in ${target}`);
          documented.decisions.push({ target: body, file: target, anchor });
        }
      }
      if (!documented.invariants.length)
        problems.push(`${where}: requires at least one @invariant`);
      for (const invariant of documented.invariants)
        if (!invariant.tests.length)
          problems.push(`${where}: invariant ${invariant.id} has no @test`);
      if (wanted.decision && !documented.decisions.length)
        problems.push(`${where}: requires a @decision`);
      symbols.push(documented);
    }
  }
  return { symbols, problems };
}

/** The raw manifest; checkContracts validates it. */
export function loadManifest(root: string): unknown {
  return JSON.parse(readFileSync(join(root, "docs/contracts/pilot.json"), "utf8"));
}
