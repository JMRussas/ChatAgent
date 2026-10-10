import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * Portable, closed schemas for the checkpoint run input, the budget record and the lead-supplied
 * gate file (doc 19). Everything here is supplied, not authenticated: a record states what the
 * runner observed about its own owned process, never that work is correct, accepted or integrated.
 * Identity, budget and counter fields are exact safe integers; only provider cost may be decimal.
 */

export const RUN_SCHEMA = "checkpoint-run/v1";
export const BUDGET_SCHEMA = "checkpoint-budget/v1";
export const GATE_SCHEMA = "checkpoint-gate/v1";
export const BUDGET_UNIT = "assistant_message_ids_distinct/v1";
/** Verbatim label shown wherever the unit is displayed. */
export const BUDGET_UNIT_LABEL = "distinct assistant message IDs seen";

export const CHECKPOINT_LIMITS = {
  maxFileBytes: 16 * 1024,
  maxHardUnits: 200,
  maxWallMs: 3_600_000,
  maxOutputBytes: 32 * 1024 * 1024,
  maxLineBytes: 4 * 1024 * 1024,
  defaultLineBytes: 1024 * 1024,
  maxPromptBytes: 256 * 1024,
  maxEvidenceRefs: 8,
  maxChecks: 16,
  maxJsonDepth: 16
} as const;

// ----- bounded strict JSON -----

export type BoundedJsonCode =
  "SYNTAX" | "DUPLICATE_KEY" | "UNSAFE_KEY" | "INVALID_NUMBER" | "DEPTH";
export class BoundedJsonError extends Error {
  constructor(readonly code: BoundedJsonCode) {
    super(code);
    this.name = "BoundedJsonError";
  }
}

export interface BoundedJsonOptions {
  maxDepth?: number;
  /**
   * `record`: an integer token must be a safe integer and a decimal token must not have an
   * integral value outside the two provider monetary fields, so "1.0" cannot pass as a counter.
   * `stream`: any finite number (provider metadata); schemas still validate what they use.
   */
  numbers?: "record" | "stream";
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Feature-local JSON parser: refuses duplicate keys (after escape decoding), `__proto__`, bad
 * numbers and nesting beyond the bound. The shared plan parser stays integer-only on purpose.
 */
export function parseBoundedJson(text: string, options: BoundedJsonOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? CHECKPOINT_LIMITS.maxJsonDepth;
  const strict = (options.numbers ?? "record") === "record";
  let at = 0;
  const fail = (code: BoundedJsonCode): never => {
    throw new BoundedJsonError(code);
  };
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at++;
  };
  const string = (): string => {
    const start = at;
    if (text[at] !== '"') fail("SYNTAX");
    for (at++; at < text.length && text[at] !== '"'; at++) {
      if (text.charCodeAt(at) < 0x20) fail("SYNTAX");
      if (text[at] === "\\") at++;
    }
    if (at >= text.length) fail("SYNTAX");
    at++;
    try {
      return JSON.parse(text.slice(start, at)) as string;
    } catch {
      return fail("SYNTAX");
    }
  };
  const number = (path: string[]): number => {
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(text);
    if (!match) return fail("SYNTAX");
    const token = match[0];
    at += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) return fail("INVALID_NUMBER");
    if (strict) {
      const decimal = /[.eE]/.test(token);
      if (Object.is(value, -0)) fail("INVALID_NUMBER");
      if (!decimal && !Number.isSafeInteger(value)) fail("INVALID_NUMBER");
      const monetary =
        (path.length === 1 && path[0] === "providerUsdCap") ||
        (path.length === 2 && path[0] === "providerReported" && path[1] === "costUsd");
      if (decimal && Number.isInteger(value) && !monetary) fail("INVALID_NUMBER");
    }
    return value;
  };
  const value = (depth: number, path: string[] = []): unknown => {
    space();
    const c = text[at];
    if (c === "{") {
      if (depth >= maxDepth) fail("DEPTH");
      at++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      space();
      if (text[at] === "}") {
        at++;
        return out;
      }
      for (;;) {
        space();
        const key = string();
        if (key === "__proto__") fail("UNSAFE_KEY");
        if (seen.has(key)) fail("DUPLICATE_KEY");
        seen.add(key);
        space();
        if (text[at++] !== ":") fail("SYNTAX");
        out[key] = value(depth + 1, [...path, key]);
        space();
        const next = text[at++];
        if (next === "}") return out;
        if (next !== ",") fail("SYNTAX");
      }
    }
    if (c === "[") {
      if (depth >= maxDepth) fail("DEPTH");
      at++;
      const out: unknown[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1, [...path, "[]"]));
        space();
        const next = text[at++];
        if (next === "]") return out;
        if (next !== ",") fail("SYNTAX");
      }
    }
    if (c === '"') return string();
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ] as const)
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    return number(path);
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("SYNTAX");
  return result;
}

// ----- schemas -----

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const safe = (min = 0) => z.number().int().min(min).max(MAX_SAFE);
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitRef = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && !/[\u0000-\u001f]/.test(value));

export const PROFILES = ["readonly_smoke", "coding"] as const;
export type CheckpointProfile = (typeof PROFILES)[number];

export const REFUSAL_CODES = [
  "profile_unsupported",
  "pin_mismatch",
  "worktree_invalid",
  "authority_mismatch",
  "authority_unavailable",
  "claim_already_owned"
] as const;
export const TRIPWIRE_CODES = [
  "hard_units",
  "hard_wall",
  "hard_output",
  "counter_uncertain",
  "authority_changed"
] as const;
export const FAILURE_CODES = [
  "exited_nonzero",
  "spawn_failed",
  "cleanup_failed",
  "record_write_failed"
] as const;

const stopSchema = z.union([
  z.object({ kind: z.literal("none"), code: z.literal("none") }).strict(),
  z.object({ kind: z.literal("refused"), code: z.enum(REFUSAL_CODES) }).strict(),
  z.object({ kind: z.literal("tripwire"), code: z.enum(TRIPWIRE_CODES) }).strict(),
  z.object({ kind: z.literal("cancelled"), code: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("exited"), code: z.literal("exited") }).strict(),
  z.object({ kind: z.literal("failed"), code: z.enum(FAILURE_CODES) }).strict()
]);
export type StopRecord = z.infer<typeof stopSchema>;

const fenceShape = {
  rootId: guid,
  nodeId: guid,
  attemptId: token,
  attemptEpoch: safe(),
  contentRevision: safe(1)
};

export const budgetRecordSchema = z
  .object({
    schema: z.literal(BUDGET_SCHEMA),
    runId: guid,
    identity: z
      .object({ ...fenceShape, observedStateRevision: safe(), executorRef: token })
      .strict(),
    baseRef: gitRef,
    profile: z.enum(PROFILES),
    state: z.enum(["running", "ended"]),
    unit: z.literal(BUDGET_UNIT),
    expected: z
      .object({
        units: safe(1).max(CHECKPOINT_LIMITS.maxHardUnits),
        basis: z.literal("provisional_heuristic")
      })
      .strict(),
    hard: z
      .object({
        units: safe(1).max(CHECKPOINT_LIMITS.maxHardUnits),
        wallMs: safe(1).max(CHECKPOINT_LIMITS.maxWallMs),
        outputBytes: safe(1).max(CHECKPOINT_LIMITS.maxOutputBytes)
      })
      .strict(),
    consumed: z
      .object({
        units: safe().max(CHECKPOINT_LIMITS.maxHardUnits + 1),
        wallMs: safe(),
        outputBytes: safe(),
        counterState: z.enum(["exact_observed", "lower_bound"])
      })
      .strict(),
    expectedExceeded: z.boolean(),
    providerReported: z
      .object({
        numTurns: safe().nullable(),
        costUsd: z.number().finite().min(0).max(1_000_000_000).nullable(),
        status: z.literal("unverified")
      })
      .strict(),
    cost: z
      .object({ enforcement: z.enum(["none", "provider_cap_configured_unverified"]) })
      .strict(),
    stop: stopSchema,
    exit: z
      .object({
        code: z.number().int().min(-2147483648).max(2147483647).nullable(),
        signal: z
          .string()
          .regex(/^SIG[A-Z0-9]{1,12}$/)
          .nullable()
      })
      .strict()
      .nullable(),
    rootPid: safe(1).nullable(),
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp.nullable(),
    writer: z.literal("runner_record"),
    recordTrust: z.literal("supplied_not_authenticated"),
    writerLiveness: z.literal("unknown"),
    artifactRef: gitRef.nullable()
  })
  .strict()
  .refine((r) => r.expected.units <= r.hard.units)
  .refine((r) =>
    r.state === "running"
      ? r.stop.kind === "none" && r.endedAt === null
      : r.stop.kind !== "none" && r.endedAt !== null
  );
export type BudgetRecord = z.infer<typeof budgetRecordSchema>;

export const GATE_CHECK_RESULTS = ["pass", "fail", "unavailable"] as const;
export const GATE_OUTCOMES = [
  "checks_passed",
  "source_failed",
  "partial",
  "verifier_unavailable"
] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/**
 * Check results do not establish cause. A source verdict needs explicit lead attribution;
 * unavailable checks prevent a clean verdict and an unattributed failure remains partial.
 */
export function deriveGateOutcome(
  checks: readonly { result: (typeof GATE_CHECK_RESULTS)[number] }[],
  failureAttribution: "source" | "unattributed" = "unattributed"
): GateOutcome {
  if (checks.length === 0 || checks.every((c) => c.result === "unavailable"))
    return "verifier_unavailable";
  if (checks.every((c) => c.result === "pass")) return "checks_passed";
  if (
    failureAttribution === "source" &&
    checks.some((c) => c.result === "fail") &&
    checks.every((c) => c.result !== "unavailable")
  )
    return "source_failed";
  return "partial";
}

export const gateRecordSchema = z
  .object({
    schema: z.literal(GATE_SCHEMA),
    runId: guid,
    identity: z.object(fenceShape).strict(),
    sourceRef: gitRef,
    suppliedBy: z.literal("lead"),
    recordedAt: timestamp,
    evidenceRefs: z
      .array(z.string().regex(/^[\x21-\x7e]{1,128}$/))
      .max(CHECKPOINT_LIMITS.maxEvidenceRefs),
    checks: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_.:/ -]{1,64}$/),
            result: z.enum(GATE_CHECK_RESULTS)
          })
          .strict()
      )
      .max(CHECKPOINT_LIMITS.maxChecks),
    failureAttribution: z.enum(["source", "unattributed"]).default("unattributed"),
    outcome: z.enum(GATE_OUTCOMES)
  })
  .strict()
  .refine((g) => g.outcome === deriveGateOutcome(g.checks, g.failureAttribution))
  .refine((g) => g.outcome !== "source_failed" || g.evidenceRefs.length > 0);
export type GateRecord = z.infer<typeof gateRecordSchema>;

export const runInputSchema = z
  .object({
    schema: z.literal(RUN_SCHEMA),
    runId: guid,
    unit: z.literal(BUDGET_UNIT),
    profile: z.enum(PROFILES),
    identity: z
      .object({
        rootId: guid,
        nodeId: guid,
        attemptId: token,
        attemptEpoch: safe(),
        contentRevision: safe(1),
        stateRevision: safe(),
        executorRef: token,
        baseRef: gitRef
      })
      .strict(),
    executable: z.object({ path: absolutePath, sha256 }).strict(),
    gitExecutable: z.object({ path: absolutePath, sha256 }).strict(),
    worktree: absolutePath,
    promptFile: absolutePath,
    promptSha256: sha256,
    recordDir: absolutePath,
    model: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    expected: z.object({ units: safe(1).max(CHECKPOINT_LIMITS.maxHardUnits) }).strict(),
    hard: z
      .object({
        units: safe(1).max(CHECKPOINT_LIMITS.maxHardUnits),
        wallMs: safe(1).max(CHECKPOINT_LIMITS.maxWallMs),
        outputBytes: safe(1).max(CHECKPOINT_LIMITS.maxOutputBytes)
      })
      .strict(),
    maxLineBytes: safe(64).max(CHECKPOINT_LIMITS.maxLineBytes).optional(),
    providerUsdCap: z.number().positive().max(1000).optional(),
    planApiUrl: z.string().min(1).max(200)
  })
  .strict()
  .refine((input) => input.expected.units <= input.hard.units);
export type RunInput = z.infer<typeof runInputSchema>;

// ----- parsing -----

export type RecordParseFailure = "invalid" | "unsupported_schema";

function parseFile<T>(
  bytes: Uint8Array,
  schemaName: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): { ok: true; value: T } | { ok: false; reason: RecordParseFailure } {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = parseBoundedJson(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const named =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { schema?: unknown }).schema
      : undefined;
  if (
    typeof named === "string" &&
    named !== schemaName &&
    named.startsWith(schemaName.slice(0, schemaName.indexOf("/") + 1))
  )
    return { ok: false, reason: "unsupported_schema" };
  const checked = schema.safeParse(parsed);
  return checked.success ? { ok: true, value: checked.data } : { ok: false, reason: "invalid" };
}

export const parseBudgetRecord = (bytes: Uint8Array) =>
  parseFile(bytes, BUDGET_SCHEMA, budgetRecordSchema);
export const parseGateRecord = (bytes: Uint8Array) =>
  parseFile(bytes, GATE_SCHEMA, gateRecordSchema);

/** Throws a code-only error: a run input is trusted configuration and never echoed back. */
export function parseRunInput(bytes: Uint8Array): RunInput {
  if (bytes.byteLength > CHECKPOINT_LIMITS.maxFileBytes)
    throw new CheckpointRecordError("INPUT_INVALID");
  const result = parseFile(bytes, RUN_SCHEMA, runInputSchema);
  if (!result.ok) throw new CheckpointRecordError("INPUT_INVALID");
  return result.value;
}

// ----- writing -----

export type CheckpointRecordErrorCode =
  "INPUT_INVALID" | "RECORD_INVALID" | "RECORD_TOO_LARGE" | "RECORD_EXISTS" | "RECORD_WRITE_FAILED";
/** Fixed write stages and symbolic errnos; the only filesystem detail a write failure may carry. */
export const RECORD_WRITE_OPERATIONS = [
  "serialize",
  "open",
  "write",
  "close",
  "rename",
  "unknown"
] as const;
export type RecordWriteOperation = (typeof RECORD_WRITE_OPERATIONS)[number];
export const RECORD_SYSTEM_CODES = [
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOENT",
  "EIO",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "EEXIST",
  "UNKNOWN"
] as const;
export type RecordSystemCode = (typeof RECORD_SYSTEM_CODES)[number];

/** Maps any thrown value onto the allowlist; the original code string is never carried over. */
export function systemCodeOf(error: unknown): RecordSystemCode {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return RECORD_SYSTEM_CODES.find((known) => known === code && known !== "UNKNOWN") ?? "UNKNOWN";
}

export class CheckpointRecordError extends Error {
  readonly operation?: RecordWriteOperation;
  readonly systemCode?: RecordSystemCode;
  constructor(
    readonly code: CheckpointRecordErrorCode,
    detail?: { operation: RecordWriteOperation; systemCode: RecordSystemCode }
  ) {
    super(code);
    this.name = "CheckpointRecordError";
    if (detail) {
      this.operation = detail.operation;
      this.systemCode = detail.systemCode;
    }
  }
}

export const RECORD_WRITE_DIAGNOSTIC_SCHEMA = "checkpoint-record-write-diagnostic/v1";
const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One fixed-shape line for the trusted runner's own stderr. Observational only: it holds a
 * validated run id and two allowlisted symbols, never a message, path, stack or record data.
 */
export function recordWriteDiagnosticLine(runId: string, error: unknown): string | null {
  if (!RUN_ID_SHAPE.test(runId)) return null;
  let operation: RecordWriteOperation = "unknown";
  let systemCode: RecordSystemCode = "UNKNOWN";
  try {
    // Types are not runtime validation: each field is read once and re-checked against the
    // fixed allowlists. A throwing getter or malformed detail degrades to unknown/UNKNOWN.
    if (error instanceof CheckpointRecordError) {
      const code: unknown = error.code;
      if (code === "RECORD_INVALID" || code === "RECORD_TOO_LARGE") operation = "serialize";
      else {
        const rawOperation: unknown = error.operation;
        const rawSystemCode: unknown = error.systemCode;
        const knownOperation = RECORD_WRITE_OPERATIONS.find((known) => known === rawOperation);
        const knownSystemCode = RECORD_SYSTEM_CODES.find((known) => known === rawSystemCode);
        if (knownOperation && knownSystemCode) {
          operation = knownOperation;
          systemCode = knownSystemCode;
        }
      }
    }
  } catch {
    operation = "unknown";
    systemCode = "UNKNOWN";
  }
  return `${JSON.stringify({
    schema: RECORD_WRITE_DIAGNOSTIC_SCHEMA,
    runId,
    operation,
    systemCode
  })}\n`;
}

const writeFailure = (operation: RecordWriteOperation, error: unknown) =>
  new CheckpointRecordError("RECORD_WRITE_FAILED", { operation, systemCode: systemCodeOf(error) });

export const budgetRecordPath = (dir: string, runId: string) => join(dir, `${runId}.budget.json`);
export const gateRecordPath = (dir: string, runId: string) => join(dir, `${runId}.gate.json`);

export function serializeBudgetRecord(record: BudgetRecord): string {
  const checked = budgetRecordSchema.safeParse(record);
  if (!checked.success) throw new CheckpointRecordError("RECORD_INVALID");
  const text = `${JSON.stringify(checked.data)}\n`;
  if (Buffer.byteLength(text, "utf8") > CHECKPOINT_LIMITS.maxFileBytes)
    throw new CheckpointRecordError("RECORD_TOO_LARGE");
  return text;
}

/** Exclusive create: an existing run id is refused, never overwritten or duplicated. */
export async function reserveBudgetRecord(dir: string, record: BudgetRecord): Promise<void> {
  const text = serializeBudgetRecord(record);
  let handle;
  try {
    handle = await open(budgetRecordPath(dir, record.runId), "wx");
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST"
      ? new CheckpointRecordError("RECORD_EXISTS")
      : writeFailure("open", error);
  }
  try {
    await handle.writeFile(text, "utf8");
  } catch (error) {
    throw writeFailure("write", error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Atomic replace: a temp file in the same directory, then a rename. */
export async function replaceBudgetRecord(dir: string, record: BudgetRecord): Promise<void> {
  const text = serializeBudgetRecord(record);
  const finalPath = budgetRecordPath(dir, record.runId);
  const temp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
  let operation: RecordWriteOperation = "open";
  try {
    const handle = await open(temp, "wx");
    try {
      operation = "write";
      await handle.writeFile(text, "utf8");
    } finally {
      const writeStage = operation;
      operation = "close";
      await handle.close();
      operation = writeStage;
    }
    operation = "rename";
    await rename(temp, finalPath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw writeFailure(operation, error);
  }
}
