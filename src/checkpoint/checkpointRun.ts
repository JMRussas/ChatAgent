import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fetchCoordinationStatus,
  planApiBase,
  type CoordinationStatus,
  type LeafStatus
} from "../integrations/hekate/devCoordination";
import { processTreeTerminator, type ProcessTreeTerminator } from "../providers/cli/runner";
import {
  BUDGET_SCHEMA,
  BUDGET_UNIT,
  CHECKPOINT_LIMITS,
  CheckpointRecordError,
  budgetRecordPath,
  parseBoundedJson,
  replaceBudgetRecord,
  reserveBudgetRecord,
  type BudgetRecord,
  type CheckpointProfile,
  type RunInput,
  type StopRecord
} from "./checkpointRecord";

/**
 * Trusted, operator-triggered checkpoint runner (doc 19). It fences an already claimed Hekate
 * task, spawns one pinned worker in a pinned linked worktree and watches only budget, process
 * and ownership tripwires. It never claims, retries, accepts, integrates or writes PlanStore
 * state, and its record is supplied, unauthenticated evidence. Worker stdout is reduced to a
 * set of message IDs and two provider numbers; no text, tool data or stderr is ever kept.
 */

/** Code constants per profile; nothing here comes from input, chat, a catalog or a browser. */
export const PROFILE_TOOLS: Record<CheckpointProfile, string> = {
  readonly_smoke: "Read,Grep,Glob",
  coding: "Read,Grep,Glob,Edit,Write"
};

export function profileArgs(
  profile: CheckpointProfile,
  model: string,
  providerUsdCap?: number
): string[] {
  const tools = PROFILE_TOOLS[profile];
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--permission-mode",
    "acceptEdits",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    "--disable-slash-commands",
    "--model",
    model,
    "--tools",
    tools,
    "--allowedTools",
    tools,
    ...(providerUsdCap === undefined ? [] : ["--max-budget-usd", String(providerUsdCap)])
  ];
}

export const RUNNER_LIMITS = {
  tickMs: 5_000,
  closeGraceMs: 10_000,
  authorityTimeoutMs: 4_000,
  preflightTimeoutMs: 5_000,
  authorityMaxBytes: 2 * 1024 * 1024,
  helpTimeoutMs: 10_000,
  helpMaxBytes: 512 * 1024,
  gitTimeoutMs: 10_000
} as const;

const MESSAGE_ID = /^[\x21-\x7e]{1,128}$/;

// ----- stream counter -----

/**
 * Counts distinct `message.id` values of newline-terminated `assistant` objects. Anything it
 * cannot read with certainty (bad UTF-8, malformed or oversize line, duplicate key, missing ID,
 * unterminated tail) makes the count a lower bound and stops further counting.
 */
export class StreamCounter {
  readonly ids = new Set<string>();
  uncertain = false;
  numTurns: number | null = null;
  costUsd: number | null = null;
  private parts: Buffer[] = [];
  private size = 0;

  constructor(
    private readonly maxLineBytes: number,
    private readonly maxIds: number
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (!this.uncertain) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, newline));
      if (!this.uncertain) this.finishLine();
      start = newline + 1;
    }
  }

  /** The stream ended: a trailing line without a newline is never counted. */
  end(): void {
    if (this.size > 0) this.uncertain = true;
  }

  private append(part: Buffer) {
    if (this.size + part.length > this.maxLineBytes) {
      this.uncertain = true;
      this.parts = [];
      this.size = 0;
      return;
    }
    if (part.length > 0) this.parts.push(Buffer.from(part));
    this.size += part.length;
  }

  private finishLine() {
    let bytes = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, -1);
    if (bytes.length === 0) return;
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      value = parseBoundedJson(text, { maxDepth: 64, numbers: "stream" });
    } catch {
      this.uncertain = true;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.uncertain = true;
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.type === "assistant") {
      const message = object.message;
      const id =
        typeof message === "object" && message !== null && !Array.isArray(message)
          ? (message as Record<string, unknown>).id
          : undefined;
      if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
        this.uncertain = true;
        return;
      }
      if (this.ids.size < this.maxIds) this.ids.add(id);
    } else if (object.type === "result") {
      const turns = object.num_turns;
      const cost = object.total_cost_usd;
      this.numTurns =
        typeof turns === "number" && Number.isSafeInteger(turns) && turns >= 0 ? turns : null;
      this.costUsd =
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1e9 ? cost : null;
    }
  }
}

// ----- signals -----

/** Aborts the controller on operator interrupt; returns the unbind function. */
export function bindProcessSignals(
  controller: AbortController,
  proc: Pick<NodeJS.Process, "on" | "off"> = process,
  signals: readonly NodeJS.Signals[] = process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"]
): () => void {
  const handler = () => controller.abort();
  for (const signal of signals) proc.on(signal, handler);
  return () => {
    for (const signal of signals) proc.off(signal, handler);
  };
}

// ----- preflight helpers -----

const sameResolved = (a: string, b: string) => {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function readPinnedPrompt(path: string): Promise<Buffer> {
  const max = CHECKPOINT_LIMITS.maxPromptBytes;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("PROMPT_INVALID");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error("PROMPT_INVALID");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > max) throw new Error("PROMPT_INVALID");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function pinnedFile(pin: { path: string; sha256: string }): Promise<boolean> {
  try {
    if (!isAbsolute(pin.path) || !sameResolved(await realpath(pin.path), pin.path)) return false;
    if (!(await stat(pin.path)).isFile()) return false;
    return (await sha256OfFile(pin.path)) === pin.sha256;
  } catch {
    return false;
  }
}

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

function defaultGitHead(git: string, worktree: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))
  );
  return new Promise((resolveHead, reject) =>
    execFile(
      git,
      ["-C", worktree, "rev-parse", "--verify", "HEAD"],
      {
        shell: false,
        windowsHide: true,
        timeout: RUNNER_LIMITS.gitTimeoutMs,
        maxBuffer: 4096,
        env
      },
      (error, stdout) => (error ? reject(new Error("GIT_FAILED")) : resolveHead(stdout.trim()))
    )
  );
}

/** Fail closed: every flag the profile uses must appear in the installed release's public help. */
function defaultConfirmFlags(executable: string, flags: readonly string[]): Promise<boolean> {
  return new Promise((resolveFlags) =>
    execFile(
      executable,
      ["--help"],
      {
        shell: false,
        windowsHide: true,
        timeout: RUNNER_LIMITS.helpTimeoutMs,
        maxBuffer: RUNNER_LIMITS.helpMaxBytes
      },
      (error, stdout) => resolveFlags(!error && flags.every((flag) => stdout.includes(flag)))
    )
  );
}

function authorityMatches(status: CoordinationStatus, input: RunInput, startOnly: boolean) {
  if (status.status !== "ok") return false;
  const leaf: LeafStatus | undefined = status.leaves.find(
    (l) => l.nodeId === input.identity.nodeId
  );
  return (
    leaf !== undefined &&
    leaf.state === "in_progress" &&
    leaf.attemptPins === "current" &&
    leaf.attemptId === input.identity.attemptId &&
    leaf.attemptEpoch === input.identity.attemptEpoch &&
    leaf.contentRevision === input.identity.contentRevision &&
    leaf.executorRef === input.identity.executorRef &&
    (!startOnly || leaf.stateRevision === input.identity.stateRevision)
  );
}

// ----- runner -----

export type RefusalOutcome = Extract<StopRecord, { kind: "refused" }>["code"];
export type RunRefusal = RefusalOutcome | "run_exists" | "record_dir_invalid";

export interface RunResult {
  /** 0 observed zero worker exit; 1 worker/spawn/cleanup failure; 2 refused; 3 tripwire/cancel; 4 record write. */
  exitCode: 0 | 1 | 2 | 3 | 4;
  /** Null only when no record could be created. */
  record: BudgetRecord | null;
  refusal?: RunRefusal;
}

export interface CheckpointDeps {
  fetchStatus?: typeof fetchCoordinationStatus;
  terminator?: ProcessTreeTerminator;
  signal?: AbortSignal;
  /**
   * Test seam, never reachable from the script or the input file: replaces the argument list of
   * the pinned executable and skips the public-help confirmation.
   */
  launchArgs?: readonly string[];
  gitHead?: (git: string, worktree: string) => Promise<string>;
  confirmFlags?: (executable: string, flags: readonly string[]) => Promise<boolean>;
  tickMs?: number;
  closeGraceMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

export const exitCodeOf = (stop: StopRecord): RunResult["exitCode"] => {
  switch (stop.kind) {
    case "exited":
      return 0;
    case "refused":
      return 2;
    case "tripwire":
    case "cancelled":
      return 3;
    case "failed":
      return stop.code === "record_write_failed" ? 4 : 1;
    case "none":
      return 1;
  }
};

export async function runCheckpoint(
  input: RunInput,
  deps: CheckpointDeps = {}
): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const tickMs = Math.min(deps.tickMs ?? RUNNER_LIMITS.tickMs, RUNNER_LIMITS.tickMs);
  const closeGraceMs = deps.closeGraceMs ?? RUNNER_LIMITS.closeGraceMs;
  const terminator = deps.terminator ?? processTreeTerminator;
  const fetchStatus = deps.fetchStatus ?? fetchCoordinationStatus;
  let startMs = now();
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  let elapsedStart = monotonicNow();
  const elapsed = () => Math.max(0, Math.floor(monotonicNow() - elapsedStart));
  const iso = (ms: number) => new Date(ms).toISOString();

  const baseRecord = (): BudgetRecord => ({
    schema: BUDGET_SCHEMA,
    runId: input.runId,
    identity: {
      rootId: input.identity.rootId,
      nodeId: input.identity.nodeId,
      attemptId: input.identity.attemptId,
      attemptEpoch: input.identity.attemptEpoch,
      contentRevision: input.identity.contentRevision,
      observedStateRevision: input.identity.stateRevision,
      executorRef: input.identity.executorRef
    },
    baseRef: input.identity.baseRef,
    profile: input.profile,
    state: "running",
    unit: BUDGET_UNIT,
    expected: { units: input.expected.units, basis: "provisional_heuristic" },
    hard: { ...input.hard },
    consumed: { units: 0, wallMs: 0, outputBytes: 0, counterState: "exact_observed" },
    expectedExceeded: false,
    providerReported: { numTurns: null, costUsd: null, status: "unverified" },
    cost: {
      enforcement:
        input.providerUsdCap === undefined ? "none" : "provider_cap_configured_unverified"
    },
    stop: { kind: "none", code: "none" },
    exit: null,
    rootPid: null,
    startedAt: iso(startMs),
    updatedAt: iso(startMs),
    endedAt: null,
    writer: "runner_record",
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    artifactRef: null
  });

  // The record directory must exist and lie outside the worktree before anything is written.
  try {
    const dir = await realpath(input.recordDir);
    const tree = await realpath(input.worktree).catch(() => resolve(input.worktree));
    if (!(await stat(dir)).isDirectory() || inside(tree, dir))
      return { exitCode: 2, record: null, refusal: "record_dir_invalid" };
  } catch {
    return { exitCode: 2, record: null, refusal: "record_dir_invalid" };
  }
  const exists = await lstat(budgetRecordPath(input.recordDir, input.runId)).then(
    () => true,
    () => false
  );
  if (exists) return { exitCode: 2, record: null, refusal: "run_exists" };

  const refuse = async (code: RefusalOutcome): Promise<RunResult> => {
    const record: BudgetRecord = {
      ...baseRecord(),
      state: "ended",
      stop: { kind: "refused", code },
      endedAt: iso(now())
    };
    try {
      await reserveBudgetRecord(input.recordDir, record);
    } catch (error) {
      const existing = error instanceof CheckpointRecordError && error.code === "RECORD_EXISTS";
      return {
        exitCode: existing ? 2 : 4,
        record: null,
        ...(existing ? { refusal: "run_exists" as const } : {})
      };
    }
    return { exitCode: 2, record, refusal: code };
  };

  // ----- preflight: nothing is spawned until every check passes -----
  let promptBytes: Buffer;
  try {
    const bytes = await readPinnedPrompt(input.promptFile);
    if (
      bytes.length > CHECKPOINT_LIMITS.maxPromptBytes ||
      createHash("sha256").update(bytes).digest("hex") !== input.promptSha256
    )
      return refuse("pin_mismatch");
    promptBytes = bytes;
  } catch {
    return refuse("pin_mismatch");
  }
  if (!(await pinnedFile(input.executable)) || !(await pinnedFile(input.gitExecutable)))
    return refuse("pin_mismatch");

  let cwd: string;
  try {
    cwd = await realpath(input.worktree);
    // A linked worktree has a `.git` file; the main checkout has a directory.
    if (!(await lstat(join(cwd, ".git"))).isFile()) return refuse("worktree_invalid");
  } catch {
    return refuse("worktree_invalid");
  }
  try {
    const head = await (deps.gitHead ?? defaultGitHead)(input.gitExecutable.path, cwd);
    if (head.toLowerCase() !== input.identity.baseRef) return refuse("pin_mismatch");
  } catch {
    return refuse("worktree_invalid");
  }

  try {
    planApiBase(input.planApiUrl);
    const status = await fetchStatus(input.planApiUrl, input.identity.rootId, {
      timeoutMs: RUNNER_LIMITS.preflightTimeoutMs,
      maxBytes: RUNNER_LIMITS.authorityMaxBytes
    });
    if (!authorityMatches(status, input, true)) return refuse("authority_mismatch");
  } catch {
    return refuse("authority_unavailable");
  }

  const args = deps.launchArgs ?? profileArgs(input.profile, input.model, input.providerUsdCap);
  if (!deps.launchArgs) {
    const flags = args.filter((arg) => arg.startsWith("--"));
    if (!(await (deps.confirmFlags ?? defaultConfirmFlags)(input.executable.path, flags)))
      return refuse("profile_unsupported");
  }

  // Worker budget excludes preparation; reserve its record before any worker can start.
  startMs = now();
  elapsedStart = monotonicNow();
  // A new run ID must not bypass an already-owned attempt in this fixed record namespace.
  const claimKey = createHash("sha256")
    .update(
      JSON.stringify([
        input.identity.rootId,
        input.identity.nodeId,
        input.identity.attemptId,
        input.identity.attemptEpoch,
        input.identity.contentRevision
      ])
    )
    .digest("hex");
  let lease;
  try {
    lease = await open(join(input.recordDir, `.claim-${claimKey}.lease`), "wx");
    await lease.writeFile(JSON.stringify({ schema: "checkpoint-claim/v1", runId: input.runId }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuse("claim_already_owned");
    return { exitCode: 4, record: null };
  } finally {
    await lease?.close();
  }
  // The attempt lease is retained even on exit: rework needs a newly fenced attempt.
  // ----- exclusive reservation, then the only worker spawn -----
  try {
    await reserveBudgetRecord(input.recordDir, baseRecord());
  } catch (error) {
    if (error instanceof CheckpointRecordError && error.code === "RECORD_EXISTS")
      return { exitCode: 2, record: null, refusal: "run_exists" };
    return { exitCode: 4, record: null };
  }

  const counter = new StreamCounter(
    input.maxLineBytes ?? CHECKPOINT_LIMITS.defaultLineBytes,
    input.hard.units + 1
  );
  let outputBytes = 0;
  let decision: StopRecord | undefined;
  let exit: BudgetRecord["exit"] = null;
  let rootPid: number | null = null;
  let cleanupFailed = false;
  let spawnFailed = false;
  let closedFlag = false;
  let recordFailed = false;
  let dirty = false;
  let lastWrite = startMs;
  let authorityBusy = false;
  let wake: () => void = () => {};
  const settled = new Promise<void>((resolveSettled) => {
    wake = resolveSettled;
  });
  let child: ChildProcess | undefined;

  const snapshot = (end: StopRecord | undefined): BudgetRecord => {
    const t = now();
    return {
      ...baseRecord(),
      state: end ? "ended" : "running",
      consumed: {
        units: counter.ids.size,
        wallMs: elapsed(),
        outputBytes,
        counterState: counter.uncertain ? "lower_bound" : "exact_observed"
      },
      expectedExceeded: counter.ids.size >= input.expected.units,
      providerReported: {
        numTurns: counter.numTurns,
        costUsd: counter.costUsd,
        status: "unverified"
      },
      stop: end ?? { kind: "none", code: "none" },
      exit: end ? exit : null,
      rootPid: end && cleanupFailed ? rootPid : null,
      updatedAt: iso(t),
      endedAt: end ? iso(t) : null
    };
  };

  let termination: Promise<void> | undefined;
  const terminate = async () => {
    const target = child;
    if (!target || closedFlag) return;
    try {
      await terminator.terminate(target);
    } catch {
      cleanupFailed = true;
      try {
        target.kill("SIGKILL");
      } catch {
        /* the root may already be gone */
      }
      await Promise.race([closedPromise, delay(closeGraceMs)]);
      wake();
      return;
    }
    // Termination is only reported clean after the process actually closes.
    await Promise.race([closedPromise, delay(closeGraceMs)]);
    if (!closedFlag) {
      cleanupFailed = true;
      wake();
    }
  };
  let closedResolve: () => void = () => {};
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  const trip = (stop: StopRecord) => {
    if (decision) return;
    decision = stop;
    termination ??= terminate();
  };

  // Writes are serialized so a late periodic write can never replace the final record.
  let inflight: Promise<void> = Promise.resolve();
  const flush = () =>
    (inflight = inflight.then(async () => {
      dirty = false;
      lastWrite = now();
      try {
        await replaceBudgetRecord(input.recordDir, snapshot(undefined));
      } catch {
        recordFailed = true;
        trip({ kind: "failed", code: "record_write_failed" });
      }
    }));

  const checkAuthority = async () => {
    if (authorityBusy || decision) return;
    authorityBusy = true;
    try {
      const status = await fetchStatus(input.planApiUrl, input.identity.rootId, {
        timeoutMs: RUNNER_LIMITS.authorityTimeoutMs,
        maxBytes: RUNNER_LIMITS.authorityMaxBytes
      });
      // An unreadable plan is uncertainty, not a change; only a readable different claim trips.
      if (status.status === "ok" && !authorityMatches(status, input, false))
        trip({ kind: "tripwire", code: "authority_changed" });
    } catch {
      /* unavailable authority is uncertainty; the other bounds still apply */
    } finally {
      authorityBusy = false;
    }
  };

  const check = () => {
    if (counter.uncertain) trip({ kind: "tripwire", code: "counter_uncertain" });
    else if (counter.ids.size > input.hard.units) trip({ kind: "tripwire", code: "hard_units" });
  };

  const stopOnAbort = () => trip({ kind: "cancelled", code: "cancelled" });
  deps.signal?.addEventListener("abort", stopOnAbort, { once: true });
  const wallTimer = setTimeout(
    () => trip({ kind: "tripwire", code: "hard_wall" }),
    Math.max(0, input.hard.wallMs - elapsed())
  );
  const ticker = setInterval(() => {
    if (!decision && elapsed() >= input.hard.wallMs) trip({ kind: "tripwire", code: "hard_wall" });
    void checkAuthority();
    if (dirty && !decision && now() - lastWrite >= tickMs) void flush();
  }, tickMs);
  const cleanupTimers = () => {
    clearTimeout(wallTimer);
    clearInterval(ticker);
    deps.signal?.removeEventListener("abort", stopOnAbort);
  };

  if (deps.signal?.aborted) {
    cleanupTimers();
    const record = snapshot({ kind: "cancelled", code: "cancelled" });
    try {
      await replaceBudgetRecord(input.recordDir, record);
    } catch {
      return { exitCode: 4, record };
    }
    return { exitCode: 3, record };
  }

  try {
    child = spawn(input.executable.path, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    spawnFailed = true;
  }
  if (child) {
    const worker = child;
    worker.stdout!.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      dirty = true;
      if (outputBytes > input.hard.outputBytes) trip({ kind: "tripwire", code: "hard_output" });
      if (decision) return;
      counter.push(chunk);
      check();
    });
    worker.stderr!.on("data", (chunk: Buffer) => {
      // Counted and discarded: stderr is never parsed, kept or published.
      outputBytes += chunk.length;
      dirty = true;
      if (outputBytes > input.hard.outputBytes) trip({ kind: "tripwire", code: "hard_output" });
    });
    worker.stdin!.on("error", () => {
      /* An early exit is judged by the close event, not by a closed pipe. */
    });
    worker.on("error", () => {
      if (worker.pid === undefined) {
        spawnFailed = true;
        closedFlag = true;
        closedResolve();
      }
    });
    worker.on("close", (code, signal) => {
      exit = { code, signal };
      if (!decision) {
        counter.end();
        if (counter.uncertain) decision = { kind: "tripwire", code: "counter_uncertain" };
      }
      closedFlag = true;
      closedResolve();
    });
    if (worker.pid !== undefined) rootPid = worker.pid;
    worker.stdin!.end(promptBytes);
    dirty = true;
    await flush();
    await Promise.race([closedPromise, settled]);
  }
  cleanupTimers();
  await inflight;
  if (termination) await termination;

  // Closure-assigned state is re-read through casts so flow analysis cannot narrow it away.
  const tripped = decision as StopRecord | undefined;
  const exited = exit as BudgetRecord["exit"];
  let stop: StopRecord;
  if (cleanupFailed as boolean) stop = { kind: "failed", code: "cleanup_failed" };
  else if ((spawnFailed as boolean) || !child) stop = { kind: "failed", code: "spawn_failed" };
  else if (tripped) stop = tripped;
  else if (exited && exited.code === 0) stop = { kind: "exited", code: "exited" };
  else stop = { kind: "failed", code: "exited_nonzero" };

  const record = snapshot(stop);
  try {
    await replaceBudgetRecord(input.recordDir, record);
  } catch {
    return { exitCode: 4, record };
  }
  return { exitCode: (recordFailed as boolean) ? 4 : exitCodeOf(stop), record };
}
