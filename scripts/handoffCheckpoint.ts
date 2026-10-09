/**
 * One-shot durable local handoff of checkpoint attention items (doc 20).
 *
 *   npx tsx scripts/handoffCheckpoint.ts --out-dir <absolute dir>
 *   npx tsx scripts/handoffCheckpoint.ts --show <file>
 *
 * Write mode reads the same environment as the server (HEKATE_PLAN_API_URL,
 * HEKATE_EXECUTIVE_OVERVIEW, HEKATE_EXECUTIVE_ROOTS_JSON, HEKATE_CHECKPOINT_RECORDS_JSON), collects
 * the overview twice through the existing loopback GETs and registered file reads, and writes one
 * `<handoffId>.handoff.json` only when both reads agree on every pinned field. The file is local
 * durable storage: it is not a notification, a wake, a delivery or an acknowledgment, and the
 * two reads are observational and not atomic. Publication writes a temp file in the target
 * directory, then creates the final name with a no-overwrite hard link; an existing target is
 * never modified. Nothing is signalled, spawned, sent or retried.
 *
 * Exit codes: 0 written, or nothing to hand off, or --show parsed; 1 refused (pin changed, read
 * unavailable, deadline, invalid out-dir, oversize, unparseable file); 2 usage; 4 write failed.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ATTENTION_LIMITS,
  HandoffError,
  buildHandoff,
  parseHandoff,
  pinOf,
  serializeHandoff,
  type Attention,
  type HandoffRecord
} from "../src/integrations/hekate/checkpointAttention";
import { loadCheckpointRecordsConfig } from "../src/config/checkpointRecordsConfig";
import { loadExecutiveOverviewConfig } from "../src/config/executiveOverviewConfig";
import {
  collectExecutiveOverview,
  type ExecutiveOverview
} from "../src/integrations/hekate/executiveOverview";

const USAGE = "usage: handoffCheckpoint --out-dir <absolute dir> | --show <file>";
export const HANDOFF_DEADLINE_MS = 20_000;

export type HandoffRefusal =
  | "NOT_CONFIGURED"
  | "READ_UNAVAILABLE"
  | "PIN_CHANGED"
  | "ITEMS_OMITTED"
  | "DEADLINE"
  | "OUT_DIR_INVALID"
  | "TOO_LARGE"
  | "FILE_UNREADABLE"
  | "FILE_INVALID";

/** A refusal carries only its code, never a path, message or record content. */
class Refusal extends Error {
  constructor(readonly code: HandoffRefusal) {
    super(code);
  }
}

export class PublishError extends Error {
  constructor(readonly code: "OUT_DIR_INVALID" | "TARGET_EXISTS" | "WRITE_FAILED") {
    super(code);
  }
}

export interface PublishIo {
  lstat: typeof lstat;
  realpath: typeof realpath;
  open: typeof open;
  link: typeof link;
  unlink: typeof unlink;
}
const REAL_IO: PublishIo = { lstat, realpath, open, link, unlink };

const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export const handoffPath = (outDir: string, handoffId: string) =>
  join(outDir, `${handoffId}.handoff.json`);

/**
 * Publishes `text` as the final name without ever replacing a file: a checked-then-renamed target
 * could be replaced by a racing creator, so the final name is created with a hard link, which
 * fails if it exists. No link support means a refusal, never a fallback to overwrite. Directory
 * sync and power-loss safety are not claimed.
 */
export async function publishHandoff(
  outDir: string,
  handoffId: string,
  text: string,
  io: PublishIo = REAL_IO
): Promise<string> {
  if (!isAbsolute(outDir) || resolve(outDir) !== outDir) throw new PublishError("OUT_DIR_INVALID");
  try {
    const info = await io.lstat(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PublishError("OUT_DIR_INVALID");
    if (!same(await io.realpath(outDir), outDir)) throw new PublishError("OUT_DIR_INVALID");
  } catch (error) {
    throw error instanceof PublishError ? error : new PublishError("OUT_DIR_INVALID");
  }
  const target = handoffPath(outDir, handoffId);
  const temp = join(outDir, `.${handoffId}.${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    const handle = await io.open(temp, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.link(temp, target);
    return target;
  } catch (error) {
    throw new PublishError(
      (error as NodeJS.ErrnoException).code === "EEXIST" && created
        ? "TARGET_EXISTS"
        : "WRITE_FAILED"
    );
  } finally {
    if (created) await io.unlink(temp).catch(() => undefined);
  }
}

export interface HandoffDeps {
  collect?: (signalMs: number) => Promise<ExecutiveOverview>;
  now?: () => Date;
  monotonicMs?: () => number;
  newId?: () => string;
  io?: PublishIo;
  deadlineMs?: number;
}

export interface CliResult {
  exitCode: 0 | 1 | 2 | 4;
  stdout: string[];
  stderr: string[];
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Refusal("DEADLINE")), Math.max(1, ms));
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

function attentionOf(overview: ExecutiveOverview): Attention {
  if (!overview.attention) throw new Refusal("READ_UNAVAILABLE");
  return overview.attention;
}

function unavailableRoots(overview: ExecutiveOverview): Map<string, string> {
  return new Map(
    overview.roots.filter((r) => r.status !== "ok").map((r) => [r.rootId, r.reason ?? r.status])
  );
}

function describe(record: HandoffRecord): string[] {
  const lines = [
    `handoff ${record.handoffId} created ${record.createdAt} (local CLI clock)`,
    `items ${record.items.length}, omitted ${record.omitted}, registered records unavailable ${record.registeredRecordsUnavailable}`,
    "delivery not_sent; notification none; wake none; acknowledgment none",
    "fences were observed at capture; they are not current state"
  ];
  for (const item of record.items)
    lines.push(
      `${item.kind} root ${item.rootId} task ${item.nodeId} run ${item.runId} stop ${item.stop.kind}/${item.stop.code} attempt ${item.fence.attemptId} epoch ${item.fence.attemptEpoch} content ${item.fence.contentRevision} action ${item.action}` +
        (item.rootPid === null ? "" : ` recorded-pid-descriptor ${item.rootPid}`)
    );
  return lines;
}

async function show(path: string, io: PublishIo): Promise<string[]> {
  const max = ATTENTION_LIMITS.maxHandoffBytes;
  let buffer: Buffer;
  try {
    const info = await io.lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Refusal("FILE_UNREADABLE");
    if (info.size > max) throw new Refusal("TOO_LARGE");
    const handle = await io.open(path, "r");
    try {
      buffer = Buffer.alloc(max + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      buffer = buffer.subarray(0, length);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal("FILE_UNREADABLE");
  }
  const parsed = parseHandoff(buffer);
  if (!parsed.ok) throw new Refusal(parsed.reason === "too_large" ? "TOO_LARGE" : "FILE_INVALID");
  return describe(parsed.value);
}

async function write(
  outDir: string,
  env: NodeJS.ProcessEnv,
  deps: HandoffDeps,
  out: string[]
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const mono = deps.monotonicMs ?? (() => performance.now());
  const deadlineMs = deps.deadlineMs ?? HANDOFF_DEADLINE_MS;
  const started = mono();
  const remaining = () => deadlineMs - (mono() - started);

  if (!isAbsolute(outDir) || resolve(outDir) !== outDir) throw new Refusal("OUT_DIR_INVALID");

  let collect = deps.collect;
  if (!collect) {
    let roots;
    let registry;
    try {
      roots = loadExecutiveOverviewConfig(env)?.roots;
      registry = roots ? loadCheckpointRecordsConfig(env, true) : undefined;
    } catch {
      throw new Refusal("NOT_CONFIGURED");
    }
    const planApiUrl = env.HEKATE_PLAN_API_URL;
    if (!roots || !registry || !planApiUrl) throw new Refusal("NOT_CONFIGURED");
    collect = (ms) =>
      collectExecutiveOverview(planApiUrl, roots, {
        checkpointRecords: registry,
        overallDeadlineMs: Math.max(1, Math.min(ms, 8_000))
      });
  }

  const read = async () => {
    if (remaining() <= 0) throw new Refusal("DEADLINE");
    const overview = await within(collect(remaining()), remaining());
    return { overview, attention: attentionOf(overview) };
  };

  const first = await read();
  if (first.attention.items.length === 0) {
    if (first.attention.omitted > 0) throw new Refusal("ITEMS_OMITTED");
    out.push("no attention items (not a health statement); nothing written");
    const down = unavailableRoots(first.overview);
    for (const [rootId, reason] of down)
      out.push(`root ${rootId} unavailable (${reason}); not covered`);
    out.push(`registered records unavailable: ${first.attention.registeredRecordsUnavailable}`);
    return;
  }

  const second = await read();
  const affected = new Set([
    ...first.attention.items.map((i) => i.rootId),
    ...second.attention.items.map((i) => i.rootId)
  ]);
  for (const view of [first.overview, second.overview])
    for (const rootId of unavailableRoots(view).keys())
      if (affected.has(rootId)) throw new Refusal("READ_UNAVAILABLE");
  if (
    pinOf(first.attention.items) !== pinOf(second.attention.items) ||
    first.attention.omitted !== second.attention.omitted
  )
    throw new Refusal("PIN_CHANGED");

  const handoffId = (deps.newId ?? randomUUID)();
  const record = buildHandoff({
    handoffId,
    createdAt: now().toISOString(),
    overviewGeneratedAt: first.overview.generatedAt,
    attention: first.attention
  });
  let text: string;
  try {
    text = serializeHandoff(record);
  } catch (error) {
    throw new Refusal(
      error instanceof HandoffError && error.code === "TOO_LARGE" ? "TOO_LARGE" : "FILE_INVALID"
    );
  }
  // Every collection, deadline and size check completes before anything is created.
  if (remaining() <= 0) throw new Refusal("DEADLINE");
  const path = await publishHandoff(outDir, handoffId, text, deps.io);
  out.push(`handoff written locally; not sent: ${path}`);
  out.push(
    `items ${record.items.length}, omitted ${record.omitted}, itemsSha256 ${record.itemsSha256}`
  );
}

export async function runHandoffCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: HandoffDeps = {}
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const done = (exitCode: CliResult["exitCode"], error?: string): CliResult => {
    if (error) stderr.push(`handoffCheckpoint: ${error}`);
    return { exitCode, stdout, stderr };
  };
  if (argv.length !== 2 || !["--out-dir", "--show"].includes(argv[0]) || argv[1] === "") {
    stderr.push(USAGE);
    return done(2);
  }
  try {
    if (argv[0] === "--show") stdout.push(...(await show(argv[1], deps.io ?? REAL_IO)));
    else await write(argv[1], env, deps, stdout);
    return done(0);
  } catch (error) {
    if (error instanceof Refusal) return done(1, error.code);
    if (error instanceof PublishError)
      return done(error.code === "OUT_DIR_INVALID" ? 1 : 4, error.code);
    return done(1, "UNEXPECTED_ERROR");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runHandoffCli(process.argv.slice(2), process.env).then((result) => {
    for (const line of result.stdout) console.log(line);
    for (const line of result.stderr) console.error(line);
    process.exitCode = result.exitCode;
  });
}
