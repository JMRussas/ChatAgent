import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExactJson, sha256Hex } from "../../src/integrations/hekate/handoffConsumer/exactJson";
import {
  compareCodePoints,
  pyCanonForm,
  pyCanonString
} from "../../src/integrations/hekate/handoffConsumer/pyCanon";
import {
  DeliveryRefusal,
  verifyDelivery,
  type HandoffDelivery
} from "../../src/integrations/hekate/handoffConsumer/delivery";

// py-canon.v0 canonical-form checking against the reviewed byte-compatibility
// vectors (Hekate e2e-byte-compat-v0) and targeted Python repr spellings.
const VECTORS = "tests/fixtures/hekate/e2e-byte-compat-v0/vectors";
const expected: Record<
  string,
  {
    sha256: string;
    strict: "ok" | "strict_json";
    pyCanonV0Canonical: boolean | null;
    producerReachable: boolean;
  }
> = JSON.parse(readFileSync(join(VECTORS, "expected.json"), "utf8"));

const read = (text: string | Uint8Array) =>
  readExactJson(typeof text === "string" ? Buffer.from(text, "utf8") : text, { maxBytes: 4096 });
const form = (text: string) => pyCanonForm(read(text)).status;

/** The strict reading stage alone, through the receipt (read before any digest). */
function strictOutcome(bytes: Uint8Array) {
  const delivery: HandoffDelivery = {
    wrapper: "handoff-delivery.v0",
    codec: "py-canon.v0",
    candidateDigest: "",
    manifest: new Uint8Array(),
    envelope: new Uint8Array(),
    task: new Uint8Array(),
    receipt: bytes,
    h1Input: new Uint8Array()
  };
  try {
    verifyDelivery(delivery);
  } catch (error) {
    // Past strict reading, a vector is never a receipt: it is refused for its shape.
    const code = (error as DeliveryRefusal).code;
    return code === "receipt_shape" ? "ok" : code;
  }
  throw new Error("a vector cannot pass as a delivery");
}

describe("byte-compatibility vectors", () => {
  const names = Object.keys(expected);
  it("covers all 34 reviewed vectors", () => {
    expect(names).toHaveLength(34);
  });

  it.each(names)("%s: hash, strict reading and canonical form", (name) => {
    const vector = expected[name];
    const bytes = new Uint8Array(readFileSync(join(VECTORS, `${name}.bin`)));
    expect(sha256Hex(bytes)).toBe(vector.sha256);
    expect(strictOutcome(bytes)).toBe(vector.strict);
    if (vector.pyCanonV0Canonical === null) return;
    const status = pyCanonForm(read(bytes)).status;
    if (vector.pyCanonV0Canonical === false) expect(status).toBe("noncanonical");
    // Producer-reachable canonical values are proven; an unreachable float boundary
    // (an exponent >= 1e16) is reported as unsupported, never as non-canonical.
    else if (name === "float-large-exponent") expect(status).toBe("unsupported");
    else expect(status).toBe("canonical");
  });
});

describe("Python float repr spellings", () => {
  it.each([
    ["1000.0", "canonical"],
    ["-0.0", "canonical"],
    ["0.0", "canonical"],
    ["0.5", "canonical"],
    ["0.0001", "canonical"],
    ["1e-05", "canonical"],
    ["1.5e-05", "canonical"],
    ["5e-324", "canonical"],
    ["999999999999.5", "canonical"],
    ["1000000000000.0", "canonical"],
    ["1000000001799.5", "canonical"],
    // CPython repr at the 1e12, 2^53 and 1e16 boundaries (uv, Python 3.13.13).
    ["1000000000000.0001", "canonical"],
    ["9007199254740991.0", "canonical"],
    ["9007199254740992.0", "canonical"],
    ["9007199254740994.0", "canonical"],
    ["4503599627370495.5", "canonical"],
    ["4503599627370497.0", "canonical"],
    ["1234567890123.4568", "canonical"],
    ["1000000000000000.2", "canonical"],
    ["9999999999999998.0", "canonical"],
    ["0.1", "canonical"],
    ["0.30000000000000004", "canonical"]
  ])("accepts %s", (lexeme, status) => {
    expect(form(`[${lexeme}]`)).toBe(status);
  });

  it.each([
    // Shapes repr never writes, whatever the value: provably non-canonical.
    "1000.00",
    "999999999999.50",
    "0.00001",
    "1e-5",
    "1E-05",
    "1.1e3",
    "1e0",
    "0.00",
    "-0.00",
    "0e0",
    "-0",
    "1.0e-05",
    // Round-trips, but longer than the shortest round-trip digits.
    "0.10000000000000001",
    "1234567890123.45678"
  ])("refuses %s as non-canonical", (lexeme) => {
    expect(form(`[${lexeme}]`)).toBe("noncanonical");
  });

  it.each([
    // Repr-shaped, outside the supported subset [0, 1e12] and -0.0: not judged.
    "-1.5",
    "-5e-324",
    "1e+16",
    "1.7976931348623157e+308",
    // 2^53 + 1 is not a double and reads as 2^53, whose repr has as many digits but
    // different ones: equal length is not decided here (Python calls it non-canonical).
    "9007199254740993.0"
  ])("reports %s as unsupported, not non-canonical", (lexeme) => {
    expect(form(`[${lexeme}]`)).toBe("unsupported");
  });

  it("keeps integers exact at any magnitude", () => {
    for (const lexeme of [
      "0",
      "-1",
      "9007199254740993",
      "9223372036854775807",
      "-123456789012345678901234567890"
    ])
      expect(form(`[${lexeme}]`)).toBe("canonical");
  });

  it("lets a non-canonical byte decide over an unsupported number", () => {
    expect(form("[1e+16, 1]")).toBe("noncanonical");
    expect(form("[1e+16,1]")).toBe("unsupported");
  });
});

describe("Python string and key spellings", () => {
  it("escapes only quote, backslash and controls, lowercase and raw elsewhere", () => {
    expect(pyCanonString('a"b\\c\n\r\t\b\f\u0000\u001f\u007f/ é\u{1f600}')).toBe(
      '"a\\"b\\\\c\\n\\r\\t\\b\\f\\u0000\\u001f\u007f/ é\u{1f600}"'
    );
  });

  it("refuses escapes Python never writes", () => {
    expect(form('["\\/"]')).toBe("noncanonical");
    expect(form('["\\u00e9"]')).toBe("noncanonical");
    expect(form('["\\u001F"]')).toBe("noncanonical");
    expect(form('["\\u001f"]')).toBe("canonical");
  });

  it("orders keys by code point, not UTF-16 unit", () => {
    // U+FB01 sorts before U+1F600 by code point but after it by UTF-16 unit.
    expect(compareCodePoints("ﬁ", "\u{1f600}")).toBeLessThan(0);
    expect(["\u{1f600}", "ﬁ"].sort()).toEqual(["\u{1f600}", "ﬁ"]);
    expect(form('{"ﬁ":1,"\u{1f600}":2}')).toBe("canonical");
    expect(form('{"\u{1f600}":2,"ﬁ":1}')).toBe("noncanonical");
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("ab", "ab")).toBe(0);
  });

  it("refuses whitespace, unsorted keys and padding anywhere", () => {
    for (const text of [
      '{"a":1, "b":2}',
      '{"b":1,"a":2}',
      "[1 ,2]",
      " [1]",
      "[1]\n",
      '{"a" :1}',
      "[ ]"
    ])
      expect(form(text)).toBe("noncanonical");
    for (const text of ['{"a":[],"b":{}}', "[]", "{}", '[true,false,null,"x"]'])
      expect(form(text)).toBe("canonical");
  });
});
