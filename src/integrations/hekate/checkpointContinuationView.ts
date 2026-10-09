import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import {
  CONTINUATION_LIMITS,
  CONTINUATION_PHASES,
  parseContinuationRecord,
  type CheckName,
  type ContinuationReason,
  type ContinuationRecord
} from "../../checkpoint/checkpointContinuation";
import type { CheckpointRecordEntry } from "../../config/checkpointRecordsConfig";
import { fenceMatches, type CheckpointBudgetView, type FencedTask } from "./checkpointBudget";
import type { LeafState } from "./devCoordination";
import type { ExecutiveRootView } from "./executiveOverview";

/**
 * Bounded, read-only view of one explicitly configured `checkpoint-continuation/v1` record
 * (doc 24). The file is supplied and unauthenticated and the writer's liveness is unknown. Only a
 * regular file within the closed size bound is read; the closed record parser is the only reader.
 * A record is shown only when it still describes the task's exact root, node, attempt, epoch,
 * content, run and (for source-bearing phases) candidate source; anything else stays explicitly
 * unavailable and never appears as a current phase. Checks passing is never task acceptance.
 * No prompt, check output, path, API body or other record field is copied into the view.
 */

export const CONTINUATION_READ_LIMITS = {
  maxBytes: CONTINUATION_LIMITS.maxRecordBytes,
  deadlineMs: 500,
  maxItems: 32
} as const;

export type ContinuationPhase = (typeof CONTINUATION_PHASES)[number];

export type ContinuationUnavailableReason =
  | "missing"
  | "unreadable"
  | "too_large"
  | "invalid"
  | "unsupported_schema"
  | "stale_identity"
  | "stale_source"
  | "stale_state"
  | "run_mismatch"
  | "run_unverified"
  | "timeout";

/** `open` still needs attention or is in flight; `settled` belongs to an accepted/cancelled task. */
export type ContinuationRelevance = "open" | "settled";
export type ContinuationAttention = "needs_operator" | "review_pending" | "none";

export interface ContinuationCheckView {
  name: CheckName;
  result: "pass" | "fail" | "unavailable";
  ran: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputLimited: boolean;
}

export interface ContinuationWorkerView {
  stopKind: string;
  stopCode: string;
  exitCode: number | null;
  signal: string | null;
}

export type ContinuationView =
  | {
      state: "reported";
      runId: string;
      phase: ContinuationPhase;
      reason: ContinuationReason;
      startedAt: string;
      updatedAt: string;
      endedAt: string | null;
      sourceRef: string | null;
      finish: ContinuationRecord["finish"];
      gate: ContinuationRecord["gate"];
      worker: ContinuationWorkerView | null;
      checks: ContinuationCheckView[];
      relevance: ContinuationRelevance;
      attention: ContinuationAttention;
      trust: "supplied_not_authenticated";
      writerLiveness: "unknown";
      semanticReview: "not_performed";
    }
  | { state: "unavailable"; reason: ContinuationUnavailableReason };

/** The task facts a record is matched against: the fence and artifact plus the recorded state. */
export interface ContinuationTask extends FencedTask {
  state: LeafState;
}

/** Test seam; production uses the real file system. */
export interface ContinuationFileOps {
  lstat: typeof lstat;
  open: typeof open;
}

export interface ReadContinuationOptions {
  io?: Partial<ContinuationFileOps>;
  deadlineMs?: number;
}

type ReadOutcome =
  { ok: true; bytes: Buffer } | { ok: false; reason: ContinuationUnavailableReason };

async function readRegularFile(path: string, io: ContinuationFileOps): Promise<ReadOutcome> {
  const max = CONTINUATION_READ_LIMITS.maxBytes;
  let info;
  try {
    info = await io.lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable"
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "unreadable" };
  if (info.size > max) return { ok: false, reason: "too_large" };
  let handle;
  try {
    handle = await io.open(path, "r");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { ok: false, reason: "unreadable" };
    if (opened.size > max) return { ok: false, reason: "too_large" };
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > max) return { ok: false, reason: "too_large" };
    return { ok: true, bytes: buffer.subarray(0, length) };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readWithDeadline(
  path: string,
  io: ContinuationFileOps,
  deadlineMs: number
): Promise<ReadOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ReadOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), deadlineMs);
  });
  try {
    return await Promise.race([readRegularFile(path, io), late]);
  } finally {
    clearTimeout(timer);
  }
}

const SUFFIX = ".continuation.json";

type Currency =
  | { ok: true; relevance: ContinuationRelevance }
  | { ok: false; reason: "stale_source" | "stale_state" };

/**
 * Whether the record still describes the task's present state. Source-bearing records (a confirmed
 * finish, `verifying`, `review_pending`) need the task artifact to equal their candidate. A phase
 * that only the task's current state can follow is otherwise stale, never current.
 */
export function continuationCurrency(
  record: Pick<ContinuationRecord, "phase" | "finish" | "sourceRef">,
  task: Pick<ContinuationTask, "state" | "artifactRef">
): Currency {
  const inactive = task.state === "accepted" || task.state === "cancelled";
  const confirmed =
    record.finish === "confirmed" ||
    record.phase === "verifying" ||
    record.phase === "review_pending";
  if (confirmed) {
    if (record.sourceRef === null || task.artifactRef !== record.sourceRef)
      return { ok: false, reason: "stale_source" };
  } else if (
    record.sourceRef !== null &&
    task.artifactRef !== null &&
    task.artifactRef !== record.sourceRef
  )
    return { ok: false, reason: "stale_source" };
  if (record.phase === "needs_operator")
    return { ok: true, relevance: inactive ? "settled" : "open" };
  if (record.phase === "review_pending") {
    if (task.state === "review_pending") return { ok: true, relevance: "open" };
    if (task.state === "accepted") return { ok: true, relevance: "settled" };
    return { ok: false, reason: "stale_state" };
  }
  const allowed = confirmed ? ["review_pending"] : ["in_progress", "review_pending"];
  return allowed.includes(task.state)
    ? { ok: true, relevance: "open" }
    : { ok: false, reason: "stale_state" };
}

const unavailable = (reason: ContinuationUnavailableReason): ContinuationView => ({
  state: "unavailable",
  reason
});

/**
 * The run must be the registered budget record's run. With no readable budget record the run is
 * only unambiguous before any worker could have written one (`reserved`, budget file missing).
 */
function runMatches(
  record: ContinuationRecord,
  budget: CheckpointBudgetView | undefined
): "ok" | "run_mismatch" | "run_unverified" | "stale_source" {
  if (budget?.state === "reported") {
    if (budget.record.runId !== record.runId) return "run_mismatch";
    return budget.record.baseRef === record.baseRef ? "ok" : "stale_source";
  }
  return budget?.state === "unavailable" &&
    budget.reason === "missing" &&
    record.phase === "reserved"
    ? "ok"
    : "run_unverified";
}

export async function readContinuation(
  entry: CheckpointRecordEntry,
  task: ContinuationTask,
  budget: CheckpointBudgetView | undefined,
  options: ReadContinuationOptions = {}
): Promise<ContinuationView> {
  const path = entry.continuationRecordPath;
  if (path === undefined) return unavailable("missing");
  const io: ContinuationFileOps = { lstat, open, ...options.io };
  const file = await readWithDeadline(
    path,
    io,
    options.deadlineMs ?? CONTINUATION_READ_LIMITS.deadlineMs
  );
  if (!file.ok) return unavailable(file.reason);
  const parsed = parseContinuationRecord(file.bytes);
  if (!parsed.ok) return unavailable(parsed.reason);
  const record = parsed.value;
  if (
    record.identity.rootId !== entry.rootId ||
    record.identity.nodeId !== entry.nodeId ||
    !fenceMatches(record.identity, task)
  )
    return unavailable("stale_identity");
  const fileRun = basename(path).slice(0, -SUFFIX.length);
  if (record.runId !== fileRun) return unavailable("run_mismatch");
  const run = runMatches(record, budget);
  if (run !== "ok") return unavailable(run);
  const current = continuationCurrency(record, task);
  if (!current.ok) return unavailable(current.reason);
  const attention: ContinuationAttention =
    current.relevance === "settled"
      ? "none"
      : record.phase === "needs_operator" || record.phase === "review_pending"
        ? record.phase
        : "none";
  return {
    state: "reported",
    runId: record.runId,
    phase: record.phase,
    reason: record.reason,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    sourceRef: record.sourceRef,
    finish: record.finish,
    gate: record.gate,
    worker: record.worker
      ? {
          stopKind: record.worker.stop.kind,
          stopCode: record.worker.stop.code,
          exitCode: record.worker.exit?.code ?? null,
          signal: record.worker.exit?.signal ?? null
        }
      : null,
    checks: record.checks.map((c) => ({
      name: c.name,
      result: c.result,
      ran: c.ran,
      exitCode: c.exitCode,
      timedOut: c.timedOut,
      outputLimited: c.outputLimited
    })),
    relevance: current.relevance,
    attention,
    trust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    semanticReview: "not_performed"
  };
}

// ----- summary -----

export interface ContinuationItem {
  rootId: string;
  nodeId: string;
  runId: string;
  phase: ContinuationPhase;
  reason: ContinuationReason;
  attention: ContinuationAttention;
  updatedAt: string;
  taskState: LeafState;
  /** False when the size cap omitted the task row. */
  taskListed: boolean;
}

export interface ContinuationSummary {
  basis: "supplied_records";
  /** Registry entries that configured a continuation record. */
  configured: number;
  /** Open records per recorded phase. Settled and unavailable records are counted apart. */
  phases: Record<ContinuationPhase, number>;
  settled: number;
  unavailable: number;
  items: ContinuationItem[];
  omitted: number;
}

/** needs_operator first, then a review waiting on the current task, then in-flight phases. */
const ITEM_RANK: Record<ContinuationPhase, number> = {
  needs_operator: 0,
  review_pending: 1,
  verifying: 2,
  snapshotting: 3,
  running: 4,
  reserved: 5
};

/**
 * Pure projection over the built root views and the trusted registry. Registered records whose
 * root, task or record cannot be observed count as unavailable coverage instead of vanishing.
 */
export function projectContinuation(
  roots: readonly ExecutiveRootView[],
  registry: readonly CheckpointRecordEntry[],
  maxItems: number = CONTINUATION_READ_LIMITS.maxItems
): ContinuationSummary {
  const phases = Object.fromEntries(CONTINUATION_PHASES.map((p) => [p, 0])) as Record<
    ContinuationPhase,
    number
  >;
  let configured = 0;
  let settled = 0;
  let missing = 0;
  const ranked: { item: ContinuationItem; root: number; task: number }[] = [];
  for (const entry of registry) {
    if (entry.continuationRecordPath === undefined) continue;
    configured++;
    const r = roots.findIndex((root) => root.rootId === entry.rootId);
    const root = roots[r];
    const t =
      root && root.status === "ok" ? root.tasks.findIndex((x) => x.nodeId === entry.nodeId) : -1;
    const task = root && t >= 0 ? root.tasks[t] : undefined;
    const view = task?.continuation;
    if (!task || view?.state !== "reported") {
      missing++;
      continue;
    }
    if (view.relevance === "settled") {
      settled++;
      continue;
    }
    phases[view.phase]++;
    ranked.push({
      item: {
        rootId: entry.rootId,
        nodeId: entry.nodeId,
        runId: view.runId,
        phase: view.phase,
        reason: view.reason,
        attention: view.attention,
        updatedAt: view.updatedAt,
        taskState: task.state,
        taskListed: true
      },
      root: r,
      task: t
    });
  }
  ranked.sort(
    (a, b) =>
      ITEM_RANK[a.item.phase] - ITEM_RANK[b.item.phase] ||
      a.root - b.root ||
      a.task - b.task ||
      (a.item.runId < b.item.runId ? -1 : a.item.runId > b.item.runId ? 1 : 0)
  );
  const items = ranked.slice(0, maxItems).map((entry) => entry.item);
  return {
    basis: "supplied_records",
    configured,
    phases,
    settled,
    unavailable: missing,
    items,
    omitted: ranked.length - items.length
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Marks which items still have a task row after the size cap, then drops trailing items (exact
 * `omitted`) until the body fits. The caller has already bounded the rest of the body.
 */
export function finalizeContinuation<
  T extends { roots: ExecutiveRootView[]; continuation?: ContinuationSummary }
>(overview: T, maxBytes: number): T {
  const summary = overview.continuation;
  if (!summary) return overview;
  const listed = new Set(
    overview.roots.flatMap((root) => root.tasks.map((task) => `${root.rootId}|${task.nodeId}`))
  );
  const items = summary.items.map((item) => ({
    ...item,
    taskListed: listed.has(`${item.rootId}|${item.nodeId}`)
  }));
  let omitted = summary.omitted;
  const build = (): T => ({ ...overview, continuation: { ...summary, items, omitted } });
  let result = build();
  while (bytes(result) > maxBytes && items.length > 0) {
    items.pop();
    omitted++;
    result = build();
  }
  return result;
}
