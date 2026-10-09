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

  /** Prepared interface: feature implementation is the supervised task. */
  async status(_rootId: string): Promise<DispatchResult> {
    return fail(503, "DISPATCH_UNIMPLEMENTED");
  }
  async launch(_rootId: string, _operationId: string): Promise<DispatchResult> {
    return fail(503, "DISPATCH_UNIMPLEMENTED");
  }
  async stop(_rootId: string, _operationId: string): Promise<DispatchResult> {
    return fail(503, "DISPATCH_UNIMPLEMENTED");
  }
}
