import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fetchCoordinationStatus,
  planApiBase,
  type LeafStatus
} from "../integrations/hekate/devCoordination";
import { processTreeTerminator, type ProcessTreeTerminator } from "../providers/cli/runner";
import {
  CHECK_NAMES,
  CONTINUATION_LIMITS,
  CONTINUATION_RECORD_SCHEMA,
  CONTINUATION_RECORD_SCHEMA_V2,
  TOOLING_ENTRIES,
  checkFormatGuard,
  claimKeyOf,
  continuationLeasePath,
  continuationRecordPath,
  defaultFinishPost,
  parseContinuationManifest,
  parseContinuationRecord,
  runContinuation,
  runOwned,
  type ContinuationDeps,
  type ContinuationManifest,
  type ContinuationResult,
  type FinishPost
} from "./checkpointContinuation";
import {
  CHECKPOINT_LIMITS,
  budgetRecordPath,
  gateRecordPath,
  parseGateRecord
} from "./checkpointRecord";
import {
  QUEUE_LIMITS,
  QueueStateError,
  VERDICT_REASON,
  initialRecord,
  parseQueueManifest,
  parseQueueRecord,
  queueLockPath,
  queueRecordPath,
  queueStopPath,
  readyToStart,
  replaceItem,
  resumable,
  reviewVerdict,
  serializeQueueRecord,
  startRequestBody,
  startedAtFrozenFence,
  todoAtFrozenFence,
  validateQueueItems,
  withTransition,
  type ItemProblem,
  type QueueItem,
  type QueueManifest,
  type QueueReason,
  type QueueRecord
} from "./checkpointQueueState";

/**
 * Bounded checkpoint queue service (doc 26). One operator invocation arms at most four pinned
 * coding checkpoints and runs them one at a time: a node-specific start of only the next approved
 * node, the unchanged finite continuation, then a wait for an exact externally recorded acceptance.
 * It never claims globally, decides, revises, cancels, releases, merges, deploys, notifies or
 * retries. Actor strings and local records are supplied, not authenticated. Not an always-on
 * service: each invocation is wall bounded and a crash-retained lock needs separate recovery.
 */

export type QueueMode = "arm" | "resume";

export type QueueRefusal =
  | ItemProblem
  | "manifest_invalid"
  | "queue_dir_invalid"
  | "item_invalid"
  | "item_pin_mismatch"
  | "record_exists"
  | "record_invalid"
  | "record_mismatch"
  | "lock_exists"
  | "stop_pending"
  | "authority_unavailable"
  | "authority_mismatch"
  | "source_invalid"
  | "not_resumable"
  | "persistence_failed";

export interface QueueResult {
  /** 0 every item accepted; 1 needs_operator; 2 refusal before any effect; 3 clean stop; 4 persistence or lock failure. */
  exitCode: 0 | 1 | 2 | 3 | 4;
  record: QueueRecord | null;
  refusal?: QueueRefusal;
}

export interface QueueDeps {
  fetchStatus?: typeof fetchCoordinationStatus;
  /** The targeted-start POST; the same bounded one-shot transport as the continuation finish. */
  post?: FinishPost;
  /** Test seams, unreachable from the script: default to the unchanged `runContinuation`. */
  continuation?: (
    manifest: ContinuationManifest,
    deps: ContinuationDeps
  ) => Promise<ContinuationResult>;
  continuationDeps?: (index: number) => ContinuationDeps;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  terminator?: ProcessTreeTerminator;
  signal?: AbortSignal;
  now?: () => number;
  monotonicNow?: () => number;
  /** Monotonic CLI entry time, so reading the manifest consumes the shared wall bound. */
  startMonotonic?: number;
}

const START_TIMEOUT_MS = 10_000;
const LOCK_SCHEMA = "checkpoint-queue-lock/v1";
const LOCK_BYTES = 512;

class Refused extends Error {
  constructor(readonly code: QueueRefusal) {
    super(code);
  }
}
class PersistenceFailure extends Error {}
class LockLost extends Error {}

// ----- bounded files -----

async function readBounded(path: string, max: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("READ");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new Error("READ");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function sha256OfFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  );

const sameResolved = (a: string, b: string) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const real = await realpath(path);
    if (!sameResolved(real, path) || !(await stat(real)).isDirectory()) throw new Error("DIR");
    return real;
  } catch {
    throw new Refused("queue_dir_invalid");
  }
}

// ----- read-only and stop commands -----

export interface QueueShow {
  schema: "checkpoint-queue-show/v1";
  record: QueueRecord | null;
  recordState: "absent" | "valid" | "invalid";
  manifestMatchesRecord: boolean | null;
  lock: "present" | "absent";
  stopRequested: boolean;
  metadata: "retained";
  writerLiveness: "unknown";
}

/** Strictly reads retained metadata; it makes no plan API request and mutates nothing. */
export async function showQueue(manifestBytes: Uint8Array): Promise<QueueShow> {
  const queue = parseQueueManifest(manifestBytes);
  const dir = await canonicalDirectory(queue.queueDir);
  let record: QueueRecord | null = null;
  let recordState: QueueShow["recordState"] = "absent";
  if (await exists(queueRecordPath(dir, queue.queueId))) {
    try {
      record =
        parseQueueRecord(
          await readBounded(queueRecordPath(dir, queue.queueId), QUEUE_LIMITS.maxRecordBytes)
        ) ?? null;
    } catch {
      record = null;
    }
    recordState = record ? "valid" : "invalid";
  }
  return {
    schema: "checkpoint-queue-show/v1",
    record,
    recordState,
    manifestMatchesRecord: record
      ? record.queueId === queue.queueId && record.manifestSha256 === sha256Of(manifestBytes)
      : null,
    lock: (await exists(queueLockPath(dir, queue.queueId))) ? "present" : "absent",
    stopRequested: await exists(queueStopPath(dir, queue.queueId)),
    metadata: "retained",
    writerLiveness: "unknown"
  };
}

/** Creates only this queue's sentinel; a running invocation lets its current child settle. */
export async function requestQueueStop(manifestBytes: Uint8Array): Promise<void> {
  const queue = parseQueueManifest(manifestBytes);
  const dir = await canonicalDirectory(queue.queueDir);
  try {
    const handle = await open(queueStopPath(dir, queue.queueId), "wx");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new PersistenceFailure();
  }
}

// ----- service -----

export async function runQueueService(
  manifestBytes: Uint8Array,
  mode: QueueMode,
  deps: QueueDeps = {}
): Promise<QueueResult> {
  const now = deps.now ?? Date.now;
  const mono = deps.monotonicNow ?? (() => performance.now());
  const started = deps.startMonotonic ?? mono();
  const fetchStatus = deps.fetchStatus ?? fetchCoordinationStatus;
  const post = deps.post ?? defaultFinishPost;
  const terminator = deps.terminator ?? processTreeTerminator;
  const sleep =
    deps.sleep ??
    ((ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }).then(
        () => undefined,
        () => undefined
      ));
  const iso = () => new Date(now()).toISOString();

  let queue: QueueManifest;
  try {
    queue = parseQueueManifest(manifestBytes);
  } catch {
    return { exitCode: 2, record: null, refusal: "manifest_invalid" };
  }
  const expiresAt = started + queue.limits.wallMs;
  const remaining = () => expiresAt - mono();

  const abort = new AbortController();
  const onSignal = () => abort.abort();
  deps.signal?.addEventListener("abort", onSignal, { once: true });
  if (deps.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), Math.max(0, remaining()));
  timer.unref();
  const halted = (): "cancelled" | "wall_exceeded" | null => {
    if (deps.signal?.aborted) return "cancelled";
    return remaining() <= 0 || abort.signal.aborted ? "wall_exceeded" : null;
  };

  let dir = "";
  let lockToken: string | null = null;
  let rec: QueueRecord | undefined;
  let loaded: ContinuationManifest[] = [];

  // ----- lock and publication -----
  const verifyLock = async () => {
    try {
      const bytes = await readBounded(queueLockPath(dir, queue.queueId), LOCK_BYTES);
      const parsed = JSON.parse(bytes.toString("utf8")) as { queueId?: unknown; token?: unknown };
      if (parsed.queueId === queue.queueId && parsed.token === lockToken) return;
    } catch {
      /* fall through */
    }
    throw new LockLost();
  };

  const acquireLock = async () => {
    const token = randomBytes(16).toString("hex");
    let handle;
    try {
      handle = await open(queueLockPath(dir, queue.queueId), "wx");
      await handle.writeFile(
        JSON.stringify({ schema: LOCK_SCHEMA, queueId: queue.queueId, token })
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refused("lock_exists");
      throw new PersistenceFailure();
    } finally {
      await handle?.close().catch(() => undefined);
    }
    lockToken = token;
  };

  /** Releases only the owned lock; a replaced token is left alone and reported. */
  const releaseLock = async (): Promise<boolean> => {
    if (lockToken === null) return true;
    try {
      await verifyLock();
      await unlink(queueLockPath(dir, queue.queueId));
      return true;
    } catch {
      return false;
    }
  };

  /** Atomic publication through an exclusive temp file; the lock token is checked before rename. */
  const publish = async (next: QueueRecord) => {
    let text: string;
    try {
      text = serializeQueueRecord(next);
    } catch {
      throw new PersistenceFailure();
    }
    const finalPath = queueRecordPath(dir, queue.queueId);
    const temp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(text, "utf8");
        } finally {
          await handle.close();
        }
      } catch {
        throw new PersistenceFailure();
      }
      await verifyLock();
      try {
        await rename(temp, finalPath);
      } catch {
        throw new PersistenceFailure();
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    rec = next;
  };

  const commit = async (
    patch: Parameters<typeof withTransition>[1],
    append = true
  ): Promise<false> => {
    await publish(withTransition(rec!, patch, iso(), append));
    return false;
  };
  const stopClean = (reason: QueueReason) => commit({ phase: "stopped", reason });
  const operator = (reason: QueueReason, item?: QueueItem, patch: Partial<QueueItem> = {}) =>
    commit({
      phase: "needs_operator",
      reason,
      ...(item ? { items: replaceItem(rec!, { ...item, state: "needs_operator", ...patch }) } : {})
    });

  // ----- plan reads -----
  const readLeaf = async (
    item: Pick<QueueItem, "rootId" | "nodeId">
  ): Promise<LeafStatus | undefined> => {
    if (remaining() <= 0) throw new Error("AUTHORITY_UNAVAILABLE");
    const status = await fetchStatus(queue.planApiUrl, item.rootId, {
      timeoutMs: Math.max(1, Math.min(CONTINUATION_LIMITS.authorityTimeoutMs, remaining())),
      maxBytes: CONTINUATION_LIMITS.authorityMaxBytes
    });
    if (status.status !== "ok") throw new Error("AUTHORITY_UNAVAILABLE");
    return status.leaves.find((leaf) => leaf.nodeId === item.nodeId);
  };
  const tryLeaf = async (item: QueueItem) => {
    try {
      return { ok: true as const, leaf: await readLeaf(item) };
    } catch {
      return { ok: false as const };
    }
  };

  // ----- source pins (fixed, shell-free) -----
  const filePinHolds = async (pin: { path: string; sha256: string }) => {
    const info = await stat(pin.path);
    return info.isFile() && (await sha256OfFile(pin.path)) === pin.sha256;
  };
  const git = async (m: ContinuationManifest, args: readonly string[]) => {
    const wt = m.run.worktree;
    const result = await runOwned(
      m.run.gitExecutable.path,
      ["-C", wt, "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args],
      {
        cwd: wt,
        timeoutMs: Math.max(1, Math.min(CONTINUATION_LIMITS.gitTimeoutMs, remaining())),
        maxOutputBytes: CONTINUATION_LIMITS.gitOutputBytes,
        capture: true,
        signal: abort.signal,
        terminator,
        closeGraceMs: CONTINUATION_LIMITS.closeGraceMs
      }
    );
    if (result.exitCode !== 0 || result.timedOut || result.outputLimited || result.cleanupFailed)
      throw new Error("GIT");
    return result.stdout.toString("utf8");
  };
  /** Executables, prompt, tooling, linked clean worktree at `head`; optionally a fresh run slot. */
  const sourcesHold = async (m: ContinuationManifest, head: string, freshRun: boolean) => {
    try {
      const run = m.run;
      for (const pin of [run.executable, m.nodeExecutable, run.gitExecutable])
        if (!(await filePinHolds(pin))) return false;
      const prompt = await readBounded(run.promptFile, CHECKPOINT_LIMITS.maxPromptBytes);
      if (sha256Of(prompt) !== run.promptSha256) return false;
      for (const name of CHECK_NAMES) {
        const path = join(run.worktree, ...TOOLING_ENTRIES[name].split("/"));
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return false;
        if ((await sha256OfFile(path)) !== m.toolingSha256[name]) return false;
      }
      if (!(await lstat(join(run.worktree, ".git"))).isFile()) return false;
      if ((await git(m, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase() !== head)
        return false;
      const status = await git(m, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (status !== "") return false;
      // Opted in, the pinned config and ignore files and the no-shadow guard are part of the pins.
      if (
        (await checkFormatGuard(run.worktree, m, () =>
          git(m, [
            "diff",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            run.identity.baseRef,
            "--",
            "package.json"
          ])
        )) !== "ok"
      )
        return false;
      if (freshRun) {
        const claimKey = claimKeyOf(run.identity);
        for (const path of [
          budgetRecordPath(run.recordDir, run.runId),
          gateRecordPath(run.recordDir, run.runId),
          continuationRecordPath(run.recordDir, run.runId),
          continuationLeasePath(run.recordDir, claimKey),
          // The unchanged runner's own claim lease (its module keeps this path private).
          join(run.recordDir, `.claim-${claimKey}.lease`)
        ])
          if (await exists(path)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // ----- setup -----
  const loadItems = async () => {
    dir = await canonicalDirectory(queue.queueDir);
    const manifests: ContinuationManifest[] = [];
    for (const entry of queue.items) {
      let bytes: Buffer;
      try {
        bytes = await readBounded(entry.manifestPath, CONTINUATION_LIMITS.maxManifestBytes);
      } catch {
        throw new Refused("item_invalid");
      }
      if (sha256Of(bytes) !== entry.manifestSha256) throw new Refused("item_pin_mismatch");
      try {
        manifests.push(parseContinuationManifest(bytes));
      } catch {
        throw new Refused("item_invalid");
      }
    }
    const problem = validateQueueItems({ ...queue, queueDir: dir }, manifests);
    if (problem) throw new Refused(problem);
    loaded = manifests;
  };

  /** Fresh PlanStore reads: every listed node still TODO at its frozen fence. */
  const requireTodoAtFence = async (items: readonly QueueItem[]) => {
    for (const item of items) {
      const read = await tryLeaf(item);
      if (!read.ok) throw new Refused("authority_unavailable");
      if (!todoAtFrozenFence(read.leaf, loaded[item.index].run.identity))
        throw new Refused("authority_mismatch");
    }
  };

  const arm = async () => {
    if (await exists(queueStopPath(dir, queue.queueId))) throw new Refused("stop_pending");
    await acquireLock();
    const first = initialRecord(queue, sha256Of(manifestBytes), loaded, iso());
    for (const item of first.items)
      if (!(await sourcesHold(loaded[item.index], item.baseRef, true)))
        throw new Refused("source_invalid");
    await requireTodoAtFence(first.items);
    let handle;
    try {
      handle = await open(queueRecordPath(dir, queue.queueId), "wx");
      await handle.writeFile(serializeQueueRecord(first), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refused("record_exists");
      throw new PersistenceFailure();
    } finally {
      await handle?.close().catch(() => undefined);
    }
    rec = first;
  };

  const resume = async () => {
    await acquireLock();
    let retained: QueueRecord | undefined;
    try {
      retained = parseQueueRecord(
        await readBounded(queueRecordPath(dir, queue.queueId), QUEUE_LIMITS.maxRecordBytes)
      );
    } catch {
      throw new Refused("record_invalid");
    }
    if (!retained) throw new Refused("record_invalid");
    const expected = initialRecord(queue, sha256Of(manifestBytes), loaded, iso());
    const fenceKey = (item: QueueItem) =>
      JSON.stringify([
        item.runId,
        item.rootId,
        item.nodeId,
        item.attemptId,
        item.attemptEpoch,
        item.contentRevision,
        item.stateRevision,
        item.executorRef,
        item.baseRef,
        item.admission
      ]);
    if (
      retained.queueId !== queue.queueId ||
      retained.manifestSha256 !== expected.manifestSha256 ||
      retained.items.length !== expected.items.length ||
      retained.items.some((item, i) => fenceKey(item) !== fenceKey(expected.items[i])) ||
      JSON.stringify(retained.admissionLimit) !== JSON.stringify(expected.admissionLimit)
    )
      throw new Refused("record_mismatch");
    if (!resumable(retained)) throw new Refused("not_resumable");
    // Every earlier acceptance and the waiting candidate are revalidated against fresh reads.
    for (const item of retained.items) {
      if (item.state === "pending") continue;
      const read = await tryLeaf(item);
      if (!read.ok) throw new Refused("authority_unavailable");
      const verdict = reviewVerdict(read.leaf, item, queue.acceptors);
      const allowed = item.state === "accepted" ? ["accepted"] : ["pending", "accepted"];
      if (!allowed.includes(verdict)) throw new Refused("authority_mismatch");
      if (
        item.state === "waiting_review" &&
        !(await sourcesHold(loaded[item.index], item.sourceRef!, false))
      )
        throw new Refused("source_invalid");
    }
    await requireTodoAtFence(retained.items.filter((item) => item.state === "pending"));
    rec = retained;
    await unlink(queueStopPath(dir, queue.queueId)).catch(() => undefined);
    await publish(
      withTransition(
        retained,
        { phase: "running", reason: "in_progress", invocations: retained.invocations + 1 },
        iso()
      )
    );
  };

  // ----- lifecycle -----
  const stopRequested = () => exists(queueStopPath(dir, queue.queueId));

  const startItem = async (item: QueueItem): Promise<boolean> => {
    const m = loaded[item.index];
    const run = m.run;
    const halt = halted();
    if (halt) return stopClean(halt);
    if (await stopRequested()) return stopClean("stop_requested");
    if (remaining() < m.limits.wallMs + QUEUE_LIMITS.itemWallReserveMs)
      return stopClean("wall_exceeded");
    if (item.index > 0) {
      const previous = rec!.items[item.index - 1];
      const read = await tryLeaf(previous);
      if (!read.ok) return stopClean("authority_unavailable");
      const verdict = reviewVerdict(read.leaf, previous, queue.acceptors);
      if (verdict !== "accepted")
        return operator(verdict === "pending" ? "fence_moved" : VERDICT_REASON[verdict]);
    }
    const read = await tryLeaf(item);
    if (!read.ok) return stopClean("authority_unavailable");
    if (!todoAtFrozenFence(read.leaf, run.identity)) return operator("fence_moved");
    if (!readyToStart(read.leaf, run.identity)) return stopClean("not_ready");
    const admit = rec!.admitted;
    const next = {
      units: admit.units + item.admission.units,
      outputBytes: admit.outputBytes + item.admission.outputBytes,
      providerCapMicros: admit.providerCapMicros + item.admission.providerCapMicros
    };
    const limit = rec!.admissionLimit;
    if (
      next.units > limit.units ||
      next.outputBytes > limit.outputBytes ||
      next.providerCapMicros > limit.providerCapMicros
    )
      return operator("admission_exceeded");
    if (!(await sourcesHold(m, item.baseRef, true))) return operator("source_invalid");

    // The preflight above is long; recheck stop and the wall/signal bounds right before the intent.
    // This narrows, but does not atomically close, the gap between the sentinel and the HTTP effect.
    const lateHalt = halted();
    if (lateHalt) return stopClean(lateHalt);
    if (await stopRequested()) return stopClean("stop_requested");
    if (remaining() < m.limits.wallMs + QUEUE_LIMITS.itemWallReserveMs)
      return stopClean("wall_exceeded");

    // The intent and worst-case admission are durable before the only mutation of this item.
    await commit({
      items: replaceItem(rec!, { ...item, state: "starting", start: "attempted" }),
      admitted: next
    });
    const starting = rec!.items[item.index];
    if (halted()) return operator("start_uncertain", starting, { start: "uncertain" });
    let status: number;
    const startUrl = `${planApiBase(queue.planApiUrl)}/api/plan-contract/v1/nodes/${run.identity.nodeId}/transition`;
    try {
      status = (
        await post({
          url: startUrl,
          body: startRequestBody(queue.queueId, item.index, run, queue.actor),
          timeoutMs: Math.max(1, Math.min(START_TIMEOUT_MS, remaining()))
        })
      ).status;
    } catch {
      return operator("start_uncertain", starting, { start: "uncertain" });
    }
    if (status === 409) return operator("start_conflict", starting, { start: "conflict" });
    if (status < 200 || status >= 300)
      return operator("start_uncertain", starting, { start: "uncertain" });
    const confirmed = await tryLeaf(starting);
    if (!confirmed.ok) return operator("start_uncertain", starting, { start: "uncertain" });
    if (!startedAtFrozenFence(confirmed.leaf, run.identity))
      return operator("fence_moved", starting, { start: "uncertain" });
    await commit({
      items: replaceItem(rec!, {
        ...starting,
        state: "running",
        start: "confirmed",
        continuation: "started"
      })
    });
    const running = rec!.items[item.index];

    const runner = deps.continuation ?? runContinuation;
    let result: ContinuationResult;
    try {
      result = await runner(m, {
        ...deps.continuationDeps?.(item.index),
        signal: abort.signal,
        startMonotonic: mono()
      });
    } catch {
      result = { exitCode: 4, record: null };
    }
    const sourceRef = await confirmedCandidate(m, running, result);
    if (sourceRef === null)
      return operator(result.record ? "continuation_failed" : "continuation_refused", running, {
        continuation: result.record ? "needs_operator" : "refused",
        continuationReason: result.record?.reason ?? null,
        sourceRef: result.record?.sourceRef ?? null
      });
    await commit({
      items: replaceItem(rec!, {
        ...running,
        state: "waiting_review",
        continuation: "review_pending",
        continuationReason: "checks_passed",
        sourceRef
      })
    });
    return true;
  };

  /** Terminal matching continuation plus a current checks_passed gate; mechanical, never acceptance. */
  const confirmedCandidate = async (
    m: ContinuationManifest,
    item: QueueItem,
    result: ContinuationResult
  ): Promise<string | null> => {
    const returned = result.record;
    if (
      result.exitCode !== 0 ||
      !returned ||
      returned.phase !== "review_pending" ||
      returned.reason !== "checks_passed" ||
      returned.gate !== "written" ||
      !returned.sourceRef
    )
      return null;
    try {
      const recordDir = m.run.recordDir;
      const stored = parseContinuationRecord(
        await readBounded(
          continuationRecordPath(recordDir, item.runId),
          CONTINUATION_LIMITS.maxRecordBytes
        )
      );
      const gate = parseGateRecord(
        await readBounded(gateRecordPath(recordDir, item.runId), CHECKPOINT_LIMITS.maxFileBytes)
      );
      if (!stored.ok || !gate.ok) return null;
      const id = stored.value.identity;
      const g = gate.value;
      const fenceHolds = (x: {
        rootId: string;
        nodeId: string;
        attemptId: string;
        attemptEpoch: number;
        contentRevision: number;
      }) =>
        x.rootId === item.rootId &&
        x.nodeId === item.nodeId &&
        x.attemptId === item.attemptId &&
        x.attemptEpoch === item.attemptEpoch &&
        x.contentRevision === item.contentRevision;
      if (
        stored.value.runId !== item.runId ||
        stored.value.phase !== "review_pending" ||
        stored.value.reason !== "checks_passed" ||
        stored.value.sourceRef !== returned.sourceRef ||
        stored.value.baseRef !== item.baseRef ||
        !fenceHolds(id) ||
        id.observedStateRevision !== item.stateRevision ||
        id.executorRef !== item.executorRef ||
        g.runId !== item.runId ||
        g.outcome !== "checks_passed" ||
        g.sourceRef !== returned.sourceRef ||
        !fenceHolds(g.identity)
      )
        return null;
      const authority = m.formatting;
      const record = stored.value;
      if (authority === undefined) {
        // Legacy manifests accept only the unchanged v1 wire shape.
        if (
          record.schema !== CONTINUATION_RECORD_SCHEMA ||
          returned.schema !== CONTINUATION_RECORD_SCHEMA
        )
          return null;
      } else {
        if (
          record.schema !== CONTINUATION_RECORD_SCHEMA_V2 ||
          returned.schema !== CONTINUATION_RECORD_SCHEMA_V2
        )
          return null;
        const facts = record.formatting;
        const consistent =
          record.rawRef !== null &&
          returned.rawRef === record.rawRef &&
          ((facts.state === "unchanged" && record.rawRef === record.sourceRef) ||
            (facts.state === "committed" && record.rawRef !== record.sourceRef));
        if (
          !consistent ||
          facts.mode !== authority.mode ||
          facts.configSha256 !== authority.configSha256 ||
          facts.ignoreSha256 !== authority.ignoreSha256
        )
          return null;
      }
      return returned.sourceRef;
    } catch {
      return null;
    }
  };

  const awaitAcceptance = async (item: QueueItem): Promise<boolean> => {
    const waitEnd = Math.min(mono() + queue.limits.reviewWaitMs, expiresAt);
    for (;;) {
      const read = await tryLeaf(item);
      if (read.ok) {
        const verdict = reviewVerdict(read.leaf, item, queue.acceptors);
        if (verdict === "accepted") {
          const index = item.index + 1;
          // The last acceptance, the completed phase and all_accepted publish as one record,
          // because the schema requires completed exactly when index equals the item count.
          await commit({
            items: replaceItem(rec!, { ...item, state: "accepted" }),
            index,
            ...(index === rec!.items.length
              ? { phase: "completed" as const, reason: "all_accepted" as const }
              : {})
          });
          return true;
        }
        if (verdict !== "pending") return operator(VERDICT_REASON[verdict]);
      }
      const halt = halted();
      if (halt) return stopClean(halt);
      if (await stopRequested()) return stopClean("stop_requested");
      const left = waitEnd - mono();
      if (left <= 0) return stopClean(read.ok ? "review_timeout" : "authority_unavailable");
      await sleep(Math.min(queue.limits.pollMs, left), abort.signal);
    }
  };

  const drive = async () => {
    while (rec!.index < rec!.items.length) {
      const item = rec!.items[rec!.index];
      if (item.state === "pending") {
        if (!(await startItem(item))) return;
      } else if (item.state === "waiting_review") {
        if (!(await awaitAcceptance(item))) return;
      } else {
        await operator("internal_error");
        return;
      }
    }
    // Completion was already published atomically with the final acceptance.
  };

  const exitOf = (record: QueueRecord): QueueResult["exitCode"] =>
    record.phase === "completed" ? 0 : record.phase === "stopped" ? 3 : 1;

  try {
    await loadItems();
    if (mode === "arm") await arm();
    else await resume();
    try {
      await drive();
    } catch (error) {
      if (!(error instanceof QueueStateError) || error.code !== "HISTORY_FULL") throw error;
      await commit({ phase: "needs_operator", reason: "history_full" }, false);
    }
    const released = await releaseLock();
    lockToken = released ? null : lockToken;
    return released ? { exitCode: exitOf(rec!), record: rec! } : { exitCode: 4, record: rec! };
  } catch (error) {
    if (error instanceof Refused) {
      await releaseLock();
      return { exitCode: 2, record: null, refusal: error.code };
    }
    if (error instanceof LockLost || error instanceof PersistenceFailure) {
      // After a lost lock nothing more is written; the retained lock is never taken over.
      if (error instanceof PersistenceFailure) await releaseLock();
      return { exitCode: 4, record: rec ?? null, refusal: "persistence_failed" };
    }
    if (rec) {
      try {
        await commit({ phase: "needs_operator", reason: "internal_error" }, false);
      } catch {
        await releaseLock();
        return { exitCode: 4, record: rec, refusal: "persistence_failed" };
      }
      await releaseLock();
      return { exitCode: 1, record: rec };
    }
    await releaseLock();
    return { exitCode: 2, record: null, refusal: "item_invalid" };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onSignal);
  }
}
