import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  chatAgentH1,
  composeHandoff,
  CompositionRefusal,
  ESTIMATOR_ID,
  type Composition,
  type ImportPolicy,
  type Retriever
} from "./compose";
import {
  DeliveryRefusal,
  INGRESS_LIMITS,
  type FreshSnapshot,
  type HandoffDelivery
} from "./delivery";
import { ExactJsonError, readExactJson, sha256Hex, type JsonNode } from "./exactJson";
import { AttachRefusal, HANDOFF_VIEW_SLOT, handoffWorkerRequest } from "./workerContext";

/**
 * The offline operator tool over the accepted handoff consumer:
 *
 *   npx tsx scripts/handoff.ts compose --delivery <dir> --fresh <file> --policy <file>
 *     --request <file> --out <new-dir> [--retrieval <recorded.json>]
 *   npx tsx scripts/handoff.ts compose --export <dir> --out <new-dir>
 *
 * It reads only the files named (or the fixed files of one `handoff-export.v0`
 * directory, checked against its index), composes with ChatAgent's own H1 at this checkout,
 * and writes the emitted view part, the bound H1 text and a summary into a new
 * directory. The snapshot file is a historical as-of input, never live authority.
 * Nothing touches a network, a provider, a source store or a conversation; there is
 * no host slot (CA-ISSUE-003), so nothing activates a new conversation.
 *
 * Failures print a stable code only, never content or paths. File and shape checks
 * at this layer run before the pure verification, which then keeps its own order.
 */

export type CliErrorCode =
  | "input_unreadable"
  | "input_too_large"
  | "input_invalid_json"
  | "delivery_invalid"
  | "fresh_invalid"
  | "request_invalid"
  | "retrieval_invalid"
  | "codec_unsupported"
  | "output_exists"
  | "output_unwritable"
  | "request_unavailable"
  | "expectation_invalid"
  | "expectation_mismatch"
  | "export_invalid";

export class CliError extends Error {
  constructor(readonly code: CliErrorCode) {
    super(code);
    this.name = "CliError";
  }
}
const fail = (code: CliErrorCode): never => {
  throw new CliError(code);
};

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE =
  "usage: handoff compose --delivery <dir> --fresh <file> --policy <file> --request <file> --out <new-dir> [--retrieval <file>] [--emit-request fast|deep] [--expect <file>]\n" +
  "   or: handoff compose --export <dir> --out <new-dir> [--emit-request fast|deep]";
const JSON_INPUT_MAX = 1 << 20;
const EXPECTATION_MAX = 4096;
const WRAPPER_MAX = 4096;
const PROVENANCE_MAX = 64 << 10;
const H1_INPUT_MAX =
  INGRESS_LIMITS.h1Response + INGRESS_LIMITS.h1RuleBytes + 4 * INGRESS_LIMITS.h1Instruction;

/** The device and inode a listed file had, so a later open can be held to it. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * Reads at most `cap` bytes of a regular file through one descriptor: the size is
 * taken from that descriptor, and one byte past the cap is read to catch growth.
 * With `identity`, the opened file must be the one that was listed.
 */
export function readBounded(path: string, cap: number, identity?: FileIdentity): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return fail("input_unreadable");
  }
  try {
    let stat;
    try {
      stat = fstatSync(fd, { bigint: true });
    } catch {
      return fail("input_unreadable");
    }
    if (!stat.isFile()) fail("input_unreadable");
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino))
      fail("input_unreadable");
    if (stat.size > BigInt(cap)) fail("input_too_large");
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
    } catch {
      return fail("input_unreadable");
    }
    if (length > cap) fail("input_too_large");
    return new Uint8Array(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

/**
 * A strictly read JSON file as host values: integers exact (a number where safe,
 * otherwise a bigint). A float cannot be spelled as Python would without proof, so it
 * is an explicit unsupported boundary here.
 */
function hostValue(node: JsonNode): unknown {
  switch (node.kind) {
    case "object":
      return Object.fromEntries(node.entries.map((e) => [e.key, hostValue(e.value)]));
    case "array":
      return node.items.map(hostValue);
    case "number": {
      if (!node.integer) return fail("codec_unsupported");
      const value = BigInt(node.lexeme);
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value;
    }
    case "string":
    case "boolean":
      return node.value;
    case "null":
      return null;
  }
}
function readJson(bytes: Uint8Array, maxBytes: number): unknown {
  try {
    return hostValue(readExactJson(bytes, { maxBytes }).root);
  } catch (error) {
    if (error instanceof ExactJsonError) return fail("input_invalid_json");
    throw error;
  }
}
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));

const DELIVERY_FILES = {
  wrapper: ["wrapper.json", WRAPPER_MAX],
  manifest: ["manifest.bin", INGRESS_LIMITS.manifest],
  envelope: ["envelope.bin", INGRESS_LIMITS.envelope],
  task: ["task.bin", INGRESS_LIMITS.task],
  receipt: ["receipt.json", INGRESS_LIMITS.receipt],
  h1Input: ["h1-input.json", H1_INPUT_MAX]
} as const;

type DeliveryBytes = Record<keyof typeof DELIVERY_FILES, Uint8Array>;

function readDeliveryDir(dir: string): DeliveryBytes {
  return Object.fromEntries(
    Object.entries(DELIVERY_FILES).map(([field, [file, cap]]) => [
      field,
      readBounded(join(dir, file), cap)
    ])
  ) as DeliveryBytes;
}

function loadDelivery(raw: DeliveryBytes) {
  const wrapper = readJson(raw.wrapper, WRAPPER_MAX);
  if (
    !isPlain(wrapper) ||
    !exactKeys(wrapper, ["wrapper", "codec", "candidateDigest"]) ||
    !Object.values(wrapper).every((v) => typeof v === "string")
  )
    fail("delivery_invalid");
  const w = wrapper as Record<string, string>;
  const delivery: HandoffDelivery = {
    wrapper: w.wrapper,
    codec: w.codec,
    candidateDigest: w.candidateDigest,
    manifest: raw.manifest,
    envelope: raw.envelope,
    task: raw.task,
    receipt: raw.receipt,
    h1Input: raw.h1Input
  };
  const hashes = Object.fromEntries(
    Object.entries(DELIVERY_FILES).map(([field, [file]]) => [
      file,
      sha256Hex(raw[field as keyof typeof raw])
    ])
  );
  return { delivery, hashes };
}

const FRESH_KEYS = [
  "candidate_digest",
  "record_id",
  "review_identity",
  "package_ref",
  "receipt_status",
  "current_binding",
  "review_class",
  "pins_problem",
  "pending",
  "queue"
];
const IDENTITY_KEYS = ["rootId", "nodeId", "attemptId", "attemptEpoch", "artifactRef"];

/** The snake_case as-of proof, adapted losslessly; a historical input, not authority. */
function toFresh(value: unknown): FreshSnapshot {
  const invalid = () => fail("fresh_invalid");
  if (!isPlain(value) || !exactKeys(value, FRESH_KEYS, ["basis"])) return invalid();
  const identity = value.review_identity;
  if (!isPlain(identity) || !exactKeys(identity, IDENTITY_KEYS)) return invalid();
  const epoch = identity.attemptEpoch;
  if (typeof epoch !== "number" && typeof epoch !== "bigint") return invalid();
  const text = (v: unknown) => (typeof v === "string" ? v : invalid());
  const nullableText = (v: unknown) => (v === null ? null : text(v));
  if (!Array.isArray(value.pending) || !Array.isArray(value.queue)) invalid();
  return {
    candidateDigest: text(value.candidate_digest),
    recordId: text(value.record_id),
    reviewIdentity: {
      rootId: text(identity.rootId),
      nodeId: text(identity.nodeId),
      attemptId: text(identity.attemptId),
      attemptEpoch: BigInt(epoch),
      artifactRef: text(identity.artifactRef)
    },
    packageRef: text(value.package_ref),
    receiptStatus: text(value.receipt_status),
    currentBinding: nullableText(value.current_binding),
    reviewClass: text(value.review_class),
    pinsProblem: nullableText(value.pins_problem),
    pending: value.pending as unknown[],
    queue: value.queue as unknown[],
    basis: value.basis ?? {}
  };
}

/**
 * A collision-free key for a host value: an integer is written as bare digits (a
 * safe number and an equal bigint give the same key), a string is always quoted,
 * object keys are sorted. Anything else cannot be a recorded request or pointer.
 */
export function requestKey(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(requestKey).join(",")}]`;
  if (isPlain(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${requestKey(value[k])}`)
      .join(",")}}`;
  throw new CliError("retrieval_invalid");
}

/**
 * Answers only the exact recorded requests; anything else is not found. A request
 * recorded twice with different results is ambiguous and refused when loaded; an
 * identical repeat (as when one run recorded it for two compositions) is accepted.
 */
function recordedRetriever(value: unknown): Retriever {
  if (!Array.isArray(value)) return fail("retrieval_invalid");
  const entries = new Map<string, unknown>();
  for (const entry of value) {
    if (!isPlain(entry) || !exactKeys(entry, ["request", "result"])) fail("retrieval_invalid");
    const { request, result } = entry as Record<string, unknown>;
    const key = requestKey(request);
    // A repeated request is accepted only with an identical recorded result.
    if (entries.has(key) && requestKey(entries.get(key)) !== requestKey(result))
      fail("retrieval_invalid");
    entries.set(key, result);
  }
  return (pointer) => {
    let key: string;
    try {
      key = requestKey(pointer);
    } catch {
      return null;
    }
    return (entries.get(key) ?? null) as ReturnType<Retriever>;
  };
}

/** A cross-repo parity expectation (CA-ISSUE-011): what the producer's own consumer emitted. */
export interface HandoffExpectation {
  version: "handoff-expectation.v0";
  /** Parity needs ChatAgent's real H1 on both sides, never an H1-shaped stub. */
  h1Builder: "chatagent-h1";
  viewDigest: string;
  viewPartSha256: string;
  reservationTokens: string;
  viewCost: number;
  h1SuppliedSha256: string;
  candidateDigest: string;
}
const EXPECTATION_KEYS = [
  "version",
  "h1Builder",
  "viewDigest",
  "viewPartSha256",
  "reservationTokens",
  "viewCost",
  "h1SuppliedSha256",
  "candidateDigest"
];
const HEX64 = /^[0-9a-f]{64}$/;

/** A closed, strictly read v0 expectation; anything else is expectation_invalid. */
export function readExpectation(bytes: Uint8Array): HandoffExpectation {
  const invalid = () => fail("expectation_invalid");
  let value: unknown;
  try {
    value = readJson(bytes, EXPECTATION_MAX);
  } catch (error) {
    if (error instanceof CliError) return invalid();
    throw error;
  }
  if (!isPlain(value) || !exactKeys(value, EXPECTATION_KEYS)) return invalid();
  const e = value as Record<string, unknown>;
  const hex = (key: string) => typeof e[key] === "string" && HEX64.test(e[key] as string);
  if (
    e.version !== "handoff-expectation.v0" ||
    e.h1Builder !== "chatagent-h1" ||
    !["viewDigest", "viewPartSha256", "h1SuppliedSha256", "candidateDigest"].every(hex) ||
    typeof e.reservationTokens !== "string" ||
    !/^[0-9]{10}$/.test(e.reservationTokens) ||
    typeof e.viewCost !== "number" ||
    !Number.isSafeInteger(e.viewCost) ||
    e.viewCost !== Number(e.reservationTokens)
  )
    return invalid();
  return e as unknown as HandoffExpectation;
}

/** Compares a composition with the producer's expectation; any difference refuses. */
function checkExpectation(expected: HandoffExpectation, c: Composition) {
  if (
    expected.viewDigest !== c.viewDigest ||
    expected.viewPartSha256 !== sha256Hex(Buffer.from(c.part, "utf8")) ||
    expected.reservationTokens !== c.reservationTokens ||
    expected.viewCost !== c.viewCost ||
    expected.h1SuppliedSha256 !== c.h1.suppliedSha256 ||
    expected.candidateDigest !== c.candidateDigest
  )
    fail("expectation_mismatch");
}

/** The raw inputs of one composition, from named paths or from one export directory. */
interface Inputs {
  delivery: ReturnType<typeof loadDelivery>;
  fresh: Uint8Array;
  policy: Uint8Array;
  request: Uint8Array;
  retrieval?: Uint8Array;
  expectation?: Uint8Array;
  exported?: { index: Uint8Array; provenance: Uint8Array; viewPart: Uint8Array };
}

export const EXPORT_VERSION = "handoff-export.v0";
export const EXPORT_INDEX = "INDEX.sha256";
/**
 * The closed `handoff-export.v0` layout (contract frozen in bridge message 1549):
 * exactly these files, each with its read cap, plus the index. Paths are fixed here
 * and never taken from the index, so nothing it names can reach another path.
 */
const EXPORT_FILES: Record<string, number> = {
  ...Object.fromEntries(
    Object.values(DELIVERY_FILES).map(([file, cap]) => [`delivery/${file}`, cap])
  ),
  "fresh.json": JSON_INPUT_MAX,
  "policy.json": JSON_INPUT_MAX,
  "request.json": JSON_INPUT_MAX,
  "retrieval.json": JSON_INPUT_MAX,
  "expected.json": EXPECTATION_MAX,
  "view-part.txt": JSON_INPUT_MAX,
  "provenance.json": PROVENANCE_MAX
};
const EXPORT_INDEX_MAX = 4096;

/**
 * Lists one directory and requires exactly `names`, each a real directory or regular
 * file as asked (a symlink, junction or other entry is refused). Returns the identity
 * of each file so the later read is held to the file that was listed.
 */
function listExact(dir: string, names: Record<string, "dir" | "file">) {
  const wanted = Object.keys(names);
  // Streamed, so an oversized directory is refused at its first unexpected entry
  // instead of being loaded whole; the handle is always closed.
  const handle = opendirSync(dir);
  const seen = new Set<string>();
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (!Object.hasOwn(names, entry.name) || seen.has(entry.name)) fail("export_invalid");
      seen.add(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  if (seen.size !== wanted.length) fail("export_invalid");
  const files = new Map<string, FileIdentity>();
  for (const name of wanted) {
    const stat = lstatSync(join(dir, name), { bigint: true });
    if (stat.isSymbolicLink()) fail("export_invalid");
    if (names[name] === "dir" ? !stat.isDirectory() : !stat.isFile()) fail("export_invalid");
    if (names[name] === "file") files.set(name, { dev: stat.dev, ino: stat.ino });
  }
  return files;
}

/** The only index an export can carry: every listed file's hash, sorted, LF-terminated. */
function canonicalIndex(files: Map<string, Uint8Array>) {
  return [...files.keys()]
    .sort()
    .map((path) => `${sha256Hex(files.get(path)!)}  ${path}\n`)
    .join("");
}

/**
 * Reads one export: the directory must hold exactly the fixed layout, each file is
 * read once through a bounded descriptor held to its listing, and the index must
 * equal the one built from those bytes. Any missing, extra, nested, linked,
 * duplicate, unsorted or mismatched entry is `export_invalid`. The hashes prove the
 * files were not altered after indexing; they do not authenticate the producer.
 */
function readExport(dir: string): Inputs {
  let bytes: Map<string, Uint8Array>;
  let index: Uint8Array;
  try {
    const root = lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) fail("export_invalid");
    const top = Object.keys(EXPORT_FILES).filter((p) => !p.includes("/"));
    const identities = listExact(dir, {
      ...Object.fromEntries(top.map((n) => [n, "file" as const])),
      [EXPORT_INDEX]: "file",
      delivery: "dir"
    });
    const nested = listExact(
      join(dir, "delivery"),
      Object.fromEntries(Object.values(DELIVERY_FILES).map(([file]) => [file, "file" as const]))
    );
    for (const [name, identity] of nested) identities.set(`delivery/${name}`, identity);
    bytes = new Map(
      Object.entries(EXPORT_FILES).map(([path, cap]) => [
        path,
        readBounded(join(dir, ...path.split("/")), cap, identities.get(path))
      ])
    );
    index = readBounded(join(dir, EXPORT_INDEX), EXPORT_INDEX_MAX, identities.get(EXPORT_INDEX));
  } catch (error) {
    // A missing, unreadable, oversized or replaced file is an invalid export.
    if (error instanceof CliError || (error as NodeJS.ErrnoException).code) fail("export_invalid");
    throw error;
  }
  if (Buffer.compare(index, Buffer.from(canonicalIndex(bytes), "utf8")) !== 0)
    fail("export_invalid");
  let provenance: unknown;
  try {
    provenance = readJson(bytes.get("provenance.json")!, PROVENANCE_MAX);
  } catch (error) {
    if (error instanceof CliError) fail("export_invalid");
    throw error;
  }
  // Only the version is read; everything else in it is producer-declared.
  if (!isPlain(provenance) || provenance.exportVersion !== EXPORT_VERSION) fail("export_invalid");
  const delivery = Object.fromEntries(
    Object.entries(DELIVERY_FILES).map(([field, [file]]) => [field, bytes.get(`delivery/${file}`)!])
  ) as DeliveryBytes;
  return {
    delivery: loadDelivery(delivery),
    fresh: bytes.get("fresh.json")!,
    policy: bytes.get("policy.json")!,
    request: bytes.get("request.json")!,
    retrieval: bytes.get("retrieval.json")!,
    expectation: bytes.get("expected.json")!,
    exported: {
      index,
      provenance: bytes.get("provenance.json")!,
      viewPart: bytes.get("view-part.txt")!
    }
  };
}

/** Reads the named input files, in the order the explicit mode always has. */
function readPaths(p: PathArgs): Inputs {
  const delivery = loadDelivery(readDeliveryDir(p.delivery));
  const fresh = readBounded(p.fresh, JSON_INPUT_MAX);
  const policy = readBounded(p.policy, JSON_INPUT_MAX);
  const request = readBounded(p.request, JSON_INPUT_MAX);
  const retrieval = p.retrieval ? readBounded(p.retrieval, JSON_INPUT_MAX) : undefined;
  let expectation: Uint8Array | undefined;
  if (p.expect)
    try {
      expectation = readBounded(p.expect, EXPECTATION_MAX);
    } catch (error) {
      // An unreadable or oversized expectation is still an invalid expectation.
      if (error instanceof CliError && error.code === "input_too_large")
        fail("expectation_invalid");
      throw error;
    }
  return { delivery, fresh, policy, request, retrieval, expectation };
}

interface PathArgs {
  delivery: string;
  fresh: string;
  policy: string;
  request: string;
  retrieval?: string;
  expect?: string;
}
interface Args {
  out: string;
  emitRequest?: "fast" | "deep";
  source: { paths: PathArgs } | { export: string };
}
const PATH_FLAGS = ["--delivery", "--fresh", "--policy", "--request", "--retrieval", "--expect"];

function parseArgs(argv: string[]): Args | undefined {
  const [command, ...rest] = argv;
  if (command !== "compose" || rest.length % 2 !== 0) return undefined;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (![...PATH_FLAGS, "--out", "--emit-request", "--export"].includes(flag)) return undefined;
    if (flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith("--")) return undefined;
    flags.set(flag, rest[i + 1]);
  }
  const get = (flag: string) => flags.get(flag);
  const role = get("--emit-request");
  if (role !== undefined && role !== "fast" && role !== "deep") return undefined;
  const out = get("--out");
  if (!out) return undefined;
  const common = { out, emitRequest: role as "fast" | "deep" | undefined };
  const exportDir = get("--export");
  if (exportDir !== undefined) {
    // An export names all of its inputs; no path flag may be mixed in.
    if (PATH_FLAGS.some((flag) => flags.has(flag))) return undefined;
    return { ...common, source: { export: exportDir } };
  }
  if (!get("--delivery") || !get("--fresh") || !get("--policy") || !get("--request"))
    return undefined;
  return {
    ...common,
    source: {
      paths: {
        delivery: get("--delivery")!,
        fresh: get("--fresh")!,
        policy: get("--policy")!,
        request: get("--request")!,
        retrieval: get("--retrieval"),
        expect: get("--expect")
      }
    }
  };
}

/**
 * Creates the output directory exclusively (an existing one, even empty, is refused),
 * writes each artifact exclusively, and writes the summary last as the completion
 * marker. On a failure it removes only what this attempt created. This is not an
 * atomic publish: a reader can see a partial directory until the summary exists.
 */
function publish(out: string, files: [string, string][]) {
  try {
    mkdirSync(out);
  } catch (error) {
    return fail(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "output_exists" : "output_unwritable"
    );
  }
  // A path is ours only once our exclusive create succeeded; a file that already
  // existed (EEXIST) belongs to someone else and is never removed.
  const owned: string[] = [];
  try {
    for (const [name, content] of files) {
      const path = join(out, name);
      const fd = openSync(path, "wx");
      owned.push(path);
      try {
        writeFileSync(fd, content, "utf8");
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    for (const path of owned.reverse())
      try {
        unlinkSync(path);
      } catch {
        // Leave what cannot be removed; the missing summary marks it incomplete.
      }
    try {
      rmdirSync(out);
    } catch {
      // Not empty: something not created by this attempt stays, and so does the dir.
    }
    fail("output_unwritable");
  }
}

function summary(
  c: Composition,
  delivery: HandoffDelivery,
  hashes: Record<string, string | null>,
  request?: { role: string; sha256: string },
  expectation?: { sha256: string },
  exported?: { indexSha256: string; provenanceSha256: string }
) {
  return (
    JSON.stringify(
      {
        tool: "chatagent-handoff-compose",
        version: 1,
        inputs: hashes,
        candidateDigest: delivery.candidateDigest,
        viewDigest: c.viewDigest,
        viewCost: c.viewCost,
        reservationTokens: c.reservationTokens,
        h1SuppliedSha256: c.h1.suppliedSha256,
        estimator: ESTIMATOR_ID,
        h1: "ChatAgent buildPlanTaskContext at this checkout; not the pinned 5255daa invocation",
        runtime: { node: process.version },
        fresh: "historical as-of input, not live authority",
        ...(expectation
          ? {
              expectation: {
                ...expectation,
                version: "handoff-expectation.v0",
                result: "matches the supplied expectation",
                producerDeclaredH1Builder: "chatagent-h1",
                claim:
                  "view bytes and bindings agree with the supplied expectation; its builder is producer-declared and not verified here; this is integrity and parity, not provenance, authentication or current authority"
              }
            }
          : {}),
        ...(exported
          ? {
              export: {
                version: EXPORT_VERSION,
                ...exported,
                files: Object.keys(EXPORT_FILES).length,
                integrity:
                  "every file matched the export index under the fixed layout; integrity only, not authenticated producer evidence",
                provenance: "producer-declared and not verified here; recorded by hash only"
              }
            }
          : {}),
        ...(request
          ? {
              request: {
                ...request,
                slot: HANDOFF_VIEW_SLOT,
                note: "offline artifact for a supervised worker; no provider was called"
              }
            }
          : {})
      },
      null,
      2
    ) + "\n"
  );
}

/** Runs one command; returns the exit code (0 composed, 1 refused, 2 usage). */
export function runHandoffCompose(argv: string[], io: CliIo): number {
  const args = parseArgs(argv);
  if (!args) {
    io.stderr(USAGE + "\n");
    return 2;
  }
  try {
    const inputs =
      "export" in args.source ? readExport(args.source.export) : readPaths(args.source.paths);
    const { delivery, hashes } = inputs.delivery;
    const {
      fresh: freshBytes,
      policy: policyBytes,
      request: requestBytes,
      retrieval: retrievalBytes,
      expectation: expectationBytes,
      exported
    } = inputs;
    const expectation = expectationBytes ? readExpectation(expectationBytes) : undefined;
    // The export's evidence copy of the view part must be the one its expectation names.
    if (exported && sha256Hex(exported.viewPart) !== expectation!.viewPartSha256)
      fail("export_invalid");
    const fresh = toFresh(readJson(freshBytes, JSON_INPUT_MAX));
    const request = readJson(requestBytes, JSON_INPUT_MAX);
    if (!isPlain(request) || !exactKeys(request, ["destination"], ["wanted"]))
      fail("request_invalid");
    const r = request as { destination: unknown; wanted?: unknown };
    const composition = composeHandoff({
      delivery,
      fresh,
      policy: readJson(policyBytes, JSON_INPUT_MAX) as ImportPolicy,
      destination: r.destination as string,
      wanted: (r.wanted ?? []) as unknown[],
      retriever: retrievalBytes
        ? recordedRetriever(readJson(retrievalBytes, JSON_INPUT_MAX))
        : undefined,
      h1: chatAgentH1
    });
    // Parity with the producer's own consumer, checked before anything is published.
    if (expectation) checkExpectation(expectation, composition);
    // The worker request, built offline through the shared adapter seam: only from
    // ChatAgent's own H1 result, never rebuilt from other options.
    let requestFile: [string, string] | undefined;
    if (args.emitRequest) {
      const planTask = composition.h1.planTask;
      if (!planTask) fail("request_unavailable");
      const built = handoffWorkerRequest(planTask!, composition, args.emitRequest);
      requestFile = [
        "request.json",
        JSON.stringify(
          {
            slot: HANDOFF_VIEW_SLOT,
            role: args.emitRequest,
            system: built.system,
            messages: built.messages
          },
          null,
          2
        ) + "\n"
      ];
    }
    publish(args.out, [
      ["view-part.txt", composition.part],
      ["h1-text.txt", composition.h1.text],
      ...(requestFile ? [requestFile] : []),
      [
        "summary.json",
        summary(
          composition,
          delivery,
          {
            ...hashes,
            fresh: sha256Hex(freshBytes),
            policy: sha256Hex(policyBytes),
            request: sha256Hex(requestBytes),
            retrieval: retrievalBytes ? sha256Hex(retrievalBytes) : null
          },
          requestFile && {
            role: args.emitRequest!,
            sha256: sha256Hex(Buffer.from(requestFile[1], "utf8"))
          },
          expectationBytes && { sha256: sha256Hex(expectationBytes) },
          exported && {
            indexSha256: sha256Hex(exported.index),
            provenanceSha256: sha256Hex(exported.provenance)
          }
        )
      ]
    ]);
    io.stdout(`handoff: composed viewDigest ${composition.viewDigest}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof CliError ||
      error instanceof DeliveryRefusal ||
      error instanceof CompositionRefusal ||
      error instanceof AttachRefusal
        ? error.code
        : "unexpected_error";
    io.stderr(`handoff: ${code}\n`);
    return 1;
  }
}
