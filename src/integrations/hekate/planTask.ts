import { createHash } from "node:crypto";
import { z } from "zod";
import { buildContext, ContextBudgetError, type ContextBudget } from "../../app/contextBuilder";
import type { ConversationContext } from "../../domain/context";

/**
 * Turns one Hekate claim response into the task context ChatAgent supplies to a
 * worker (docs/implementation/13-hekate-plan-node-integration.md).
 *
 * Hekate's supervisor owns claiming, finishing and releasing; nothing here talks to
 * Hekate or decides whether work may run. The response is validated as received:
 * `replayed` and `stillCurrent` are kept as historical facts, never as permission.
 * Hekate's digests are opaque source identities; ChatAgent hashes the text it
 * actually supplies separately and never derives one from the other.
 *
 * Only the raw response text is accepted. Each public function parses, renders and
 * (for the context) builds in one call, copying caller-supplied rules and limits
 * once, so no intermediate object can be altered or forged between validation and
 * use. The package it returns is frozen.
 */

export const PLAN_CONTRACT_VERSION = "plan-contract/v1";

export type PlanTaskErrorCode =
  | "INPUT_TOO_LARGE"
  | "INVALID_NUMBER"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_CONTRACT"
  | "NO_WORK"
  | "INVALID_RULES"
  | "PACKAGE_TOO_LARGE"
  | "INVALID_OPTIONS";

/** A refusal with a stable code; it never echoes received content. */
export class PlanTaskError extends Error {
  constructor(readonly code: PlanTaskErrorCode) {
    super(code);
    this.name = "PlanTaskError";
  }
}

export interface PlanTaskLimits {
  /** UTF-8 bytes of the raw claim response, checked before parsing. */
  maxResponseBytes: number;
  /** UTF-8 bytes of the serialized prerequisite snapshot. */
  maxPrerequisiteBytes: number;
  maxRules: number;
  /** UTF-8 bytes of all rule paths, revisions and texts together. */
  maxRuleBytes: number;
  /** UTF-8 bytes of the rendered package, checked before any context is built. */
  maxPackageBytes: number;
}

// Local-use choices, not measurements. The provider budget usually binds first;
// these stop oversized input before any parsing or rendering work.
export const DEFAULT_PLAN_TASK_LIMITS: Readonly<PlanTaskLimits> = Object.freeze({
  maxResponseBytes: 1_048_576,
  maxPrerequisiteBytes: 262_144,
  maxRules: 32,
  maxRuleBytes: 262_144,
  maxPackageBytes: 2_097_152
});
const LIMIT_NAMES = Object.keys(DEFAULT_PLAN_TASK_LIMITS) as (keyof PlanTaskLimits)[];
const LIMIT_CEILING = 16_777_216;

/**
 * A frozen copy of explicit limits, or the defaults when none are given. Explicit
 * limits must name every field, each a whole number from 1 to the ceiling; a
 * missing, extra, null or non-numeric field is refused, never defaulted.
 */
export function resolvePlanTaskLimits(limits?: unknown): Readonly<PlanTaskLimits> {
  if (limits === undefined) return DEFAULT_PLAN_TASK_LIMITS;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new Error("Plan task limits must be an object naming every limit.");
  const given = limits as Record<string, unknown>;
  for (const key of Object.keys(given))
    if (!(LIMIT_NAMES as string[]).includes(key))
      throw new Error(`Unknown plan task limit ${JSON.stringify(key)}.`);
  const copy = {} as PlanTaskLimits;
  for (const name of LIMIT_NAMES) {
    const value = given[name];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > LIMIT_CEILING
    )
      throw new Error(
        `${name} must be an integer from 1 to ${LIMIT_CEILING}; got ${String(value)}.`
      );
    copy[name] = value;
  }
  return Object.freeze(copy);
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Plain JSON.parse rounds integers above 2^53 - 1 silently, which would corrupt the
 * attempt epochs and revisions that fence work. Every number written in the raw
 * text must be an exact safe integer; anything else (fractions, exponents, -0,
 * unsafe magnitudes) is refused rather than rounded. The scan reads the raw text,
 * not parsed values, so a number hidden by a later duplicate key is checked too.
 * Text inside strings is skipped, escapes included; JSON.parse then checks syntax.
 */
function parseLossless(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // Skip the string; a backslash escapes the next character.
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const token = /^[-+0-9.eE]+/.exec(text.slice(i, i + 32))![0];
      if (!/^(?:0|-?[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token)))
        throw new PlanTaskError("INVALID_NUMBER");
      i += token.length - 1;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PlanTaskError("INVALID_RESPONSE");
  }
}

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** 1-256 characters, not blank: Hekate's rule for attempt ids and actors. */
const label = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim().length > 0);
const claimKey = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{1,128}$/)
  .refine((s) => s !== "." && s !== "..");
/** 1-256 printable ASCII characters without spaces, as Hekate validates it. */
const executorRef = z
  .string()
  .regex(/^[\x21-\x7e]{1,256}$/)
  .nullable();
const counter = (min: number) => z.number().int().min(min);
/** A System.Text.Json DateTime: kept as received, checked to be a real instant. */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((s) => Number.isFinite(Date.parse(s)));

const contentSnapshot = z
  .object({
    // Both may be null in a valid snapshot; null is kept distinct from empty.
    value: z.string().nullable(),
    attributes: z.record(z.string()).nullable()
  })
  .strict();

const claimedReceipt = z
  .object({
    rootId: guid,
    claimKey,
    outcome: z.literal("claimed"),
    nodeId: guid,
    attemptId: label,
    // The claimed attempt's epoch is always issued, so at least 1.
    attemptEpoch: counter(1),
    executorRef,
    contentRevision: counter(1),
    // Hekate's PlanContentDigest (uppercase) and prerequisite digest (lowercase),
    // kept exactly: a change of either format fails closed here.
    contentDigest: z.string().regex(/^[0-9A-F]{64}$/),
    contentSnapshot,
    prereqDigest: z.string().regex(/^[0-9a-f]{64}$/),
    // Opaque: never interpreted or used to recompute readiness. Nested epochs may be 0.
    prereqSnapshot: z.record(z.unknown()),
    eventSeq: counter(1),
    actor: label,
    createdAt: instant
  })
  .strict();

const noWorkReceipt = z
  .object({
    rootId: guid,
    claimKey,
    outcome: z.literal("no_ready_work"),
    nodeId: z.null(),
    attemptId: z.null(),
    attemptEpoch: z.null(),
    executorRef: z.null(),
    contentRevision: z.null(),
    contentDigest: z.null(),
    contentSnapshot: z.null(),
    prereqDigest: z.null(),
    prereqSnapshot: z.null(),
    eventSeq: z.null(),
    actor: label,
    createdAt: instant
  })
  .strict();

const claimResponse = z
  .object({
    contractVersion: z.string(),
    replayed: z.boolean(),
    stillCurrent: z.boolean(),
    current: z
      .object({
        work: z.enum(["todo", "in_progress", "done", "cancelled"]),
        attemptId: z.string().nullable(),
        attemptEpoch: counter(0)
      })
      .strict()
      .nullable(),
    receipt: z.discriminatedUnion("outcome", [claimedReceipt, noWorkReceipt])
  })
  .strict();

type PlanClaimReceipt = z.infer<typeof claimedReceipt>;
interface PlanClaim {
  contractVersion: typeof PLAN_CONTRACT_VERSION;
  /** Historical facts from the response; neither authorizes running or relaunching. */
  replayed: boolean;
  stillCurrent: boolean;
  receipt: PlanClaimReceipt;
}

/**
 * Validates a raw claim response body exactly as Hekate sent it. Callers pass the
 * original text: parsing and re-serializing first would already round unsafe numbers.
 */
function parsePlanClaim(text: unknown, limits: Readonly<PlanTaskLimits>): PlanClaim {
  if (typeof text !== "string") throw new PlanTaskError("INVALID_RESPONSE");
  if (bytes(text) > limits.maxResponseBytes) throw new PlanTaskError("INPUT_TOO_LARGE");
  const parsed = claimResponse.safeParse(parseLossless(text));
  if (!parsed.success) throw new PlanTaskError("INVALID_RESPONSE");
  const { contractVersion, replayed, stillCurrent, receipt } = parsed.data;
  if (contractVersion !== PLAN_CONTRACT_VERSION) throw new PlanTaskError("UNSUPPORTED_CONTRACT");
  if (receipt.outcome !== "claimed") throw new PlanTaskError("NO_WORK");
  if (bytes(JSON.stringify(receipt.prereqSnapshot)) > limits.maxPrerequisiteBytes)
    throw new PlanTaskError("INPUT_TOO_LARGE");
  return { contractVersion: PLAN_CONTRACT_VERSION, replayed, stillCurrent, receipt };
}

export interface PlanRule {
  /** Repository path, for example "AGENTS.md". */
  path: string;
  /** The revision the text was read at. */
  revision: string;
  text: string;
}

export interface PinnedPlanSource {
  kind: "hekate-plan-leaf";
  contractVersion: typeof PLAN_CONTRACT_VERSION;
  rootId: string;
  nodeId: string;
  claimKey: string;
  attemptId: string;
  attemptEpoch: number;
  executorRef: string | null;
  contentRevision: number;
  /** Hekate's identities for the inputs, as received. */
  contentDigest: string;
  prereqDigest: string;
  eventSeq: number;
  actor: string;
  createdAt: string;
  replayed: boolean;
  stillCurrent: boolean;
  /** SHA-256 of the exact UTF-8 text supplied for each section, computed here. */
  supplied: {
    requirementSha256: string;
    prerequisitesSha256: string;
    rules: readonly { path: string; revision: string; sha256: string }[];
  };
}

export interface PlanTaskInput {
  text: string;
  /** SHA-256 of the whole supplied text. */
  suppliedSha256: string;
  source: PinnedPlanSource;
}

/** A length-prefixed block: deterministic encoding, not protection from prompt injection. */
const block = (label: string, body: string) => `${label} (${bytes(body)} bytes):\n${body}\n`;

/** Reads each rule's fields once into a copy, validates the copies and uses only them. */
function copyRules(rules: unknown, limits: Readonly<PlanTaskLimits>): PlanRule[] {
  if (!Array.isArray(rules) || rules.length > limits.maxRules)
    throw new PlanTaskError("INVALID_RULES");
  const copies: PlanRule[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const rule of rules as unknown[]) {
    if (typeof rule !== "object" || rule === null) throw new PlanTaskError("INVALID_RULES");
    const { path, revision, text } = rule as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      typeof revision !== "string" ||
      typeof text !== "string" ||
      !path.trim() ||
      !revision.trim() ||
      !text ||
      /[\r\n]/.test(path) ||
      /[\r\n]/.test(revision) ||
      paths.has(path)
    )
      throw new PlanTaskError("INVALID_RULES");
    paths.add(path);
    total += bytes(path) + bytes(revision) + bytes(text);
    if (total > limits.maxRuleBytes) throw new PlanTaskError("INVALID_RULES");
    copies.push({ path, revision, text });
  }
  return copies;
}

/**
 * Validates a raw claim response and renders its requirement, prerequisite snapshot
 * and the required rules as one deterministic text. Nothing is trimmed, reordered
 * beyond the stated sort, or dropped; rules are omitted only by passing an empty
 * list. The result is frozen.
 */
export function planTaskFromResponse(
  response: string,
  rules: readonly PlanRule[],
  limits?: PlanTaskLimits
): Readonly<PlanTaskInput> {
  const resolved = resolvePlanTaskLimits(limits);
  const ruleCopies = copyRules(rules, resolved);
  return render(parsePlanClaim(response, resolved), ruleCopies, resolved);
}

function render(
  claim: PlanClaim,
  rules: readonly PlanRule[],
  limits: Readonly<PlanTaskLimits>
): Readonly<PlanTaskInput> {
  const r = claim.receipt;
  const { value, attributes } = r.contentSnapshot;
  // Ordinal by UTF-16 code unit, as Hekate sorts them. Object key order alone is not
  // enough: JavaScript lists integer-like keys first.
  const keys = attributes === null ? [] : Object.keys(attributes).sort();
  const requirement =
    (value === null ? "Requirement: null\n" : block("Requirement", value)) +
    (attributes === null
      ? "Attributes: null\n"
      : `Attributes: ${keys.length}\n` +
        keys
          .map((k) => block("Attribute key", k) + block("Attribute value", attributes[k]))
          .join(""));
  const prerequisites = JSON.stringify(r.prereqSnapshot);
  const header =
    `ChatAgent plan task (${PLAN_CONTRACT_VERSION})\n` +
    `Root: ${r.rootId}\nNode: ${r.nodeId}\nClaim key: ${r.claimKey}\n` +
    `Attempt epoch: ${r.attemptEpoch}\nContent revision: ${r.contentRevision}\n` +
    block("Attempt id", r.attemptId);
  const text =
    header +
    requirement +
    block("Prerequisites", prerequisites) +
    `Rules: ${rules.length}\n` +
    // Path, revision and text are each framed: an unframed label such as
    // "path @ revision" would let different rules render identically.
    rules
      .map(
        (rule) =>
          block("Rule path", rule.path) +
          block("Rule revision", rule.revision) +
          block("Rule text", rule.text)
      )
      .join("");
  if (bytes(text) > limits.maxPackageBytes) throw new PlanTaskError("PACKAGE_TOO_LARGE");
  return deepFreeze({
    text,
    suppliedSha256: sha256(text),
    source: {
      kind: "hekate-plan-leaf",
      contractVersion: PLAN_CONTRACT_VERSION,
      rootId: r.rootId,
      nodeId: r.nodeId,
      claimKey: r.claimKey,
      attemptId: r.attemptId,
      attemptEpoch: r.attemptEpoch,
      executorRef: r.executorRef,
      contentRevision: r.contentRevision,
      contentDigest: r.contentDigest,
      prereqDigest: r.prereqDigest,
      eventSeq: r.eventSeq,
      actor: r.actor,
      createdAt: r.createdAt,
      replayed: claim.replayed,
      stillCurrent: claim.stillCurrent,
      supplied: {
        requirementSha256: sha256(requirement),
        prerequisitesSha256: sha256(prerequisites),
        rules: rules.map((rule) => ({
          path: rule.path,
          revision: rule.revision,
          sha256: sha256(rule.text)
        }))
      }
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export interface PlanTaskContextInput {
  /** The raw claim response body, exactly as received. */
  response: string;
  rules: readonly PlanRule[];
  limits?: PlanTaskLimits;
  systemInstruction: string;
  roleInstructions: Readonly<{ fast: string; deep: string }>;
  budget: ContextBudget;
  capturedAtIso: string;
}

export interface PlanTaskContext extends PlanTaskInput {
  /** Its snapshotId is a fresh random UUID; provenance is `source` and the hashes. */
  context: ConversationContext;
}

const tokens = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);
// buildContext trusts its budget: NaN, infinite or negative reserves would let an
// oversized package through, so every field is required and checked here first.
const contextOptions = z
  .object({
    systemInstruction: z.string(),
    roleInstructions: z.object({ fast: z.string(), deep: z.string() }).strict(),
    budget: z
      .object({
        windowTokens: tokens(1),
        maxHistoryTurns: tokens(0),
        safetyTokens: tokens(0),
        fastOutputTokens: tokens(1),
        deepOutputTokens: tokens(1)
      })
      .strict(),
    capturedAtIso: z.string().datetime()
  })
  .strict();

/**
 * Builds the context through the one existing budget engine. The whole package is
 * the current message, so it is fixed cost: when it does not fit, the result is
 * CONTEXT_TOO_LARGE and nothing is truncated. A plan task carries no history.
 */
export function buildPlanTaskContext(
  options: PlanTaskContextInput
): PlanTaskContext | ContextBudgetError {
  const { response, rules, limits, ...rest } = options;
  // A parsed copy: the budget and instructions used are the ones validated here.
  const checked = contextOptions.safeParse(rest);
  if (!checked.success) throw new PlanTaskError("INVALID_OPTIONS");
  const input = planTaskFromResponse(response, rules, limits);
  const context = buildContext({
    conversationId: `hekate-plan:${input.source.rootId}:${input.source.nodeId}`,
    events: [],
    currentMessageId: input.source.claimKey,
    currentUserText: input.text,
    capturedAtIso: checked.data.capturedAtIso,
    systemInstruction: checked.data.systemInstruction,
    roleInstructions: checked.data.roleInstructions,
    // The conservative UTF-8 estimate only: a caller-supplied counter could
    // under-report. It is an estimate, not a provider tokenizer or a proof of fit.
    budget: checked.data.budget
  });
  if (context instanceof ContextBudgetError) return context;
  // Exactly one message, the package itself, byte for byte; no history, memory,
  // sources or active tasks.
  const [only] = context.messages;
  if (
    context.messages.length !== 1 ||
    only.role !== "user" ||
    only.content !== input.text ||
    context.memory !== null ||
    context.resolvedSources.length ||
    context.unavailableSources.length ||
    context.omittedSourceCount !== 0 ||
    context.includedTurnIds.length ||
    context.omittedTurnIds.length ||
    context.activeTasks.length ||
    context.omittedActiveTaskIds.length ||
    context.budgetUsage?.references !== 0
  )
    throw new Error("A plan task context must carry no history or optional context.");
  // The package fields stay frozen; the context is a fresh object built for this call.
  return { ...input, context };
}
