import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHECKPOINT_LIMITS,
  gateRecordPath,
  parseBudgetRecord,
  parseGateRecord,
  type BudgetRecord,
  type GateRecord
} from "../../checkpoint/checkpointRecord";
import type { CheckpointRecordEntry } from "../../config/checkpointRecordsConfig";

/**
 * Bounded, read-only lookup of one registered runner record and its lead-supplied gate file.
 * Both are supplied, unauthenticated files: a symlink or non-regular file is refused, size, time
 * and schema are bounded, and a record whose identity fence differs from the task's current
 * attempt is quarantined without its numbers. Nothing is written, spawned or followed.
 */

export const BUDGET_READ_LIMITS = {
  maxBytes: CHECKPOINT_LIMITS.maxFileBytes,
  deadlineMs: 500,
  overdueGraceMs: 60_000
} as const;

export type BudgetUnavailableReason =
  | "missing"
  | "unreadable"
  | "too_large"
  | "invalid"
  | "unsupported_schema"
  | "stale_identity"
  | "timeout";

export type CheckpointGateView =
  | { state: "current" | "history"; gate: GateRecord }
  | { state: "unavailable"; reason: BudgetUnavailableReason };

export type CheckpointBudgetView =
  | {
      state: "reported";
      record: BudgetRecord;
      gate: CheckpointGateView;
      /** A running record past its hard wall limit plus grace with no end recorded. */
      overdueUnreported: boolean;
    }
  | { state: "unavailable"; reason: BudgetUnavailableReason };

/** The task facts a record is matched against: its current attempt identity and artifact. */
export interface FencedTask {
  attemptId: string | null;
  attemptEpoch: number;
  contentRevision: number;
  artifactRef: string | null;
}

/** Test seam; production uses the real file system. */
export interface BudgetFileOps {
  lstat: typeof lstat;
  open: typeof open;
}

export interface ReadBudgetOptions {
  io?: Partial<BudgetFileOps>;
  now?: () => number;
  deadlineMs?: number;
}

type ReadOutcome = { ok: true; bytes: Buffer } | { ok: false; reason: BudgetUnavailableReason };

async function readRegularFile(path: string, io: BudgetFileOps): Promise<ReadOutcome> {
  const max = BUDGET_READ_LIMITS.maxBytes;
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
    if (!(await handle.stat()).isFile()) return { ok: false, reason: "unreadable" };
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
  io: BudgetFileOps,
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

export function fenceMatches(
  fence: { attemptId: string; attemptEpoch: number; contentRevision: number },
  task: FencedTask
): boolean {
  return (
    task.attemptId !== null &&
    fence.attemptId === task.attemptId &&
    fence.attemptEpoch === task.attemptEpoch &&
    fence.contentRevision === task.contentRevision
  );
}

/**
 * Gate evidence is current only for the exact attempt, content and artifact. The same fence with
 * a different (or no) task artifact is history; another fence is quarantined by the caller.
 */
export function classifyGate(gate: GateRecord, task: FencedTask): "current" | "history" {
  return task.artifactRef !== null && gate.sourceRef === task.artifactRef ? "current" : "history";
}

export async function readCheckpointBudget(
  entry: CheckpointRecordEntry,
  task: FencedTask,
  options: ReadBudgetOptions = {}
): Promise<CheckpointBudgetView> {
  const io: BudgetFileOps = { lstat, open, ...options.io };
  const deadlineMs = options.deadlineMs ?? BUDGET_READ_LIMITS.deadlineMs;
  const now = options.now ?? Date.now;

  const file = await readWithDeadline(entry.recordPath, io, deadlineMs);
  if (!file.ok) return { state: "unavailable", reason: file.reason };
  const parsed = parseBudgetRecord(file.bytes);
  if (!parsed.ok) return { state: "unavailable", reason: parsed.reason };
  const record = parsed.value;
  if (
    record.identity.rootId !== entry.rootId ||
    record.identity.nodeId !== entry.nodeId ||
    !fenceMatches(record.identity, task)
  )
    return { state: "unavailable", reason: "stale_identity" };

  const gateFile = await readWithDeadline(
    gateRecordPath(dirname(entry.recordPath), record.runId),
    io,
    deadlineMs
  );
  let gate: CheckpointGateView;
  if (!gateFile.ok) gate = { state: "unavailable", reason: gateFile.reason };
  else {
    const parsedGate = parseGateRecord(gateFile.bytes);
    if (!parsedGate.ok) gate = { state: "unavailable", reason: parsedGate.reason };
    else if (
      parsedGate.value.runId !== record.runId ||
      parsedGate.value.identity.rootId !== entry.rootId ||
      parsedGate.value.identity.nodeId !== entry.nodeId ||
      !fenceMatches(parsedGate.value.identity, task)
    )
      gate = { state: "unavailable", reason: "stale_identity" };
    else gate = { state: classifyGate(parsedGate.value, task), gate: parsedGate.value };
  }

  const started = Date.parse(record.startedAt);
  const overdueUnreported =
    record.state === "running" &&
    now() > started + record.hard.wallMs + BUDGET_READ_LIMITS.overdueGraceMs;
  return { state: "reported", record, gate, overdueUnreported };
}
