import {
  ExactJsonError,
  member,
  readExactJson,
  sha256Hex,
  type ExactJsonDocument,
  type JsonNode,
  type ObjectNode
} from "./exactJson";
import { pyCanonForm, pyCanonString } from "./pyCanon";

/**
 * Offline verification of one Hekate handoff delivery (plan 034 rev 3, ported from
 * the accepted `e1/consumer.py` `verify_delivery` and `revalidate`): the exact
 * accepted v0 bytes, the commit receipt, the H1 options and a supplied as-of
 * revalidation snapshot. Verification only: no policy, retrieval, consumer view,
 * H1 call or composition happens here, nothing is written, and nothing is cached.
 *
 * Checks run in the accepted consumer's order and the first failure refuses the
 * whole delivery with a stable code that never echoes input. Digests are computed
 * over received bytes only. Canonical form is checked token by token against the
 * Python spelling (`pyCanon.ts`); nothing is re-serialized in JavaScript, and an
 * integer is never converted to a Number.
 */

export const WRAPPER = "handoff-delivery.v0";
export const CODEC = "py-canon.v0";
export const ENVELOPE_VERSION = "handoff-envelope.v0";

const MIB = 1 << 20;
/** Ingress caps on raw bytes, before any parsing (034 §2). */
export const INGRESS_LIMITS = Object.freeze({
  manifest: MIB,
  envelope: MIB,
  task: MIB,
  receipt: 4096,
  h1Response: MIB,
  h1Rules: 32,
  h1RuleBytes: 256 * 1024,
  h1Instruction: 64 * 1024,
  wrapper: 4_718_592
});
/** The H1 options' raw cap: one response, the rule bytes and four instruction texts. */
const H1_INPUT_MAX =
  INGRESS_LIMITS.h1Response + INGRESS_LIMITS.h1RuleBytes + 4 * INGRESS_LIMITS.h1Instruction;
/** 032 delivered-content caps, re-checked on decoded content. */
export const DELIVERED_LIMITS = Object.freeze({
  requiredBytes: 64 * 1024,
  requiredRefs: 256,
  optionalBytes: 32 * 1024,
  optionalRefs: 64,
  totalBytes: 96 * 1024
});
/** The current uncertainty list must fit the mandatory part (034 §6). */
export const UNCERTAINTY_REFS_MAX = 256;
/**
 * Host capacity for reading each document. Deeper or larger documents are refused
 * as unsupported by this host (`codec_unsupported`), not as invalid producer data.
 * The depth stays far below where the reference reader fails (about 1,000 levels,
 * an untyped RecursionError); the reviewed fixture documents nest at most 7 deep.
 */
export const READ_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 1_048_576 });
/** Python refuses integer literals of more digits (int_max_str_digits): strict_json. */
export const MAX_INT_DIGITS = 4300;

export type DeliveryRefusalCode =
  | "ingress_too_large"
  | "codec_unsupported"
  | "strict_json"
  | "receipt_shape"
  | "digest_mismatch"
  | "h1_input"
  | "delivery_mismatch"
  | "receipt_mismatch"
  | "delivery_overflow"
  | "fresh_mismatch"
  | "receipt_not_current"
  | "binding_moved"
  | "review_not_candidate"
  | "stale_content"
  | "uncertainty_overflow"
  | "task_mismatch";

/** Why something is unsupported by this host; never input content. */
export type UnsupportedReason = "WRAPPER" | "NUMBER" | "KEY" | "DEPTH" | "NODES";

/** A refusal of the whole delivery. It carries a stable code and never input content. */
export class DeliveryRefusal extends Error {
  constructor(
    readonly code: DeliveryRefusalCode,
    readonly reason?: UnsupportedReason
  ) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "DeliveryRefusal";
  }
}

/** One delivery as received: every payload field is the exact bytes. */
export interface HandoffDelivery {
  wrapper: string;
  codec: string;
  candidateDigest: string;
  manifest: Uint8Array;
  envelope: Uint8Array;
  task: Uint8Array;
  receipt: Uint8Array;
  h1Input: Uint8Array;
}

/**
 * The as-of revalidation facts, read by the host in one combined snapshot (034 §6).
 * Trusted in-process data, as in the reference consumer; it is not an
 * authenticated proof. Its identity fields must name this exact delivery.
 */
export interface FreshSnapshot {
  candidateDigest: string;
  recordId: string;
  reviewIdentity: {
    rootId: string;
    nodeId: string;
    attemptId: string;
    attemptEpoch: bigint;
    artifactRef: string;
  };
  packageRef: string;
  receiptStatus: string;
  currentBinding: string | null;
  reviewClass: string;
  pinsProblem: string | null;
  pending: readonly unknown[];
  queue: readonly unknown[];
  basis?: unknown;
}

export interface VerifiedReceipt {
  handoffId: string;
  candidateDigest: string;
  bindingLinkId: string;
  recordId: string;
  /** Exact, up to Python's 4,300-digit integer limit (longer is strict_json). */
  seq: bigint;
  recordHash: string;
}

export interface VerifiedTask {
  text: string;
  instructions: { system: string; fast: string; deep: string };
  packageRef: string;
}

/** A delivery whose bytes, receipt and H1 options passed every check. */
export interface VerifiedDelivery {
  candidateDigest: string;
  receipt: VerifiedReceipt;
  /** The exact manifest, envelope and H1 option documents (bytes and spans). */
  manifest: ExactJsonDocument;
  envelope: ExactJsonDocument;
  h1Input: ExactJsonDocument;
  task: VerifiedTask;
  transition: { handoffId: string; recordId: string; linkId: string };
}

/** A verified delivery that also passed revalidation against one snapshot. */
export interface RevalidatedDelivery extends VerifiedDelivery {
  revalidation: {
    asOf: "revalidation";
    basis: unknown;
    pending: readonly unknown[];
    queue: readonly unknown[];
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BUDGET_KEYS = [
  "windowTokens",
  "maxHistoryTurns",
  "safetyTokens",
  "fastOutputTokens",
  "deepOutputTokens"
] as const;
const H1_REQUIRED = [
  "response",
  "rules",
  "systemInstruction",
  "roleInstructions",
  "budget",
  "capturedAtIso"
];
const H1_ALLOWED = new Set([...H1_REQUIRED, "limits"]);

const refuse = (code: DeliveryRefusalCode, reason?: UnsupportedReason): never => {
  throw new DeliveryRefusal(code, reason);
};
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

/** Strict reading, as the reference strict_loads: refusals are strict_json. */
function strict(bytes: Uint8Array, maxBytes: number): ExactJsonDocument {
  let doc: ExactJsonDocument;
  try {
    doc = readExactJson(bytes, { maxBytes, ...READ_LIMITS });
  } catch (error) {
    if (!(error instanceof ExactJsonError)) throw error;
    if (error.code === "TOO_DEEP") return refuse("codec_unsupported", "DEPTH");
    if (error.code === "TOO_MANY_NODES") return refuse("codec_unsupported", "NODES");
    // Python accepts "__proto__" as a key; this host does not represent it.
    if (error.code === "UNSAFE_KEY") return refuse("codec_unsupported", "KEY");
    if (error.code === "INPUT_TOO_LARGE") return refuse("ingress_too_large");
    return refuse("strict_json");
  }
  // strict_loads refuses a non-finite float (1e999 overflows to infinity).
  const pending: JsonNode[] = [doc.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === "number") {
      if (node.integer) {
        if (node.lexeme.replace("-", "").length > MAX_INT_DIGITS) refuse("strict_json");
      } else if (!Number.isFinite(Number(node.lexeme))) refuse("strict_json");
    } else if (node.kind === "array") {
      // One push per item: spreading a wide array would exceed the argument limit.
      for (const item of node.items) pending.push(item);
    } else if (node.kind === "object") for (const entry of node.entries) pending.push(entry.value);
  }
  return doc;
}

/** Refuses with `code` unless the document is exactly py-canon.v0. */
function requireCanonical(doc: ExactJsonDocument, code: DeliveryRefusalCode) {
  const result = pyCanonForm(doc);
  if (result.status === "noncanonical") refuse(code);
  if (result.status === "unsupported") refuse("codec_unsupported", result.reason);
}

// Typed accessors over parsed nodes. `fail` is the refusal for a shape mismatch.
type Fail = () => never;
function asObject(node: JsonNode | undefined, fail: Fail): ObjectNode {
  return node?.kind === "object" ? node : fail();
}
function asString(node: JsonNode | undefined, fail: Fail): string {
  return node?.kind === "string" ? node.value : fail();
}
function asArray(node: JsonNode | undefined, fail: Fail): readonly JsonNode[] {
  return node?.kind === "array" ? node.items : fail();
}
/** A Python int (no fraction or exponent) at any magnitude; -0 is the int 0. */
function asInt(node: JsonNode | undefined, fail: Fail): bigint {
  return node?.kind === "number" && node.integer ? BigInt(node.lexeme) : fail();
}
function keysOf(node: ObjectNode) {
  return node.entries.map((entry) => entry.key);
}
function exactKeys(node: ObjectNode, keys: readonly string[]) {
  const own = keysOf(node);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}
const path = (root: JsonNode, keys: readonly string[], fail: Fail): JsonNode => {
  let node = root;
  for (const key of keys) {
    const next = member(asObject(node, fail), key);
    if (next === undefined) return fail();
    node = next;
  }
  return node;
};

/**
 * A typed array's true byte length, from the intrinsic getter: a subclass cannot
 * report a smaller size than the bytes it holds.
 */
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)!.get!;
const sizeOf = (bytes: Uint8Array): number => intrinsicByteLength.call(bytes);
const textLength = (value: unknown) => (typeof value === "string" ? utf8Length(value) : 0);

function ingress(d: HandoffDelivery) {
  const fields = [d.manifest, d.envelope, d.task, d.receipt, d.h1Input];
  const total =
    fields.reduce((n, bytes) => n + sizeOf(bytes), 0) +
    textLength(d.wrapper) +
    textLength(d.codec) +
    textLength(d.candidateDigest);
  if (total > INGRESS_LIMITS.wrapper) refuse("ingress_too_large");
  const caps: [Uint8Array, number][] = [
    [d.manifest, INGRESS_LIMITS.manifest],
    [d.envelope, INGRESS_LIMITS.envelope],
    [d.task, INGRESS_LIMITS.task],
    [d.receipt, INGRESS_LIMITS.receipt],
    [d.h1Input, H1_INPUT_MAX]
  ];
  for (const [bytes, cap] of caps) if (sizeOf(bytes) > cap) refuse("ingress_too_large");
}

function closedReceipt(doc: ExactJsonDocument): VerifiedReceipt {
  const fail = () => refuse("receipt_shape");
  const root = asObject(doc.root, fail);
  const keys = ["handoffId", "candidateDigest", "bindingLinkId", "recordId", "seq", "recordHash"];
  if (!exactKeys(root, keys)) fail();
  const text = (key: string, pattern: RegExp) => {
    const value = asString(member(root, key), fail);
    return pattern.test(value) ? value : fail();
  };
  const receipt = {
    handoffId: text("handoffId", UUID),
    candidateDigest: text("candidateDigest", HEX64),
    bindingLinkId: text("bindingLinkId", UUID),
    recordId: text("recordId", UUID),
    seq: asInt(member(root, "seq"), fail),
    recordHash: text("recordHash", HEX64)
  };
  if (receipt.seq < 1n) fail();
  return receipt;
}

/** The byte length of py-canon.v0(value) for H1 rules: a list of string-valued objects. */
function rulesCanonicalLength(rules: readonly JsonNode[]) {
  let length = 2 + Math.max(0, rules.length - 1);
  for (const rule of rules) {
    const entries = (rule as ObjectNode).entries;
    length += 2 + Math.max(0, entries.length - 1);
    for (const { key, value } of entries)
      length +=
        utf8Length(pyCanonString(key)) +
        1 +
        utf8Length(pyCanonString((value as { value: string }).value));
  }
  return length;
}

/** The closed H1 option set and its caps (reference `_h1_input_caps`). */
function h1InputCaps(doc: ExactJsonDocument) {
  const fail = () => refuse("h1_input");
  const tooLarge = () => refuse("ingress_too_large");
  const root = asObject(doc.root, fail);
  const keys = keysOf(root);
  if (!H1_REQUIRED.every((key) => keys.includes(key)) || keys.some((key) => !H1_ALLOWED.has(key)))
    fail();
  const budget = asObject(member(root, "budget"), fail);
  if (!exactKeys(budget, BUDGET_KEYS)) fail();
  for (const key of BUDGET_KEYS) {
    const value = asInt(member(budget, key), fail);
    if (value < 0n || value > MAX_SAFE) fail();
  }
  asString(member(root, "capturedAtIso"), fail);
  const limits = member(root, "limits");
  if (limits !== undefined) asObject(limits, fail);
  const rules = asArray(member(root, "rules"), fail);
  for (const rule of rules)
    for (const entry of asObject(rule, fail).entries) asString(entry.value, fail);
  const response = member(root, "response");
  if (response?.kind !== "string" || utf8Length(response.value) > INGRESS_LIMITS.h1Response)
    tooLarge();
  if (
    rules.length > INGRESS_LIMITS.h1Rules ||
    rulesCanonicalLength(rules) > INGRESS_LIMITS.h1RuleBytes
  )
    tooLarge();
  const role = asObject(member(root, "roleInstructions"), fail);
  if (!exactKeys(role, ["fast", "deep"])) fail();
  for (const node of [
    member(root, "systemInstruction"),
    member(role, "fast"),
    member(role, "deep")
  ])
    if (node?.kind !== "string" || utf8Length(node.value) > INGRESS_LIMITS.h1Instruction)
      tooLarge();
}

const OPTIONAL_EMPTY = '{"diagnostics":null,"evidence":[],"imports":[],"note":null}';

/**
 * Reference `handoff.verify_stored` and the consumer's required shape and 032
 * accounting. Every mismatch is delivery_mismatch.
 */
function verifyStored(
  manifest: ExactJsonDocument,
  envelope: ExactJsonDocument,
  taskDoc: ExactJsonDocument
) {
  const fail = () => refuse("delivery_mismatch");
  const m = asObject(manifest.root, fail);
  // The digest equals sha256(py-canon.v0(manifest)): the bytes are their canonical form.
  requireCanonical(manifest, "delivery_mismatch");
  // The envelope is exactly the canonical envelope of this manifest and its payload.
  const e = asObject(envelope.root, fail);
  const payload = asObject(member(e, "payload"), fail);
  if (!exactKeys(payload, ["imports", "note"])) fail();
  const payloadImports = asArray(member(payload, "imports"), fail);
  if (!exactKeys(e, ["manifest", "payload", "version"])) fail();
  if (asString(member(e, "version"), fail) !== ENVELOPE_VERSION) fail();
  requireCanonical(envelope, "delivery_mismatch");
  const inner = member(e, "manifest")!;
  if (
    sha256Hex(envelope.raw(inner)) !== manifest.sha256 ||
    inner.end - inner.start !== manifest.byteLength
  )
    fail();
  // The retained Task bytes: exactly {text, instructions{system, fast, deep}, packageRef}.
  const t = asObject(taskDoc.root, fail);
  if (!exactKeys(t, ["text", "instructions", "packageRef"])) fail();
  const ti = asObject(member(t, "instructions"), fail);
  if (!exactKeys(ti, ["system", "fast", "deep"])) fail();
  const task: VerifiedTask = {
    text: asString(member(t, "text"), fail),
    instructions: {
      system: asString(member(ti, "system"), fail),
      fast: asString(member(ti, "fast"), fail),
      deep: asString(member(ti, "deep"), fail)
    },
    packageRef: asString(member(t, "packageRef"), fail)
  };
  requireCanonical(taskDoc, "delivery_mismatch");
  // Task, import and note bytes against the manifest's digests.
  const sha = (text: string) => sha256Hex(Buffer.from(text, "utf8"));
  const mt = asObject(member(m, "task"), fail);
  const mi = asObject(member(mt, "instructions"), fail);
  if (
    sha(task.text) !== asString(member(mt, "suppliedSha256"), fail) ||
    !exactKeys(mi, ["deep", "fast", "system"]) ||
    (["system", "fast", "deep"] as const).some(
      (key) =>
        member(mi, key)?.kind !== "string" ||
        sha(task.instructions[key]) !== (member(mi, key) as { value: string }).value
    ) ||
    task.packageRef !== asString(member(mt, "packageRef"), fail)
  )
    fail();
  const optional = asObject(member(m, "optional"), fail);
  const imports = asArray(member(optional, "imports"), fail);
  if (
    imports.length !== payloadImports.length ||
    imports.some(
      (item, k) =>
        sha(asString(payloadImports[k], fail)) !==
        asString(member(asObject(item, fail), "textSha256"), fail)
    )
  )
    fail();
  const note = member(optional, "note");
  const payloadNote = member(payload, "note")!;
  if (note === undefined || (note.kind === "null") !== (payloadNote.kind === "null")) fail();
  if (note!.kind !== "null") {
    const noteSha = asString(member(asObject(note, fail), "sha256"), fail);
    if (sha(asString(payloadNote, fail)) !== noteSha) fail();
  }
  // The consumer's required manifest shape.
  const transition = asObject(member(m, "transition"), fail);
  const authority = asObject(member(m, "authority"), fail);
  path(m, ["state", "mandatory", "identity"], fail);
  const evidenceIndex = asArray(member(m, "evidenceIndex"), fail);
  const pending = asArray(member(authority, "pending"), fail);
  const queue = asArray(member(authority, "queue"), fail);
  const optionalEvidence = asArray(member(optional, "evidence"), fail);
  const ids = {
    handoffId: member(transition, "handoffId"),
    recordId: member(transition, "recordId"),
    linkId: member(transition, "linkId")
  };
  if (!ids.handoffId || !ids.recordId || !ids.linkId) fail();
  // 032 delivered-content accounting on decoded content, by byte arithmetic over
  // verified canonical spans: nothing is re-encoded.
  const taskBytes =
    utf8Length(task.text) +
    utf8Length(task.instructions.system) +
    utf8Length(task.instructions.fast) +
    utf8Length(task.instructions.deep);
  const optionalSpan = member(m, "optional")!;
  const requiredManifest =
    manifest.byteLength - (optionalSpan.end - optionalSpan.start) + OPTIONAL_EMPTY.length;
  const required =
    taskBytes +
    '{"manifest":'.length +
    requiredManifest +
    `,"payload":{"imports":[],"note":null},"version":"${ENVELOPE_VERSION}"}`.length;
  const total = taskBytes + envelope.byteLength;
  return {
    task,
    transitionIds: ids,
    sizes: {
      required,
      total,
      refs: evidenceIndex.length + pending.length + queue.length,
      optionalRefs: optionalEvidence.length + imports.length
    }
  };
}

/**
 * Verifies the delivery's exact bytes, receipt and H1 options in the reference
 * order. Any failure refuses the whole delivery.
 */
export function verifyDelivery(input: HandoffDelivery): VerifiedDelivery {
  // Each caller property is read once, so a getter cannot supply different fields to
  // the size checks and to verification. Text fields are not coerced: a non-string
  // never equals the expected value, as in the reference.
  const given: HandoffDelivery = {
    wrapper: input.wrapper,
    codec: input.codec,
    candidateDigest: input.candidateDigest,
    manifest: input.manifest,
    envelope: input.envelope,
    task: input.task,
    receipt: input.receipt,
    h1Input: input.h1Input
  };
  for (const field of [given.manifest, given.envelope, given.task, given.receipt, given.h1Input])
    if (!(field instanceof Uint8Array)) refuse("strict_json");
  ingress(given);
  // After the size checks, one private copy of every field; only the copies are
  // hashed and parsed, so a shared or later-changed buffer cannot split them. The
  // constructor always copies; a field's own slice() may not (Node's Buffer.slice
  // returns a view of the same memory).
  const copy = (bytes: Uint8Array) => {
    try {
      return new Uint8Array(bytes);
    } catch {
      // A detached buffer cannot be read (CA-ISSUE-001): a typed refusal, not a throw.
      return refuse("strict_json");
    }
  };
  const d: HandoffDelivery = {
    ...given,
    manifest: copy(given.manifest),
    envelope: copy(given.envelope),
    task: copy(given.task),
    receipt: copy(given.receipt),
    h1Input: copy(given.h1Input)
  };
  if (d.wrapper !== WRAPPER || d.codec !== CODEC) refuse("codec_unsupported", "WRAPPER");
  if (typeof d.candidateDigest !== "string") refuse("digest_mismatch");
  const receiptDoc = strict(d.receipt, INGRESS_LIMITS.receipt);
  const receipt = closedReceipt(receiptDoc);
  const digest = sha256Hex(d.manifest);
  if (!(digest === d.candidateDigest && digest === receipt.candidateDigest))
    refuse("digest_mismatch");
  const manifest = strict(d.manifest, INGRESS_LIMITS.manifest);
  if (manifest.sha256 !== digest) refuse("digest_mismatch");
  const envelope = strict(d.envelope, INGRESS_LIMITS.envelope);
  const taskDoc = strict(d.task, INGRESS_LIMITS.task);
  const h1Input = strict(d.h1Input, H1_INPUT_MAX);
  h1InputCaps(h1Input);
  if (manifest.root.kind !== "object") refuse("delivery_mismatch");
  const { task, transitionIds, sizes } = verifyStored(manifest, envelope, taskDoc);
  const transition = {
    handoffId: transitionIds.handoffId!.kind === "string" ? transitionIds.handoffId!.value : "",
    recordId: transitionIds.recordId!.kind === "string" ? transitionIds.recordId!.value : "",
    linkId: transitionIds.linkId!.kind === "string" ? transitionIds.linkId!.value : ""
  };
  if (
    transitionIds.handoffId!.kind !== "string" ||
    transitionIds.recordId!.kind !== "string" ||
    transitionIds.linkId!.kind !== "string" ||
    receipt.handoffId !== transition.handoffId ||
    receipt.recordId !== transition.recordId ||
    receipt.bindingLinkId !== transition.linkId
  )
    refuse("receipt_mismatch");
  if (
    sizes.required > DELIVERED_LIMITS.requiredBytes ||
    sizes.refs > DELIVERED_LIMITS.requiredRefs ||
    sizes.total > DELIVERED_LIMITS.totalBytes ||
    sizes.total - sizes.required > DELIVERED_LIMITS.optionalBytes ||
    sizes.optionalRefs > DELIVERED_LIMITS.optionalRefs
  )
    refuse("delivery_overflow");
  return Object.freeze({
    candidateDigest: d.candidateDigest,
    receipt: Object.freeze(receipt),
    manifest,
    envelope,
    h1Input,
    task: Object.freeze({ ...task, instructions: Object.freeze(task.instructions) }),
    transition: Object.freeze(transition)
  });
}

/** The manifest's review identity, compared exactly (attemptEpoch as an exact int). */
function sameReviewIdentity(manifest: ExactJsonDocument, fresh: FreshSnapshot["reviewIdentity"]) {
  const fail = (): never => {
    throw new DeliveryRefusal("fresh_mismatch");
  };
  // As the reference's dict equality: exactly these five fields.
  if (typeof fresh !== "object" || fresh === null) return false;
  const keys = Object.keys(fresh).sort();
  if (keys.join() !== "artifactRef,attemptEpoch,attemptId,nodeId,rootId") return false;
  try {
    const identity = asObject(path(manifest.root, ["state", "mandatory", "identity"], fail), fail);
    for (const key of ["rootId", "nodeId", "attemptId", "artifactRef"] as const)
      if (asString(member(identity, key), fail) !== fresh[key]) return false;
    return (
      typeof fresh.attemptEpoch === "bigint" &&
      asInt(member(identity, "attemptEpoch"), fail) === fresh.attemptEpoch
    );
  } catch (error) {
    if (error instanceof DeliveryRefusal) return false;
    throw error;
  }
}

/**
 * Checks a verified delivery against one as-of snapshot, then binds the H1 option
 * instructions to the committed task. The result is as-of that snapshot only: it
 * narrows, and never closes, the window before any later use.
 */
export function revalidateDelivery(v: VerifiedDelivery, fresh: FreshSnapshot): RevalidatedDelivery {
  if (
    fresh.candidateDigest !== v.receipt.candidateDigest ||
    fresh.recordId !== v.receipt.recordId ||
    !sameReviewIdentity(v.manifest, fresh.reviewIdentity) ||
    fresh.packageRef !== v.task.packageRef
  )
    refuse("fresh_mismatch");
  if (fresh.receiptStatus !== "current") refuse("receipt_not_current");
  if (fresh.currentBinding !== v.transition.linkId) refuse("binding_moved");
  if (fresh.reviewClass !== "candidate") refuse("review_not_candidate");
  if (fresh.pinsProblem) refuse("stale_content");
  if (!Array.isArray(fresh.pending) || !Array.isArray(fresh.queue)) refuse("fresh_mismatch");
  if (fresh.pending.length + fresh.queue.length > UNCERTAINTY_REFS_MAX)
    refuse("uncertainty_overflow");
  const fail = () => refuse("task_mismatch");
  const root = asObject(v.h1Input.root, fail);
  const role = asObject(member(root, "roleInstructions"), fail);
  if (
    asString(member(root, "systemInstruction"), fail) !== v.task.instructions.system ||
    asString(member(role, "fast"), fail) !== v.task.instructions.fast ||
    asString(member(role, "deep"), fail) !== v.task.instructions.deep
  )
    refuse("task_mismatch");
  return Object.freeze({
    ...v,
    revalidation: Object.freeze({
      asOf: "revalidation" as const,
      basis: fresh.basis ?? {},
      pending: Object.freeze([...fresh.pending]),
      queue: Object.freeze([...fresh.queue])
    })
  });
}

/** The whole verification stage: exact bytes, then the supplied snapshot. */
export function verifyHandoffDelivery(
  d: HandoffDelivery,
  fresh: FreshSnapshot
): RevalidatedDelivery {
  return revalidateDelivery(verifyDelivery(d), fresh);
}
