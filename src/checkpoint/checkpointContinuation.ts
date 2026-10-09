import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  fetchCoordinationStatus,
  planApiBase,
  type LeafStatus
} from "../integrations/hekate/devCoordination";
import { processTreeTerminator, type ProcessTreeTerminator } from "../providers/cli/runner";
import { runCheckpoint, type CheckpointDeps, type RunResult } from "./checkpointRun";
import {
  CHECKPOINT_LIMITS,
  GATE_CHECK_RESULTS,
  GATE_SCHEMA,
  budgetRecordPath,
  deriveGateOutcome,
  gateRecordPath,
  gateRecordSchema,
  parseBoundedJson,
  runInputSchema,
  type GateRecord,
  type RunInput
} from "./checkpointRecord";

/**
 * Finite checkpoint verification continuation (doc 22). One operator-invoked process owns one
 * already claimed coding checkpoint: it reserves a cooperative lease, runs the existing fixed
 * worker runner once, snapshots only operator-declared source edits into an isolated candidate
 * commit, issues one finish-only PlanStore transition, then runs fixed external Prettier,
 * TypeScript and Vitest processes and stores a supplied gate. It ends at `review_pending` or
 * `needs_operator`. It never claims, releases, revises, decides, accepts, integrates, retries,
 * calls a model, notifies or supervises beyond its own lifetime. Records are supplied evidence,
 * not authenticated authority, and fixed tooling execution is host-owned, not a sandbox.
 */

export const CONTINUATION_MANIFEST_SCHEMA = "checkpoint-continuation-run/v1";
export const CONTINUATION_RECORD_SCHEMA = "checkpoint-continuation/v1";

export const CONTINUATION_LIMITS = {
  maxManifestBytes: 32 * 1024,
  maxRecordBytes: 16 * 1024,
  maxFiles: 24,
  maxFocusedTests: 8,
  maxPathChars: 240,
  maxWallMs: 1_800_000,
  maxVerifierWallMs: 600_000,
  maxVerifierOutputBytes: 4 * 1024 * 1024,
  reservedMs: 30_000,
  gitTimeoutMs: 10_000,
  gitOutputBytes: 256 * 1024,
  maxGitEntries: 1000,
  authorityTimeoutMs: 4_000,
  authorityMaxBytes: 2 * 1024 * 1024,
  finishTimeoutMs: 10_000,
  finishResponseBytes: 64 * 1024,
  closeGraceMs: 10_000,
  leaseBytes: 512
} as const;

/** Fixed tooling entry paths, resolved only from the linked worktree. */
export const TOOLING_ENTRIES = {
  prettier: "node_modules/prettier/bin/prettier.cjs",
  typescript: "node_modules/typescript/lib/_tsc.js",
  vitest: "node_modules/vitest/vitest.mjs"
} as const;
export const CHECK_NAMES = ["prettier", "typescript", "vitest"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

const FINISH_ACTOR = "checkpoint-continuation";
const COMMIT_MESSAGE = "checkpoint: candidate snapshot";
const SOURCE_ROOTS = ["src", "scripts", "tests", "docs"];

// ----- schemas -----

const safe = (min = 0) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);
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

/** Relative, forward-slash, printable ASCII, no dot segments or Git metadata. */
export function validRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > CONTINUATION_LIMITS.maxPathChars) return false;
  if (!/^[\x21-\x7e]+$/.test(path) || /[\\:*?[\]]/.test(path) || path.startsWith("-")) return false;
  const segments = path.split("/");
  if (segments.length < 2 || !SOURCE_ROOTS.includes(segments[0])) return false;
  return segments.every((segment) => {
    const lower = segment.toLowerCase();
    return (
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !lower.startsWith(".git") &&
      lower !== "node_modules" &&
      !segment.endsWith(".")
    );
  });
}

const sourcePath = z.string().refine(validRelativePath);
const focusedPath = z
  .string()
  .refine(
    (path) => validRelativePath(path) && path.startsWith("tests/") && path.endsWith(".test.ts")
  );
const unique = (values: string[]) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;

export const continuationManifestSchema = z
  .object({
    schema: z.literal(CONTINUATION_MANIFEST_SCHEMA),
    run: runInputSchema,
    files: z.array(sourcePath).min(1).max(CONTINUATION_LIMITS.maxFiles).refine(unique),
    focusedTests: z
      .array(focusedPath)
      .min(1)
      .max(CONTINUATION_LIMITS.maxFocusedTests)
      .refine(unique),
    nodeExecutable: z.object({ path: absolutePath, sha256 }).strict(),
    toolingSha256: z.object({ prettier: sha256, typescript: sha256, vitest: sha256 }).strict(),
    limits: z
      .object({
        wallMs: safe(1).max(CONTINUATION_LIMITS.maxWallMs),
        verifierWallMs: safe(1).max(CONTINUATION_LIMITS.maxVerifierWallMs),
        verifierOutputBytes: safe(1).max(CONTINUATION_LIMITS.maxVerifierOutputBytes)
      })
      .strict()
  })
  .strict()
  .refine((m) => m.run.profile === "coding")
  .refine(
    (m) =>
      m.limits.wallMs > m.run.hard.wallMs + m.limits.verifierWallMs + CONTINUATION_LIMITS.reservedMs
  );
export type ContinuationManifest = z.infer<typeof continuationManifestSchema>;

export const CONTINUATION_PHASES = [
  "reserved",
  "running",
  "snapshotting",
  "verifying",
  "review_pending",
  "needs_operator"
] as const;
export const CONTINUATION_REASONS = [
  "in_progress",
  "checks_passed",
  "worker_not_clean",
  "authority_changed",
  "authority_unavailable",
  "scope_violation",
  "no_source_change",
  "snapshot_failed",
  "finish_conflict",
  "finish_uncertain",
  "finish_unconfirmed",
  "check_failed",
  "check_unavailable",
  "source_changed",
  "deadline_exceeded",
  "cancelled",
  "cleanup_failed",
  "gate_write_failed",
  "lease_changed",
  "internal_error"
] as const;
export type ContinuationReason = (typeof CONTINUATION_REASONS)[number];
export const FINISH_STATES = [
  "not_attempted",
  "attempted",
  "confirmed",
  "conflict",
  "uncertain"
] as const;

const exitCodeSchema = z.number().int().min(-2147483648).max(2147483647).nullable();
const signalSchema = z
  .string()
  .regex(/^SIG[A-Z0-9]{1,12}$/)
  .nullable();

const checkSchema = z
  .object({
    name: z.enum(CHECK_NAMES),
    result: z.enum(GATE_CHECK_RESULTS),
    ran: z.boolean(),
    exitCode: exitCodeSchema,
    signal: signalSchema,
    timedOut: z.boolean(),
    outputLimited: z.boolean(),
    outputBytes: safe(),
    outputSha256: sha256.nullable(),
    startedAt: timestamp.nullable(),
    endedAt: timestamp.nullable()
  })
  .strict();
export type CheckResult = z.infer<typeof checkSchema>;

const workerSchema = z
  .object({
    stop: z
      .object({
        kind: z.string().regex(/^[a-z_]{1,16}$/),
        code: z.string().regex(/^[a-z_]{1,32}$/)
      })
      .strict(),
    exit: z.object({ code: exitCodeSchema, signal: signalSchema }).strict().nullable(),
    consumed: z
      .object({
        units: safe(),
        wallMs: safe(),
        outputBytes: safe(),
        counterState: z.enum(["exact_observed", "lower_bound"])
      })
      .strict(),
    providerReported: z
      .object({
        numTurns: safe().nullable(),
        costUsd: z.number().finite().min(0).max(1_000_000_000).nullable(),
        status: z.literal("unverified")
      })
      .strict()
  })
  .strict();

export const continuationRecordSchema = z
  .object({
    schema: z.literal(CONTINUATION_RECORD_SCHEMA),
    runId: guid,
    identity: z
      .object({
        rootId: guid,
        nodeId: guid,
        attemptId: token,
        attemptEpoch: safe(),
        contentRevision: safe(1),
        observedStateRevision: safe(),
        executorRef: token
      })
      .strict(),
    baseRef: gitRef,
    phase: z.enum(CONTINUATION_PHASES),
    reason: z.enum(CONTINUATION_REASONS),
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp.nullable(),
    sourceRef: gitRef.nullable(),
    worker: workerSchema.nullable(),
    finish: z.enum(FINISH_STATES),
    checkRole: z.literal("mimir_external_checks"),
    checks: z.array(checkSchema).max(CHECK_NAMES.length),
    gate: z.enum(["not_written", "written"]),
    failureAttribution: z.literal("unattributed"),
    leadAcceptance: z.literal("pending"),
    semanticReview: z.literal("not_performed"),
    delivery: z.literal("not_sent"),
    wake: z.literal("none"),
    acknowledgment: z.literal("none"),
    recordTrust: z.literal("supplied_not_authenticated"),
    writerLiveness: z.literal("unknown")
  })
  .strict()
  .refine(
    (r) => (r.phase === "review_pending" || r.phase === "needs_operator") === (r.endedAt !== null)
  )
  .refine((r) => {
    if (r.phase === "review_pending")
      return (
        r.reason === "checks_passed" &&
        r.gate === "written" &&
        r.checks.length === CHECK_NAMES.length &&
        r.checks.every((c) => c.result === "pass")
      );
    if (r.phase === "needs_operator")
      return r.reason !== "in_progress" && r.reason !== "checks_passed";
    return r.reason === "in_progress" && r.gate === "not_written";
  });
export type ContinuationRecord = z.infer<typeof continuationRecordSchema>;

export class ContinuationRecordError extends Error {
  constructor(readonly code: "INPUT_INVALID" | "RECORD_INVALID" | "RECORD_TOO_LARGE") {
    super(code);
    this.name = "ContinuationRecordError";
  }
}

type ParseOutcome<T> =
  { ok: true; value: T } | { ok: false; reason: "invalid" | "unsupported_schema" };

function parseClosed<T>(
  bytes: Uint8Array,
  family: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  maxBytes: number
): ParseOutcome<T> {
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "invalid" };
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    );
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const named =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { schema?: unknown }).schema
      : undefined;
  if (typeof named === "string" && named.startsWith(family) && !named.endsWith("/v1"))
    return { ok: false, reason: "unsupported_schema" };
  const checked = schema.safeParse(parsed);
  return checked.success ? { ok: true, value: checked.data } : { ok: false, reason: "invalid" };
}

/** Throws a code-only error: the manifest is trusted configuration and never echoed back. */
export function parseContinuationManifest(bytes: Uint8Array): ContinuationManifest {
  const result = parseClosed(
    bytes,
    "checkpoint-continuation-run/",
    continuationManifestSchema,
    CONTINUATION_LIMITS.maxManifestBytes
  );
  if (!result.ok) throw new ContinuationRecordError("INPUT_INVALID");
  return result.value;
}

export const parseContinuationRecord = (bytes: Uint8Array) =>
  parseClosed(
    bytes,
    "checkpoint-continuation/",
    continuationRecordSchema,
    CONTINUATION_LIMITS.maxRecordBytes
  );

export function serializeContinuationRecord(record: ContinuationRecord): string {
  const checked = continuationRecordSchema.safeParse(record);
  if (!checked.success) throw new ContinuationRecordError("RECORD_INVALID");
  const text = `${JSON.stringify(checked.data)}\n`;
  if (Buffer.byteLength(text, "utf8") > CONTINUATION_LIMITS.maxRecordBytes)
    throw new ContinuationRecordError("RECORD_TOO_LARGE");
  return text;
}

/** The attempt fence hash shared with the runner's claim lease namespace. */
export const claimKeyOf = (identity: RunInput["identity"]) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        identity.rootId,
        identity.nodeId,
        identity.attemptId,
        identity.attemptEpoch,
        identity.contentRevision
      ])
    )
    .digest("hex");

export const continuationRecordPath = (dir: string, runId: string) =>
  join(dir, `${runId}.continuation.json`);
export const continuationLeasePath = (dir: string, claimKey: string) =>
  join(dir, `.continuation-${claimKey}.lease`);
const runnerClaimPath = (dir: string, claimKey: string) => join(dir, `.claim-${claimKey}.lease`);

// ----- Git output parsing -----

export interface StatusEntry {
  x: string;
  y: string;
  path: string;
}
export interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  status: string;
  path: string;
}
export interface ChangedFile {
  path: string;
  deleted: boolean;
}

const strictText = (bytes: Uint8Array) => {
  if (bytes.byteLength > CONTINUATION_LIMITS.gitOutputBytes) throw new Error("GIT_OUTPUT");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
};

/** `git status --porcelain=v1 -z --no-renames`: `XY path` records, NUL-terminated. */
export function parseStatusZ(bytes: Uint8Array): StatusEntry[] {
  const text = strictText(bytes);
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("GIT_OUTPUT");
  const parts = text.slice(0, -1).split("\0");
  if (parts.length > CONTINUATION_LIMITS.maxGitEntries) throw new Error("GIT_OUTPUT");
  return parts.map((entry) => {
    if (entry.length < 4 || entry[2] !== " ") throw new Error("GIT_OUTPUT");
    return { x: entry[0], y: entry[1], path: entry.slice(3) };
  });
}

/** `git diff --raw -z --no-renames --no-abbrev`: `:old new oldsha newsha S` then the path. */
export function parseRawDiffZ(bytes: Uint8Array): RawDiffEntry[] {
  const text = strictText(bytes);
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("GIT_OUTPUT");
  const parts = text.slice(0, -1).split("\0");
  if (parts.length % 2 !== 0 || parts.length / 2 > CONTINUATION_LIMITS.maxGitEntries)
    throw new Error("GIT_OUTPUT");
  const out: RawDiffEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([ADMT])$/.exec(parts[i]);
    if (!match || parts[i + 1] === "") throw new Error("GIT_OUTPUT");
    out.push({ oldMode: match[1], newMode: match[2], status: match[3], path: parts[i + 1] });
  }
  return out;
}

const REGULAR_MODES = new Set(["000000", "100644", "100755"]);

// ----- fixed command profiles -----

/** Arguments after the Node executable. Nothing here is input-controlled except declared paths. */
export function checkArguments(
  name: CheckName,
  existingChanged: readonly string[],
  focusedTests: readonly string[]
): string[] {
  const entry = TOOLING_ENTRIES[name];
  switch (name) {
    case "prettier":
      return [entry, "--check", "--ignore-unknown", ...existingChanged];
    case "typescript":
      return [entry, "--project", "tsconfig.json", "--noEmit"];
    case "vitest":
      return [entry, "run", "--maxWorkers=1", ...focusedTests];
  }
}

const ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL"
];
/** An allowlisted environment: no credentials, Git variables or NODE_OPTIONS reach children. */
const childEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    ENV_ALLOW.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  ),
  CI: "1",
  NO_COLOR: "1"
});

// ----- owned child processes -----

export interface OwnedResult {
  launchFailed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimited: boolean;
  aborted: boolean;
  cleanupFailed: boolean;
  outputBytes: number;
  outputSha256: string;
  stdout: Buffer;
}

interface OwnedOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  capture: boolean;
  signal: AbortSignal;
  terminator: ProcessTreeTerminator;
  closeGraceMs: number;
}

/**
 * One shell-free child with bounded time and output. Output is hashed as it streams and discarded
 * unless `capture` (Git plumbing only). A still-running tree is terminated through the owned
 * terminator and awaited; cleanup is reported clean only after the root actually closed.
 */
export async function runOwned(
  file: string,
  args: readonly string[],
  options: OwnedOptions
): Promise<OwnedResult> {
  const hash = createHash("sha256");
  const parts: Buffer[] = [];
  let bytes = 0;
  const result = (over: Partial<OwnedResult>): OwnedResult => ({
    launchFailed: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    outputLimited: false,
    aborted: false,
    cleanupFailed: false,
    outputBytes: bytes,
    outputSha256: hash.copy().digest("hex"),
    stdout: Buffer.concat(parts),
    ...over
  });
  if (options.signal.aborted) return result({ aborted: true });
  let child: ChildProcess;
  try {
    child = spawn(file, [...args], {
      cwd: options.cwd,
      env: childEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    return result({ launchFailed: true });
  }
  let closed = false;
  let launchFailed = false;
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  let why: "timeout" | "output" | "abort" | undefined;
  let requestStop: () => void = () => {};
  const stopRequested = new Promise<void>((r) => {
    requestStop = r;
  });
  const closedPromise = new Promise<void>((r) => {
    child.on("close", (code, signal) => {
      closed = true;
      exit = { code, signal };
      r();
    });
    child.on("error", () => {
      if (child.pid === undefined) {
        launchFailed = true;
        closed = true;
        r();
      }
    });
  });
  const stop = (reason: "timeout" | "output" | "abort") => {
    why ??= reason;
    requestStop();
  };
  const onData = (chunk: Buffer) => {
    const room = options.maxOutputBytes - bytes;
    const taken = chunk.subarray(0, Math.max(0, room));
    bytes += taken.length;
    hash.update(taken);
    if (options.capture && taken.length > 0) parts.push(Buffer.from(taken));
    if (chunk.length > taken.length) stop("output");
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", (chunk: Buffer) => {
    const room = options.maxOutputBytes - bytes;
    const taken = chunk.subarray(0, Math.max(0, room));
    bytes += taken.length;
    hash.update(taken);
    if (chunk.length > taken.length) stop("output");
  });
  const onAbort = () => stop("abort");
  options.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), Math.max(0, options.timeoutMs));
  await Promise.race([closedPromise, stopRequested]);
  clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);
  let cleanupFailed = false;
  if (!closed) {
    try {
      await options.terminator.terminate(child);
    } catch {
      cleanupFailed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* the root may already be gone */
      }
    }
    await Promise.race([closedPromise, delay(options.closeGraceMs, undefined, { ref: false })]);
    if (!closed) cleanupFailed = true;
  }
  return result({
    launchFailed,
    exitCode: launchFailed ? null : exit.code,
    signal: exit.signal,
    timedOut: why === "timeout",
    outputLimited: why === "output",
    aborted: why === "abort",
    cleanupFailed
  });
}

// ----- file helpers -----

const sameResolved = (a: string, b: string) => {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
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

/** Absolute canonical regular file whose bytes match the pin. */
async function pinnedExecutable(pin: { path: string; sha256: string }): Promise<boolean> {
  try {
    if (!isAbsolute(pin.path) || !sameResolved(await realpath(pin.path), pin.path)) return false;
    if (!(await stat(pin.path)).isFile()) return false;
    return (await sha256OfFile(pin.path)) === pin.sha256;
  } catch {
    return false;
  }
}

/** A tooling entry must be a regular, non-symlink file whose bytes match the pin. */
async function pinnedEntry(path: string, expected: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && (await sha256OfFile(path)) === expected;
  } catch {
    return false;
  }
}

async function readSmall(path: string, max: number): Promise<Buffer> {
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

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  );

/** `file` for a regular entry, `absent` if missing, `unsafe` for symlinks and non-regular parents. */
export async function entryState(cwd: string, path: string): Promise<"file" | "absent" | "unsafe"> {
  const segments = path.split("/");
  let current = cwd;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
    }
    if (info.isSymbolicLink()) return "unsafe";
    if (i === segments.length - 1) return info.isFile() ? "file" : "unsafe";
    if (!info.isDirectory()) return "unsafe";
  }
  return "unsafe";
}

// ----- authority -----

/** The exact claimed identity and dependency authority, required in every state. */
function holdsIdentity(leaf: LeafStatus | undefined, input: RunInput): leaf is LeafStatus {
  return (
    leaf !== undefined &&
    leaf.attemptPins === "current" &&
    leaf.attemptId === input.identity.attemptId &&
    leaf.attemptEpoch === input.identity.attemptEpoch &&
    leaf.contentRevision === input.identity.contentRevision &&
    leaf.executorRef === input.identity.executorRef &&
    leaf.gatesHold &&
    !leaf.upstreamChanged
  );
}

function matchesLeaf(leaf: LeafStatus | undefined, input: RunInput, startRevision: boolean) {
  return (
    holdsIdentity(leaf, input) &&
    leaf.state === "in_progress" &&
    (!startRevision || leaf.stateRevision === input.identity.stateRevision)
  );
}

function matchesFinished(leaf: LeafStatus | undefined, input: RunInput, candidate: string) {
  return (
    holdsIdentity(leaf, input) && leaf.state === "review_pending" && leaf.artifactRef === candidate
  );
}

export interface FinishRequest {
  url: string;
  body: string;
  timeoutMs: number;
}
export type FinishPost = (request: FinishRequest) => Promise<{ status: number }>;

/** One bounded POST; the response body is drained to a cap and discarded. */
export const defaultFinishPost: FinishPost = async ({ url, body, timeoutMs }) => {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", accept: "application/json" },
    body
  });
  const reader = response.body?.getReader();
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CONTINUATION_LIMITS.finishResponseBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    /* the status was already observed; the body is never used */
  }
  return { status: response.status };
};

/** The exact finish-only transition body; the key binds this run to this candidate. */
export function finishRequestBody(
  input: RunInput,
  candidate: string,
  stateRevision: number
): string {
  return JSON.stringify({
    to: "done",
    rootId: input.identity.rootId,
    attemptId: input.identity.attemptId,
    attemptEpoch: input.identity.attemptEpoch,
    artifactRef: candidate,
    expectedStateRevision: stateRevision,
    actor: FINISH_ACTOR,
    operationKey: createHash("sha256").update(`${input.runId}:${candidate}`).digest("hex")
  });
}

// ----- gate -----

export function buildGate(
  record: ContinuationRecord,
  claimKey: string,
  recordedAt: string
): GateRecord {
  const checks = record.checks.map((c) => ({ name: c.name, result: c.result }));
  const failed = record.checks.some((c) => c.result !== "pass");
  const reason = failed
    ? record.checks.some((c) => c.result === "unavailable")
      ? "check_unavailable"
      : "check_failed"
    : "checks_passed";
  return {
    schema: GATE_SCHEMA,
    runId: record.runId,
    identity: {
      rootId: record.identity.rootId,
      nodeId: record.identity.nodeId,
      attemptId: record.identity.attemptId,
      attemptEpoch: record.identity.attemptEpoch,
      contentRevision: record.identity.contentRevision
    },
    sourceRef: record.sourceRef!,
    suppliedBy: "lead",
    recordedAt,
    evidenceRefs: [
      `continuation-run:${record.runId}`,
      `continuation:${reason}`,
      `fence:${claimKey.slice(0, 16)}`,
      `source:${record.sourceRef}`,
      "role:mimir-external-checks",
      "semantic-review:not-performed"
    ],
    checks,
    failureAttribution: "unattributed",
    outcome: deriveGateOutcome(checks)
  };
}

// ----- coordinator -----

export type ContinuationRefusal =
  | "record_dir_invalid"
  | "run_exists"
  | "lease_exists"
  | "pin_mismatch"
  | "worktree_invalid"
  | "worktree_dirty"
  | "source_invalid"
  | "authority_mismatch"
  | "authority_unavailable"
  | "deadline_exceeded"
  | "cancelled"
  | "cleanup_failed";

export interface ContinuationResult {
  /** 0 stored review_pending; 1 stored operator outcome; 2 refusal; 4 persistence/cleanup failure. */
  exitCode: 0 | 1 | 2 | 4;
  record: ContinuationRecord | null;
  refusal?: ContinuationRefusal;
}

export interface ContinuationDeps {
  fetchStatus?: typeof fetchCoordinationStatus;
  post?: FinishPost;
  /** Test seam, unreachable from the script: defaults to the unchanged `runCheckpoint`. */
  runWorker?: (input: RunInput, deps: CheckpointDeps) => Promise<RunResult>;
  workerDeps?: CheckpointDeps;
  terminator?: ProcessTreeTerminator;
  signal?: AbortSignal;
  closeGraceMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  /** Monotonic CLI entry time, so manifest reading consumes the shared deadline. */
  startMonotonic?: number;
}

class Stop extends Error {
  constructor(readonly reason: ContinuationReason) {
    super(reason);
  }
}
class Refusal extends Error {
  constructor(readonly code: ContinuationRefusal) {
    super(code);
  }
}
class PersistenceFailure extends Error {}

const PERSISTENCE_REASONS = new Set<ContinuationReason>([
  "cleanup_failed",
  "gate_write_failed",
  "lease_changed"
]);

const blankCheck = (name: CheckName): CheckResult => ({
  name,
  result: "unavailable",
  ran: false,
  exitCode: null,
  signal: null,
  timedOut: false,
  outputLimited: false,
  outputBytes: 0,
  outputSha256: null,
  startedAt: null,
  endedAt: null
});

export async function runContinuation(
  manifest: ContinuationManifest,
  deps: ContinuationDeps = {}
): Promise<ContinuationResult> {
  const input = manifest.run;
  const now = deps.now ?? Date.now;
  const mono = deps.monotonicNow ?? (() => performance.now());
  const expiresAt = (deps.startMonotonic ?? mono()) + manifest.limits.wallMs;
  const remaining = () => expiresAt - mono();
  const terminator = deps.terminator ?? processTreeTerminator;
  const fetchStatus = deps.fetchStatus ?? fetchCoordinationStatus;
  const post = deps.post ?? defaultFinishPost;
  const closeGraceMs = deps.closeGraceMs ?? CONTINUATION_LIMITS.closeGraceMs;
  const iso = (ms: number) => new Date(ms).toISOString();
  const claimKey = claimKeyOf(input.identity);

  const abort = new AbortController();
  const onSignal = () => abort.abort();
  deps.signal?.addEventListener("abort", onSignal, { once: true });
  if (deps.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), Math.max(0, remaining()));
  const stopReason = (): ContinuationReason | null =>
    deps.signal?.aborted
      ? "cancelled"
      : remaining() <= 0 || abort.signal.aborted
        ? "deadline_exceeded"
        : null;
  const live = () => {
    const reason = stopReason();
    if (reason) throw new Stop(reason);
  };

  let cwd = "";
  let recordDir = "";
  let gitPath = input.gitExecutable.path;
  let reserved = false;
  let candidate: string | null = null;
  let changes: ChangedFile[] = [];
  const startedAt = iso(now());
  let state: ContinuationRecord = {
    schema: CONTINUATION_RECORD_SCHEMA,
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
    phase: "reserved",
    reason: "in_progress",
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    sourceRef: null,
    worker: null,
    finish: "not_attempted",
    checkRole: "mimir_external_checks",
    checks: [],
    gate: "not_written",
    failureAttribution: "unattributed",
    leadAcceptance: "pending",
    semanticReview: "not_performed",
    delivery: "not_sent",
    wake: "none",
    acknowledgment: "none",
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown"
  };
  const set = (patch: Partial<ContinuationRecord>) => {
    state = { ...state, ...patch };
  };
  let leaseToken = "";

  const verifyLease = async () => {
    try {
      const bytes = await readSmall(
        continuationLeasePath(recordDir, claimKey),
        CONTINUATION_LIMITS.leaseBytes
      );
      const lease = JSON.parse(bytes.toString("utf8")) as { runId?: unknown; token?: unknown };
      if (lease.runId === input.runId && lease.token === leaseToken) return;
    } catch {
      /* fall through */
    }
    throw new Stop("lease_changed");
  };

  /** Atomic publish through this instance's exclusive temp file; the lease is checked first. */
  const publish = async (patch: Partial<ContinuationRecord>, final = false) => {
    const terminal = patch.phase === "review_pending" || patch.phase === "needs_operator";
    const stamp = iso(now());
    set({ ...patch, updatedAt: stamp, endedAt: terminal ? stamp : null });
    if (!final) live();
    let text: string;
    try {
      text = serializeContinuationRecord(state);
    } catch {
      throw new PersistenceFailure();
    }
    const finalPath = continuationRecordPath(recordDir, input.runId);
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
      // Lease and liveness are rechecked after the awaited write, immediately before the rename.
      await verifyLease();
      if (!final) live();
      try {
        await rename(temp, finalPath);
      } catch {
        throw new PersistenceFailure();
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  };

  // ----- bounded owned Git -----
  const noHooks = () => join(recordDir, `.no-hooks-${claimKey.slice(0, 16)}`);
  const git = async (args: readonly string[], capture = true, mutates = false): Promise<Buffer> => {
    // A mutation rechecks the lease, then liveness synchronously before the process starts.
    if (mutates) await verifyLease();
    live();
    const result = await runOwned(
      gitPath,
      [
        "-C",
        cwd,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${noHooks()}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=ChatAgent Checkpoint",
        "-c",
        "user.email=checkpoint@invalid",
        "--literal-pathspecs",
        ...args
      ],
      {
        cwd,
        timeoutMs: Math.min(CONTINUATION_LIMITS.gitTimeoutMs, remaining()),
        maxOutputBytes: CONTINUATION_LIMITS.gitOutputBytes,
        capture,
        signal: abort.signal,
        terminator,
        closeGraceMs
      }
    );
    if (result.cleanupFailed) throw new Stop("cleanup_failed");
    live();
    if (result.launchFailed || result.timedOut || result.outputLimited || result.exitCode !== 0)
      throw new Stop("snapshot_failed");
    return result.stdout;
  };
  const head = async () => (await git(["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  const statusEntries = async () =>
    parseStatusZ(
      await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
    );

  const readLeaf = async (timeoutMs: number): Promise<LeafStatus | undefined> => {
    live();
    const status = await fetchStatus(input.planApiUrl, input.identity.rootId, {
      timeoutMs: Math.max(1, Math.min(timeoutMs, remaining())),
      maxBytes: CONTINUATION_LIMITS.authorityMaxBytes
    });
    live();
    // Unavailable authority throws; a readable status without this leaf is a mismatch.
    if (status.status !== "ok") throw new Error("AUTHORITY_UNAVAILABLE");
    return status.leaves.find((l) => l.nodeId === input.identity.nodeId);
  };

  const declared = new Set(manifest.files);

  // ----- preflight: nothing is created until every check passes -----
  const preflight = async () => {
    live();
    try {
      recordDir = await realpath(input.recordDir);
      const tree = await realpath(input.worktree);
      if (!(await stat(recordDir)).isDirectory() || inside(tree, recordDir))
        throw new Refusal("record_dir_invalid");
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal("record_dir_invalid");
    }
    if (
      (await exists(budgetRecordPath(recordDir, input.runId))) ||
      (await exists(gateRecordPath(recordDir, input.runId))) ||
      (await exists(continuationRecordPath(recordDir, input.runId)))
    )
      throw new Refusal("run_exists");
    if (
      (await exists(continuationLeasePath(recordDir, claimKey))) ||
      (await exists(runnerClaimPath(recordDir, claimKey)))
    )
      throw new Refusal("lease_exists");
    if (
      !(await pinnedExecutable(manifest.nodeExecutable)) ||
      !(await pinnedExecutable(input.gitExecutable))
    )
      throw new Refusal("pin_mismatch");
    try {
      cwd = await realpath(input.worktree);
      // A linked worktree has a `.git` file; the main checkout has a directory.
      if (!(await lstat(join(cwd, ".git"))).isFile()) throw new Refusal("worktree_invalid");
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal("worktree_invalid");
    }
    for (const name of CHECK_NAMES)
      if (!(await pinnedEntry(toolPath(name), manifest.toolingSha256[name])))
        throw new Refusal("pin_mismatch");
    for (const path of manifest.files)
      if ((await entryState(cwd, path)) === "unsafe") throw new Refusal("source_invalid");
    live();
    try {
      if ((await head()).toLowerCase() !== input.identity.baseRef)
        throw new Refusal("pin_mismatch");
      if ((await statusEntries()).length > 0) throw new Refusal("worktree_dirty");
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (error instanceof Stop && error.reason !== "snapshot_failed") throw error;
      throw new Refusal("worktree_invalid");
    }
    let leaf: LeafStatus | undefined;
    try {
      leaf = await readLeaf(CONTINUATION_LIMITS.authorityTimeoutMs);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Refusal("authority_unavailable");
    }
    if (!matchesLeaf(leaf, input, true)) throw new Refusal("authority_mismatch");
  };
  const toolPath = (name: CheckName) => join(cwd, ...TOOLING_ENTRIES[name].split("/"));

  // Exclusive cooperative reservation: lease first, then the record, both before any worker.
  const reserve = async () => {
    leaseToken = randomBytes(16).toString("hex");
    let lease;
    try {
      lease = await open(continuationLeasePath(recordDir, claimKey), "wx");
      await lease.writeFile(
        JSON.stringify({
          schema: "checkpoint-continuation-lease/v1",
          runId: input.runId,
          token: leaseToken
        })
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refusal("lease_exists");
      throw new PersistenceFailure();
    } finally {
      await lease?.close().catch(() => undefined);
    }
    reserved = true;
    let handle;
    try {
      handle = await open(continuationRecordPath(recordDir, input.runId), "wx");
      await handle.writeFile(serializeContinuationRecord(state), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refusal("run_exists");
      throw new PersistenceFailure();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const workerSummary = (record: NonNullable<RunResult["record"]>) => ({
    stop: { kind: record.stop.kind, code: record.stop.code },
    exit: record.exit,
    consumed: {
      units: record.consumed.units,
      wallMs: record.consumed.wallMs,
      outputBytes: record.consumed.outputBytes,
      counterState: record.consumed.counterState
    },
    providerReported: { ...record.providerReported }
  });

  const runWorkerStep = async () => {
    await publish({ phase: "running" });
    const runWorker = deps.runWorker ?? runCheckpoint;
    const result = await runWorker(input, { ...deps.workerDeps, signal: abort.signal });
    if (result.record) set({ worker: workerSummary(result.record) });
    const observed = stopReason();
    if (observed) throw new Stop(observed);
    const record = result.record;
    if (record?.stop.kind === "failed" && record.stop.code === "cleanup_failed")
      throw new Stop("cleanup_failed");
    if (
      result.exitCode !== 0 ||
      !record ||
      record.state !== "ended" ||
      record.stop.kind !== "exited" ||
      record.exit?.code !== 0 ||
      record.exit.signal !== null
    )
      throw new Stop("worker_not_clean");
  };

  const collectChanges = async (): Promise<ChangedFile[]> => {
    const entries = await statusEntries();
    const diff = parseRawDiffZ(
      await git(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "HEAD"])
    );
    if (entries.length === 0) throw new Stop("no_source_change");
    const found = new Set<string>();
    const out: ChangedFile[] = [];
    for (const entry of entries) {
      const kind = `${entry.x}${entry.y}`;
      if (!["??", " M", " D"].includes(kind) || !declared.has(entry.path) || found.has(entry.path))
        throw new Stop("scope_violation");
      found.add(entry.path);
      const deleted = kind === " D";
      const onDisk = await entryState(cwd, entry.path);
      if (onDisk === "unsafe" || (deleted ? onDisk !== "absent" : onDisk !== "file"))
        throw new Stop("scope_violation");
      out.push({ path: entry.path, deleted });
    }
    for (const entry of diff)
      if (
        !found.has(entry.path) ||
        !REGULAR_MODES.has(entry.oldMode) ||
        !REGULAR_MODES.has(entry.newMode)
      )
        throw new Stop("scope_violation");
    return out;
  };

  const sameSet = (paths: readonly string[], expected: readonly string[]) =>
    paths.length === expected.length &&
    [...paths].sort().join("\0") === [...expected].sort().join("\0");

  const snapshotStep = async () => {
    await publish({ phase: "snapshotting" });
    let leaf: LeafStatus | undefined;
    try {
      leaf = await readLeaf(CONTINUATION_LIMITS.authorityTimeoutMs);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop("authority_unavailable");
    }
    if (!matchesLeaf(leaf, input, false)) throw new Stop("authority_changed");
    if ((await head()).toLowerCase() !== input.identity.baseRef) throw new Stop("source_changed");
    changes = await collectChanges();
    const paths = changes.map((c) => c.path);
    if (!(await pinnedExecutable(input.gitExecutable))) throw new Stop("snapshot_failed");
    await git(["add", "-A", "--", ...paths], false, true);
    const staged = parseRawDiffZ(
      await git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"])
    );
    if (
      !sameSet(
        staged.map((e) => e.path),
        paths
      ) ||
      staged.some((e) => !REGULAR_MODES.has(e.oldMode) || !REGULAR_MODES.has(e.newMode))
    )
      throw new Stop("scope_violation");
    await git(
      ["commit", "--no-verify", "--no-gpg-sign", "--quiet", "-m", COMMIT_MESSAGE],
      false,
      true
    );
    const sha = (await head()).toLowerCase();
    if (!gitRef.safeParse(sha).success || sha === input.identity.baseRef)
      throw new Stop("snapshot_failed");
    candidate = sha;
    set({ sourceRef: sha });
    const parent = (await git(["rev-parse", "--verify", "HEAD^"])).toString("utf8").trim();
    const committed = parseRawDiffZ(
      await git([
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        "--no-abbrev",
        "HEAD"
      ])
    );
    if (
      parent.toLowerCase() !== input.identity.baseRef ||
      !sameSet(
        committed.map((e) => e.path),
        paths
      ) ||
      (await statusEntries()).length > 0
    )
      throw new Stop("snapshot_failed");
    await publish({ sourceRef: sha });
  };

  const finishStep = async (sha: string) => {
    let leaf: LeafStatus | undefined;
    try {
      leaf = await readLeaf(CONTINUATION_LIMITS.authorityTimeoutMs);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop("authority_unavailable");
    }
    if (!matchesLeaf(leaf, input, false)) throw new Stop("authority_changed");
    const body = finishRequestBody(input, sha, leaf!.stateRevision);
    const url = `${planApiBase(input.planApiUrl)}/api/plan-contract/v1/nodes/${input.identity.nodeId}/transition`;
    // The attempt is durable before the only mutation: a crash can never be replayed as unsent.
    await publish({ finish: "attempted" });
    // Recheck after the awaited publish; a stop here leaves the attempt recorded, never rolled back.
    await verifyLease();
    live();
    let status: number;
    try {
      status = (
        await post({
          url,
          body,
          timeoutMs: Math.max(1, Math.min(CONTINUATION_LIMITS.finishTimeoutMs, remaining()))
        })
      ).status;
    } catch {
      set({ finish: "uncertain" });
      throw new Stop(stopReason() ?? "finish_uncertain");
    }
    if (status === 409) {
      set({ finish: "conflict" });
      throw new Stop("finish_conflict");
    }
    if (status < 200 || status >= 300) {
      set({ finish: "uncertain" });
      throw new Stop("finish_uncertain");
    }
    set({ finish: "uncertain" });
    live();
    let confirmed: LeafStatus | undefined;
    try {
      confirmed = await readLeaf(CONTINUATION_LIMITS.authorityTimeoutMs);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop("finish_unconfirmed");
    }
    if (!matchesFinished(confirmed, input, sha)) throw new Stop("finish_unconfirmed");
    set({ finish: "confirmed" });
  };

  const hashesHold = async (name: CheckName) =>
    (await pinnedExecutable(manifest.nodeExecutable)) &&
    (await pinnedEntry(toolPath(name), manifest.toolingSha256[name]));

  const verifyStep = async () => {
    const checks = CHECK_NAMES.map(blankCheck);
    await publish({ phase: "verifying", checks });
    const verifierEnd = mono() + manifest.limits.verifierWallMs;
    const existingChanged = changes.filter((c) => !c.deleted).map((c) => c.path);
    let outputUsed = 0;
    let stopped = false;
    for (let i = 0; i < CHECK_NAMES.length; i++) {
      const name = CHECK_NAMES[i];
      live();
      if (stopped) continue;
      if (name === "prettier" && existingChanged.length === 0) {
        // Deletion-only change: nothing exists to format. Recorded as not run, never as run.
        checks[i] = { ...checks[i], result: "pass" };
        await publish({ checks });
        continue;
      }
      const budgetMs = Math.min(verifierEnd - mono(), remaining());
      const outputLeft = manifest.limits.verifierOutputBytes - outputUsed;
      if (budgetMs <= 0 || outputLeft <= 0) {
        checks[i] = { ...checks[i], timedOut: budgetMs <= 0, outputLimited: outputLeft <= 0 };
        stopped = true;
        await publish({ checks });
        continue;
      }
      if (!(await hashesHold(name))) {
        stopped = true;
        continue;
      }
      await verifyLease();
      live();
      const began = iso(now());
      const result = await runOwned(
        manifest.nodeExecutable.path,
        checkArguments(name, existingChanged, manifest.focusedTests),
        {
          cwd,
          timeoutMs: Math.min(verifierEnd - mono(), remaining()),
          maxOutputBytes: outputLeft,
          capture: false,
          signal: abort.signal,
          terminator,
          closeGraceMs
        }
      );
      outputUsed += result.outputBytes;
      const interrupted =
        result.launchFailed || result.timedOut || result.outputLimited || result.aborted;
      checks[i] = {
        name,
        result: interrupted ? "unavailable" : result.exitCode === 0 ? "pass" : "fail",
        ran: !result.launchFailed,
        exitCode: result.exitCode,
        signal: result.signal && /^SIG[A-Z0-9]{1,12}$/.test(result.signal) ? result.signal : null,
        timedOut: result.timedOut,
        outputLimited: result.outputLimited,
        outputBytes: result.outputBytes,
        outputSha256: result.launchFailed ? null : result.outputSha256,
        startedAt: began,
        endedAt: iso(now())
      };
      set({ checks });
      if (result.cleanupFailed) throw new Stop("cleanup_failed");
      if (interrupted) stopped = true;
      await publish({ checks });
    }
    live();
  };

  const gateStep = async (sha: string) => {
    live();
    let leaf: LeafStatus | undefined;
    try {
      leaf = await readLeaf(CONTINUATION_LIMITS.authorityTimeoutMs);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop("authority_unavailable");
    }
    if (!matchesFinished(leaf, input, sha)) throw new Stop("authority_changed");
    if ((await head()).toLowerCase() !== sha || (await statusEntries()).length > 0)
      throw new Stop("source_changed");
    live();
    const gate = buildGate(state, claimKey, iso(now()));
    const parsed = gateRecordSchema.safeParse(gate);
    if (!parsed.success) throw new Stop("gate_write_failed");
    const text = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(text, "utf8") > CHECKPOINT_LIMITS.maxFileBytes)
      throw new Stop("gate_write_failed");
    const finalPath = gateRecordPath(recordDir, input.runId);
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
        throw new Stop("gate_write_failed");
      }
      // Lease and liveness are rechecked after the awaited write, immediately before the link.
      await verifyLease();
      live();
      try {
        await link(temp, finalPath);
      } catch {
        throw new Stop("gate_write_failed");
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    const passed = parsed.data.outcome === "checks_passed";
    // The gate is durable, so a stop observed now is recorded with it as needs_operator: only a
    // failed-check record is final; review_pending is never published after a stop.
    await publish(
      passed
        ? { phase: "review_pending", reason: "checks_passed", gate: "written" }
        : {
            phase: "needs_operator",
            reason: state.checks.some((c) => c.result === "unavailable")
              ? "check_unavailable"
              : "check_failed",
            gate: "written"
          },
      !passed
    );
  };

  try {
    await preflight();
    await reserve();
    await runWorkerStep();
    await snapshotStep();
    await finishStep(candidate!);
    await verifyStep();
    await gateStep(candidate!);
    return { exitCode: state.phase === "review_pending" ? 0 : 1, record: state };
  } catch (error) {
    if (error instanceof Refusal) return { exitCode: 2, record: null, refusal: error.code };
    if (error instanceof PersistenceFailure)
      return { exitCode: 4, record: reserved ? state : null };
    const reason: ContinuationReason = error instanceof Stop ? error.reason : "internal_error";
    if (!reserved) {
      if (reason === "cleanup_failed")
        return { exitCode: 4, record: null, refusal: "cleanup_failed" };
      if (reason === "deadline_exceeded" || reason === "cancelled")
        return { exitCode: 2, record: null, refusal: reason };
      return { exitCode: 2, record: null, refusal: "worktree_invalid" };
    }
    try {
      await publish({ phase: "needs_operator", reason }, true);
    } catch {
      return { exitCode: 4, record: state };
    }
    return { exitCode: PERSISTENCE_REASONS.has(reason) ? 4 : 1, record: state };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onSignal);
  }
}
