/**
 * Operator-triggered bounded checkpoint queue (doc 26).
 *
 *   npx tsx scripts/runCheckpointQueue.ts --manifest <checkpoint-queue-service-manifest.json> --arm
 *
 * Exactly one of `--arm` (start a new queue), `--resume` (continue a cleanly stopped queue),
 * `--stop` (create this queue's stop sentinel) or `--show` (read retained metadata only, no plan
 * API request, no mutation). The manifest (at most 32 KiB, closed schema) is the only
 * configuration. It never claims globally, decides, revises, merges, deploys, notifies or retries.
 * It prints the queue record only: never prompts, raw output, paths or credentials. Actor strings
 * are supplied, not authenticated, and writer liveness is unknown.
 *
 * Exit codes: 0 every item accepted (or stop/show succeeded); 1 stored needs_operator; 2 input or
 * preflight refusal; 3 cleanly stopped and resumable; 4 persistence, lock or cleanup failure.
 */
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { bindProcessSignals } from "../src/checkpoint/checkpointRun";
import {
  requestQueueStop,
  runQueueService,
  showQueue,
  type QueueDeps
} from "../src/checkpoint/checkpointQueueService";
import { QUEUE_LIMITS } from "../src/checkpoint/checkpointQueueState";

const USAGE =
  "usage: runCheckpointQueue --manifest <checkpoint-queue-service-manifest.json> --arm|--resume|--stop|--show";
const COMMANDS = ["--arm", "--resume", "--stop", "--show"] as const;

async function readManifest(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("INPUT_INVALID");
    const max = QUEUE_LIMITS.maxManifestBytes;
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new Error("INPUT_INVALID");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface CliResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  stdout: string[];
  stderr: string[];
}

export async function runQueueCli(
  argv: readonly string[],
  deps: QueueDeps = {}
): Promise<CliResult> {
  const startMonotonic = deps.startMonotonic ?? performance.now();
  const command = COMMANDS.find((flag) => flag === argv[2]);
  if (argv.length !== 3 || argv[0] !== "--manifest" || !command)
    return { exitCode: 2, stdout: [], stderr: [USAGE] };
  let bytes: Buffer;
  try {
    bytes = await readManifest(argv[1]);
  } catch {
    return { exitCode: 2, stdout: [], stderr: ["runCheckpointQueue: INPUT_INVALID"] };
  }
  try {
    if (command === "--show")
      return { exitCode: 0, stdout: [JSON.stringify(await showQueue(bytes))], stderr: [] };
    if (command === "--stop") {
      await requestQueueStop(bytes);
      return { exitCode: 0, stdout: ['{"stopRequested":true}'], stderr: [] };
    }
    const result = await runQueueService(bytes, command === "--arm" ? "arm" : "resume", {
      ...deps,
      startMonotonic
    });
    return {
      exitCode: result.exitCode,
      stdout: result.record ? [JSON.stringify(result.record)] : [],
      stderr: result.refusal ? [`runCheckpointQueue: ${result.refusal}`] : []
    };
  } catch {
    return { exitCode: 2, stdout: [], stderr: ["runCheckpointQueue: INPUT_INVALID"] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = performance.now();
  const controller = new AbortController();
  const unbind = bindProcessSignals(controller);
  void runQueueCli(process.argv.slice(2), { signal: controller.signal, startMonotonic: entry })
    .then((result) => {
      for (const line of result.stdout) console.log(line);
      for (const line of result.stderr) console.error(line);
      process.exitCode = result.exitCode;
    })
    .finally(unbind);
}
