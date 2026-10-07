import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExactJsonDocument,
  ExactJsonError,
  exactInteger,
  member,
  readExactJson,
  safeInteger,
  sha256Hex,
  type JsonNode,
  type NumberNode,
  type ObjectNode
} from "../../src/integrations/hekate/handoffConsumer/exactJson";

// The reviewed producer bundle, read as raw bytes only (never decoded and re-encoded).
const BUNDLE = "tests/fixtures/hekate/e2e-consumer-v0";
// Pinned when the bundle was copied; every other file is pinned by INDEX.sha256.
const INDEX_SHA256 = "6093034b04c0762daf55eace33ba6ea226966591016a4fd56a780b50458daf0b";
const CANDIDATE_DIGEST = "21305a74e6c904c436ac9aeae58c6e43f4f963a0573a7d3ea19660c23eab776e";
const MiB = 1_048_576;

const bundle = (rel: string) => readFileSync(join(BUNDLE, rel));
const read = (text: string, limits: Parameters<typeof readExactJson>[1] = { maxBytes: MiB }) =>
  readExactJson(Buffer.from(text, "utf8"), limits);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExactJsonError) return error.code;
    throw error;
  }
  return "OK";
};
/** Follows object keys and array indexes from a node. */
const at = (node: JsonNode, ...path: (string | number)[]): JsonNode => {
  let current: JsonNode | undefined = node;
  for (const step of path) {
    if (typeof step === "number" && current?.kind === "array") current = current.items[step];
    else if (typeof step === "string" && current?.kind === "object")
      current = member(current, step);
    else current = undefined;
    if (!current) throw new Error(`no ${String(step)}`);
  }
  return current!;
};
const num = (node: JsonNode) => {
  if (node.kind !== "number") throw new Error("not a number");
  return node;
};
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("the e2e-consumer-v0 bundle", () => {
  it("matches its pinned index exactly: 26 indexed files plus the index", () => {
    const index = bundle("INDEX.sha256");
    expect(sha256Hex(index)).toBe(INDEX_SHA256);
    const lines = index.toString("utf8").split("\n");
    expect(lines.pop()).toBe("");
    const listed = lines.map((line) => {
      const [digest, rel, ...rest] = line.split("  ");
      expect(rest).toEqual([]);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(bundle(rel)), rel).toBe(digest);
      return rel;
    });
    expect(listed).toHaveLength(26);
    // Nothing unlisted: every file on disk is indexed, apart from the index itself.
    const files = (readdirSync(BUNDLE, { recursive: true }) as string[])
      .filter((rel) => statSync(join(BUNDLE, rel)).isFile())
      .map((rel) => rel.split(sep).join("/"))
      .sort();
    expect(files).toEqual([...listed, "INDEX.sha256"].sort());
  });

  it("parses every JSON file in the bundle, keeping each document's own digest", () => {
    const digests = new Map(
      bundle("INDEX.sha256")
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("  ").reverse() as [string, string])
    );
    for (const rel of [...digests.keys()].filter((r) => /\.(json|bin)$/.test(r))) {
      const doc = readExactJson(bundle(rel), { maxBytes: MiB });
      expect(doc.sha256, rel).toBe(digests.get(rel));
      expect(Buffer.from(doc.bytes()).equals(bundle(rel)), rel).toBe(true);
    }
  });

  it("finds the manifest inside the envelope as exactly the manifest bytes", () => {
    const manifest = bundle("delivery/manifest.bin");
    const envelope = readExactJson(bundle("delivery/envelope.bin"), { maxBytes: MiB });
    const node = at(envelope.root, "manifest");
    expect(Buffer.from(envelope.raw(node)).equals(manifest)).toBe(true);
    expect(envelope.rawSha256(node)).toBe(CANDIDATE_DIGEST);
    expect(sha256Hex(manifest)).toBe(CANDIDATE_DIGEST);
    // The receipt names the same digest.
    const receipt = readExactJson(bundle("delivery/receipt.json"), { maxBytes: 4096 });
    expect((at(receipt.root, "candidateDigest") as { value: string }).value).toBe(CANDIDATE_DIGEST);
    expect(safeInteger(num(at(receipt.root, "seq")))).toBe(8);
  });

  it("keeps the manifest's floats as written and refuses them as integers", () => {
    const manifest = readExactJson(bundle("delivery/manifest.bin"), { maxBytes: MiB });
    const value = at(manifest.root, "obligations", "phase", "value");
    for (const [key, lexeme] of [
      ["anchorAt", "1200.0"],
      ["deadline", "3000.0"]
    ]) {
      const node = num(at(value, key));
      expect(node).toMatchObject({ lexeme, integer: false });
      expect(text(manifest.raw(node))).toBe(lexeme);
      expect(code(() => safeInteger(node))).toBe("UNSUPPORTED_NUMBER");
      expect(code(() => exactInteger(node))).toBe("UNSUPPORTED_NUMBER");
    }
    const ack = num(at(manifest.root, "optional", "diagnostics", "ack", "value", "at"));
    expect(ack.lexeme).toBe("1100.0");
  });
});

describe("numbers", () => {
  it("keeps every lexeme exactly, integral or not", () => {
    const lexemes = [
      "0",
      "-1",
      "9007199254740991",
      "9007199254740992",
      "9223372036854775807",
      "123456789012345678901234567890",
      "1000.0",
      "-0.0",
      "1e-07",
      "5e-324",
      "1E+3",
      "-0"
    ];
    const doc = read(`[${lexemes.join(", ")}]`);
    const items = (doc.root as { items: readonly JsonNode[] }).items.map(num);
    expect(items.map((n) => n.lexeme)).toEqual(lexemes);
    expect(items.map((n) => text(doc.raw(n)))).toEqual(lexemes);
    expect(items.map((n) => n.integer)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true
    ]);
  });

  it("gives exact integers at any size and safe ones only within 2^53 - 1", () => {
    const doc = read(
      "[9007199254740991, -9007199254740991, 9007199254740992, 9223372036854775807, 123456789012345678901234567890]"
    );
    const [maxSafe, minSafe, twoTo53, twoTo63Less1, huge] = (
      doc.root as { items: readonly JsonNode[] }
    ).items.map(num);
    expect(safeInteger(maxSafe)).toBe(Number.MAX_SAFE_INTEGER);
    expect(safeInteger(minSafe)).toBe(-Number.MAX_SAFE_INTEGER);
    for (const n of [twoTo53, twoTo63Less1, huge])
      expect(code(() => safeInteger(n))).toBe("UNSUPPORTED_NUMBER");
    expect(exactInteger(twoTo53)).toBe(2n ** 53n);
    expect(exactInteger(twoTo63Less1)).toBe(2n ** 63n - 1n);
    expect(exactInteger(huge)).toBe(123456789012345678901234567890n);
  });

  it("refuses every non-integer representation, and -0, instead of converting it", () => {
    for (const lexeme of ["1.0", "1e3", "1E+3", "-0.0", "1e-07", "-0"]) {
      const node = num(read(lexeme).root);
      expect(
        code(() => safeInteger(node)),
        lexeme
      ).toBe("UNSUPPORTED_NUMBER");
      expect(
        code(() => exactInteger(node)),
        lexeme
      ).toBe("UNSUPPORTED_NUMBER");
    }
  });

  it("converts only parsed number nodes, refusing forged ones before reading them", () => {
    let reads = 0;
    const forged = [
      { kind: "number", start: 0, end: 1, integer: true, lexeme: "1" },
      { kind: "number", start: 0, end: 1, integer: true, lexeme: "sensitive-not-a-number" },
      { kind: "number", integer: true, lexeme: "1".repeat(64) },
      { kind: "string", value: "1" },
      // A copy of a parsed node is not that node.
      { ...num(read("7").root) },
      // Getters would run on any property read.
      {
        get kind() {
          reads++;
          return "number";
        },
        get integer() {
          reads++;
          return true;
        },
        get lexeme() {
          reads++;
          return "sensitive";
        }
      },
      Object.freeze({ kind: "number", integer: true, lexeme: "2" }),
      null,
      undefined,
      "1",
      1
    ];
    for (const node of forged)
      for (const accessor of [safeInteger, exactInteger]) {
        let error: unknown;
        try {
          accessor(node as unknown as NumberNode);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(ExactJsonError);
        expect((error as ExactJsonError).code).toBe("FOREIGN_NODE");
        expect((error as Error).message).toBe("FOREIGN_NODE");
      }
    expect(reads).toBe(0);
    // Parsed numbers from any document stay convertible.
    expect(safeInteger(num(at(read("[41]").root, 0)))).toBe(41);
    expect(exactInteger(num(at(read('{"n":-42}').root, "n")))).toBe(-42n);
  });

  it("keeps a non-finite lexeme as written; finite validation is the consumer's gate", () => {
    const node = num(read("1e999").root);
    expect(node).toMatchObject({ lexeme: "1e999", integer: false });
    expect(code(() => safeInteger(node))).toBe("UNSUPPORTED_NUMBER");
    expect(code(() => exactInteger(node))).toBe("UNSUPPORTED_NUMBER");
  });
});

describe("grammar and keys", () => {
  it.each([
    "",
    " ",
    "{",
    "}",
    "[1,]",
    "[,1]",
    '{"a":1,}',
    '{"a" 1}',
    "{a:1}",
    "[1 2]",
    "1 2",
    "01",
    "-01",
    "1.",
    ".5",
    "+1",
    "-",
    "1e",
    "1e+",
    "NaN",
    "Infinity",
    "'a'",
    "tru",
    "nul",
    "falsey",
    '"abc',
    '"\\x"',
    '"\\u12G4"',
    '"\\u12"',
    '"tab\there"',
    '"line\nbreak"',
    "[1] "
  ])("refuses malformed JSON %j", (input) => {
    expect(code(() => read(input))).toBe("INVALID_JSON");
  });

  it("refuses duplicate keys, including escaped spellings, at any depth", () => {
    for (const input of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"é":1,"\\u00e9":2}',
      '{"x":{"b":[],"b":null}}'
    ])
      expect(
        code(() => read(input)),
        input
      ).toBe("DUPLICATE_KEY");
    // The same key in different objects is not a duplicate.
    expect(code(() => read('{"a":{"a":1},"b":[{"a":2},{"a":3}]}'))).toBe("OK");
  });

  it("refuses __proto__ in any spelling and has no prototype lookups", () => {
    for (const input of ['{"__proto__":1}', '{"__pro\\u0074o__":{}}', '[{"__proto__":null}]'])
      expect(
        code(() => read(input)),
        input
      ).toBe("UNSAFE_KEY");
    const root = read('{"constructor":1}').root as ObjectNode;
    expect(num(member(root, "constructor")!).lexeme).toBe("1");
    expect(member(root, "toString")).toBeUndefined();
    expect(member(root, "hasOwnProperty")).toBeUndefined();
  });

  it("decodes escapes and keeps entries in input order", () => {
    const root = read(
      '{"z":"\\"\\\\\\/\\b\\f\\n\\r\\t","a":"\\u00e9\\ud83d\\ude00","m":[true,false,null]}'
    ).root as ObjectNode;
    expect(root.entries.map((e) => e.key)).toEqual(["z", "a", "m"]);
    expect((member(root, "z") as { value: string }).value).toBe('"\\/\b\f\n\r\t');
    expect((member(root, "a") as { value: string }).value).toBe("é😀");
    expect((member(root, "m") as { items: readonly JsonNode[] }).items.map((n) => n.kind)).toEqual([
      "boolean",
      "boolean",
      "null"
    ]);
  });
});

describe("encoding", () => {
  it("refuses a byte-order mark", () => {
    expect(
      code(() => readExactJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), { maxBytes: 10 }))
    ).toBe("BOM");
  });

  it.each([
    ["an invalid byte", [0x22, 0xff, 0x22]],
    ["an overlong encoding", [0x22, 0xc0, 0xaf, 0x22]],
    ["an encoded surrogate", [0x22, 0xed, 0xa0, 0x80, 0x22]],
    ["a truncated sequence", [0x22, 0xe6, 0x97, 0x22]],
    ["a stray continuation byte", [0x22, 0x80, 0x22]]
  ])("refuses %s", (_label, bytes) => {
    expect(code(() => readExactJson(Uint8Array.from(bytes), { maxBytes: 16 }))).toBe(
      "INVALID_UTF8"
    );
  });

  it("refuses escaped lone surrogates in values and keys, and accepts a valid pair", () => {
    for (const input of [
      '"\\ud800"',
      '"\\udc00"',
      '"\\ud800x"',
      '"\\ud800\\u0041"',
      '"\\udc00\\ud800"',
      '{"\\ud83d":1}'
    ])
      expect(
        code(() => read(input)),
        input
      ).toBe("LONE_SURROGATE");
    expect((read('"\\ud83d\\ude00"').root as { value: string }).value).toBe("😀");
  });

  it("records byte spans, not UTF-16 offsets, around multibyte and astral text", () => {
    const source = '{"é":"日本語","😀":[1,"ß"],"k":true}';
    const bytes = Buffer.from(source, "utf8");
    const doc = readExactJson(bytes, { maxBytes: 1024 });
    const root = doc.root as ObjectNode;
    for (const entry of root.entries) {
      const token = `"${entry.key}"`;
      const start = bytes.indexOf(Buffer.from(token, "utf8"));
      expect(entry.keySpan).toEqual({ start, end: start + Buffer.byteLength(token) });
      expect(text(doc.raw(entry.keySpan))).toBe(token);
    }
    expect(text(doc.raw(at(root, "é")))).toBe('"日本語"');
    expect(text(doc.raw(at(root, "😀")))).toBe('[1,"ß"]');
    expect(text(doc.raw(at(root, "😀", 1)))).toBe('"ß"');
    expect(at(root, "k").start).toBe(bytes.indexOf(Buffer.from("true")));
    expect(doc.rawSha256(root)).toBe(sha256Hex(bytes));
  });

  it("excludes surrounding whitespace from spans", () => {
    const doc = read(' { "a" : [ 1 , 2 ] } \n');
    expect(doc.root).toMatchObject({ start: 1, end: 20 });
    expect(text(doc.raw(at(doc.root, "a")))).toBe("[ 1 , 2 ]");
    expect(text(doc.raw(at(doc.root, "a", 1)))).toBe("2");
  });
});

describe("bounds", () => {
  it("checks the byte cap before reading, exactly at the limit", () => {
    const fits = Buffer.from('"0123456789"');
    expect(code(() => readExactJson(fits, { maxBytes: fits.length }))).toBe("OK");
    expect(code(() => readExactJson(fits, { maxBytes: fits.length - 1 }))).toBe("INPUT_TOO_LARGE");
    // Refused before any decoding: invalid bytes over the cap report the cap.
    expect(code(() => readExactJson(Uint8Array.from([0xff, 0xff]), { maxBytes: 1 }))).toBe(
      "INPUT_TOO_LARGE"
    );
  });

  it("bounds nesting depth, failing typed rather than overflowing the stack", () => {
    const nest = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    expect(code(() => read(nest(8), { maxBytes: MiB, maxDepth: 8 }))).toBe("OK");
    expect(code(() => read(nest(9), { maxBytes: MiB, maxDepth: 8 }))).toBe("TOO_DEEP");
    expect(code(() => read('{"a":{"b":{}}}', { maxBytes: MiB, maxDepth: 2 }))).toBe("TOO_DEEP");
    // Far deeper than any call stack, under the default bound.
    expect(code(() => read(nest(200_000), { maxBytes: MiB }))).toBe("TOO_DEEP");
  });

  it("bounds the number of values, containers included", () => {
    // One array holding k values is k + 1 nodes.
    const array = (k: number) => `[${Array(k).fill("0").join(",")}]`;
    expect(code(() => read(array(9), { maxBytes: MiB, maxNodes: 10 }))).toBe("OK");
    expect(code(() => read(array(10), { maxBytes: MiB, maxNodes: 10 }))).toBe("TOO_MANY_NODES");
    expect(code(() => read('{"a":{}}', { maxBytes: MiB, maxNodes: 1 }))).toBe("TOO_MANY_NODES");
  });

  it("refuses invalid limits and non-byte input", () => {
    for (const limits of [
      undefined,
      null,
      [],
      {},
      { maxBytes: 0 },
      { maxBytes: 1.5 },
      { maxBytes: Number.NaN },
      { maxBytes: "10" },
      { maxBytes: 16_777_217 },
      { maxBytes: 10, maxDepth: 0 },
      { maxBytes: 10, maxNodes: -1 }
    ])
      expect(
        code(() => readExactJson(Buffer.from("1"), limits as never)),
        JSON.stringify(limits)
      ).toBe("INVALID_LIMITS");
    for (const input of ["{}", [123, 125], null])
      expect(code(() => readExactJson(input as never, { maxBytes: 10 }))).toBe("INVALID_INPUT");
    expect(code(() => sha256Hex("abc" as never))).toBe("INVALID_INPUT");
  });

  it("never echoes input in a refusal", () => {
    let message: string | undefined;
    try {
      read('{"secret-value":1,"secret-value":2}');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("DUPLICATE_KEY");
  });
});

describe("immutability", () => {
  it("keeps its own copy: later changes to the caller's buffer change nothing", () => {
    const input = Buffer.from('{"a":"x","b":[1]}');
    const original = Buffer.from(input);
    const doc = readExactJson(input, { maxBytes: 64 });
    input.fill(0x20);
    expect(Buffer.from(doc.bytes()).equals(original)).toBe(true);
    expect(text(doc.raw(at(doc.root, "a")))).toBe('"x"');
    expect(doc.sha256).toBe(sha256Hex(original));
  });

  it("hands out copies: changing a returned slice changes nothing", () => {
    const doc = read('{"a":"x"}');
    const slice = doc.raw(at(doc.root, "a"));
    slice.fill(0);
    const whole = doc.bytes();
    whole.fill(0);
    expect(text(doc.raw(at(doc.root, "a")))).toBe('"x"');
    expect(text(doc.bytes())).toBe('{"a":"x"}');
  });

  it("freezes the document, every node, entry, list and span", () => {
    const doc = read('{"a":[1,{"b":"c"}]}');
    const root = doc.root as ObjectNode;
    const list = at(root, "a");
    for (const value of [
      doc,
      root,
      root.entries,
      root.entries[0],
      root.entries[0].keySpan,
      list,
      (list as { items: readonly JsonNode[] }).items,
      at(root, "a", 1, "b")
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (root as { start: number }).start = 5;
    }).toThrow(TypeError);
    expect(() => {
      (root.entries as unknown as unknown[]).push(root);
    }).toThrow(TypeError);
  });

  it("only reads spans of its own nodes, and cannot be constructed unparsed", () => {
    const one = read('{"a":1}');
    const two = read('{"a":1}');
    expect(code(() => one.raw(two.root))).toBe("FOREIGN_NODE");
    expect(code(() => one.raw({ kind: "null", start: 0, end: 3 } as JsonNode))).toBe(
      "FOREIGN_NODE"
    );
    expect(code(() => one.rawSha256({ start: 0, end: 7 }))).toBe("FOREIGN_NODE");
    expect(code(() => member({ kind: "object" } as ObjectNode, "a"))).toBe("FOREIGN_NODE");
    expect(
      code(() => new ExactJsonDocument(Symbol("parsed"), new Uint8Array(), one.root, new WeakSet()))
    ).toBe("INVALID_INPUT");
  });
});
