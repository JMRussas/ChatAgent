import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, opendir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Operator adapter for Hekate's existing `e1.owned_dispatch` host. It runs only the
 * native status, launch and stop commands with literal argv. It never opens
 * LocalStore, schedules, retries, reclaims or kills a process tree: the native host
 * stays the single owner and the final authority. The journal and the config are
 * observations and permissions, never task state.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LAUNCH_ID = /^[0-9a-f]{32}$/;
const PROCESS_BIRTH = /^[0-9]{1,24}$/;
const SAFE_WORD = /^[A-Za-z0-9_.:-]{1,80}$/;
const STAMP = /^[0-9T:.+\-Z]{10,40}$/;
const JOURNAL_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const MAX_JOURNAL_FILES = 1000;
/** Counts the lock and temporary files that may sit beside the records. */
const MAX_JOURNAL_ENTRIES = MAX_JOURNAL_FILES + 16;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_BINDING_BYTES = 16 * 1024;
const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
const PLAN_MAX_BYTES = 8 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;

/**
 * The only production entry: the maintained module, run by the pinned interpreter. It is
 * a constant, not configuration; tests substitute a fake program only by wrapping the
 * injected spawn function.
 */
export const PYTHON_ENTRY_PREFIX: readonly string[] = Object.freeze(["-m", "e1.owned_dispatch"]);
/**
 * The maintained `e1.harness` finds the owned container by this label, and the launch
 * path (`LocalStore.open`) needs `HEKATE_E1_CONTAINER_WORKSPACE` to be this value or the
 * repository that holds the e1 tree. Nothing else is accepted there.
 */
export const ORIGINAL_CONTAINER_WORKSPACE = "D:\\Git\\Hekate";
export const CONTAINER_WORKSPACE_ENV = "HEKATE_E1_CONTAINER_WORKSPACE";
/**
 * The variable Hekate's attempt-trace viewer confines its reads under. It is never
 * inherited: only the operator-approved `traceRoot` of the trusted configuration reaches
 * a child.
 */
export const TRACE_ROOT_ENV = "HEKATE_TRACE_ROOT";
/**
 * Every maintained module the `status`, `launch`, `stop` and detached `run` commands can
 * import, directly or lazily (curated from the import graph of `owned_dispatch`,
 * `plan_cli`, `plan_run`, `local_store` and their dependencies). The source manifest must
 * cover all of them, plus the dependency manifest; `uv.lock` has its own field.
 */
export const REQUIRED_E1_MODULES: readonly string[] = Object.freeze([
  "__init__",
  "owned_dispatch",
  "plan_cli",
  "plan_import",
  "plan_run",
  "local_store",
  "operator_acts",
  "wire",
  "exact",
  "harness",
  "cli_worker",
  "pilot",
  "pilot_real",
  "pilot_export",
  "export",
  "h1_bridge",
  "acts",
  "acts_durable",
  "durable",
  "evidence",
  "handoff",
  "handoff_durable",
  "consumer",
  "consumer_durable",
  "task_spec",
  "task_runner",
  "task_format",
  "successor",
  "provenance"
]);
export const REQUIRED_SOURCE_PATHS: readonly string[] = Object.freeze([
  "pyproject.toml",
  ...REQUIRED_E1_MODULES.map((name) => `e1/${name}.py`)
]);
const UV_LOCK_PATH = "uv.lock";

/** Only these variables reach a child; provider credentials never do. */
const ENV_ALLOW = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "LANG",
  "LC_ALL"
]);
/** The native `Limits` field names, as the status file spells them. */
const NATIVE_LIMITS = {
  maxDurationS: "max_duration_s",
  pollS: "poll_s",
  maxPollS: "max_poll_s",
  heartbeatS: "heartbeat_s",
  maxNodes: "max_nodes"
} as const;
const LIVENESS = ["running", "unresponsive", "owner_unverified", "owner_gone", "exited"] as const;
/** A host that ended in one of these may be replaced; anything else needs an operator. */
const RELAUNCH_STATES = new Set(["stopped", "ready_idle", "done"]);
const RESOLUTIONS = ["status_exited_matching_launch_id", "operator_inspected"] as const;

const absolute = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.includes("\0") && path.isAbsolute(p), "absolute path");
const relative = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !path.isAbsolute(p) &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split(/[\\/]/).includes(".."),
    "relative path inside the root"
  );
/** A label for the maintained harness, so a Windows path is valid on any host. */
const workspaceLabel = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !p.includes("\0") && (path.win32.isAbsolute(p) || path.posix.isAbsolute(p)),
    "absolute path"
  );
const sha256 = z.string().regex(SHA256);
/** Printable ASCII that cannot be read as an option flag. */
const argText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[\x21-\x2c\x2e-\x7e][\x20-\x7e]*$/);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const limitsSchema = z
  .object({
    maxDurationS: int(60, 24 * 3600),
    pollS: int(5, 3600),
    maxPollS: int(5, 3600),
    heartbeatS: int(5, 300),
    maxNodes: int(1, 20)
  })
  .strict()
  .refine((l) => l.maxPollS >= l.pollS, "maxPollS >= pollS");

const rootSchema = z
  .object({
    rootId: z.string().regex(GUID),
    taskId: z.string().regex(GUID),
    stateDir: absolute,
    planFile: absolute,
    planSha256: sha256,
    importSha256: sha256,
    runRoot: absolute,
    executable: absolute,
    executableSha256: sha256,
    worker: z.enum(["claude", "codex"]),
    workerModel: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
      .optional(),
    rootGo: argText(200),
    actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/),
    limits: limitsSchema
  })
  .strict()
  .refine((r) => r.workerModel === undefined || r.worker === "codex", "workerModel needs codex");

const configSchema = z
  .object({
    journalDir: absolute,
    /** The fixed value the maintained launch path requires; never taken from a request. */
    containerWorkspace: workspaceLabel,
    /** Optional approved root for the attempt-trace viewer; checked against the paths below. */
    traceRoot: absolute.optional(),
    python: z
      .object({
        executable: absolute,
        sha256,
        /** The exact `--version` output. */
        version: z.string().regex(/^[\x20-\x7e]{1,80}$/)
      })
      .strict(),
    source: z
      .object({
        e1Root: absolute,
        files: z
          .array(z.object({ path: relative, sha256 }).strict())
          .min(REQUIRED_SOURCE_PATHS.length)
          .max(200),
        uvLock: z.object({ path: relative, sha256 }).strict()
      })
      .strict(),
    bounds: z
      .object({
        stdoutBytes: int(1, 64 * 1024),
        stderrBytes: int(1, 16 * 1024),
        commandDeadlineMs: int(100, 45_000),
        launchDeadlineMs: int(100, 45_000),
        waitS: int(1, 40),
        /** Largest interpreter or model executable that is hashed. */
        toolMaxBytes: int(1, 512 * 1024 * 1024),
        /** One budget for all hashing of one guarded operation. */
        pinDeadlineMs: int(100, 120_000)
      })
      .strict()
      .refine((b) => b.launchDeadlineMs > b.waitS * 1000, "launch deadline must exceed waitS"),
    roots: z.array(rootSchema).min(1).max(8)
  })
  .strict();

export type DispatchHostConfig = z.input<typeof configSchema>;
type Config = z.output<typeof configSchema>;
type RootConfig = Config["roots"][number];

export class DispatchHostConfigError extends Error {
  constructor(readonly fields: string[]) {
    super(`INVALID_DISPATCH_HOST_CONFIG: ${fields.join(", ")}`);
    this.name = "DispatchHostConfigError";
  }
}

/** Test seam only: production constructs the host without options and uses node's spawn. */
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface DispatchHostOptions {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}
export interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

type Outcome =
  | { kind: "exit"; code: number | null; stdout: string }
  | { kind: "timeout" }
  | { kind: "overflow" }
  | { kind: "spawn_error" };
type Report = Record<string, unknown>;
type Liveness = (typeof LIVENESS)[number];
type Kind = "launch" | "stop";

interface JournalRecord {
  schema: "dispatch-journal.v0";
  operationId: string;
  kind: Kind;
  rootId: string;
  taskId: string;
  state: "intent" | "complete";
  createdAt: string;
  outcome?: string;
  result?: DispatchResult;
  launchId?: string;
  targetLaunchId?: string;
  processBirth?: string;
  completedAt?: string;
  /** Written only by an explicit inspection or a matching native launch ID. */
  resolution?: string;
  /** In memory only: an unreadable, foreign or altered file, which blocks like an intent. */
  malformed?: true;
}

const timeText = z.string().regex(STAMP);
const recordBase = {
  schema: z.literal("dispatch-journal.v0"),
  operationId: z.string().regex(GUID),
  kind: z.enum(["launch", "stop"]),
  rootId: z.string().regex(GUID),
  taskId: z.string().regex(GUID),
  createdAt: timeText,
  targetLaunchId: z.string().regex(LAUNCH_ID).optional(),
  resolution: z.enum(RESOLUTIONS).optional()
};
const intentSchema = z.object({ ...recordBase, state: z.literal("intent") }).strict();
const completeSchema = z
  .object({
    ...recordBase,
    state: z.literal("complete"),
    outcome: z.enum(["launched", "uncertain", "failed", "refused", "stop_requested"]),
    result: z.object({ status: int(100, 599), body: z.record(z.string(), z.unknown()) }).strict(),
    launchId: z.string().regex(LAUNCH_ID).optional(),
    processBirth: z.string().regex(PROCESS_BIRTH).optional(),
    completedAt: timeText
  })
  .strict();
/** The run-root binding the maintained `plan_cli` writes: exactly these four fields. */
const bindingSchema = z
  .object({
    marker: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    planRoot: z.string().regex(GUID),
    importSha256: sha256
  })
  .strict();

const fail = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {}
): DispatchResult => ({
  status,
  body: { code, ...extra }
});
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const word = (v: unknown): string | null => (typeof v === "string" && SAFE_WORD.test(v) ? v : null);
const count = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const stamp = (v: unknown): string | null => (typeof v === "string" && STAMP.test(v) ? v : null);
const norm = (p: string) =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const samePath = (a: string, b: string) => norm(a) === norm(b);
const nested = (a: string, b: string) => {
  const rel = path.relative(norm(a), norm(b));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const label = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const sourceKey = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A regular file read whole only after its size is known to be within the cap. */
async function readBounded(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("FILE_BOUNDS");
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const { bytesRead } = await handle.read(buffer, read, info.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    // A file that grew after the size check is not the file that was checked.
    if ((await handle.read(Buffer.alloc(1), 0, 1, info.size)).bytesRead > 0)
      throw new Error("FILE_BOUNDS");
    return buffer.toString("utf8", 0, read);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type Hashed = { hash: string } | { timeout: true } | undefined;
/** Streams a regular file in fixed chunks, within a byte cap and an absolute deadline. */
async function boundedSha256(file: string, maxBytes: number, deadline: number): Promise<Hashed> {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      if (Date.now() > deadline) return { timeout: true };
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { hash: hash.digest("hex") };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const malformedRecord = (root: RootConfig, operationId: string): JournalRecord => ({
  schema: "dispatch-journal.v0",
  operationId,
  kind: "launch",
  rootId: root.rootId,
  taskId: root.taskId,
  state: "intent",
  createdAt: "",
  malformed: true
});

/**
 * The exact public result a completed record may carry for its kind and outcome. Anything
 * else (another status, an extra body field, a foreign ID) is an altered record.
 */
function completedResult(
  record: z.infer<typeof completeSchema>
): { status: number; body: Record<string, unknown> } | undefined {
  const { kind, outcome, operationId } = record;
  const { status, body } = record.result;
  const exact = (...keys: string[]) =>
    Object.keys(body).sort().join() === [...keys, "operationId", "outcome"].sort().join();
  if (body.operationId !== operationId || body.outcome !== outcome) return undefined;
  if (kind === "launch" && record.targetLaunchId !== undefined) return undefined;
  if (kind === "stop" && (record.launchId !== undefined || record.processBirth !== undefined))
    return undefined;
  if (outcome !== "launched" && (record.processBirth !== undefined || body.launchId !== undefined))
    return undefined;
  const ok = (() => {
    if (kind === "launch" && outcome === "launched")
      return (
        status === 200 &&
        exact("code", "launchId", "host") &&
        body.code === "LAUNCHED" &&
        body.host === "attached" &&
        record.launchId !== undefined &&
        body.launchId === record.launchId
      );
    if (kind === "launch" && outcome === "uncertain")
      return (
        exact("code", "childStatus") &&
        body.childStatus === "unknown" &&
        ((body.code === "LAUNCH_UNCERTAIN" && (status === 504 || status === 502)) ||
          (body.code === "UNCONFIRMED" && status === 202))
      );
    if (kind === "launch" && outcome === "failed")
      return status === 502 && exact("code") && body.code === "LAUNCH_FAILED";
    if (kind === "launch" && outcome === "refused")
      return (
        status === 409 &&
        exact("code", "reason") &&
        body.code === "LAUNCH_REFUSED" &&
        (body.reason === null || word(body.reason) !== null)
      );
    if (kind === "stop" && outcome === "stop_requested")
      return (
        status === 202 &&
        exact("code", "state", "exited", "graceful") &&
        body.code === "STOP_REQUESTED" &&
        body.state === "stop_requested" &&
        body.exited === false &&
        body.graceful === true
      );
    if (kind === "stop" && outcome === "refused")
      return (
        status === 409 &&
        exact("code") &&
        (body.code === "STOP_ALREADY_REQUESTED" ||
          body.code === "NO_LIVE_OWNER" ||
          body.code === "OWNER_CHANGED")
      );
    if (kind === "stop" && outcome === "uncertain")
      return status === 502 && exact("code") && body.code === "STOP_UNCERTAIN";
    return false;
  })();
  return ok ? { status, body: { ...body } } : undefined;
}

/** A record that names this root and task and carries only allowed fields, or undefined. */
function parseRecord(
  value: unknown,
  root: RootConfig,
  operationId: string
): JournalRecord | undefined {
  const parsed =
    isObject(value) && value.state === "complete"
      ? completeSchema.safeParse(value)
      : intentSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if (
    data.operationId !== operationId ||
    data.rootId !== root.rootId ||
    data.taskId !== root.taskId
  )
    return undefined;
  if (data.kind === "launch" && data.targetLaunchId !== undefined) return undefined;
  if (data.state === "intent") return data as JournalRecord;
  const result = completedResult(data);
  return result ? ({ ...data, result } as JournalRecord) : undefined;
}

export class DispatchHost {
  private readonly config: Config;
  private readonly spawnFn: SpawnFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly roots = new Map<string, RootConfig>();
  private readonly chains = new Map<string, Promise<void>>();

  /** Validates everything before any state exists; throws a value-free error. */
  constructor(config: unknown, options: DispatchHostOptions = {}) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success)
      throw new DispatchHostConfigError(
        parsed.error.issues.map((issue) => issue.path.join(".") || "(config)")
      );
    const data = parsed.data;
    const seen = new Set<string>();
    const duplicate = (kind: string, key: string) => {
      if (seen.has(`${kind}:${key}`)) throw new DispatchHostConfigError([`roots.${kind}`]);
      seen.add(`${kind}:${key}`);
    };
    for (const root of data.roots) {
      duplicate("rootId", root.rootId);
      duplicate("stateDir", norm(root.stateDir));
      duplicate("runRoot", norm(root.runRoot));
      const places = [data.journalDir, data.source.e1Root, root.stateDir, root.runRoot];
      for (let i = 0; i < places.length; i++)
        for (let j = i + 1; j < places.length; j++)
          if (nested(places[i], places[j]) || nested(places[j], places[i]))
            throw new DispatchHostConfigError(["roots.paths"]);
    }
    const approved = data.traceRoot;
    if (approved !== undefined) {
      const resolved = path.resolve(approved);
      const protectedPaths = [
        data.source.e1Root,
        data.journalDir,
        ...data.roots.map((root) => root.stateDir)
      ];
      if (
        resolved === path.parse(resolved).root ||
        data.roots.some((root) => !nested(approved, root.runRoot)) ||
        protectedPaths.some((place) => nested(approved, place))
      )
        throw new DispatchHostConfigError(["traceRoot"]);
    }
    // The maintained launch path accepts only the original workspace or its own repository.
    const repository = path.resolve(data.source.e1Root, "..", "..", "..");
    const workspace = label(data.containerWorkspace);
    if (workspace !== label(ORIGINAL_CONTAINER_WORKSPACE) && workspace !== label(repository))
      throw new DispatchHostConfigError(["containerWorkspace"]);
    const listed = data.source.files.map((file) => sourceKey(file.path));
    if (new Set(listed).size !== listed.length) throw new DispatchHostConfigError(["source.files"]);
    if (REQUIRED_SOURCE_PATHS.some((required) => !listed.includes(required.toLowerCase())))
      throw new DispatchHostConfigError(["source.files"]);
    if (sourceKey(data.source.uvLock.path) !== UV_LOCK_PATH)
      throw new DispatchHostConfigError(["source.uvLock"]);
    this.config = deepFreeze(data);
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.env = options.env ?? process.env;
    for (const root of this.config.roots) this.roots.set(root.rootId, root);
  }

  has(rootId: string): boolean {
    return this.roots.has(rootId);
  }

  /** Read-only: pins, native status and the journal, projected through an allowlist. */
  async status(rootId: string): Promise<DispatchResult> {
    const root = this.roots.get(rootId);
    if (!root) return fail(404, "DISPATCH_NOT_PREPARED");
    try {
      const pin = await this.pins(root);
      if (pin) return pin;
      const read = await this.readStatus(root);
      if ("error" in read) return read.error;
      const journal = await this.readJournal(root);
      return { status: 200, body: this.project(root, read, journal) };
    } catch {
      return fail(500, "DISPATCH_ERROR");
    }
  }

  async launch(rootId: string, operationId: string): Promise<DispatchResult> {
    return this.mutation(rootId, operationId, "launch", (root, op, journal) =>
      this.doLaunch(root, op, journal)
    );
  }

  async stop(rootId: string, operationId: string): Promise<DispatchResult> {
    return this.mutation(rootId, operationId, "stop", (root, op) => this.doStop(root, op));
  }

  // ---- mutation scaffolding ------------------------------------------------------------

  private async mutation(
    rootId: string,
    rawOperation: string,
    kind: Kind,
    effect: (root: RootConfig, operationId: string, journal: Journal) => Promise<DispatchResult>
  ): Promise<DispatchResult> {
    const root = this.roots.get(rootId);
    if (!root) return fail(404, "DISPATCH_NOT_PREPARED");
    if (typeof rawOperation !== "string" || !GUID.test(rawOperation.toLowerCase()))
      return fail(400, "INVALID_OPERATION_ID");
    const operationId = rawOperation.toLowerCase();
    const previous = this.chains.get(rootId) ?? Promise.resolve();
    const run = previous.then(async (): Promise<DispatchResult> => {
      try {
        const pin = await this.pins(root);
        if (pin) return pin;
        const lock = await this.acquire(root);
        if ("result" in lock) return lock.result;
        try {
          const journal = await this.readJournal(root);
          if (!journal) return fail(503, "JOURNAL_UNAVAILABLE");
          const existing = journal.records.get(operationId);
          if (existing) {
            if (existing.malformed || existing.state === "intent" || !existing.result)
              return fail(409, "INTENT_UNRESOLVED", { operationId });
            if (existing.kind !== kind) return fail(409, "OPERATION_ID_REUSED");
            return {
              status: existing.result.status,
              body: { ...existing.result.body, replayed: true }
            };
          }
          if (blocking(journal)) return fail(409, "INTENT_UNRESOLVED");
          return await effect(root, operationId, journal);
        } finally {
          await lock.release();
        }
      } catch {
        return fail(500, "DISPATCH_ERROR");
      }
    });
    this.chains.set(
      rootId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  private async doLaunch(
    root: RootConfig,
    operationId: string,
    journal: Journal
  ): Promise<DispatchResult> {
    const read = await this.readStatus(root);
    if ("error" in read) return read.error;
    let report: Report | undefined;
    if (read.kind === "report") {
      if (!read.matches) return fail(409, "HOST_MISMATCH");
      report = read.report;
      const refusal = launchGate(report);
      if (refusal) return fail(409, refusal);
    }
    // An uncertain launch clears only when the native host exited with that exact launch ID
    // (or an operator recorded an inspection); never by time or by another ID.
    const resolvable: JournalRecord[] = [];
    for (const record of journal.records.values()) {
      if (!isUncertain(record, "launch")) continue;
      if (report && exitedWith(report, record.launchId)) resolvable.push(record);
      else return fail(409, "PREVIOUS_LAUNCH_UNCERTAIN");
    }
    for (const record of resolvable) {
      try {
        await this.writeRecord(root, { ...record, resolution: RESOLUTIONS[0] }, false);
      } catch {
        return fail(503, "JOURNAL_UNAVAILABLE");
      }
    }
    const intent: JournalRecord = {
      schema: "dispatch-journal.v0",
      operationId,
      kind: "launch",
      rootId: root.rootId,
      taskId: root.taskId,
      state: "intent",
      createdAt: new Date().toISOString()
    };
    try {
      await this.writeRecord(root, intent, true);
    } catch {
      return fail(503, "JOURNAL_UNAVAILABLE");
    }
    const limits = root.limits;
    const args = [
      "launch",
      "--state-dir",
      root.stateDir,
      "--plan",
      root.planFile,
      "--plan-sha256",
      root.planSha256,
      "--run-root",
      root.runRoot,
      "--exe",
      root.executable,
      "--exe-sha256",
      root.executableSha256,
      "--launch-real-model",
      "--root-go",
      root.rootGo,
      "--worker",
      root.worker,
      "--actor",
      root.actor,
      "--max-duration-s",
      String(limits.maxDurationS),
      "--poll-s",
      String(limits.pollS),
      "--max-poll-s",
      String(limits.maxPollS),
      "--heartbeat-s",
      String(limits.heartbeatS),
      "--max-nodes",
      String(limits.maxNodes),
      "--wait-s",
      String(this.config.bounds.waitS),
      ...(root.workerModel !== undefined ? ["--worker-model", root.workerModel] : [])
    ];
    const outcome = await this.run(
      [...PYTHON_ENTRY_PREFIX, ...args],
      this.config.bounds.launchDeadlineMs
    );
    const uncertain = (status: number, code: string, launchId?: string) =>
      this.complete(
        root,
        intent,
        "uncertain",
        status,
        { code, childStatus: "unknown" },
        launchId ? { launchId } : {}
      );
    if (outcome.kind === "timeout") return uncertain(504, "LAUNCH_UNCERTAIN");
    if (outcome.kind !== "exit") return uncertain(502, "LAUNCH_UNCERTAIN");
    const out = parseJson(outcome.stdout);
    if (!out) return uncertain(502, "LAUNCH_UNCERTAIN");
    if (outcome.code === 0 && out.launched === true) {
      const launchId =
        typeof out.launchId === "string" && LAUNCH_ID.test(out.launchId) ? out.launchId : undefined;
      if (!launchId) return uncertain(502, "LAUNCH_UNCERTAIN");
      const after = await this.readStatus(root);
      if (
        !("error" in after) &&
        after.kind === "report" &&
        after.matches &&
        after.report.liveness === "running" &&
        isObject(after.report.owner) &&
        after.report.owner.launchId === launchId
      ) {
        const birth = (after.report.owner as Report).processBirth;
        const processBirth =
          typeof birth === "string" && PROCESS_BIRTH.test(birth) ? birth : undefined;
        return this.complete(
          root,
          intent,
          "launched",
          200,
          { code: "LAUNCHED", launchId, host: "attached" },
          processBirth ? { launchId, processBirth } : { launchId }
        );
      }
      return uncertain(202, "UNCONFIRMED", launchId);
    }
    if (outcome.code === 1 && out.launched === "unconfirmed") {
      // An older producer sends no ID; a missing or malformed one stays unresolvable by status.
      const unconfirmedId =
        typeof out.launchId === "string" &&
        out.launchId.length === 32 &&
        LAUNCH_ID.test(out.launchId)
          ? out.launchId
          : undefined;
      return uncertain(202, "UNCONFIRMED", unconfirmedId);
    }
    if (outcome.code === 1 && out.launched === false)
      return this.complete(root, intent, "failed", 502, { code: "LAUNCH_FAILED" });
    if (outcome.code === 2 && typeof out.refused === "string")
      return this.complete(root, intent, "refused", 409, {
        code: "LAUNCH_REFUSED",
        reason: word(out.refused)
      });
    return uncertain(502, "LAUNCH_UNCERTAIN");
  }

  private async doStop(root: RootConfig, operationId: string): Promise<DispatchResult> {
    const read = await this.readStatus(root);
    if ("error" in read) return read.error;
    if (read.kind !== "report") return fail(409, "NO_LIVE_OWNER");
    if (!read.matches) return fail(409, "HOST_MISMATCH");
    if (read.report.liveness !== "running") return fail(409, "NO_LIVE_OWNER");
    const owner = read.report.owner;
    const target = isObject(owner) ? owner.launchId : undefined;
    if (typeof target !== "string" || !LAUNCH_ID.test(target)) return fail(409, "OWNER_UNVERIFIED");
    const intent: JournalRecord = {
      schema: "dispatch-journal.v0",
      operationId,
      kind: "stop",
      rootId: root.rootId,
      taskId: root.taskId,
      state: "intent",
      createdAt: new Date().toISOString(),
      targetLaunchId: target
    };
    try {
      await this.writeRecord(root, intent, true);
    } catch {
      return fail(503, "JOURNAL_UNAVAILABLE");
    }
    const outcome = await this.run(
      [
        ...PYTHON_ENTRY_PREFIX,
        "stop",
        "--state-dir",
        root.stateDir,
        "--actor",
        root.actor,
        "--expected-launch-id",
        target
      ],
      this.config.bounds.commandDeadlineMs
    );
    const out = outcome.kind === "exit" ? parseJson(outcome.stdout) : undefined;
    if (outcome.kind === "exit" && out) {
      if (outcome.code === 0 && out.stopRequested === true && out.targetLaunchId === target)
        return this.complete(root, intent, "stop_requested", 202, {
          code: "STOP_REQUESTED",
          state: "stop_requested",
          exited: false,
          graceful: true
        });
      if (outcome.code === 2) {
        const typed: Record<string, string> = {
          stop_already_requested: "STOP_ALREADY_REQUESTED",
          no_live_owner: "NO_LIVE_OWNER"
        };
        if (out.refused === "owner_changed" && out.expectedLaunchId === target)
          return this.complete(root, intent, "refused", 409, { code: "OWNER_CHANGED" });
        const code = typeof out.refused === "string" ? typed[out.refused] : undefined;
        if (code) return this.complete(root, intent, "refused", 409, { code });
      }
    }
    return this.complete(root, intent, "uncertain", 502, { code: "STOP_UNCERTAIN" });
  }

  // ---- pins ----------------------------------------------------------------------------

  /** Hashes every pinned input within one deadline; a failure means no native call. */
  private async pins(root: RootConfig): Promise<DispatchResult | undefined> {
    const deadline = Date.now() + this.config.bounds.pinDeadlineMs;
    const mismatch = (check: string) => fail(409, "PIN_MISMATCH", { check });
    const timeout = fail(504, "PIN_TIMEOUT");
    const verify = async (
      file: string,
      max: number,
      expected: string,
      check: string
    ): Promise<DispatchResult | undefined> => {
      const hashed = await boundedSha256(file, max, deadline);
      if (hashed && "timeout" in hashed) return timeout;
      return hashed && hashed.hash === expected ? undefined : mismatch(check);
    };
    const { python, source, bounds } = this.config;
    const interpreter = await verify(
      python.executable,
      bounds.toolMaxBytes,
      python.sha256,
      "python"
    );
    if (interpreter) return interpreter;
    const version = await this.run(["--version"], bounds.commandDeadlineMs);
    if (version.kind !== "exit" || version.code !== 0 || version.stdout.trim() !== python.version)
      return mismatch("python_version");
    for (const file of source.files) {
      const failed = await verify(
        path.join(source.e1Root, ...file.path.split(/[\\/]/)),
        SOURCE_MAX_BYTES,
        file.sha256,
        "source"
      );
      if (failed) return failed;
    }
    const lock = await verify(
      path.join(source.e1Root, ...source.uvLock.path.split(/[\\/]/)),
      SOURCE_MAX_BYTES,
      source.uvLock.sha256,
      "uv_lock"
    );
    if (lock) return lock;
    const model = await verify(
      root.executable,
      bounds.toolMaxBytes,
      root.executableSha256,
      "executable"
    );
    if (model) return model;
    const plan = await verify(root.planFile, PLAN_MAX_BYTES, root.planSha256, "plan");
    if (plan) return plan;
    // A run root that does not exist yet is the unprepared state; an existing one must bind.
    let info;
    try {
      info = await stat(root.runRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return mismatch("binding");
    }
    if (!info.isDirectory()) return mismatch("binding");
    try {
      const binding = bindingSchema.parse(
        JSON.parse(
          await readBounded(path.join(root.runRoot, "plan.binding.json"), MAX_BINDING_BYTES)
        )
      );
      if (binding.planRoot !== root.rootId || binding.importSha256 !== root.planSha256)
        return mismatch("binding");
    } catch {
      return mismatch("binding");
    }
    const bound = await boundedSha256(
      path.join(root.runRoot, "plan.import.json"),
      PLAN_MAX_BYTES,
      deadline
    );
    if (bound && "timeout" in bound) return timeout;
    return bound && bound.hash === root.planSha256 ? undefined : mismatch("binding");
  }

  // ---- native commands -----------------------------------------------------------------

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.env))
      if (value !== undefined && ENV_ALLOW.has(key.toUpperCase())) env[key] = value;
    env.PYTHONUTF8 = "1";
    env[CONTAINER_WORKSPACE_ENV] = this.config.containerWorkspace;
    if (this.config.traceRoot !== undefined) env[TRACE_ROOT_ENV] = this.config.traceRoot;
    return env;
  }

  /**
   * One bounded, hidden, shell-less command. Only this command's own process is ended on a
   * deadline or an output cap; a detached native child is never touched.
   */
  private run(args: string[], deadlineMs: number): Promise<Outcome> {
    const { stdoutBytes, stderrBytes } = this.config.bounds;
    return new Promise((resolve) => {
      let done = false;
      let child: ChildProcess | undefined;
      const chunks: Buffer[] = [];
      let out = 0;
      let err = 0;
      const finish = (outcome: Outcome, kill: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (kill && child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ kind: "timeout" }, true), deadlineMs);
      try {
        child = this.spawnFn(this.config.python.executable, args, {
          cwd: this.config.source.e1Root,
          env: this.childEnv(),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        finish({ kind: "spawn_error" }, false);
        return;
      }
      child.on("error", () => finish({ kind: "spawn_error" }, true));
      child.stdout?.on("data", (data: Buffer) => {
        if (done) return;
        out += data.length;
        if (out > stdoutBytes) finish({ kind: "overflow" }, true);
        else chunks.push(data);
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (done) return;
        err += data.length;
        if (err > stderrBytes) finish({ kind: "overflow" }, true);
      });
      child.on("close", (code) =>
        finish({ kind: "exit", code, stdout: Buffer.concat(chunks).toString("utf8") }, false)
      );
    });
  }

  private async readStatus(root: RootConfig): Promise<StatusRead> {
    const outcome = await this.run(
      [...PYTHON_ENTRY_PREFIX, "status", "--state-dir", root.stateDir],
      this.config.bounds.commandDeadlineMs
    );
    if (outcome.kind === "timeout") return { error: fail(504, "STATUS_TIMEOUT") };
    if (outcome.kind === "overflow") return { error: fail(502, "OUTPUT_TOO_LARGE") };
    if (outcome.kind !== "exit") return { error: fail(502, "STATUS_UNAVAILABLE") };
    const report = parseJson(outcome.stdout);
    if (!report) return { error: fail(502, "STATUS_UNAVAILABLE") };
    if (outcome.code === 2 && report.state === "no_status" && report.liveness === null)
      return { kind: "none" };
    if (outcome.code !== 0) return { error: fail(502, "STATUS_UNAVAILABLE") };
    if (
      report.schema !== "owned-dispatch-status.v0" ||
      !(LIVENESS as readonly unknown[]).includes(report.liveness)
    )
      return { error: fail(502, "STATUS_MALFORMED") };
    return { kind: "report", report, matches: hostMatches(root, report) };
  }

  // ---- journal -------------------------------------------------------------------------

  private dir(root: RootConfig) {
    return path.join(this.config.journalDir, root.rootId);
  }

  /** Bounded read of the whole journal; undefined when it cannot be trusted to be small. */
  private async readJournal(root: RootConfig): Promise<Journal | undefined> {
    const dir = this.dir(root);
    const names: string[] = [];
    try {
      const handle = await opendir(dir);
      try {
        for await (const entry of handle) {
          names.push(entry.name);
          if (names.length > MAX_JOURNAL_ENTRIES) return undefined;
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { records: new Map(), malformed: 0 };
      return undefined;
    }
    const files = names.filter((name) => name !== "lock" && !name.endsWith(".tmp"));
    if (files.length > MAX_JOURNAL_FILES) return undefined;
    const records = new Map<string, JournalRecord>();
    let malformed = 0;
    for (const name of files) {
      if (!JOURNAL_FILE.test(name)) {
        malformed++;
        continue;
      }
      const operationId = name.slice(0, -".json".length);
      let record: JournalRecord | undefined;
      try {
        record = parseRecord(
          JSON.parse(await readBounded(path.join(dir, name), MAX_RECORD_BYTES)),
          root,
          operationId
        );
      } catch {
        record = undefined;
      }
      if (!record) {
        malformed++;
        record = malformedRecord(root, operationId);
      }
      records.set(operationId, record);
    }
    return { records, malformed };
  }

  /** An exclusive lock file, never reclaimed by age or by this adapter. */
  private async acquire(
    root: RootConfig
  ): Promise<{ result: DispatchResult } | { release: () => Promise<void> }> {
    const dir = this.dir(root);
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      return { result: fail(503, "JOURNAL_UNAVAILABLE") };
    }
    const file = path.join(dir, "lock");
    let handle;
    try {
      handle = await open(file, "wx");
    } catch (error) {
      return {
        result: fail(
          503,
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? "JOURNAL_LOCKED"
            : "JOURNAL_UNAVAILABLE"
        )
      };
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch {
      // The lock exists either way and is released below.
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { release: () => unlink(file).catch(() => undefined) };
  }

  /** An intent is created exclusively; a completion replaces its record atomically. */
  private async writeRecord(root: RootConfig, record: JournalRecord, exclusive: boolean) {
    const file = path.join(this.dir(root), `${record.operationId}.json`);
    const { malformed: _ignored, ...clean } = record;
    const text = JSON.stringify(clean);
    if (exclusive) {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      return;
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  }

  private async complete(
    root: RootConfig,
    intent: JournalRecord,
    outcome: NonNullable<JournalRecord["outcome"]>,
    status: number,
    body: Record<string, unknown>,
    extra: { launchId?: string; processBirth?: string } = {}
  ): Promise<DispatchResult> {
    const result: DispatchResult = {
      status,
      body: { ...body, operationId: intent.operationId, outcome }
    };
    const record: JournalRecord = {
      ...intent,
      state: "complete",
      outcome,
      result,
      ...extra,
      completedAt: new Date().toISOString()
    };
    // Only a record this adapter could later replay is written.
    if (!parseRecord(JSON.parse(JSON.stringify(record)), root, intent.operationId))
      return fail(503, "JOURNAL_UNAVAILABLE");
    try {
      await this.writeRecord(root, record, false);
    } catch {
      return fail(503, "JOURNAL_UNAVAILABLE");
    }
    return result;
  }

  // ---- projection ----------------------------------------------------------------------

  private project(root: RootConfig, read: StatusOk, journal: Journal | undefined): Report {
    const report = read.kind === "report" ? read.report : undefined;
    const attached = report !== undefined && read.kind === "report" && read.matches;
    const liveness = attached ? (report.liveness as Liveness) : null;
    const owner: Report = attached && isObject(report.owner) ? report.owner : {};
    const launchId =
      typeof owner.launchId === "string" && LAUNCH_ID.test(owner.launchId) ? owner.launchId : null;
    const records = journal ? [...journal.records.values()] : [];
    const stopRequested =
      liveness === "running" &&
      launchId !== null &&
      records.some(
        (r) =>
          r.kind === "stop" &&
          r.state === "complete" &&
          r.outcome === "stop_requested" &&
          !r.malformed &&
          r.targetLaunchId === launchId
      );
    const hostActive =
      read.kind === "report" &&
      (!read.matches || ["running", "unresponsive", "owner_unverified"].includes(String(liveness)));
    const summary = journal
      ? {
          unresolvedIntent: blocking(journal),
          uncertainLaunch: records.some(
            (r) => isUncertain(r, "launch") && !(attached && exitedWith(report, r.launchId))
          ),
          uncertainStop: hostActive && records.some((r) => isUncertain(r, "stop")),
          malformedRecords: journal.malformed
        }
      : null;
    const base = { rootId: root.rootId, journal: summary };
    const empty = {
      ...base,
      host: "none",
      lifecycle: "no_host",
      liveness: null,
      phase: null,
      state: null,
      stopReason: null,
      launchId: null,
      startedAt: null,
      heartbeatAt: null,
      exitedAt: null,
      current: null,
      counters: null,
      stopRequested: false
    };
    if (!report) return empty;
    if (!attached) return { ...empty, host: "host_mismatch", lifecycle: "host_mismatch" };
    const state = word(report.state);
    let lifecycle: string;
    if (liveness === "running")
      lifecycle = stopRequested
        ? "stop_requested"
        : report.current != null
          ? "dispatching"
          : "running";
    else if (liveness === "unresponsive" || liveness === "owner_unverified")
      lifecycle = "unverified";
    else if (liveness === "owner_gone") lifecycle = "owner_gone";
    else lifecycle = state === "stopped" ? "stopped" : state === "failed" ? "failed" : "exited";
    const counters = isObject(report.counters)
      ? Object.fromEntries(
          Object.entries(report.counters)
            .filter(([key, value]) => SAFE_WORD.test(key) && count(value) !== null)
            .slice(0, 16)
        )
      : null;
    const heartbeat: Report = isObject(report.heartbeat) ? report.heartbeat : {};
    return {
      ...base,
      host: "attached",
      lifecycle,
      liveness,
      phase: word(report.phase),
      state,
      stopReason: word(report.stopReason),
      launchId,
      startedAt: stamp(owner.startedAt),
      heartbeatAt: stamp(heartbeat.at),
      exitedAt: stamp(report.exitedAt),
      current: isObject(report.current)
        ? {
            node: word(report.current.node),
            ...(typeof report.current.nodeId === "string" && GUID.test(report.current.nodeId)
              ? { nodeId: report.current.nodeId }
              : {}),
            workerLiveness: "unknown"
          }
        : null,
      counters,
      stopRequested
    };
  }
}

interface Journal {
  records: Map<string, JournalRecord>;
  malformed: number;
}
type StatusOk = { kind: "none" } | { kind: "report"; report: Report; matches: boolean };
type StatusRead = { error: DispatchResult } | StatusOk;

const parseJson = (text: string): Report | undefined => {
  try {
    const value: unknown = JSON.parse(text.trim());
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Any intent or unreadable record blocks every mutation until an operator inspects it. */
const blocking = (journal: Journal) =>
  journal.malformed > 0 ||
  [...journal.records.values()].some((r) => r.malformed || r.state === "intent");

const isUncertain = (record: JournalRecord, kind: Kind) =>
  record.kind === kind &&
  record.state === "complete" &&
  record.outcome === "uncertain" &&
  record.resolution === undefined &&
  !record.malformed;

/** The one correlation allowed for an uncertain launch: an exited owner with its exact ID. */
const exitedWith = (report: Report | undefined, launchId: string | undefined) =>
  report !== undefined &&
  launchId !== undefined &&
  report.liveness === "exited" &&
  isObject(report.owner) &&
  report.owner.launchId === launchId;

/** The native status must describe this root's plan, import, run root, tool and limits. */
function hostMatches(root: RootConfig, report: Report): boolean {
  if (report.planFileSha256 !== root.planSha256 || report.importSha256 !== root.importSha256)
    return false;
  if (typeof report.runRoot !== "string" || !samePath(report.runRoot, root.runRoot)) return false;
  if (!isObject(report.owner) || report.owner.exeSha256 !== root.executableSha256) return false;
  const limits = report.limits;
  if (!isObject(limits)) return false;
  const names = Object.values(NATIVE_LIMITS);
  if (Object.keys(limits).sort().join() !== [...names].sort().join()) return false;
  return (Object.keys(NATIVE_LIMITS) as (keyof typeof NATIVE_LIMITS)[]).every(
    (key) => limits[NATIVE_LIMITS[key]] === root.limits[key]
  );
}

const IDLE_LAST_STATES = new Set(["blocked", ...RELAUNCH_STATES]);
/** The refusal code for a native host that must not be replaced, or undefined if it may be. */
function launchGate(report: Report): string | undefined {
  const liveness = report.liveness as Liveness;
  if (liveness === "running") return "OWNER_PRESENT";
  if (liveness === "unresponsive" || liveness === "owner_unverified") return "OWNER_UNVERIFIED";
  if (liveness === "owner_gone") {
    const idle =
      (report.current === null || report.current === undefined) &&
      typeof report.lastState === "string" &&
      IDLE_LAST_STATES.has(report.lastState);
    return idle ? undefined : "PREVIOUS_OWNER_UNCERTAIN";
  }
  return RELAUNCH_STATES.has(String(report.state)) ? undefined : "PREVIOUS_OWNER_UNCERTAIN";
}
