import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  FAILURE_CODES,
  GATE_OUTCOMES,
  REFUSAL_CODES,
  TRIPWIRE_CODES,
  parseBoundedJson
} from "../../checkpoint/checkpointRecord";
import {
  readCheckpointBudget,
  type BudgetUnavailableReason,
  type CheckpointBudgetView
} from "./checkpointBudget";
import {
  fetchCoordinationStatus,
  planApiBase,
  type CoordinationStatus,
  type LeafStatus
} from "./devCoordination";

/**
 * Read-only durable checkpoint review ledger (doc 21). It classifies already observed plan and
 * runner-record facts into a closed bounded ledger and publishes it locally. It never claims,
 * dispatches, accepts, integrates, retries, notifies or wakes anything, and it runs nothing.
 * Manifest, records and plan facts are supplied, not authenticated; worker liveness stays unknown.
 * Publication is serialized among writers that respect the cooperative lock; it is not an atomic
 * compare-and-swap against arbitrary external writers.
 */

export const MANIFEST_SCHEMA = "checkpoint-queue-manifest/v1";
export const LEDGER_SCHEMA = "checkpoint-queue/v1";
export const QUEUE_LIMITS = {
  maxManifestBytes: 32 * 1024,
  maxLedgerBytes: 64 * 1024,
  maxLockBytes: 128,
  maxEntries: 8,
  deadlineMs: 20_000
} as const;

export type QueueErrorCode =
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_TOO_LARGE"
  | "MANIFEST_INVALID"
  | "LEDGER_DIR_INVALID"
  | "LOCK_BUSY"
  | "LOCK_FAILED"
  | "LEDGER_MISSING"
  | "LEDGER_UNREADABLE"
  | "LEDGER_TOO_LARGE"
  | "LEDGER_INVALID"
  | "LEDGER_UNSUPPORTED_SCHEMA"
  | "LEDGER_IDENTITY_MISMATCH"
  | "LEDGER_MANIFEST_CHANGED"
  | "LEDGER_MOVED"
  | "OUTPUT_TOO_LARGE"
  | "WRITE_FAILED"
  | "DEADLINE";

/** Usage/configuration refusals (exit 2); every other code is an ownership/ledger failure (exit 4). */
export const CONFIG_CODES: readonly QueueErrorCode[] = [
  "MANIFEST_UNREADABLE",
  "MANIFEST_TOO_LARGE",
  "MANIFEST_INVALID",
  "LEDGER_DIR_INVALID"
];

export type CleanupResidue = "temp_retained" | "lock_retained" | "lock_token_changed";

/** A refusal carries its code only: never a path, a manifest value or file content. */
export class QueueError extends Error {
  /** Owned resources that could not be cleaned; empty or absent means none are known to remain. */
  cleanup: CleanupResidue[] = [];
  /** After a deadline refusal, resolves when the abandoned work has finished cleaning up. */
  settled?: Promise<void>;
  constructor(readonly code: QueueErrorCode) {
    super(code);
    this.name = "QueueError";
  }
}

export interface QueueIo {
  lstat: typeof lstat;
  realpath: typeof realpath;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  unlink: typeof unlink;
}
const REAL_IO: QueueIo = { lstat, realpath, open, link, rename, unlink };

// ----- schemas -----

const SAFE = Number.MAX_SAFE_INTEGER;
const safe = (min = 0) => z.number().int().min(min).max(SAFE);
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitRef = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const label = z.string().regex(/^[\x20-\x7e]{1,80}$/);

const expectedSchema = z
  .object({ attemptId: token.nullable(), attemptEpoch: safe(), contentRevision: safe(1) })
  .strict();
export type ExpectedFence = z.infer<typeof expectedSchema>;

const canonicalPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => isAbsolute(v) && resolve(v) === v && !/[\u0000-\u001f]/.test(v));

const caseKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

const manifestEntrySchema = z
  .object({
    entryId: guid,
    rootId: guid,
    nodeId: guid,
    label,
    expected: expectedSchema,
    recordPath: canonicalPath.nullable()
  })
  .strict();
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

const manifestSchema = z
  .object({
    schema: z.literal(MANIFEST_SCHEMA),
    queueId: guid,
    planApiUrl: z.string().min(1).max(200),
    ledgerDir: canonicalPath,
    entries: z.array(manifestEntrySchema).min(1).max(QUEUE_LIMITS.maxEntries)
  })
  .strict()
  .refine((m) => {
    const paths = m.entries.flatMap((e) => (e.recordPath === null ? [] : [caseKey(e.recordPath)]));
    return (
      new Set(m.entries.map((e) => e.entryId)).size === m.entries.length &&
      new Set(m.entries.map((e) => `${e.rootId}|${e.nodeId}`)).size === m.entries.length &&
      new Set(paths).size === paths.length
    );
  })
  .refine((m) => {
    try {
      planApiBase(m.planApiUrl);
      return true;
    } catch {
      return false;
    }
  });
export type QueueManifest = z.infer<typeof manifestSchema>;

export const ENTRY_STATES = [
  "unobservable",
  "needs_operator",
  "accepted",
  "blocked",
  "ready_unclaimed",
  "gate_recorded",
  "review_pending",
  "running_recorded",
  "claimed_unobserved"
] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

const NEEDS_OPERATOR_REASONS = [
  "fence_moved",
  "plan_rejected",
  "plan_stale",
  "plan_cancelled",
  "plan_inconsistent",
  "stop_refused",
  "stop_tripwire",
  "stop_failed",
  "stop_cancelled",
  "exit_nonzero",
  "verification_unavailable",
  "verification_incomplete",
  "source_failure_reported",
  "overdue_unreported"
] as const;

const STATE_REASONS: Record<EntryState, readonly string[]> = {
  unobservable: ["plan_unavailable", "task_missing"],
  needs_operator: NEEDS_OPERATOR_REASONS,
  accepted: ["current_acceptance_recorded"],
  blocked: ["blocked_by_dependency"],
  ready_unclaimed: ["prepare_or_claim_outside_tool"],
  gate_recorded: ["awaiting_lead_acceptance"],
  review_pending: ["awaiting_independent_review"],
  running_recorded: ["liveness_unknown"],
  claimed_unobserved: [
    "record_not_registered",
    "record_missing",
    "record_unreadable",
    "record_too_large",
    "record_invalid",
    "record_unsupported_schema",
    "record_stale_identity",
    "record_timeout"
  ]
};
const ALL_REASONS = [...new Set(Object.values(STATE_REASONS).flat())] as [string, ...string[]];

export const ENTRY_ACTIONS = [
  "none_required",
  "restore_observation",
  "inspect_evidence",
  "wait_for_dependency",
  "prepare_or_claim_outside_tool",
  "run_independent_review",
  "review_acceptance_outside_tool",
  "confirm_owner_outside_tool"
] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

export const QUEUE_OUTCOMES = [
  "all_accepted",
  "review_required",
  "operator_required",
  "ready_requires_claim",
  "blocked",
  "running_recorded",
  "unobservable"
] as const;
export type QueueOutcome = (typeof QUEUE_OUTCOMES)[number];

const observedSchema = z
  .object({ attemptId: token.nullable(), attemptEpoch: safe(), contentRevision: safe(1) })
  .strict();
/** A source artifact is a hex Git SHA, or present-but-withheld; never a path or URL. */
const artifactRefSchema = z.union([gitRef, z.literal("withheld")]).nullable();
const stopSchema = z.union([
  z.object({ kind: z.literal("refused"), code: z.enum(REFUSAL_CODES) }).strict(),
  z.object({ kind: z.literal("tripwire"), code: z.enum(TRIPWIRE_CODES) }).strict(),
  z.object({ kind: z.literal("cancelled"), code: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("exited"), code: z.literal("exited") }).strict(),
  z.object({ kind: z.literal("failed"), code: z.enum(FAILURE_CODES) }).strict()
]);
const gateSchema = z.union([
  z
    .object({
      state: z.enum(["current", "history"]),
      outcome: z.enum(GATE_OUTCOMES),
      sourceRef: gitRef
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "missing",
        "unreadable",
        "too_large",
        "invalid",
        "unsupported_schema",
        "stale_identity",
        "timeout"
      ])
    })
    .strict(),
  z.object({ state: z.literal("none") }).strict()
]);

const observationShape = {
  observed: observedSchema.nullable(),
  state: z.enum(ENTRY_STATES),
  reason: z.enum(ALL_REASONS),
  action: z.enum(ENTRY_ACTIONS),
  artifactRef: artifactRefSchema,
  runId: guid.nullable(),
  recordState: z.enum(["running", "ended"]).nullable(),
  stop: stopSchema.nullable(),
  gate: gateSchema
};
const observationSchema = z.object(observationShape).strict();
export type Classification = z.infer<typeof observationSchema>;

const ledgerEntrySchema = z
  .object({
    entryId: guid,
    rootId: guid,
    nodeId: guid,
    label,
    expected: expectedSchema,
    ...observationShape,
    firstSeenAt: stamp,
    stateSince: stamp
  })
  .strict()
  .refine((e) => STATE_REASONS[e.state].includes(e.reason));
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

const ledgerSchema = z
  .object({
    schema: z.literal(LEDGER_SCHEMA),
    queueId: guid,
    manifestSha256: sha256,
    generation: safe(1),
    evaluatedAt: stamp,
    outcome: z.enum(QUEUE_OUTCOMES),
    entries: z.array(ledgerEntrySchema).min(1).max(QUEUE_LIMITS.maxEntries),
    trust: z.literal("supplied_not_authenticated"),
    workerLiveness: z.literal("unknown"),
    taskMutationAllowed: z.literal(false),
    delivery: z.literal("not_sent"),
    notification: z.literal("none"),
    wake: z.literal("none"),
    acknowledgment: z.literal("none")
  })
  .strict()
  .refine((l) => new Set(l.entries.map((e) => e.entryId)).size === l.entries.length)
  .refine((l) => l.outcome === outcomeOf(l.entries.map((e) => e.state)));
export type QueueLedger = z.infer<typeof ledgerSchema>;

// ----- pure classification -----

export type PlanFact = { kind: "unavailable" } | { kind: "ok"; leaf: LeafStatus | null };

export type RecordFact =
  | { kind: "not_registered" }
  /** Registered or not, but the current fence differs or there is no attempt: nothing was read. */
  | { kind: "not_read" }
  | { kind: "observed"; view: CheckpointBudgetView };

const WITHHELD = "<withheld>";
const TOKEN = /^[\x21-\x7e]{1,200}$/;
const GIT_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const boundedRef = (ref: string | null) =>
  ref === null ? null : GIT_REF.test(ref) ? ref : ("withheld" as const);

function observedFence(leaf: LeafStatus) {
  return {
    attemptId:
      leaf.attemptId === null ? null : TOKEN.test(leaf.attemptId) ? leaf.attemptId : WITHHELD,
    attemptEpoch: leaf.attemptEpoch,
    contentRevision: leaf.contentRevision
  };
}

export function fenceMoved(expected: ExpectedFence, leaf: LeafStatus): boolean {
  return (
    leaf.attemptId !== expected.attemptId ||
    leaf.attemptEpoch !== expected.attemptEpoch ||
    leaf.contentRevision !== expected.contentRevision
  );
}

/** A current acceptance matches the leaf state, attempt, epoch, content and artifact exactly. */
function currentAcceptance(leaf: LeafStatus): boolean {
  const a = leaf.acceptance;
  return (
    leaf.state === "accepted" &&
    !leaf.acceptanceHistorical &&
    a !== null &&
    a.decision === "accepted" &&
    a.attemptId === leaf.attemptId &&
    a.attemptEpoch === leaf.attemptEpoch &&
    a.contentRevision === leaf.contentRevision &&
    a.artifactRef === leaf.artifactRef
  );
}

const NONE_GATE = { state: "none" } as const;

/**
 * First matching rule of doc 21 section 4. Pure: it reads no clock, file or network, and carries
 * no number from a quarantined record.
 */
export function classifyEntry(
  entry: Pick<ManifestEntry, "expected">,
  plan: PlanFact,
  record: RecordFact
): Classification {
  const make = (
    state: EntryState,
    reason: string,
    action: EntryAction,
    rest: Partial<Classification> = {}
  ): Classification => ({
    observed: null,
    state,
    reason,
    action,
    artifactRef: null,
    runId: null,
    recordState: null,
    stop: null,
    gate: NONE_GATE,
    ...rest
  });

  if (plan.kind === "unavailable")
    return make("unobservable", "plan_unavailable", "restore_observation");
  const leaf = plan.leaf;
  if (leaf === null) return make("unobservable", "task_missing", "restore_observation");

  const observed = observedFence(leaf);
  if (fenceMoved(entry.expected, leaf))
    return make("needs_operator", "fence_moved", "inspect_evidence", { observed });
  const artifactRef = boundedRef(leaf.artifactRef);
  const at = { observed, artifactRef };

  if (currentAcceptance(leaf))
    return make("accepted", "current_acceptance_recorded", "none_required", at);

  switch (leaf.state) {
    case "accepted": // accepted without a matching current decision is contradictory
      return make("needs_operator", "plan_inconsistent", "inspect_evidence", at);
    case "rejected":
      return make("needs_operator", "plan_rejected", "inspect_evidence", at);
    case "stale":
      return make("needs_operator", "plan_stale", "inspect_evidence", at);
    case "cancelled":
      return make("needs_operator", "plan_cancelled", "inspect_evidence", at);
    case "blocked":
      return make("blocked", "blocked_by_dependency", "wait_for_dependency", at);
    case "ready":
      break;
    default:
      break;
  }

  if (!leaf.gatesHold || leaf.blockers.length > 0)
    return make("blocked", "blocked_by_dependency", "wait_for_dependency", at);
  if (leaf.state === "ready")
    return make(
      "ready_unclaimed",
      "prepare_or_claim_outside_tool",
      "prepare_or_claim_outside_tool",
      at
    );

  if (record.kind === "observed" && record.view.state === "reported") {
    const { record: run, gate, overdueUnreported } = record.view;
    const detail = {
      ...at,
      runId: run.runId,
      recordState: run.state,
      stop: run.stop.kind === "none" ? null : (run.stop as Classification["stop"]),
      gate:
        gate.state === "unavailable"
          ? ({ state: "unavailable", reason: gate.reason } as const)
          : ({
              state: gate.state,
              outcome: gate.gate.outcome,
              sourceRef: gate.gate.sourceRef
            } as const)
    };
    const exitedClean = run.state === "ended" && run.stop.kind === "exited" && run.exit?.code === 0;
    if (run.state === "ended" && !exitedClean) {
      const reason = run.stop.kind === "exited" ? "exit_nonzero" : `stop_${run.stop.kind}`;
      return make("needs_operator", reason, "inspect_evidence", detail);
    }
    if (gate.state === "current") {
      const outcome = gate.gate.outcome;
      if (outcome === "verifier_unavailable")
        return make("needs_operator", "verification_unavailable", "inspect_evidence", detail);
      if (outcome === "partial")
        return make("needs_operator", "verification_incomplete", "inspect_evidence", detail);
      if (outcome === "source_failed")
        return make("needs_operator", "source_failure_reported", "inspect_evidence", detail);
      return make(
        "gate_recorded",
        "awaiting_lead_acceptance",
        "review_acceptance_outside_tool",
        detail
      );
    }
    if (leaf.state === "review_pending" || exitedClean)
      return make(
        "review_pending",
        "awaiting_independent_review",
        "run_independent_review",
        detail
      );
    if (overdueUnreported)
      return make("needs_operator", "overdue_unreported", "confirm_owner_outside_tool", detail);
    return make("running_recorded", "liveness_unknown", "confirm_owner_outside_tool", detail);
  }

  if (leaf.state === "review_pending")
    return make("review_pending", "awaiting_independent_review", "run_independent_review", at);

  const reason =
    record.kind === "observed" && record.view.state === "unavailable"
      ? `record_${record.view.reason satisfies BudgetUnavailableReason}`
      : "record_not_registered";
  return make("claimed_unobserved", reason, "confirm_owner_outside_tool", at);
}

/** Priority: unobservable, operator, review/acceptance, ready, blocked, running, all accepted. */
export function outcomeOf(states: readonly EntryState[]): QueueOutcome {
  const has = (...wanted: EntryState[]) => states.some((s) => wanted.includes(s));
  if (has("unobservable", "claimed_unobserved")) return "unobservable";
  if (has("needs_operator")) return "operator_required";
  if (has("review_pending", "gate_recorded")) return "review_required";
  if (has("ready_unclaimed")) return "ready_requires_claim";
  if (has("blocked")) return "blocked";
  if (has("running_recorded")) return "running_recorded";
  return "all_accepted";
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function buildLedger(
  manifest: QueueManifest,
  manifestSha256: string,
  classes: readonly Classification[],
  prior: QueueLedger | null,
  evaluatedAt: string
): QueueLedger {
  const entries = manifest.entries.map((entry, i): LedgerEntry => {
    const c = classes[i];
    const before = prior?.entries.find(
      (p) => p.entryId === entry.entryId && p.rootId === entry.rootId && p.nodeId === entry.nodeId
    );
    const unchanged =
      before !== undefined &&
      before.state === c.state &&
      before.reason === c.reason &&
      sameValue(before.observed, c.observed) &&
      sameValue(before.expected, entry.expected);
    return {
      entryId: entry.entryId,
      rootId: entry.rootId,
      nodeId: entry.nodeId,
      label: entry.label,
      expected: entry.expected,
      ...c,
      firstSeenAt: before?.firstSeenAt ?? evaluatedAt,
      stateSince: unchanged ? before.stateSince : evaluatedAt
    };
  });
  return {
    schema: LEDGER_SCHEMA,
    queueId: manifest.queueId,
    manifestSha256,
    generation: (prior?.generation ?? 0) + 1,
    evaluatedAt,
    outcome: outcomeOf(entries.map((e) => e.state)),
    entries,
    trust: "supplied_not_authenticated",
    workerLiveness: "unknown",
    taskMutationAllowed: false,
    delivery: "not_sent",
    notification: "none",
    wake: "none",
    acknowledgment: "none"
  };
}

export function serializeLedger(ledger: QueueLedger): string {
  const checked = ledgerSchema.safeParse(ledger);
  if (!checked.success) throw new QueueError("LEDGER_INVALID");
  const text = `${JSON.stringify(checked.data)}\n`;
  if (Buffer.byteLength(text, "utf8") > QUEUE_LIMITS.maxLedgerBytes)
    throw new QueueError("OUTPUT_TOO_LARGE");
  return text;
}

// ----- parsing and bounded file reads -----

function decodeJson(bytes: Uint8Array, invalid: QueueErrorCode): unknown {
  try {
    return parseBoundedJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new QueueError(invalid);
  }
}

export function parseManifest(bytes: Uint8Array): QueueManifest {
  if (bytes.byteLength > QUEUE_LIMITS.maxManifestBytes) throw new QueueError("MANIFEST_TOO_LARGE");
  const parsed = manifestSchema.safeParse(decodeJson(bytes, "MANIFEST_INVALID"));
  if (!parsed.success) throw new QueueError("MANIFEST_INVALID");
  return parsed.data;
}

export function parseLedger(bytes: Uint8Array): QueueLedger {
  if (bytes.byteLength > QUEUE_LIMITS.maxLedgerBytes) throw new QueueError("LEDGER_TOO_LARGE");
  const raw = decodeJson(bytes, "LEDGER_INVALID");
  const named =
    typeof raw === "object" && raw !== null ? (raw as { schema?: unknown }).schema : undefined;
  if (typeof named === "string" && named !== LEDGER_SCHEMA && named.startsWith("checkpoint-queue/"))
    throw new QueueError("LEDGER_UNSUPPORTED_SCHEMA");
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) throw new QueueError("LEDGER_INVALID");
  return parsed.data;
}

/** lstat, open, fstat and a read allocated no larger than the bound. `null` only for allowed absence. */
async function readBounded(
  path: string,
  max: number,
  io: QueueIo,
  codes: { unreadable: QueueErrorCode; tooLarge: QueueErrorCode },
  allowMissing = false
): Promise<Buffer | null> {
  let info;
  try {
    info = await io.lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (allowMissing && (code === "ENOENT" || code === "ENOTDIR")) return null;
    throw new QueueError(codes.unreadable);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new QueueError(codes.unreadable);
  if (info.size > max) throw new QueueError(codes.tooLarge);
  let handle;
  try {
    handle = await io.open(path, "r");
  } catch {
    throw new QueueError(codes.unreadable);
  }
  try {
    if (!(await handle.stat()).isFile()) throw new QueueError(codes.unreadable);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > max) throw new QueueError(codes.tooLarge);
    return buffer.subarray(0, length);
  } catch (error) {
    throw error instanceof QueueError ? error : new QueueError(codes.unreadable);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const ledgerPath = (dir: string, queueId: string) => join(dir, `${queueId}.queue.json`);
export const lockPath = (dir: string, queueId: string) => join(dir, `${queueId}.lock`);

export async function checkLedgerDir(dir: string, io: QueueIo = REAL_IO): Promise<void> {
  try {
    const info = await io.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new QueueError("LEDGER_DIR_INVALID");
    if (caseKey(await io.realpath(dir)) !== caseKey(dir))
      throw new QueueError("LEDGER_DIR_INVALID");
  } catch (error) {
    throw error instanceof QueueError ? error : new QueueError("LEDGER_DIR_INVALID");
  }
}

export interface LoadedManifest {
  manifest: QueueManifest;
  sha256: string;
}

/** Reads the exact trusted manifest and verifies its ledger directory; echoes nothing on refusal. */
export async function loadManifest(
  path: string,
  override: Partial<QueueIo> = {},
  deadlineMs: number = QUEUE_LIMITS.deadlineMs
): Promise<LoadedManifest> {
  const io: QueueIo = { ...REAL_IO, ...override };
  const read = async (): Promise<LoadedManifest> => {
    const bytes = await readBounded(path, QUEUE_LIMITS.maxManifestBytes, io, {
      unreadable: "MANIFEST_UNREADABLE",
      tooLarge: "MANIFEST_TOO_LARGE"
    });
    const manifest = parseManifest(bytes!);
    await checkLedgerDir(manifest.ledgerDir, io);
    return { manifest, sha256: createHash("sha256").update(bytes!).digest("hex") };
  };
  return withDeadline(read(), deadlineMs);
}

function checkLedgerMatches(
  ledger: QueueLedger,
  manifest: QueueManifest,
  manifestSha256: string
): void {
  if (ledger.queueId !== manifest.queueId) throw new QueueError("LEDGER_IDENTITY_MISMATCH");
  if (
    ledger.manifestSha256 !== manifestSha256 ||
    ledger.entries.length !== manifest.entries.length ||
    ledger.entries.some((e, i) => {
      const m = manifest.entries[i];
      return (
        e.entryId !== m.entryId ||
        e.rootId !== m.rootId ||
        e.nodeId !== m.nodeId ||
        e.label !== m.label ||
        !sameValue(e.expected, m.expected)
      );
    })
  )
    throw new QueueError("LEDGER_MANIFEST_CHANGED");
}

async function readLedgerBytes(manifest: QueueManifest, io: QueueIo) {
  return readBounded(
    ledgerPath(manifest.ledgerDir, manifest.queueId),
    QUEUE_LIMITS.maxLedgerBytes,
    io,
    { unreadable: "LEDGER_UNREADABLE", tooLarge: "LEDGER_TOO_LARGE" },
    true
  );
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new QueueError("DEADLINE")), Math.max(1, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** `--show`: validates and returns the retained ledger. No API request, no write, no lock. */
export async function showQueue(
  loaded: LoadedManifest,
  options: { io?: Partial<QueueIo>; deadlineMs?: number } = {}
): Promise<QueueLedger> {
  const io: QueueIo = { ...REAL_IO, ...options.io };
  const read = async () => {
    const bytes = await readLedgerBytes(loaded.manifest, io);
    if (bytes === null) throw new QueueError("LEDGER_MISSING");
    const ledger = parseLedger(bytes);
    checkLedgerMatches(ledger, loaded.manifest, loaded.sha256);
    return ledger;
  };
  return withDeadline(read(), options.deadlineMs ?? QUEUE_LIMITS.deadlineMs);
}

// ----- evaluation and publication -----

export interface EvaluateDeps {
  fetchStatus?: typeof fetchCoordinationStatus;
  readBudget?: typeof readCheckpointBudget;
  now?: () => Date;
  monotonicMs?: () => number;
  io?: Partial<QueueIo>;
  newToken?: () => string;
  deadlineMs?: number;
  /** Absolute monotonic deadline supplied by the CLI, including manifest loading. */
  deadlineAtMs?: number;
}

export interface EvaluateResult {
  ledger: QueueLedger;
  /** Owned resources that remain after a publication; empty means none are known to remain. */
  cleanup: CleanupResidue[];
}

async function observe(
  loaded: LoadedManifest,
  deps: EvaluateDeps,
  remaining: () => number,
  guard: () => void
): Promise<Classification[]> {
  const fetchStatus = deps.fetchStatus ?? fetchCoordinationStatus;
  const readBudget = deps.readBudget ?? readCheckpointBudget;
  const now = deps.now ?? (() => new Date());
  const { manifest } = loaded;

  const roots = [...new Set(manifest.entries.map((e) => e.rootId))];
  const statuses = new Map<string, CoordinationStatus | null>();
  await Promise.all(
    roots.map(async (rootId) => {
      guard();
      try {
        const timeoutMs = Math.max(1, Math.min(10_000, Math.floor(remaining())));
        statuses.set(rootId, await fetchStatus(manifest.planApiUrl, rootId, { timeoutMs }));
      } catch {
        statuses.set(rootId, null);
      }
    })
  );

  const classes: Classification[] = [];
  for (const entry of manifest.entries) {
    guard();
    const status = statuses.get(entry.rootId);
    const plan: PlanFact =
      status && status.status === "ok"
        ? { kind: "ok", leaf: status.leaves.find((l) => l.nodeId === entry.nodeId) ?? null }
        : { kind: "unavailable" };
    let record: RecordFact = { kind: "not_read" };
    if (plan.kind === "ok" && plan.leaf && !fenceMoved(entry.expected, plan.leaf)) {
      if (entry.recordPath === null) record = { kind: "not_registered" };
      else if (plan.leaf.attemptId !== null) {
        const view = await readBudget(
          { rootId: entry.rootId, nodeId: entry.nodeId, recordPath: entry.recordPath },
          {
            attemptId: plan.leaf.attemptId,
            attemptEpoch: plan.leaf.attemptEpoch,
            contentRevision: plan.leaf.contentRevision,
            artifactRef: plan.leaf.artifactRef
          },
          { now: () => now().getTime() }
        );
        record = { kind: "observed", view };
      }
    }
    classes.push(classifyEntry(entry, plan, record));
  }
  return classes;
}

/**
 * Observes and publishes one ledger generation under the cooperative instance lock. The whole
 * operation shares one monotonic deadline; after a deadline refusal nothing is published, and the
 * abandoned work removes only its own temp file and lock when it settles (`error.settled`).
 */
export async function evaluateQueue(
  loaded: LoadedManifest,
  deps: EvaluateDeps = {}
): Promise<EvaluateResult> {
  const io: QueueIo = { ...REAL_IO, ...deps.io };
  const now = deps.now ?? (() => new Date());
  const mono = deps.monotonicMs ?? (() => performance.now());
  const deadlineMs = deps.deadlineMs ?? QUEUE_LIMITS.deadlineMs;
  const started = mono();
  const deadlineAt = deps.deadlineAtMs ?? started + deadlineMs;
  const remaining = () => deadlineAt - mono();
  const { manifest } = loaded;
  const target = ledgerPath(manifest.ledgerDir, manifest.queueId);
  const lock = lockPath(manifest.ledgerDir, manifest.queueId);
  const instanceToken = (deps.newToken ?? (() => randomBytes(16).toString("hex")))();

  let abandoned = false;
  let lockHeld = false;
  let tempPath: string | null = null;
  const guard = () => {
    if (abandoned || remaining() <= 0) throw new QueueError("DEADLINE");
  };

  const cleanupOwned = async (): Promise<CleanupResidue[]> => {
    const residue: CleanupResidue[] = [];
    if (tempPath !== null) {
      try {
        await io.unlink(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") residue.push("temp_retained");
      }
    }
    if (lockHeld) {
      try {
        const current = await readBounded(lock, QUEUE_LIMITS.maxLockBytes, io, {
          unreadable: "LOCK_FAILED",
          tooLarge: "LOCK_FAILED"
        });
        if (current?.toString("utf8") !== `${instanceToken}\n`) residue.push("lock_token_changed");
        else await io.unlink(lock);
      } catch {
        residue.push("lock_retained");
      }
    }
    return residue;
  };

  const run = async (): Promise<QueueLedger> => {
    guard();
    await checkLedgerDir(manifest.ledgerDir, io);
    guard();
    try {
      const handle = await io.open(lock, "wx", 0o600);
      lockHeld = true;
      try {
        await handle.writeFile(`${instanceToken}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new QueueError(
        (error as NodeJS.ErrnoException).code === "EEXIST" && !lockHeld
          ? "LOCK_BUSY"
          : "LOCK_FAILED"
      );
    }

    guard();
    const priorBytes = await readLedgerBytes(manifest, io);
    let prior: QueueLedger | null = null;
    if (priorBytes !== null) {
      prior = parseLedger(priorBytes);
      checkLedgerMatches(prior, manifest, loaded.sha256);
    }

    const classes = await observe(loaded, deps, remaining, guard);
    const ledger = buildLedger(manifest, loaded.sha256, classes, prior, now().toISOString());
    const text = serializeLedger(ledger);

    guard();
    const temp = join(
      manifest.ledgerDir,
      `.${manifest.queueId}.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      const handle = await io.open(temp, "wx", 0o600);
      tempPath = temp;
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      throw new QueueError("WRITE_FAILED");
    }

    // Observed external change: the prior bytes must be unchanged (or the target still absent).
    const again = await readLedgerBytes(manifest, io);
    if (
      (again === null) !== (priorBytes === null) ||
      (again && priorBytes && !again.equals(priorBytes))
    )
      throw new QueueError("LEDGER_MOVED");

    const currentLock = await readBounded(lock, QUEUE_LIMITS.maxLockBytes, io, {
      unreadable: "LOCK_FAILED",
      tooLarge: "LOCK_FAILED"
    });
    if (currentLock?.toString("utf8") !== `${instanceToken}\n`) throw new QueueError("LOCK_FAILED");

    guard(); // synchronous with the publish call below: no late publication after the deadline
    try {
      if (priorBytes === null) await io.link(temp, target);
      else await io.rename(temp, target);
    } catch (error) {
      throw new QueueError(
        (error as NodeJS.ErrnoException).code === "EEXIST" ? "LEDGER_MOVED" : "WRITE_FAILED"
      );
    }
    return ledger;
  };

  const work = (async (): Promise<EvaluateResult> => {
    let failure: QueueError | undefined;
    let ledger: QueueLedger | undefined;
    try {
      ledger = await run();
    } catch (error) {
      failure = error instanceof QueueError ? error : new QueueError("WRITE_FAILED");
    }
    const residue = lockHeld || tempPath !== null ? await cleanupOwned() : [];
    if (failure) {
      failure.cleanup = residue;
      throw failure;
    }
    return { ledger: ledger!, cleanup: residue };
  })();

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        abandoned = true;
        const error = new QueueError("DEADLINE");
        error.settled = work.then(
          () => undefined,
          () => undefined
        );
        reject(error);
      },
      Math.max(1, deadlineMs)
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// ----- presentation -----

/** Fixed text for humans and AI readers. It never prints a bare healthy/idle/ok result. */
export function describeLedger(ledger: QueueLedger, mode: "evaluate" | "show"): string[] {
  const lines = [
    `queue ${ledger.queueId} generation ${ledger.generation} outcome ${ledger.outcome} evaluated ${ledger.evaluatedAt} (manager UTC clock)`,
    mode === "show"
      ? "retained observation, not current state; no plan request was made"
      : "observation at evaluation time; not a liveness statement",
    "trust supplied_not_authenticated; worker liveness unknown; task mutation not allowed",
    "delivery not_sent; notification none; wake none; acknowledgment none"
  ];
  for (const e of ledger.entries) {
    const o = e.observed;
    lines.push(
      `entry ${e.entryId} "${e.label}" root ${e.rootId} task ${e.nodeId} state ${e.state} reason ${e.reason} action ${e.action}`,
      `  expected attempt ${e.expected.attemptId ?? "none"} epoch ${e.expected.attemptEpoch} content ${e.expected.contentRevision}; observed ` +
        (o
          ? `attempt ${o.attemptId ?? "none"} epoch ${o.attemptEpoch} content ${o.contentRevision}`
          : "none") +
        `; first seen ${e.firstSeenAt}; state since ${e.stateSince}`
    );
    const extra = [
      e.artifactRef === null ? null : `artifact ${e.artifactRef}`,
      e.runId === null ? null : `run ${e.runId}`,
      e.recordState === null ? null : `record ${e.recordState}`,
      e.stop === null ? null : `stop ${e.stop.kind}/${e.stop.code}`,
      e.gate.state === "none"
        ? null
        : e.gate.state === "unavailable"
          ? `gate unavailable ${e.gate.reason}`
          : `gate ${e.gate.state} ${e.gate.outcome} source ${e.gate.sourceRef}`
    ].filter((v): v is string => v !== null);
    if (extra.length) lines.push(`  ${extra.join("; ")}`);
  }
  return lines;
}
