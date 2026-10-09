/**
 * Bounded, read-only recovery assessment of one Hekate plan node (doc 17).
 *
 *   HEKATE_PLAN_API_URL=http://127.0.0.1:5100 npx tsx scripts/assessRecovery.ts \
 *     --root <guid> --node <guid> --attempt <id|none> --epoch <n> --content <n> \
 *     [--launch-id <hex32>] [--host-status <file>] [--cycles 1..6] [--interval-ms 5000..60000] [--json]
 *   npx tsx scripts/assessRecovery.ts --replay <input.json> [--json]
 *
 * Live mode makes fresh GET observations through the same attempt-progress service the
 * server route uses (loopback plan API only; no token, cookie or browser state). Each
 * cycle is independent; another cycle runs only after a cycle that recommended
 * re-observation, never earlier than --interval-ms. The whole run has a 60 s deadline,
 * each observation gets only the time remaining, a late result is discarded, and the
 * process stops one second after the deadline even when a read has not returned.
 *
 * Replay mode reads one bounded recovery-assessment-input/v1 file, makes no request and
 * invokes nothing. The optional host status file is a supplied, unauthenticated
 * dispatch status body, reduced to an allowlist. Nothing is written to disk and no
 * model, shell or native executable is used. Output is fixed vocabulary, ids and integers.
 *
 * Exit codes: 0 only when the recommended action is none; 4 any other valid assessment;
 * 1 a refusal (including the deadline); 2 a usage error.
 */
import { open, type FileHandle } from "node:fs/promises";
import {
  ATTEMPT_PROGRESS_LIMITS,
  createAttemptProgressService
} from "../src/integrations/hekate/attemptProgress";
import { parseStrictJson } from "../src/integrations/hekate/devCoordination";
import {
  ASSESSMENT_LIMITS,
  assessRecovery,
  assessmentExitCode,
  extractAssessmentInput,
  extractHostInput,
  parseAssessmentInput,
  renderAssessment,
  type ExpectedFence,
  type HostInput,
  type RecoveryAssessment
} from "../src/integrations/hekate/recoveryAssessment";
import { createRoleObserver } from "../src/integrations/hekate/roleObservation";

const USAGE =
  "usage: assessRecovery --root <guid> --node <guid> --attempt <id|none> --epoch <n> --content <n> [--launch-id <hex32>] [--host-status <file>] [--cycles 1..6] [--interval-ms 5000..60000] [--json] | --replay <input.json> [--json]";

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

type RefusalCode =
  "DEADLINE" | "INPUT_UNREADABLE" | "INPUT_TOO_LARGE" | "INPUT_INVALID" | "OUTPUT_TOO_LARGE";

/** A refusal carries only its code, never a path, message or content. */
class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAUNCH_ID = /^[0-9a-f]{32}$/;
const ATTEMPT_ID = /^[\x21-\x7e]{1,200}$/;
const FLAGS_WITH_VALUE = new Set([
  "--root",
  "--node",
  "--attempt",
  "--epoch",
  "--content",
  "--launch-id",
  "--host-status",
  "--replay",
  "--cycles",
  "--interval-ms"
]);

const FENCE_FLAGS = ["--root", "--node", "--attempt", "--epoch", "--content", "--launch-id"];
const LIVE_ONLY_FLAGS = ["--host-status", "--cycles", "--interval-ms"];

interface Args {
  values: Map<string, string>;
  json: boolean;
}

function parse(argv: string[]): Args {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      if (json) usage();
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (!FLAGS_WITH_VALUE.has(flag) || value === undefined || values.has(flag)) usage();
    values.set(flag, value);
    i++;
  }
  return { values, json };
}

function whole(value: string | undefined, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) usage();
  return n;
}

function pattern(value: string | undefined, re: RegExp): string {
  if (value === undefined || !re.test(value)) usage();
  return value;
}

function fence(values: Map<string, string>): ExpectedFence {
  const attempt = values.get("--attempt");
  const launch = values.get("--launch-id");
  return {
    rootId: pattern(values.get("--root"), GUID),
    nodeId: pattern(values.get("--node"), GUID),
    attemptId: attempt === "none" ? null : pattern(attempt, ATTEMPT_ID),
    attemptEpoch: whole(values.get("--epoch"), 0, Number.MAX_SAFE_INTEGER),
    contentRevision: whole(values.get("--content"), 1, Number.MAX_SAFE_INTEGER),
    ...(launch === undefined ? {} : { launchId: pattern(launch, LAUNCH_ID) })
  };
}

/** One bounded read of a regular file: at most `max` bytes, nothing is written. */
async function readBounded(path: string, max: number): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new Refusal("INPUT_UNREADABLE");
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Refusal("INPUT_UNREADABLE");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > max) throw new Refusal("INPUT_TOO_LARGE");
    return buffer.subarray(0, length);
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal("INPUT_UNREADABLE");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readHost(path: string): Promise<HostInput> {
  const bytes = await readBounded(path, ASSESSMENT_LIMITS.maxInputBytes);
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = parseStrictJson(text);
  } catch {
    throw new Refusal("INPUT_INVALID");
  }
  const host = extractHostInput(parsed);
  if (!host.ok) throw new Refusal("INPUT_INVALID");
  return host.value;
}

function present(assessment: RecoveryAssessment, json: boolean) {
  console.log(json ? JSON.stringify(assessment) : renderAssessment(assessment));
}

/** Resolves with the work, or refuses at the deadline; a later result is discarded. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Refusal("DEADLINE")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function replay(args: Args): Promise<RecoveryAssessment> {
  const { values } = args;
  if (LIVE_ONLY_FLAGS.some((flag) => values.has(flag))) usage();
  const bytes = await readBounded(values.get("--replay")!, ASSESSMENT_LIMITS.maxInputBytes);
  const input = parseAssessmentInput(bytes);
  if (!input.ok) throw new Refusal("INPUT_INVALID");
  // Fence flags are optional with a replay, but must then agree with the recorded input.
  if (FENCE_FLAGS.some((flag) => values.has(flag))) {
    const supplied = fence(new Map([...values].filter(([flag]) => flag !== "--replay")));
    const recorded = input.value.expected;
    for (const key of Object.keys(supplied) as (keyof ExpectedFence)[])
      if (supplied[key] !== recorded[key]) usage();
    if (supplied.launchId === undefined && recorded.launchId !== undefined) usage();
  }
  const result = assessRecovery(input.value);
  if (!result.ok) throw new Refusal("OUTPUT_TOO_LARGE");
  return result.value;
}

async function live(args: Args, deadlineAt: number): Promise<RecoveryAssessment> {
  const { values } = args;
  const expected = fence(values);
  const cycles = whole(values.get("--cycles"), 1, ASSESSMENT_LIMITS.maxCycles, 1);
  const intervalMs = whole(
    values.get("--interval-ms"),
    ASSESSMENT_LIMITS.minIntervalMs,
    ASSESSMENT_LIMITS.maxIntervalMs,
    ASSESSMENT_LIMITS.minIntervalMs
  );
  const hostPath = values.get("--host-status");
  const host = hostPath === undefined ? undefined : await readHost(hostPath);

  const base = process.env.HEKATE_PLAN_API_URL;
  // The service validates the loopback URL; each observation gets only the time left.
  const service = createAttemptProgressService(base ?? "", {
    createObserver: () =>
      createRoleObserver(base, {
        ...ATTEMPT_PROGRESS_LIMITS.observer,
        timeoutMs: Math.max(
          1,
          Math.min(ATTEMPT_PROGRESS_LIMITS.observer.timeoutMs, deadlineAt - Date.now())
        )
      })
  });

  let last: RecoveryAssessment | undefined;
  for (let cycle = 0; cycle < cycles; cycle++) {
    if (cycle > 0) {
      if (Date.now() + intervalMs >= deadlineAt) break;
      await sleep(intervalMs);
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Refusal("DEADLINE");
    const response = await within(service.read(expected.rootId, expected.nodeId), remaining);
    const input = extractAssessmentInput({ expected, response, ...(host ? { host } : {}) });
    if (!input.ok) throw new Refusal("INPUT_INVALID");
    const result = assessRecovery(input.value);
    if (!result.ok) throw new Refusal("OUTPUT_TOO_LARGE");
    last = result.value;
    present(last, args.json);
    if (!["reobserve_then_escalate", "wait_and_reobserve"].includes(last.recommendation.action))
      break;
  }
  if (!last) throw new Refusal("DEADLINE");
  process.exitCode = assessmentExitCode(last);
  return last;
}

async function main(argv: string[]) {
  const args = parse(argv);
  const replaying = args.values.has("--replay");
  if (!replaying) fence(args.values);
  // One deadline covers every read; file I/O cannot be interrupted, so the process itself
  // stops shortly after it.
  const deadlineAt = Date.now() + ASSESSMENT_LIMITS.deadlineMs;
  const hardStop = setTimeout(() => {
    console.error("assessRecovery: DEADLINE");
    process.exit(1);
  }, ASSESSMENT_LIMITS.deadlineMs + ASSESSMENT_LIMITS.hardStopGraceMs);
  try {
    if (replaying) {
      const assessment = await replay(args);
      present(assessment, args.json);
      process.exitCode = assessmentExitCode(assessment);
    } else {
      await live(args, deadlineAt);
    }
  } catch (error) {
    console.error(`assessRecovery: ${error instanceof Refusal ? error.code : "UNEXPECTED_ERROR"}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
  }
}

void main(process.argv.slice(2));
