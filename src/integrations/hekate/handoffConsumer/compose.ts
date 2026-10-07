import { ContextBudgetError } from "../../../app/contextBuilder";
import {
  buildPlanTaskContext,
  PlanTaskError,
  type PlanTaskContext,
  type PlanTaskContextInput
} from "../planTask";
import {
  CODEC,
  verifyHandoffDelivery,
  type FreshSnapshot,
  type HandoffDelivery,
  type RevalidatedDelivery
} from "./delivery";
import { member, sha256Hex, type JsonNode, type ObjectNode } from "./exactJson";
import { compareCodePoints, pyCanonString } from "./pyCanon";

/**
 * Offline composition of a verified Hekate handoff delivery (plan 034 rev 3 §3–§5,
 * ported from the accepted `e1/consumer.py` `compose`): the import policy stub,
 * bounded retrieval, the separately identified consumer view with its digest and
 * fixed-width reservation, and an H1 call under the reduced window, bound to the
 * committed task. The committed candidate is never altered.
 *
 * Pure: it writes nothing, caches nothing and invokes no model. The only effects are
 * the injected H1 builder and retriever calls. The view is written in `py-canon.v0`
 * without printing a JavaScript float: manifest values come from the verified
 * canonical document (floats keep their verified lexeme, integers stay exact), and
 * host values may hold only strings, booleans, null and exact integers.
 */

export const VIEW_VERSION = "consumer-view.v0";
export const POLICY_VERSION = "import-policy-stub.v0";
/** The accepted reference estimator, whose algorithm ChatAgent's H1 implements. */
export const ESTIMATOR_ID = "chatagent-utf8-conservative-v1@5255daa";
export const MESSAGE_OVERHEAD_TOKENS = 16;
export const RESERVATION_WIDTH = 10;
export const RETRIEVAL_LIMITS = Object.freeze({ calls: 16, items: 64, bytes: 32 * 1024 });
/** Optional items are omitted for budget in this order, the last of a kind first. */
export const DROP_ORDER = ["retrieval", "import", "note"] as const;

export type CompositionRefusalCode =
  | "codec_unsupported"
  | "delivery_mismatch"
  | "policy_invalid"
  | "request_invalid"
  | "retrieval_request_too_large"
  | "retrieval_request_malformed"
  | "h1_unavailable"
  | "h1_refused"
  | "CONTEXT_TOO_LARGE"
  | "task_mismatch";

/** A refusal of the composition. It carries a stable code and never input content. */
export class CompositionRefusal extends Error {
  constructor(readonly code: CompositionRefusalCode) {
    super(code);
    this.name = "CompositionRefusal";
  }
}
const refuse = (code: CompositionRefusalCode): never => {
  throw new CompositionRefusal(code);
};

// --- py-canon.v0 writer -------------------------------------------------------------

/** Text already in py-canon.v0, taken from a verified canonical document. */
class Verbatim {
  constructor(readonly text: string) {}
}
type CanonValue =
  | null
  | boolean
  | string
  | bigint
  | number
  | Verbatim
  | readonly CanonValue[]
  | { readonly [key: string]: CanonValue };

const MAX_HOST_DEPTH = 64;

/**
 * The py-canon.v0 text of a value. Host numbers must be exact integers (a float
 * could not be spelled as Python would without proof), and objects must be plain.
 */
function canon(value: unknown, depth = 0): string {
  if (depth > MAX_HOST_DEPTH) return refuse("codec_unsupported");
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return pyCanonString(wellFormed(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? String(value) : refuse("codec_unsupported");
  if (value instanceof Verbatim) return value.text;
  if (Array.isArray(value)) return `[${value.map((v) => canon(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return refuse("codec_unsupported");
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      compareCodePoints(a, b)
    );
    return `{${entries.map(([k, v]) => `${pyCanonString(wellFormed(k))}:${canon(v, depth + 1)}`).join(",")}}`;
  }
  return refuse("codec_unsupported");
}
const sameValue = (a: unknown, b: unknown) => canon(a) === canon(b);
/**
 * A host string as given, refused if it holds a lone surrogate: UTF-8 cannot carry
 * one (it would become U+FFFD, so two different strings could hash alike), and
 * Python's encoder refuses it too. Producer strings are already checked by the reader.
 */
function wellFormed(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return refuse("codec_unsupported");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return refuse("codec_unsupported");
  }
  return value;
}
const sha = (text: string) => sha256Hex(Buffer.from(wellFormed(text), "utf8"));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

/** A verified canonical manifest node as a value: floats keep their lexeme. */
function fromNode(node: JsonNode): CanonValue {
  switch (node.kind) {
    case "object": {
      const out: Record<string, CanonValue> = {};
      for (const entry of node.entries) out[entry.key] = fromNode(entry.value);
      return out;
    }
    case "array":
      return node.items.map(fromNode);
    case "string":
      return node.value;
    case "number":
      return node.integer ? BigInt(node.lexeme) : new Verbatim(node.lexeme);
    case "boolean":
      return node.value;
    case "null":
      return null;
  }
}
/** A plain host copy for a callback: integers become numbers where exact. */
function toHost(value: CanonValue): unknown {
  if (typeof value === "bigint")
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (value instanceof Verbatim) return Number(value.text);
  if (Array.isArray(value)) return value.map(toHost);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toHost(v)]));
  return value;
}

// Manifest access: the delivery is verified, so a missing field is a mismatch.
const fail = () => refuse("delivery_mismatch");
function at(node: JsonNode | undefined, ...keys: string[]): JsonNode {
  let current = node;
  for (const key of keys)
    current = current?.kind === "object" ? member(current as ObjectNode, key) : undefined;
  return current ?? fail();
}
const text = (node: JsonNode) => (node.kind === "string" ? node.value : fail());
const items = (node: JsonNode) => (node.kind === "array" ? node.items : fail());

// --- policy stub (034 §5): default deny, two questions, recorded tokens -------------

export interface PolicyRule {
  id: string;
  action: "source_read" | "destination_use";
  match: Record<string, unknown>;
  allow: boolean;
}
/** The fixture stub of plan 034, never production authorization. */
export interface ImportPolicy {
  principal: string;
  rules: readonly PolicyRule[];
}
interface Decision {
  action: string;
  rule: string | null;
  allow: boolean;
  token: string | null;
}

function policyDigest(policy: ImportPolicy) {
  return sha(canon({ version: POLICY_VERSION, principal: policy.principal, rules: policy.rules }));
}
/** First matching rule wins; no match denies. A match compares exact canonical values. */
function decide(
  policy: ImportPolicy,
  action: string,
  target: Record<string, CanonValue>
): Decision {
  for (const rule of policy.rules) {
    if (
      rule.action === action &&
      // As the reference's target.get(k) == v: a missing key compares as null.
      Object.entries(rule.match).every(([key, value]) =>
        sameValue(Object.hasOwn(target, key) ? target[key] : null, value)
      )
    ) {
      const token = rule.allow
        ? sha(canon([POLICY_VERSION, policy.principal, action, target, rule.id])).slice(0, 32)
        : null;
      return { action, rule: rule.id, allow: Boolean(rule.allow), token };
    }
  }
  return { action, rule: null, allow: false, token: null };
}
const decisions = (
  policy: ImportPolicy,
  target: Record<string, CanonValue>,
  destination: string
) => [
  decide(policy, "source_read", target),
  decide(policy, "destination_use", { ...target, destinationConversationId: destination })
];

// --- optional items: retrieval, imports, note --------------------------------------

export interface RetrievalResult {
  /** Must echo the requested pointer exactly. */
  pointer: unknown;
  bytes: string;
  basis?: unknown;
}
/** The full manifest pointer plus its source stream -> an as-of result, or nothing. */
export type Retriever = (pointer: Record<string, unknown>) => RetrievalResult | null | undefined;
export interface WantedPointer {
  seq: number | bigint;
  kind: string;
}

type Item = Record<string, CanonValue>;

function retrieve(
  rd: RevalidatedDelivery,
  policy: ImportPolicy,
  destination: string,
  wanted: readonly unknown[],
  retriever: Retriever | undefined
): Item[] {
  const m = rd.manifest.root;
  const transition = at(m, "transition");
  const root = text(at(transition, "root"));
  const claimKey = text(at(transition, "claimKey"));
  const whitelist = new Map<string, Record<string, CanonValue>>();
  for (const entry of [...items(at(m, "evidenceIndex")), ...items(at(m, "optional", "evidence"))]) {
    const value = fromNode(entry) as Record<string, CanonValue>;
    whitelist.set(`${canon(value.seq)}\u0000${canon(value.kind)}`, value);
  }
  // Bound and deduplicate the request before any policy check or callback.
  if (wanted.length > RETRIEVAL_LIMITS.items) refuse("retrieval_request_too_large");
  const keys: { seq: bigint; kind: string }[] = [];
  for (const p of wanted) {
    const w = p as Record<string, unknown>;
    if (
      typeof p !== "object" ||
      p === null ||
      Array.isArray(p) ||
      Object.keys(w).some((k) => k !== "seq" && k !== "kind") ||
      !(typeof w.seq === "bigint" || Number.isSafeInteger(w.seq)) ||
      typeof w.kind !== "string" ||
      w.kind.length > 64
    )
      refuse("retrieval_request_malformed");
    const key = { seq: BigInt(w.seq as number | bigint), kind: w.kind as string };
    if (!keys.some((k) => k.seq === key.seq && k.kind === key.kind)) keys.push(key);
  }
  const out: Item[] = [];
  let calls = 0;
  let included = 0;
  let used = 0;
  for (const { seq, kind } of keys) {
    const target = { kind: "journal", root, claimKey, seq, recordKind: kind };
    const item: Item = { kind: "retrieval", pointer: { seq, kind } };
    const selected = whitelist.get(`${canon(seq)}\u0000${canon(kind)}`);
    if (!selected) {
      out.push({ ...item, status: "denied", reason: "not_selected" });
      continue;
    }
    const full = { ...selected, root, claimKey };
    const decided = decisions(policy, target, destination);
    const base: Item = { ...item, pointer: full, decisions: decided as unknown as CanonValue };
    if (!decided.every((d) => d.allow)) {
      out.push({ ...base, status: "denied", reason: "policy" });
      continue;
    }
    if (!retriever || calls >= RETRIEVAL_LIMITS.calls || included >= RETRIEVAL_LIMITS.items) {
      out.push({ ...base, status: "unavailable", reason: retriever ? "cap" : "no_retriever" });
      continue;
    }
    calls++;
    let got: RetrievalResult | null | undefined;
    try {
      got = retriever(toHost(full) as Record<string, unknown>);
    } catch {
      // An optional source outage: unavailable, nothing of it leaked.
      out.push({ ...base, status: "unavailable", reason: "source_error" });
      continue;
    }
    if (got === null || got === undefined) {
      out.push({ ...base, status: "unavailable", reason: "not_found_or_invalid" });
      continue;
    }
    // The callback's result is read once; only these copies are checked and used.
    let pointer: unknown;
    let body: unknown;
    let basis: unknown;
    let echoed = false;
    try {
      ({ pointer, bytes: body, basis } = got as RetrievalResult);
      echoed = typeof got === "object" && typeof body === "string" && sameValue(pointer, full);
    } catch {
      echoed = false;
    }
    if (!echoed || typeof body !== "string") {
      // The callback can never broaden the whitelist.
      out.push({ ...base, status: "unavailable", reason: "callback_mismatch" });
      continue;
    }
    const n = utf8Length(wellFormed(body));
    if (used + n > RETRIEVAL_LIMITS.bytes) {
      out.push({ ...base, status: "unavailable", reason: "cap" });
      continue;
    }
    used += n;
    included++;
    out.push({
      ...base,
      status: "included",
      label: "as-of",
      basis: new Verbatim(canon(basis ?? null)),
      sha256: sha(body),
      text: body
    });
  }
  return out;
}

function imports(rd: RevalidatedDelivery, policy: ImportPolicy, destination: string): Item[] {
  const listed = items(at(rd.manifest.root, "optional", "imports"));
  const payload = items(at(rd.envelope.root, "payload", "imports"));
  return listed.map((node, i) => {
    const imp = fromNode(node) as Record<string, CanonValue>;
    const ref = imp.ref as Record<string, CanonValue>;
    const body = text(payload[i] ?? fail());
    const item: Item = {
      kind: "import",
      ref,
      provenance: imp.provenance,
      destination: imp.destination
    };
    const decided = decisions(policy, { ...ref, kind: "import" }, destination);
    item.decisions = decided as unknown as CanonValue;
    const dest = imp.destination as Record<string, CanonValue>;
    if (dest?.conversationId !== destination)
      return { ...item, status: "denied", reason: "destination_mismatch" };
    if (!decided.every((d) => d.allow)) return { ...item, status: "denied", reason: "policy" };
    if (sha(body) !== imp.textSha256 || sha(body) !== ref.contentHash)
      return { ...item, status: "unavailable", reason: "hash_mismatch" };
    return {
      ...item,
      status: "included",
      label: `imported:${String(imp.provenance)}`,
      sha256: sha(body),
      text: body
    };
  });
}

function note(rd: RevalidatedDelivery): Item[] {
  const n = at(rd.manifest.root, "optional", "note");
  if (n.kind === "null") return [];
  return [
    {
      kind: "note",
      status: "included",
      label: "claim",
      author: fromNode(at(n, "author")),
      sha256: text(at(n, "sha256")),
      text: text(at(rd.envelope.root, "payload", "note"))
    }
  ];
}

// --- H1 ------------------------------------------------------------------------------

/** Freezes a plain copied value and everything it holds. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export type H1Outcome =
  | {
      ok: true;
      text: string;
      suppliedSha256: string;
      systemInstruction: string;
      roleInstructions: { fast: string; deep: string };
      messages: readonly { role: string; content: string }[];
      /** ChatAgent's whole H1 result, frozen, when the builder is ChatAgent's H1. */
      planTask?: PlanTaskContext;
    }
  | { ok: false; code: string };
/** The H1 options with the reduced window -> H1's result or its typed refusal. */
export type H1Builder = (options: Record<string, unknown>) => H1Outcome;

/** ChatAgent's own H1 (`buildPlanTaskContext`), unchanged. */
export const chatAgentH1: H1Builder = (options) => {
  let result;
  try {
    result = buildPlanTaskContext(options as unknown as PlanTaskContextInput);
  } catch (error) {
    if (error instanceof PlanTaskError) return { ok: false, code: error.code };
    throw error;
  }
  if (result instanceof ContextBudgetError) return { ok: false, code: result.code };
  return {
    ok: true,
    text: result.text,
    suppliedSha256: result.suppliedSha256,
    systemInstruction: result.context.systemInstruction,
    roleInstructions: { ...result.context.roleInstructions },
    messages: result.context.messages.map((m) => ({ role: m.role, content: m.content })),
    planTask: result
  };
};

// --- the view and its emitted part (034 §3, §4) ---------------------------------------

/** The emitted part and its viewDigest, over the view's canonical text only. */
function render(view: Record<string, CanonValue>) {
  const body = canon(view);
  const digest = sha(body);
  return { part: `<<handoff-view ${VIEW_VERSION}>>\n${body}\n<<viewDigest ${digest}>>\n`, digest };
}

/** The fixed-width reservation fixed point: measure with zeros, then fill in. */
function viewCost(view: Record<string, CanonValue>) {
  const zeros = "0".repeat(RESERVATION_WIDTH);
  const cost =
    utf8Length(render({ ...view, reservationTokens: zeros }).part) + MESSAGE_OVERHEAD_TOKENS;
  if (String(cost).length > RESERVATION_WIDTH) refuse("CONTEXT_TOO_LARGE");
  const reservationTokens = String(cost).padStart(RESERVATION_WIDTH, "0");
  const final = { ...view, reservationTokens };
  const { part, digest } = render(final);
  if (utf8Length(part) + MESSAGE_OVERHEAD_TOKENS !== cost)
    throw new Error("reservation fixed point");
  return { cost, reservationTokens, part, digest, view: final };
}

export interface ComposeInput {
  delivery: HandoffDelivery;
  fresh: FreshSnapshot;
  policy: ImportPolicy;
  destination: string;
  h1: H1Builder;
  wanted?: readonly unknown[];
  retriever?: Retriever;
}

export interface Composition {
  /** The emitted view part: header, canonical view, digest line. */
  part: string;
  viewDigest: string;
  viewCost: number;
  reservationTokens: string;
  /** The H1 result bound to the committed task. */
  h1: Extract<H1Outcome, { ok: true }>;
  candidateDigest: string;
  /** The original H1 option budget the view records, exact. */
  budget: Readonly<Record<BudgetKey, bigint>>;
}
export type BudgetKey =
  "windowTokens" | "maxHistoryTurns" | "safetyTokens" | "fastOutputTokens" | "deepOutputTokens";

/**
 * The reference order: verify (refuse whole) -> revalidate against the snapshot ->
 * policy and bounded retrieval (authorization before any callback) -> the view ->
 * measure (fixed point) -> H1 under the reduced window -> bind H1 to the task.
 */
/**
 * Snapshots the host policy before any callback, so a callback changing the
 * caller's object cannot change decisions or the policy digest. Match values are
 * limited to strings, null and exact integers, where canonical equality is Python's
 * `==`; a boolean, float or container (where Python's `True == 1` or `1 == 1.0`
 * would differ) is an explicit unsupported boundary.
 */

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Validates the policy copy taken at entry. Its shape is strict (a plain object with
 * a string principal, and rules with a string id, a known action, a plain match
 * object and a boolean allow), so no value is coerced into an authorization.
 */
function validatePolicy(copy: unknown): ImportPolicy {
  const invalid = () => refuse("policy_invalid");
  if (!isPlain(copy) || typeof copy.principal !== "string" || !Array.isArray(copy.rules))
    return invalid();
  wellFormed(copy.principal);
  for (const rule of copy.rules as unknown[]) {
    if (
      !isPlain(rule) ||
      typeof rule.id !== "string" ||
      (rule.action !== "source_read" && rule.action !== "destination_use") ||
      !isPlain(rule.match) ||
      typeof rule.allow !== "boolean"
    )
      invalid();
    for (const value of Object.values((rule as { match: Record<string, unknown> }).match))
      if (!(
        value === null ||
        typeof value === "string" ||
        typeof value === "bigint" ||
        Number.isSafeInteger(value)
      ))
        refuse("codec_unsupported");
  }
  canon(copy);
  return copy as unknown as ImportPolicy;
}

/** A host value copied now and judged later, so refusal order follows the reference. */
function copyLater<T>(value: T): () => T {
  try {
    const copy = structuredClone(value);
    return () => copy;
  } catch {
    return () => refuse("codec_unsupported");
  }
}

export function composeHandoff(input: ComposeInput): Composition {
  // Every host input is read once and copied before any callback can run, but judged
  // only after the delivery is verified, as in the reference order.
  const policyCopy = copyLater(input.policy);
  const wantedCopy = copyLater(input.wanted ?? []);
  const destinationGiven: unknown = input.destination;
  const { h1, retriever } = input;
  const rd = verifyHandoffDelivery(input.delivery, input.fresh);
  if (typeof destinationGiven !== "string") return refuse("request_invalid");
  const destination = wellFormed(destinationGiven);
  const policy = validatePolicy(policyCopy());
  let wanted: unknown;
  try {
    wanted = wantedCopy();
  } catch {
    return refuse("retrieval_request_malformed");
  }
  if (!Array.isArray(wanted)) return refuse("retrieval_request_malformed");
  // The snapshot facts as validated in this same call, fixed as canonical text now.
  const revalidation = {
    asOf: "revalidation",
    basis: new Verbatim(canon(rd.revalidation.basis)),
    pending: new Verbatim(canon(rd.revalidation.pending)),
    queue: new Verbatim(canon(rd.revalidation.queue))
  };
  let optional = [
    ...retrieve(rd, policy, destination, wanted, retriever),
    ...imports(rd, policy, destination),
    ...note(rd)
  ];
  const m = rd.manifest.root;
  const mt = at(m, "task");
  const budgetNode = at(rd.h1Input.root, "budget");
  const budget: Record<string, bigint> = {};
  for (const key of [
    "windowTokens",
    "maxHistoryTurns",
    "safetyTokens",
    "fastOutputTokens",
    "deepOutputTokens"
  ])
    budget[key] = fromNode(at(budgetNode, key)) as bigint;
  const base: Record<string, CanonValue> = {
    version: VIEW_VERSION,
    codec: CODEC,
    candidateDigest: rd.candidateDigest,
    receipt: {
      handoffId: rd.receipt.handoffId,
      recordId: rd.receipt.recordId,
      seq: rd.receipt.seq,
      recordHash: rd.receipt.recordHash,
      bindingLinkId: rd.receipt.bindingLinkId
    },
    principal: policy.principal,
    destination,
    policy: { version: POLICY_VERSION, digest: policyDigest(policy) },
    estimator: ESTIMATOR_ID,
    budget,
    h1: {
      suppliedSha256: text(at(mt, "suppliedSha256")),
      instructions: fromNode(at(mt, "instructions"))
    },
    mandatory: {
      authority: fromNode(at(m, "authority")),
      state: fromNode(at(m, "state")),
      obligations: fromNode(at(m, "obligations")),
      evidenceIndex: fromNode(at(m, "evidenceIndex")),
      revalidation,
      transition: fromNode(at(m, "transition"))
    }
  };
  const options = JSON.parse(Buffer.from(rd.h1Input.bytes()).toString("utf8"));
  // Exact integer budgeting: each input is at most 2^53 - 1, their sums need not be.
  const reserve =
    (budget.fastOutputTokens > budget.deepOutputTokens
      ? budget.fastOutputTokens
      : budget.deepOutputTokens) + budget.safetyTokens;
  for (;;) {
    const measured = viewCost({ ...base, optional: optional as CanonValue });
    const window = budget.windowTokens - BigInt(measured.cost);
    let result: H1Outcome | undefined;
    // H1 needs at least one window token; a window that leaves no input room is the
    // consumer's own typed CONTEXT_TOO_LARGE, never an H1 options refusal.
    if (window >= 1n && window - reserve >= 0n) {
      try {
        result = h1({
          ...options,
          budget: { ...options.budget, windowTokens: Number(window) }
        });
      } catch {
        // The required Task source failed: refuse, typed, nothing leaked.
        return refuse("h1_unavailable");
      }
      result = readH1(result);
      if (result.ok) return bind(rd, mt, result, measured, budget);
      if (result.code !== "CONTEXT_TOO_LARGE") refuse("h1_refused");
    }
    const drop = dropIndex(optional);
    if (drop === undefined) return refuse("CONTEXT_TOO_LARGE");
    const omitted: Item = { ...optional[drop], status: "omitted", reason: "budget" };
    delete omitted.text;
    optional = [...optional.slice(0, drop), omitted, ...optional.slice(drop + 1)];
  }
}

function dropIndex(optional: readonly Item[]) {
  for (const kind of DROP_ORDER)
    for (let i = optional.length - 1; i >= 0; i--)
      if (optional[i].kind === kind && optional[i].status === "included") return i;
  return undefined;
}

/**
 * The H1 result read once into a frozen copy, so the builder cannot change what was
 * bound afterwards. A non-object or a non-boolean `ok` is h1_unavailable; wrongly
 * typed fields of an ok result are kept as given and then fail binding.
 */
function readH1(result: unknown): H1Outcome {
  const blank = Object.freeze({ role: "", content: "" });
  try {
    if (typeof result !== "object" || result === null) return refuse("h1_unavailable");
    const {
      ok,
      code,
      text,
      suppliedSha256,
      systemInstruction,
      roleInstructions,
      messages,
      planTask
    } = result as Record<string, unknown>;
    if (typeof ok !== "boolean") return refuse("h1_unavailable");
    if (!ok)
      return Object.freeze({ ok: false as const, code: typeof code === "string" ? code : "" });
    let fast: unknown;
    let deep: unknown;
    if (typeof roleInstructions === "object" && roleInstructions !== null)
      ({ fast, deep } = roleInstructions as Record<string, unknown>);
    // A missing, non-array or malformed message list can never be the one task message.
    // Array.from visits holes too, so a sparse list cannot leave an undefined entry.
    const copied = Array.isArray(messages)
      ? Array.from(messages as unknown[], (m) => {
          if (typeof m !== "object" || m === null) return blank;
          const { role, content } = m as Record<string, unknown>;
          return Object.freeze({ role: role as string, content: content as string });
        })
      : [blank, blank];
    return Object.freeze({
      ok: true as const,
      text: text as string,
      suppliedSha256: suppliedSha256 as string,
      systemInstruction: systemInstruction as string,
      roleInstructions: Object.freeze({ fast: fast as string, deep: deep as string }),
      messages: Object.freeze(copied),
      ...(planTask === undefined
        ? {}
        : { planTask: deepFreeze(structuredClone(planTask)) as PlanTaskContext })
    });
  } catch (error) {
    if (error instanceof CompositionRefusal) throw error;
    // A throwing accessor: the required Task source failed.
    return refuse("h1_unavailable");
  }
}

/** H1 stays exactly one message: the committed task, with its instruction digests. */
function bind(
  rd: RevalidatedDelivery,
  mt: JsonNode,
  result: Extract<H1Outcome, { ok: true }>,
  measured: ReturnType<typeof viewCost>,
  budget: Record<string, bigint>
): Composition {
  const task = rd.task.text;
  const [only] = result.messages ?? [];
  if (
    result.text !== task ||
    result.suppliedSha256 !== text(at(mt, "suppliedSha256")) ||
    result.messages?.length !== 1 ||
    only.role !== "user" ||
    only.content !== task
  )
    refuse("task_mismatch");
  const instructions = at(mt, "instructions");
  const digests: [string, string | undefined][] = [
    ["system", result.systemInstruction],
    ["fast", result.roleInstructions?.fast],
    ["deep", result.roleInstructions?.deep]
  ];
  for (const [key, value] of digests)
    if (typeof value !== "string" || sha(value) !== text(at(instructions, key)))
      refuse("task_mismatch");
  return Object.freeze({
    part: measured.part,
    viewDigest: measured.digest,
    viewCost: measured.cost,
    reservationTokens: measured.reservationTokens,
    h1: result,
    candidateDigest: rd.candidateDigest,
    budget: Object.freeze({ ...budget }) as Readonly<Record<BudgetKey, bigint>>
  });
}
