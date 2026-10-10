import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { planApiBase, type LeafStatus } from "../integrations/hekate/devCoordination";
import { CONTINUATION_REASONS, type ContinuationManifest } from "./checkpointContinuation";
import { parseBoundedJson, type RunInput } from "./checkpointRecord";

/**
 * Pure, closed state for the bounded checkpoint queue (doc 26). The queue record owns sequencing
 * and admission only; PlanStore owns tasks and decisions. Everything here is supplied, not
 * authenticated: an actor string or a retained record is never proof of who acted.
 */

export const QUEUE_MANIFEST_SCHEMA = "checkpoint-queue-service-manifest/v1";
export const QUEUE_RECORD_SCHEMA = "checkpoint-queue-service/v1";

export const QUEUE_LIMITS = {
  maxManifestBytes: 32 * 1024,
  maxRecordBytes: 32 * 1024,
  maxItems: 4,
  maxInvocations: 4,
  maxTransitions: 64,
  /** A resume needs room to record at least a few further transitions. */
  resumeTransitionRoom: 8,
  maxWallMs: 7_200_000,
  minPollMs: 1_000,
  maxPollMs: 30_000,
  maxReviewWaitMs: 1_800_000,
  itemWallReserveMs: 30_000,
  maxAcceptors: 4
} as const;

const safe = (min = 0) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const actorToken = z.string().regex(/^[\x21-\x7e]{1,64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitRef = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && !/[\u0000-\u001f]/.test(value));

export const queueManifestSchema = z
  .object({
    schema: z.literal(QUEUE_MANIFEST_SCHEMA),
    queueId: guid,
    queueDir: absolutePath,
    planApiUrl: z
      .string()
      .min(1)
      .max(200)
      .refine((url) => {
        try {
          planApiBase(url);
          return true;
        } catch {
          return false;
        }
      }),
    actor: actorToken,
    acceptors: z
      .array(actorToken)
      .min(1)
      .max(QUEUE_LIMITS.maxAcceptors)
      .refine((values) => new Set(values).size === values.length),
    items: z
      .array(z.object({ manifestPath: absolutePath, manifestSha256: sha256 }).strict())
      .min(1)
      .max(QUEUE_LIMITS.maxItems),
    limits: z
      .object({
        wallMs: safe(1).max(QUEUE_LIMITS.maxWallMs),
        pollMs: safe(QUEUE_LIMITS.minPollMs).max(QUEUE_LIMITS.maxPollMs),
        reviewWaitMs: safe(1).max(QUEUE_LIMITS.maxReviewWaitMs),
        totalUnits: safe(1).max(800),
        totalOutputBytes: safe(1).max(4 * 32 * 1024 * 1024),
        totalProviderCapMicros: safe(1).max(4_000_000_000)
      })
      .strict()
  })
  .strict();
export type QueueManifest = z.infer<typeof queueManifestSchema>;

export class QueueStateError extends Error {
  constructor(
    readonly code: "INPUT_INVALID" | "RECORD_INVALID" | "RECORD_TOO_LARGE" | "HISTORY_FULL"
  ) {
    super(code);
    this.name = "QueueStateError";
  }
}

function parseClosed<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  max: number
) {
  if (bytes.byteLength > max) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const checked = schema.safeParse(parseBoundedJson(text));
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined;
  }
}

/** Throws a code-only error: the manifest is trusted configuration and never echoed back. */
export function parseQueueManifest(bytes: Uint8Array): QueueManifest {
  const value = parseClosed(bytes, queueManifestSchema, QUEUE_LIMITS.maxManifestBytes);
  if (!value) throw new QueueStateError("INPUT_INVALID");
  return value;
}

// ----- record -----

export const ITEM_STATES = [
  "pending",
  "starting",
  "running",
  "waiting_review",
  "accepted",
  "needs_operator"
] as const;
export const START_OUTCOMES = [
  "not_attempted",
  "attempted",
  "confirmed",
  "conflict",
  "uncertain"
] as const;
export const CONTINUATION_OUTCOMES = [
  "none",
  "started",
  "review_pending",
  "needs_operator",
  "refused"
] as const;

export const QUEUE_PHASES = ["running", "stopped", "needs_operator", "completed"] as const;
/** Clean reasons: nothing is uncertain and a resume may revalidate the boundary. */
export const STOPPED_REASONS = [
  "stop_requested",
  "review_timeout",
  "authority_unavailable",
  "not_ready",
  "wall_exceeded",
  "cancelled"
] as const;
export const OPERATOR_REASONS = [
  "review_rejected",
  "acceptance_mismatch",
  "acceptor_not_allowed",
  "fence_moved",
  "admission_exceeded",
  "history_full",
  "source_invalid",
  "start_conflict",
  "start_uncertain",
  "continuation_failed",
  "continuation_refused",
  "lock_lost",
  "internal_error"
] as const;
export const QUEUE_REASONS = [
  "in_progress",
  "all_accepted",
  ...STOPPED_REASONS,
  ...OPERATOR_REASONS
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];
export type ItemState = (typeof ITEM_STATES)[number];

const admissionShape = z
  .object({ units: safe(1), outputBytes: safe(1), providerCapMicros: safe(1) })
  .strict();
export type Admission = z.infer<typeof admissionShape>;

const itemSchema = z
  .object({
    index: safe(0).max(QUEUE_LIMITS.maxItems - 1),
    runId: guid,
    rootId: guid,
    nodeId: guid,
    attemptId: token,
    attemptEpoch: safe(1),
    contentRevision: safe(1),
    /** The frozen state revision AFTER the targeted start. */
    stateRevision: safe(1),
    executorRef: token,
    baseRef: gitRef,
    state: z.enum(ITEM_STATES),
    start: z.enum(START_OUTCOMES),
    continuation: z.enum(CONTINUATION_OUTCOMES),
    continuationReason: z.enum(CONTINUATION_REASONS).nullable(),
    sourceRef: gitRef.nullable(),
    admission: admissionShape
  })
  .strict()
  .refine((item) => {
    switch (item.state) {
      case "pending":
        return (
          item.start === "not_attempted" &&
          item.continuation === "none" &&
          item.sourceRef === null &&
          item.continuationReason === null
        );
      case "starting":
        return item.start === "attempted" && item.continuation === "none";
      case "running":
        return item.start === "confirmed" && item.continuation === "started";
      case "waiting_review":
      case "accepted":
        return (
          item.start === "confirmed" &&
          item.continuation === "review_pending" &&
          item.sourceRef !== null
        );
      case "needs_operator":
        return true;
    }
  });
export type QueueItem = z.infer<typeof itemSchema>;

const transitionSchema = z
  .object({
    generation: safe(1),
    at: timestamp,
    phase: z.enum(QUEUE_PHASES),
    reason: z.enum(QUEUE_REASONS),
    index: safe(0).max(QUEUE_LIMITS.maxItems),
    itemState: z.enum(ITEM_STATES).nullable()
  })
  .strict();
export type QueueTransition = z.infer<typeof transitionSchema>;

const sum = (items: readonly QueueItem[], key: keyof Admission) =>
  items.filter((i) => i.state !== "pending").reduce((total, i) => total + i.admission[key], 0);

export const queueRecordSchema = z
  .object({
    schema: z.literal(QUEUE_RECORD_SCHEMA),
    queueId: guid,
    manifestSha256: sha256,
    generation: safe(1),
    invocations: safe(1).max(QUEUE_LIMITS.maxInvocations),
    phase: z.enum(QUEUE_PHASES),
    reason: z.enum(QUEUE_REASONS),
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp.nullable(),
    /** Index of the current or next item; the item count once every item is accepted. */
    index: safe(0).max(QUEUE_LIMITS.maxItems),
    admissionLimit: z
      .object({ units: safe(1), outputBytes: safe(1), providerCapMicros: safe(1) })
      .strict(),
    admitted: z.object({ units: safe(), outputBytes: safe(), providerCapMicros: safe() }).strict(),
    providerCap: z.literal("configured_enforcement_unverified"),
    items: z.array(itemSchema).min(1).max(QUEUE_LIMITS.maxItems),
    transitions: z.array(transitionSchema).max(QUEUE_LIMITS.maxTransitions),
    recordTrust: z.literal("supplied_not_authenticated"),
    writerLiveness: z.literal("unknown"),
    semanticReview: z.literal("not_performed"),
    delivery: z.literal("not_sent"),
    wake: z.literal("none"),
    integration: z.literal("not_observed")
  })
  .strict()
  .refine((r) => (r.phase === "running") === (r.endedAt === null))
  .refine((r) => {
    if (r.phase === "running") return r.reason === "in_progress";
    if (r.phase === "completed") return r.reason === "all_accepted";
    const clean = (STOPPED_REASONS as readonly string[]).includes(r.reason);
    return r.phase === "stopped"
      ? clean
      : !clean && r.reason !== "in_progress" && r.reason !== "all_accepted";
  })
  .refine(
    (r) =>
      r.items.every((item, i) => item.index === i) &&
      r.index <= r.items.length &&
      r.items.every((item, i) =>
        i < r.index ? item.state === "accepted" : i === r.index || item.state === "pending"
      ) &&
      (r.phase === "completed") === (r.index === r.items.length)
  )
  .refine((r) =>
    (["units", "outputBytes", "providerCapMicros"] as const).every(
      (key) => r.admitted[key] === sum(r.items, key) && r.admitted[key] <= r.admissionLimit[key]
    )
  );
export type QueueRecord = z.infer<typeof queueRecordSchema>;

export function parseQueueRecord(bytes: Uint8Array): QueueRecord | undefined {
  return parseClosed(bytes, queueRecordSchema, QUEUE_LIMITS.maxRecordBytes);
}

export function serializeQueueRecord(record: QueueRecord): string {
  const checked = queueRecordSchema.safeParse(record);
  if (!checked.success) throw new QueueStateError("RECORD_INVALID");
  const text = `${JSON.stringify(checked.data)}\n`;
  if (Buffer.byteLength(text, "utf8") > QUEUE_LIMITS.maxRecordBytes)
    throw new QueueStateError("RECORD_TOO_LARGE");
  return text;
}

export const queueRecordPath = (dir: string, queueId: string) => join(dir, `${queueId}.queue.json`);
export const queueLockPath = (dir: string, queueId: string) => join(dir, `${queueId}.service.lock`);
export const queueStopPath = (dir: string, queueId: string) => join(dir, `${queueId}.stop`);

// ----- admission and item validation -----

/**
 * Provider caps are rounded UP to whole micro-USD from the raw product, so declared worst-case
 * admission is never rounded down. A binary-float product just above a whole micro may round one
 * micro up; that is the conservative direction.
 */
export const providerCapMicros = (usd: number) => Math.ceil(usd * 1_000_000);

export function itemAdmission(manifest: ContinuationManifest): Admission {
  return {
    units: manifest.run.hard.units,
    outputBytes: manifest.run.hard.outputBytes,
    providerCapMicros: providerCapMicros(manifest.run.providerUsdCap ?? 0)
  };
}

const lower = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

export type ItemProblem =
  | "item_count"
  | "api_url"
  | "cap_missing"
  | "duplicate_identity"
  | "scope_overlap"
  | "template_invalid"
  | "wall_too_small"
  | "admission_exceeded"
  | "queue_dir_in_worktree";

/** Cross-item rules over already hash-verified, individually parsed continuation manifests. */
export function validateQueueItems(
  queue: QueueManifest,
  items: readonly ContinuationManifest[]
): ItemProblem | null {
  if (items.length !== queue.items.length) return "item_count";
  if (items.some((m) => m.run.planApiUrl !== queue.planApiUrl)) return "api_url";
  if (items.some((m) => m.run.providerUsdCap === undefined)) return "cap_missing";
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(items.map((m) => m.run.runId)) ||
    !unique(items.map((m) => m.run.identity.nodeId)) ||
    !unique(items.map((m) => lower(m.run.worktree)))
  )
    return "duplicate_identity";
  const files = items.flatMap((m) => m.files.map((f) => f.toLowerCase()));
  if (!unique(files)) return "scope_overlap";
  // The template names the AFTER-start fence, so the node has a previous epoch and revision.
  if (items.some((m) => m.run.identity.attemptEpoch < 1 || m.run.identity.stateRevision < 1))
    return "template_invalid";
  if (items.some((m) => queue.limits.wallMs < m.limits.wallMs + QUEUE_LIMITS.itemWallReserveMs))
    return "wall_too_small";
  const total = items.map(itemAdmission);
  const add = (key: keyof Admission) => total.reduce((acc, a) => acc + a[key], 0);
  if (
    add("units") > queue.limits.totalUnits ||
    add("outputBytes") > queue.limits.totalOutputBytes ||
    add("providerCapMicros") > queue.limits.totalProviderCapMicros
  )
    return "admission_exceeded";
  if (items.some((m) => inside(lower(m.run.worktree), lower(queue.queueDir))))
    return "queue_dir_in_worktree";
  return null;
}

export function initialRecord(
  queue: QueueManifest,
  manifestSha256: string,
  items: readonly ContinuationManifest[],
  at: string
): QueueRecord {
  return {
    schema: QUEUE_RECORD_SCHEMA,
    queueId: queue.queueId,
    manifestSha256,
    generation: 1,
    invocations: 1,
    phase: "running",
    reason: "in_progress",
    startedAt: at,
    updatedAt: at,
    endedAt: null,
    index: 0,
    admissionLimit: {
      units: queue.limits.totalUnits,
      outputBytes: queue.limits.totalOutputBytes,
      providerCapMicros: queue.limits.totalProviderCapMicros
    },
    admitted: { units: 0, outputBytes: 0, providerCapMicros: 0 },
    providerCap: "configured_enforcement_unverified",
    items: items.map((m, index) => ({
      index,
      runId: m.run.runId,
      rootId: m.run.identity.rootId,
      nodeId: m.run.identity.nodeId,
      attemptId: m.run.identity.attemptId,
      attemptEpoch: m.run.identity.attemptEpoch,
      contentRevision: m.run.identity.contentRevision,
      stateRevision: m.run.identity.stateRevision,
      executorRef: m.run.identity.executorRef,
      baseRef: m.run.identity.baseRef,
      state: "pending",
      start: "not_attempted",
      continuation: "none",
      continuationReason: null,
      sourceRef: null,
      admission: itemAdmission(m)
    })),
    transitions: [
      {
        generation: 1,
        at,
        phase: "running",
        reason: "in_progress",
        index: 0,
        itemState: "pending"
      }
    ],
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    semanticReview: "not_performed",
    delivery: "not_sent",
    wake: "none",
    integration: "not_observed"
  };
}

/** Whether a retained record sits at a clean, settled boundary a resume may revalidate. */
export function resumable(record: QueueRecord): boolean {
  if (record.phase !== "stopped" || record.invocations >= QUEUE_LIMITS.maxInvocations) return false;
  if (record.transitions.length > QUEUE_LIMITS.maxTransitions - QUEUE_LIMITS.resumeTransitionRoom)
    return false;
  const current = record.items[record.index];
  return (
    current !== undefined && (current.state === "pending" || current.state === "waiting_review")
  );
}

/** Returns the next record, or throws HISTORY_FULL rather than truncating evidence. */
export function withTransition(
  record: QueueRecord,
  patch: Partial<Omit<QueueRecord, "transitions" | "generation" | "updatedAt" | "endedAt">>,
  at: string,
  append = true
): QueueRecord {
  const phase = patch.phase ?? record.phase;
  const next: QueueRecord = {
    ...record,
    ...patch,
    generation: record.generation + 1,
    updatedAt: at,
    endedAt: phase === "running" ? null : at
  };
  if (!append) return next;
  if (record.transitions.length >= QUEUE_LIMITS.maxTransitions)
    throw new QueueStateError("HISTORY_FULL");
  return {
    ...next,
    transitions: [
      ...record.transitions,
      {
        generation: next.generation,
        at,
        phase: next.phase,
        reason: next.reason,
        index: next.index,
        itemState: next.items[next.index]?.state ?? null
      }
    ]
  };
}

export const replaceItem = (record: QueueRecord, item: QueueItem): QueueItem[] =>
  record.items.map((existing) => (existing.index === item.index ? item : existing));

/** Deterministic key binding one targeted start to this queue and item. */
export const startOperationKey = (queueId: string, index: number, runId: string) =>
  createHash("sha256").update(`${queueId}:${index}:${runId}`).digest("hex");

export function startRequestBody(
  queueId: string,
  index: number,
  run: RunInput,
  actor: string
): string {
  return JSON.stringify({
    to: "in_progress",
    attemptId: run.identity.attemptId,
    executorRef: run.identity.executorRef,
    operationKey: startOperationKey(queueId, index, run.runId),
    expectedStateRevision: run.identity.stateRevision - 1,
    actor
  });
}

// ----- PlanStore predicates (frozen fence, never replaced with fresh values) -----

type Fence = Pick<
  RunInput["identity"],
  "nodeId" | "attemptId" | "attemptEpoch" | "contentRevision" | "stateRevision" | "executorRef"
>;

/** TODO (ready or blocked) at exact content, previous epoch and previous node revision. */
export const todoAtFrozenFence = (leaf: LeafStatus | undefined, fence: Fence): boolean =>
  leaf !== undefined &&
  leaf.nodeId === fence.nodeId &&
  (leaf.state === "ready" || leaf.state === "blocked") &&
  leaf.contentRevision === fence.contentRevision &&
  leaf.attemptEpoch === fence.attemptEpoch - 1 &&
  leaf.stateRevision === fence.stateRevision - 1;

/** Safe to POST the targeted start now: the exact TODO node is ready with its gates holding. */
export const readyToStart = (leaf: LeafStatus | undefined, fence: Fence): boolean =>
  todoAtFrozenFence(leaf, fence) &&
  leaf!.state === "ready" &&
  leaf!.gatesHold &&
  !leaf!.upstreamChanged;

/** After a start: the exact in_progress attempt with the AFTER-start revision and current pins. */
export const startedAtFrozenFence = (leaf: LeafStatus | undefined, fence: Fence): boolean =>
  leaf !== undefined &&
  leaf.nodeId === fence.nodeId &&
  leaf.state === "in_progress" &&
  leaf.attemptPins === "current" &&
  leaf.attemptId === fence.attemptId &&
  leaf.attemptEpoch === fence.attemptEpoch &&
  leaf.contentRevision === fence.contentRevision &&
  leaf.stateRevision === fence.stateRevision &&
  leaf.executorRef === fence.executorRef &&
  leaf.gatesHold &&
  !leaf.upstreamChanged;

export type ReviewVerdict =
  "accepted" | "pending" | "rejected" | "moved" | "artifact_mismatch" | "acceptor_not_allowed";

/**
 * Exact acceptance of the recorded source for the recorded fence. Historical decisions, another
 * artifact or attempt, moved pins and a reviewer outside the allowlist never advance.
 */
export function reviewVerdict(
  leaf: LeafStatus | undefined,
  item: Pick<
    QueueItem,
    "nodeId" | "attemptId" | "attemptEpoch" | "contentRevision" | "executorRef" | "sourceRef"
  >,
  acceptors: readonly string[]
): ReviewVerdict {
  if (
    !leaf ||
    leaf.nodeId !== item.nodeId ||
    leaf.attemptId !== item.attemptId ||
    leaf.attemptEpoch !== item.attemptEpoch ||
    leaf.contentRevision !== item.contentRevision ||
    leaf.executorRef !== item.executorRef ||
    leaf.attemptPins !== "current" ||
    !leaf.gatesHold ||
    leaf.upstreamChanged
  )
    return "moved";
  // A current pending review stays pending beside an older attempt's decision: that history can
  // neither grant acceptance nor end the wait.
  if (leaf.state === "review_pending")
    return leaf.artifactRef === item.sourceRef ? "pending" : "artifact_mismatch";
  if (leaf.acceptanceHistorical) return "moved";
  if (leaf.state === "rejected") return "rejected";
  if (leaf.state !== "accepted") return "moved";
  const decision = leaf.acceptance;
  if (
    !decision ||
    decision.decision !== "accepted" ||
    decision.attemptId !== item.attemptId ||
    decision.attemptEpoch !== item.attemptEpoch ||
    decision.contentRevision !== item.contentRevision
  )
    return "moved";
  if (decision.artifactRef !== item.sourceRef || leaf.artifactRef !== item.sourceRef)
    return "artifact_mismatch";
  return acceptors.includes(decision.decidedBy) ? "accepted" : "acceptor_not_allowed";
}

export const VERDICT_REASON: Record<Exclude<ReviewVerdict, "accepted" | "pending">, QueueReason> = {
  rejected: "review_rejected",
  moved: "fence_moved",
  artifact_mismatch: "acceptance_mismatch",
  acceptor_not_allowed: "acceptor_not_allowed"
};
