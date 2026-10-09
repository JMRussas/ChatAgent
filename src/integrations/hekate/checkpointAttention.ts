import { createHash } from "node:crypto";
import { z } from "zod";
import {
  FAILURE_CODES,
  REFUSAL_CODES,
  TRIPWIRE_CODES,
  parseBoundedJson
} from "../../checkpoint/checkpointRecord";
import type { CheckpointRecordEntry } from "../../config/checkpointRecordsConfig";
import type { ExecutiveOverview, ExecutiveRootView } from "./executiveOverview";
import type { LeafState } from "./devCoordination";
import { FORBIDDEN_ACTIONS } from "./recoveryAssessment";

/**
 * `checkpoint-attention/v1`: a pure, derived summary of the exact facts registered runner records
 * and lead gate files already carry, plus the `checkpoint-handoff/v1` record built from it
 * (doc 20). Everything here is supplied and unauthenticated. A "stopped" item means a supplied
 * record says so, never that a process is gone; an "overdue" item means no end was recorded past
 * a declared bound, never that anything hung; a verification outage stays unattributed. The
 * projection reads no file, clock, random source or network.
 */

export const ATTENTION_LIMITS = {
  maxItems: 32,
  maxItemBytes: 1024,
  maxHandoffBytes: 64 * 1024
} as const;

export const HANDOFF_SCHEMA = "checkpoint-handoff/v1";

export const ATTENTION_KINDS = [
  "cleanup_unconfirmed",
  "overdue_unreported",
  "stopped_tripwire",
  "stopped_failed",
  "refused_start",
  "verification_unavailable"
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_ACTIONS = [
  "inspect_owned_process_manually",
  "confirm_owner_before_any_action",
  "decide_new_attempt_or_discard",
  "fix_start_precondition",
  "rerun_independent_checks_outside_worker"
] as const;
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];

const ACTION_OF: Record<AttentionKind, AttentionAction> = {
  cleanup_unconfirmed: "inspect_owned_process_manually",
  overdue_unreported: "confirm_owner_before_any_action",
  stopped_tripwire: "decide_new_attempt_or_discard",
  stopped_failed: "decide_new_attempt_or_discard",
  refused_start: "fix_start_precondition",
  verification_unavailable: "rerun_independent_checks_outside_worker"
};

export const ATTENTION_FORBIDDEN: readonly string[] = [
  ...FORBIDDEN_ACTIONS,
  "model_retry",
  "terminate_unknown_pid",
  "second_worker_for_claim"
];

export interface AttentionFence {
  attemptId: string;
  attemptEpoch: number;
  contentRevision: number;
}

export interface AttentionItem {
  kind: AttentionKind;
  rootId: string;
  nodeId: string;
  fence: AttentionFence;
  runId: string;
  stop: { kind: string; code: string };
  recordState: "running" | "ended";
  recordUpdatedAt: string;
  /** Only for cleanup_unconfirmed; a recorded descriptor, never authority. */
  rootPid: number | null;
  /** Only for verification_unavailable. */
  gateSourceRef: string | null;
  taskState: LeafState;
  /** False when the size cap omitted the task row. */
  taskListed: boolean;
  attribution: "unattributed";
  action: AttentionAction;
  trust: "supplied_not_authenticated";
  writerLiveness: "unknown";
}

export interface Attention {
  items: AttentionItem[];
  omitted: number;
  /** Registry entries whose task, root or record could not be observed as a matching record. */
  registeredRecordsUnavailable: number;
  basis: "supplied_records";
  automaticAllowed: false;
  forbidden: readonly string[];
}

const PRIORITY = new Map<AttentionKind, number>(ATTENTION_KINDS.map((kind, i) => [kind, i]));
const SUPPRESSIBLE: ReadonlySet<AttentionKind> = new Set([
  "stopped_tripwire",
  "stopped_failed",
  "refused_start"
]);

const itemBytes = (item: unknown) => Buffer.byteLength(JSON.stringify(item), "utf8");

function itemsOfTask(
  root: ExecutiveRootView,
  task: ExecutiveRootView["tasks"][number]
): AttentionItem[] {
  const budget = task.checkpointBudget;
  if (!budget || budget.state !== "reported") return [];
  const { record, gate } = budget;
  const base = {
    rootId: root.rootId,
    nodeId: task.nodeId,
    fence: {
      attemptId: record.identity.attemptId,
      attemptEpoch: record.identity.attemptEpoch,
      contentRevision: record.identity.contentRevision
    },
    runId: record.runId,
    stop: { kind: record.stop.kind, code: record.stop.code },
    recordState: record.state,
    recordUpdatedAt: record.updatedAt,
    taskState: task.state,
    taskListed: true,
    attribution: "unattributed" as const,
    trust: "supplied_not_authenticated" as const,
    writerLiveness: "unknown" as const
  };
  const make = (
    kind: AttentionKind,
    extra: { rootPid: number | null; gateSourceRef: string | null }
  ): AttentionItem => ({ kind, ...base, ...extra, action: ACTION_OF[kind] });
  const inactive = task.state === "accepted" || task.state === "cancelled";
  const out: AttentionItem[] = [];

  let primary: AttentionKind | null = null;
  if (record.stop.code === "cleanup_failed") primary = "cleanup_unconfirmed";
  else if (budget.overdueUnreported) primary = "overdue_unreported";
  else if (record.state === "ended") {
    if (record.stop.kind === "tripwire") primary = "stopped_tripwire";
    else if (record.stop.kind === "failed") primary = "stopped_failed";
    else if (record.stop.kind === "refused") primary = "refused_start";
  }
  if (primary !== null && !(inactive && SUPPRESSIBLE.has(primary)))
    out.push(
      make(primary, {
        rootPid: primary === "cleanup_unconfirmed" ? record.rootPid : null,
        gateSourceRef: null
      })
    );
  if (
    gate.state === "current" &&
    gate.gate.outcome === "verifier_unavailable" &&
    task.artifactRef !== null &&
    gate.gate.sourceRef === task.artifactRef
  )
    out.push(make("verification_unavailable", { rootPid: null, gateSourceRef: gate.gate.sourceRef }));
  return out;
}

/**
 * Pure projection over the built root views and the trusted registry. The registry is an explicit
 * input so entries whose root is unavailable or whose task is missing or omitted count as
 * unavailable coverage instead of vanishing.
 */
export function projectAttention(
  roots: readonly ExecutiveRootView[],
  registry: readonly CheckpointRecordEntry[],
  maxItems: number = ATTENTION_LIMITS.maxItems
): Attention {
  let unavailable = 0;
  for (const entry of registry) {
    const root = roots.find((r) => r.rootId === entry.rootId);
    const task = root && root.status === "ok" ? root.tasks.find((t) => t.nodeId === entry.nodeId) : undefined;
    if (!task || task.checkpointBudget?.state !== "reported") unavailable++;
  }
  const ranked: { item: AttentionItem; root: number; task: number }[] = [];
  let oversized = 0;
  roots.forEach((root, r) => {
    if (root.status !== "ok") return;
    root.tasks.forEach((task, t) => {
      if (!registry.some((e) => e.rootId === root.rootId && e.nodeId === task.nodeId)) return;
      for (const item of itemsOfTask(root, task)) {
        if (itemBytes(item) > ATTENTION_LIMITS.maxItemBytes) oversized++;
        else ranked.push({ item, root: r, task: t });
      }
    });
  });
  ranked.sort(
    (a, b) =>
      PRIORITY.get(a.item.kind)! - PRIORITY.get(b.item.kind)! ||
      a.root - b.root ||
      a.task - b.task ||
      (a.item.runId < b.item.runId ? -1 : a.item.runId > b.item.runId ? 1 : 0)
  );
  const kept = ranked.slice(0, maxItems).map((r) => r.item);
  return {
    items: kept,
    omitted: oversized + ranked.length - kept.length,
    registeredRecordsUnavailable: unavailable,
    basis: "supplied_records",
    automaticAllowed: false,
    forbidden: ATTENTION_FORBIDDEN
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Marks which items still have a task row after the size cap, then drops trailing items (exact
 * `omitted`) until the body fits. Never returns an oversized body; an item whose row is gone is
 * kept with `taskListed: false` rather than silently discarded.
 */
export function finalizeAttention(overview: ExecutiveOverview, maxBytes: number): ExecutiveOverview {
  const attention = overview.attention;
  if (!attention) return overview;
  const listed = new Set(
    overview.roots.flatMap((root) => root.tasks.map((task) => `${root.rootId}|${task.nodeId}`))
  );
  const items = attention.items.map((item) => ({
    ...item,
    taskListed: listed.has(`${item.rootId}|${item.nodeId}`)
  }));
  let omitted = attention.omitted;
  const build = (): ExecutiveOverview => ({ ...overview, attention: { ...attention, items, omitted } });
  let result = build();
  while (bytes(result) > maxBytes && items.length > 0) {
    items.pop();
    omitted++;
    result = build();
  }
  return result;
}

// ----- handoff record -----

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const gitRef = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const STATES = [
  "ready",
  "blocked",
  "in_progress",
  "review_pending",
  "accepted",
  "rejected",
  "stale",
  "cancelled"
] as const;

const stopShape = z.union([
  z.object({ kind: z.literal("none"), code: z.literal("none") }).strict(),
  z.object({ kind: z.literal("refused"), code: z.enum(REFUSAL_CODES) }).strict(),
  z.object({ kind: z.literal("tripwire"), code: z.enum(TRIPWIRE_CODES) }).strict(),
  z.object({ kind: z.literal("cancelled"), code: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("exited"), code: z.literal("exited") }).strict(),
  z.object({ kind: z.literal("failed"), code: z.enum(FAILURE_CODES) }).strict()
]);

const handoffItemSchema = z
  .object({
    kind: z.enum(ATTENTION_KINDS),
    rootId: guid,
    nodeId: guid,
    fence: z
      .object({ attemptId: token, attemptEpoch: safe, contentRevision: safe.min(1) })
      .strict(),
    runId: guid,
    stop: stopShape,
    recordState: z.enum(["running", "ended"]),
    recordUpdatedAt: stamp,
    rootPid: safe.min(1).nullable(),
    gateSourceRef: gitRef.nullable(),
    taskState: z.enum(STATES),
    attribution: z.literal("unattributed"),
    action: z.enum(ATTENTION_ACTIONS),
    trust: z.literal("supplied_not_authenticated"),
    writerLiveness: z.literal("unknown")
  })
  .strict()
  .refine((i) => i.action === ACTION_OF[i.kind])
  .refine((i) => (i.kind === "cleanup_unconfirmed") === (i.stop.code === "cleanup_failed"))
  .refine((i) => i.rootPid === null || i.kind === "cleanup_unconfirmed")
  .refine((i) => (i.kind === "verification_unavailable") === (i.gateSourceRef !== null))
  .refine((i) => i.kind !== "overdue_unreported" || (i.recordState === "running" && i.stop.kind === "none"))
  .refine((i) => i.kind !== "stopped_tripwire" || i.stop.kind === "tripwire")
  .refine((i) => i.kind !== "stopped_failed" || (i.stop.kind === "failed" && i.stop.code !== "cleanup_failed"))
  .refine((i) => i.kind !== "refused_start" || i.stop.kind === "refused");
export type HandoffItem = Omit<AttentionItem, "taskListed">;

export interface HandoffRecord {
  schema: typeof HANDOFF_SCHEMA;
  handoffId: string;
  createdAt: string;
  source: { overviewSchema: "executive-overview/v3"; overviewGeneratedAt: string; atomic: false };
  items: HandoffItem[];
  fenceStatus: "observed_at_capture";
  omitted: number;
  registeredRecordsUnavailable: number;
  itemsSha256: string;
  forbidden: readonly string[];
  automaticAllowed: false;
  trust: {
    records: "supplied_not_authenticated";
    writerLiveness: "unknown";
    author: "local_cli_unauthenticated";
  };
  delivery: "not_sent";
  notification: "none";
  wake: "none";
  acknowledgment: "none";
}

/** Fixed key order so the digest never depends on parse order. */
function canonicalItem(i: HandoffItem): HandoffItem {
  return {
    kind: i.kind,
    rootId: i.rootId,
    nodeId: i.nodeId,
    fence: {
      attemptId: i.fence.attemptId,
      attemptEpoch: i.fence.attemptEpoch,
      contentRevision: i.fence.contentRevision
    },
    runId: i.runId,
    stop: { kind: i.stop.kind, code: i.stop.code },
    recordState: i.recordState,
    recordUpdatedAt: i.recordUpdatedAt,
    rootPid: i.rootPid,
    gateSourceRef: i.gateSourceRef,
    taskState: i.taskState,
    attribution: i.attribution,
    action: i.action,
    trust: i.trust,
    writerLiveness: i.writerLiveness
  };
}

export function itemsDigest(items: readonly HandoffItem[]): string {
  return createHash("sha256").update(JSON.stringify(items.map(canonicalItem))).digest("hex");
}

export function toHandoffItem(item: AttentionItem): HandoffItem {
  return canonicalItem(item);
}

export class HandoffError extends Error {
  constructor(readonly code: "TOO_LARGE" | "INVALID") {
    super(code);
    this.name = "HandoffError";
  }
}

export interface BuildHandoffInput {
  handoffId: string;
  createdAt: string;
  overviewGeneratedAt: string;
  attention: Attention;
}

export function buildHandoff(input: BuildHandoffInput): HandoffRecord {
  const items = input.attention.items.map(toHandoffItem);
  return {
    schema: HANDOFF_SCHEMA,
    handoffId: input.handoffId,
    createdAt: input.createdAt,
    source: {
      overviewSchema: "executive-overview/v3",
      overviewGeneratedAt: input.overviewGeneratedAt,
      atomic: false
    },
    items,
    fenceStatus: "observed_at_capture",
    omitted: input.attention.omitted,
    registeredRecordsUnavailable: input.attention.registeredRecordsUnavailable,
    itemsSha256: itemsDigest(items),
    forbidden: ATTENTION_FORBIDDEN,
    automaticAllowed: false,
    trust: {
      records: "supplied_not_authenticated",
      writerLiveness: "unknown",
      author: "local_cli_unauthenticated"
    },
    delivery: "not_sent",
    notification: "none",
    wake: "none",
    acknowledgment: "none"
  };
}

const handoffSchema = z
  .object({
    schema: z.literal(HANDOFF_SCHEMA),
    handoffId: guid,
    createdAt: stamp,
    source: z
      .object({
        overviewSchema: z.literal("executive-overview/v3"),
        overviewGeneratedAt: stamp,
        atomic: z.literal(false)
      })
      .strict(),
    items: z.array(handoffItemSchema).min(1).max(ATTENTION_LIMITS.maxItems),
    fenceStatus: z.literal("observed_at_capture"),
    omitted: safe,
    registeredRecordsUnavailable: safe,
    itemsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    forbidden: z.array(z.string()).refine((f) => JSON.stringify(f) === JSON.stringify(ATTENTION_FORBIDDEN)),
    automaticAllowed: z.literal(false),
    trust: z
      .object({
        records: z.literal("supplied_not_authenticated"),
        writerLiveness: z.literal("unknown"),
        author: z.literal("local_cli_unauthenticated")
      })
      .strict(),
    delivery: z.literal("not_sent"),
    notification: z.literal("none"),
    wake: z.literal("none"),
    acknowledgment: z.literal("none")
  })
  .strict();

/** Validates the record and returns the exact bytes to publish (newline-terminated). */
export function serializeHandoff(record: HandoffRecord): string {
  const checked = handoffSchema.safeParse(record);
  if (!checked.success || checked.data.itemsSha256 !== itemsDigest(checked.data.items))
    throw new HandoffError("INVALID");
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, "utf8") > ATTENTION_LIMITS.maxHandoffBytes)
    throw new HandoffError("TOO_LARGE");
  return text;
}

export type HandoffParseFailure = "too_large" | "invalid";

/** Strict, bounded parse. The failure is a code only; input is never echoed. */
export function parseHandoff(
  input: Uint8Array
): { ok: true; value: HandoffRecord } | { ok: false; reason: HandoffParseFailure } {
  if (input.byteLength > ATTENTION_LIMITS.maxHandoffBytes) return { ok: false, reason: "too_large" };
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    parsed = parseBoundedJson(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const checked = handoffSchema.safeParse(parsed);
  if (!checked.success || checked.data.itemsSha256 !== itemsDigest(checked.data.items))
    return { ok: false, reason: "invalid" };
  return { ok: true, value: checked.data as HandoffRecord };
}

/** The pinned fields a second read must reproduce; times and row listing are ignored. */
export function pinOf(items: readonly AttentionItem[]): string {
  return JSON.stringify(
    items.map((i) => [i.kind, i.rootId, i.nodeId, i.fence, i.runId, i.stop, i.recordState, i.gateSourceRef])
  );
}
