import { createHash } from "node:crypto";

/**
 * Exact-byte JSON reading for the offline handoff consumer (Hekate plan 034).
 *
 * Producer bytes are canonical Python output (`py-canon.v0`) and must never be
 * re-encoded in JavaScript to be checked: floats, key order and large integers
 * differ between the two. This reader therefore keeps what it read. It parses the
 * strict JSON grammar directly over a private copy of the bytes, records the byte
 * span of every key and value, keeps every number as its exact lexeme, and hashes
 * raw bytes only. It checks grammar, not canonical form: whitespace between tokens
 * is accepted, and canonical spelling is deliberately not checked here.
 *
 * Numbers are grammar-checked only: a lexeme such as `1e999`, whose value is not
 * finite, is kept as written. Finite-value and canonical-spelling validation is a
 * separate gate that every consumer of these documents must apply (the producer
 * refuses non-finite values); this reader does not provide it.
 *
 * Refusals carry a code only and never echo the input. Nothing is rounded,
 * truncated or repaired. Once returned, a document, its tree and its spans cannot
 * be changed, and raw bytes are only ever handed out as copies.
 */

export type ExactJsonErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LIMITS"
  | "INPUT_TOO_LARGE"
  | "BOM"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "LONE_SURROGATE"
  | "DUPLICATE_KEY"
  | "UNSAFE_KEY"
  | "TOO_DEEP"
  | "TOO_MANY_NODES"
  | "UNSUPPORTED_NUMBER"
  | "FOREIGN_NODE";

/** A refusal with a stable code; it never carries input content. */
export class ExactJsonError extends Error {
  constructor(readonly code: ExactJsonErrorCode) {
    super(code);
    this.name = "ExactJsonError";
  }
}

export interface ExactJsonLimits {
  /** Required: UTF-8 bytes of the whole input, checked before anything is read. */
  maxBytes: number;
  /** Nested objects and arrays, the outermost counting as 1. */
  maxDepth?: number;
  /** Values of every kind, containers included. */
  maxNodes?: number;
}

export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_MAX_NODES = 100_000;
const MAX_BYTES_CEILING = 16_777_216;
const MAX_DEPTH_CEILING = 1_024;
const MAX_NODES_CEILING = 10_000_000;

interface Span {
  /** Byte offset of the first byte of the token or value. */
  readonly start: number;
  /** Byte offset just past its last byte. */
  readonly end: number;
}
export interface ObjectEntry {
  readonly key: string;
  /** The key's string token, quotes included. */
  readonly keySpan: Span;
  readonly value: JsonNode;
}
export interface ObjectNode extends Span {
  readonly kind: "object";
  /** In input order. */
  readonly entries: readonly ObjectEntry[];
}
export interface ArrayNode extends Span {
  readonly kind: "array";
  readonly items: readonly JsonNode[];
}
export interface StringNode extends Span {
  readonly kind: "string";
  /** The decoded, well-formed value. */
  readonly value: string;
}
export interface NumberNode extends Span {
  readonly kind: "number";
  /** The number exactly as written. */
  readonly lexeme: string;
  /** True when written without a fraction or exponent. */
  readonly integer: boolean;
}
export interface BooleanNode extends Span {
  readonly kind: "boolean";
  readonly value: boolean;
}
export interface NullNode extends Span {
  readonly kind: "null";
}
export type JsonNode = ObjectNode | ArrayNode | StringNode | NumberNode | BooleanNode | NullNode;

/** SHA-256 hex of exactly these bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new ExactJsonError("INVALID_INPUT");
  return createHash("sha256").update(bytes).digest("hex");
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// Number nodes produced by readExactJson. Only these are converted, so a
// fabricated node can neither reach BigInt nor run a getter.
const parsedNumbers = new WeakSet<object>();

/**
 * The exact value of an integer lexeme, at any magnitude. A fraction or exponent
 * is refused even when its value is integral (`1.0`, `1e3`), as is `-0`, whose
 * sign an integer cannot keep: the representation is unsupported, and nothing is
 * converted. Only number nodes of a parsed document are accepted (FOREIGN_NODE
 * otherwise), checked before any property is read.
 */
export function exactInteger(node: NumberNode): bigint {
  if (!parsedNumbers.has(node)) throw new ExactJsonError("FOREIGN_NODE");
  if (!node.integer || node.lexeme === "-0") throw new ExactJsonError("UNSUPPORTED_NUMBER");
  return BigInt(node.lexeme);
}

/**
 * The value of an integer lexeme within ±(2^53 − 1). Anything else, including a
 * fraction, an exponent or a larger magnitude, is refused, never rounded.
 */
export function safeInteger(node: NumberNode): number {
  const value = exactInteger(node);
  if (value > MAX_SAFE || value < -MAX_SAFE) throw new ExactJsonError("UNSUPPORTED_NUMBER");
  return Number(value);
}

/** The value of a member, or undefined; lookup by decoded key, never via a prototype. */
export function member(node: ObjectNode, key: string): JsonNode | undefined {
  const index = memberIndex.get(node);
  if (!index) throw new ExactJsonError("FOREIGN_NODE");
  return index.get(key);
}

// Private lookup per object node: a Map handed out could still be changed.
const memberIndex = new WeakMap<ObjectNode, ReadonlyMap<string, JsonNode>>();
// Only readExactJson holds this, so no unvalidated document can be constructed.
const PARSED = Symbol("parsed");

/** A strictly parsed JSON document over a private, immutable copy of its bytes. */
export class ExactJsonDocument {
  readonly root: JsonNode;
  readonly byteLength: number;
  /** SHA-256 hex of the exact input bytes. */
  readonly sha256: string;
  readonly #bytes: Uint8Array;
  readonly #nodes: WeakSet<object>;

  /** Use readExactJson; any other construction is refused. */
  constructor(token: symbol, bytes: Uint8Array, root: JsonNode, nodes: WeakSet<object>) {
    if (token !== PARSED) throw new ExactJsonError("INVALID_INPUT");
    this.#bytes = bytes;
    this.#nodes = nodes;
    this.root = root;
    this.byteLength = bytes.byteLength;
    this.sha256 = sha256Hex(bytes);
    Object.freeze(this);
  }

  /** A copy of the whole input. */
  bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  /** A copy of the exact bytes of a node of this document, or of a key's token. */
  raw(span: JsonNode | Span): Uint8Array {
    if (!this.#nodes.has(span)) throw new ExactJsonError("FOREIGN_NODE");
    return this.#bytes.slice(span.start, span.end);
  }

  /** SHA-256 hex of the exact bytes of a node of this document. */
  rawSha256(span: JsonNode | Span): string {
    if (!this.#nodes.has(span)) throw new ExactJsonError("FOREIGN_NODE");
    return sha256Hex(this.#bytes.subarray(span.start, span.end));
  }
}

function resolveLimits(limits: unknown) {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new ExactJsonError("INVALID_LIMITS");
  const {
    maxBytes,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES
  } = limits as Record<string, unknown>;
  const bound = (value: unknown, ceiling: number) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling)
      throw new ExactJsonError("INVALID_LIMITS");
    return value;
  };
  return {
    maxBytes: bound(maxBytes, MAX_BYTES_CEILING),
    maxDepth: bound(maxDepth, MAX_DEPTH_CEILING),
    maxNodes: bound(maxNodes, MAX_NODES_CEILING)
  };
}

/** Without lone surrogates: unpaired UTF-16 halves can come only from \u escapes. */
function wellFormed(s: string) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const SHORT_ESCAPES: Record<number, string> = {
  0x22: '"',
  0x5c: "\\",
  0x2f: "/",
  0x62: "\b",
  0x66: "\f",
  0x6e: "\n",
  0x72: "\r",
  0x74: "\t"
};

const hexValue = (b: number) =>
  b >= 0x30 && b <= 0x39
    ? b - 0x30
    : b >= 0x61 && b <= 0x66
      ? b - 0x57
      : b >= 0x41 && b <= 0x46
        ? b - 0x37
        : -1;

type Frame =
  | {
      kind: "object";
      start: number;
      entries: ObjectEntry[];
      index: Map<string, JsonNode>;
      pending?: { key: string; keySpan: Span };
    }
  | { kind: "array"; start: number; items: JsonNode[] };

/**
 * Reads one strict JSON document from bytes. The input is copied first, and only
 * the copy is checked and kept, so later changes to the caller's buffer change
 * nothing. Iterative, so deep nesting fails with TOO_DEEP rather than exhausting
 * the call stack.
 */
export function readExactJson(input: Uint8Array, limits: ExactJsonLimits): ExactJsonDocument {
  if (!(input instanceof Uint8Array)) throw new ExactJsonError("INVALID_INPUT");
  const { maxBytes, maxDepth, maxNodes } = resolveLimits(limits);
  if (input.byteLength > maxBytes) throw new ExactJsonError("INPUT_TOO_LARGE");
  const bytes = new Uint8Array(input);
  const n = bytes.length;
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new ExactJsonError("BOM");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    decoder.decode(bytes);
  } catch {
    throw new ExactJsonError("INVALID_UTF8");
  }

  const nodes = new WeakSet<object>();
  let count = 0;
  let i = 0;
  const fail = (code: ExactJsonErrorCode = "INVALID_JSON"): never => {
    throw new ExactJsonError(code);
  };
  const made = <T extends JsonNode>(node: T): T => {
    if (++count > maxNodes) fail("TOO_MANY_NODES");
    nodes.add(Object.freeze(node));
    return node;
  };
  const ws = () => {
    for (; i < n; i++) {
      const c = bytes[i];
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    }
  };

  /** Reads a string token at i (an opening quote); returns its decoded value. */
  const readString = (): string => {
    i++;
    let value = "";
    let run = i;
    for (;;) {
      if (i >= n) fail();
      const b = bytes[i];
      if (b === 0x22) {
        // The whole input is valid UTF-8 and runs end at ASCII bytes, so each run decodes whole.
        value += decoder.decode(bytes.subarray(run, i));
        i++;
        break;
      }
      if (b < 0x20) fail();
      if (b !== 0x5c) {
        i++;
        continue;
      }
      value += decoder.decode(bytes.subarray(run, i));
      const e = bytes[i + 1];
      if (e === 0x75) {
        let code = 0;
        for (let k = 2; k < 6; k++) {
          const h = i + k < n ? hexValue(bytes[i + k]) : -1;
          if (h < 0) fail();
          code = code * 16 + h;
        }
        value += String.fromCharCode(code);
        i += 6;
      } else {
        const short = e === undefined ? undefined : SHORT_ESCAPES[e];
        if (short === undefined) fail();
        value += short;
        i += 2;
      }
      run = i;
    }
    if (!wellFormed(value)) fail("LONE_SURROGATE");
    return value;
  };

  const digits = () => {
    const from = i;
    while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    return i - from;
  };

  /** Reads a number token, keeping its lexeme exactly. */
  const readNumber = (): NumberNode => {
    const start = i;
    let integer = true;
    if (bytes[i] === 0x2d) i++;
    if (bytes[i] === 0x30) i++;
    else if (bytes[i] >= 0x31 && bytes[i] <= 0x39) digits();
    else fail();
    if (bytes[i] === 0x2e) {
      i++;
      integer = false;
      if (!digits()) fail();
    }
    if (bytes[i] === 0x65 || bytes[i] === 0x45) {
      i++;
      integer = false;
      if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;
      if (!digits()) fail();
    }
    // Digits, signs, '.', 'e' and 'E' only: ASCII, so the decoder is exact.
    const lexeme = decoder.decode(bytes.subarray(start, i));
    const node = made<NumberNode>({ kind: "number", start, end: i, lexeme, integer });
    parsedNumbers.add(node);
    return node;
  };

  const literal = (text: string) => {
    for (let k = 0; k < text.length; k++) if (bytes[i + k] !== text.charCodeAt(k)) fail();
    i += text.length;
  };

  const readScalar = (): JsonNode => {
    const start = i;
    const c = bytes[i];
    if (c === 0x22) {
      const value = readString();
      return made<StringNode>({ kind: "string", start, end: i, value });
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return readNumber();
    if (c === 0x74) {
      literal("true");
      return made<BooleanNode>({ kind: "boolean", start, end: i, value: true });
    }
    if (c === 0x66) {
      literal("false");
      return made<BooleanNode>({ kind: "boolean", start, end: i, value: false });
    }
    if (c === 0x6e) {
      literal("null");
      return made<NullNode>({ kind: "null", start, end: i });
    }
    return fail();
  };

  /** Reads `"key" :` into the frame, refusing duplicate and prototype keys. */
  const readKey = (frame: Extract<Frame, { kind: "object" }>) => {
    if (bytes[i] !== 0x22) fail();
    const start = i;
    const key = readString();
    if (key === "__proto__") fail("UNSAFE_KEY");
    if (frame.index.has(key)) fail("DUPLICATE_KEY");
    const keySpan = Object.freeze({ start, end: i });
    nodes.add(keySpan);
    frame.pending = { key, keySpan };
    ws();
    if (bytes[i] !== 0x3a) fail();
    i++;
  };

  const stack: Frame[] = [];
  const open = () => {
    if (++count > maxNodes) fail("TOO_MANY_NODES");
    if (stack.length >= maxDepth) fail("TOO_DEEP");
  };
  const closeObject = (frame: Extract<Frame, { kind: "object" }>): ObjectNode => {
    const node: ObjectNode = Object.freeze({
      kind: "object",
      start: frame.start,
      end: i,
      entries: Object.freeze(frame.entries)
    });
    nodes.add(node);
    memberIndex.set(node, frame.index);
    return node;
  };
  const closeArray = (frame: Extract<Frame, { kind: "array" }>): ArrayNode => {
    const node: ArrayNode = Object.freeze({
      kind: "array",
      start: frame.start,
      end: i,
      items: Object.freeze(frame.items)
    });
    nodes.add(node);
    return node;
  };

  let last: JsonNode | undefined;
  for (;;) {
    if (last === undefined) {
      // A value is expected at i.
      ws();
      const c = bytes[i];
      if (c === 0x7b) {
        open();
        const frame: Frame = { kind: "object", start: i, entries: [], index: new Map() };
        stack.push(frame);
        i++;
        ws();
        if (bytes[i] === 0x7d) {
          i++;
          stack.pop();
          last = closeObject(frame);
        } else readKey(frame);
      } else if (c === 0x5b) {
        open();
        const frame: Frame = { kind: "array", start: i, items: [] };
        stack.push(frame);
        i++;
        ws();
        if (bytes[i] === 0x5d) {
          i++;
          stack.pop();
          last = closeArray(frame);
        }
      } else last = readScalar();
      continue;
    }
    // A value is complete: attach it to its container, or finish.
    const top = stack.at(-1);
    if (!top) {
      ws();
      if (i !== n) fail();
      break;
    }
    if (top.kind === "array") top.items.push(last);
    else {
      const { key, keySpan } = top.pending!;
      top.entries.push(Object.freeze({ key, keySpan, value: last }));
      top.index.set(key, last);
      top.pending = undefined;
    }
    ws();
    const c = bytes[i];
    if (c === 0x2c) {
      i++;
      last = undefined;
      if (top.kind === "object") {
        ws();
        readKey(top);
      }
    } else if (top.kind === "array" && c === 0x5d) {
      i++;
      stack.pop();
      last = closeArray(top);
    } else if (top.kind === "object" && c === 0x7d) {
      i++;
      stack.pop();
      last = closeObject(top);
    } else fail();
  }
  return new ExactJsonDocument(PARSED, bytes, last as JsonNode, nodes);
}
