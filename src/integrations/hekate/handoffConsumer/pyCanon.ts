import type { ExactJsonDocument, JsonNode, NumberNode } from "./exactJson";

/**
 * Canonical-form checking for `py-canon.v0` (Hekate plan 034): the bytes Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
 * writes. It is not RFC 8785, and JavaScript cannot reproduce it by serializing.
 *
 * Each token and separator of a parsed document is compared with the spelling
 * Python would give its decoded value. Nothing is serialized in JavaScript to
 * produce the bytes, and digests are only ever taken over the received bytes.
 *
 * A float is judged from its own lexeme. A spelling Python's repr can never produce
 * is non-canonical; within the supported subset the lexeme must also carry the
 * shortest round-trip digits. Where JavaScript's shortest digits merely differ, or
 * the value is outside the subset, the result is `unsupported`: not proven either
 * way, and never reported as non-canonical.
 */

export type PyCanonResult =
  | { readonly status: "canonical" }
  | { readonly status: "noncanonical" }
  | { readonly status: "unsupported"; readonly reason: "NUMBER" };

/**
 * The supported float subset: -0.0 and every finite value in [0, 1e16), the range
 * Python's repr writes in fixed or small-exponent form. It covers the v0 producer's
 * fake clock (instants up to 1e12, and deadlines an instant plus a window), down to
 * subnormals. Other floats are unsupported here, never rounded or re-spelled.
 */
export const PY_FLOAT_LIMIT = 1e16;

const CANONICAL: PyCanonResult = Object.freeze({ status: "canonical" });
const NONCANONICAL: PyCanonResult = Object.freeze({ status: "noncanonical" });
const UNSUPPORTED: PyCanonResult = Object.freeze({ status: "unsupported", reason: "NUMBER" });

const SHORT: Record<number, string> = {
  0x22: '\\"',
  0x5c: "\\\\",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x08: "\\b",
  0x0c: "\\f"
};

/**
 * Python's quoted JSON spelling of a well-formed string: quote, backslash and the
 * short controls escaped, other controls below U+0020 as lowercase \u00xx, and
 * everything else (including '/', U+007F and U+2028/2029) as raw UTF-8. No
 * normalization.
 */
export function pyCanonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const short = SHORT[c];
    if (short !== undefined) out += short;
    else if (c < 0x20) out += "\\u00" + c.toString(16).padStart(2, "0");
    else out += value[i];
  }
  return out + '"';
}

/** Compares two well-formed strings by Unicode code point, as Python sorts keys. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** Significant digits (no leading or trailing zeros) and decimal point position. */
interface Decimal {
  digits: string;
  /** The value is 0.d1d2... × 10^decpt. */
  decpt: number;
}

function decimalOf(text: string): Decimal {
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  let digits = whole + fraction;
  let decpt = whole.length + Number(exponent);
  const lead = /^0*/.exec(digits)![0].length;
  digits = digits.slice(lead);
  decpt -= lead;
  digits = digits.replace(/0+$/, "");
  return { digits, decpt };
}

/** Python repr's spelling of a nonzero finite magnitude with these digits. */
function pyReprSpelling({ digits, decpt }: Decimal): string {
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return "0." + "0".repeat(-decpt) + digits;
    if (decpt >= digits.length) return digits + "0".repeat(decpt - digits.length) + ".0";
    return digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  const exponent = decpt - 1;
  const mantissa = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
  return `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

/** Whether a number lexeme (from a parsed document) is py-canon.v0. */
export function pyCanonNumber(node: NumberNode): PyCanonResult {
  const lexeme = node.lexeme;
  // Python writes an int as its digits; -0 parses to the int 0, written 0.
  if (node.integer) return lexeme === "-0" ? NONCANONICAL : CANONICAL;
  const value = Number(lexeme);
  if (!Number.isFinite(value)) return UNSUPPORTED;
  const negative = lexeme.startsWith("-");
  const magnitude = negative ? lexeme.slice(1) : lexeme;
  const own = decimalOf(magnitude);
  if (own.digits === "") {
    // A zero: repr writes 0.0 or -0.0 and nothing else.
    return magnitude === "0.0" ? CANONICAL : NONCANONICAL;
  }
  // A shape repr never writes for these digits is not canonical, whatever the value.
  if (magnitude !== pyReprSpelling(own)) return NONCANONICAL;
  if (negative || value >= PY_FLOAT_LIMIT) return UNSUPPORTED;
  const shortest = decimalOf(String(value));
  if (own.digits === shortest.digits && own.decpt === shortest.decpt) return CANONICAL;
  // repr is the shortest round-trip spelling, so a longer one is never repr output.
  // Any other difference is not proven here either way.
  return own.digits.length > shortest.digits.length ? NONCANONICAL : UNSUPPORTED;
}

/**
 * Whether a node of a parsed document, with every byte between and around its
 * tokens, is exactly py-canon.v0. A non-canonical byte anywhere decides the
 * result; otherwise any unsupported number makes it unsupported.
 */
export function pyCanonForm(doc: ExactJsonDocument, node: JsonNode = doc.root): PyCanonResult {
  const bytes = doc.bytes();
  const encoder = new TextEncoder();
  // The whole document has no bytes before or after its root value.
  if (node === doc.root && (node.start !== 0 || node.end !== doc.byteLength)) return NONCANONICAL;
  let unsupported: PyCanonResult | undefined;
  const sameBytes = (start: number, end: number, text: string) => {
    const expected = encoder.encode(text);
    if (expected.length !== end - start) return false;
    for (let k = 0; k < expected.length; k++) if (bytes[start + k] !== expected[k]) return false;
    return true;
  };
  // Iterative: depth is bounded by the reader, not by this call stack.
  const pending: JsonNode[] = [node];
  while (pending.length) {
    const n = pending.pop()!;
    switch (n.kind) {
      case "string":
        if (!sameBytes(n.start, n.end, pyCanonString(n.value))) return NONCANONICAL;
        break;
      case "number": {
        const result = pyCanonNumber(n);
        if (result.status === "noncanonical") return NONCANONICAL;
        if (result.status === "unsupported") unsupported ??= result;
        break;
      }
      case "boolean":
      case "null":
        break;
      case "array": {
        let at = n.start + 1;
        for (const [k, item] of n.items.entries()) {
          if (k > 0 && bytes[at++] !== 0x2c) return NONCANONICAL;
          if (item.start !== at) return NONCANONICAL;
          at = item.end;
          pending.push(item);
        }
        if (bytes[at] !== 0x5d || n.end !== at + 1) return NONCANONICAL;
        break;
      }
      case "object": {
        let at = n.start + 1;
        let previous: string | undefined;
        for (const [k, entry] of n.entries.entries()) {
          if (k > 0 && bytes[at++] !== 0x2c) return NONCANONICAL;
          if (previous !== undefined && compareCodePoints(previous, entry.key) >= 0)
            return NONCANONICAL;
          previous = entry.key;
          const { keySpan, value } = entry;
          if (
            keySpan.start !== at ||
            !sameBytes(keySpan.start, keySpan.end, pyCanonString(entry.key))
          )
            return NONCANONICAL;
          if (bytes[keySpan.end] !== 0x3a || value.start !== keySpan.end + 1) return NONCANONICAL;
          at = value.end;
          pending.push(value);
        }
        if (bytes[at] !== 0x7d || n.end !== at + 1) return NONCANONICAL;
        break;
      }
    }
  }
  return unsupported ?? CANONICAL;
}
