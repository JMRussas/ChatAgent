/**
 * Operator-triggered finite checkpoint continuation (doc 22).
 *
 *   npx tsx scripts/continueCheckpoint.ts --manifest <checkpoint-continuation-run.json>
 *
 * The manifest (at most 32 KiB, closed schema) is the only configuration. One process waits for
 * the maintained worker, snapshots declared source edits into an isolated candidate commit,
 * finishes that task attempt once, runs fixed external format, type and focused test checks and
 * stores a supplied gate. It never claims, releases, revises, decides, accepts, integrates,
 * retries, calls a model or notifies. The wall deadline starts at CLI entry, before the manifest
 * is read. It prints the public continuation record only, never prompts, output, paths or bodies.
 *
 * Exit codes: 0 stored review_pending with every check passed (never task acceptance); 1 stored
 * operator outcome; 2 input or preflight refusal; 4 persistence or cleanup failure.
 */
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  CONTINUATION_LIMITS,
  parseContinuationManifest,
  runContinuation,
  type ContinuationDeps
} from "../src/checkpoint/checkpointContinuation";
import { bindProcessSignals } from "../src/checkpoint/checkpointRun";

async function readManifest(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("INPUT_INVALID");
    const max = CONTINUATION_LIMITS.maxManifestBytes;
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new Error("INPUT_INVALID");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface CliResult {
  exitCode: 0 | 1 | 2 | 4;
  stdout: string[];
  stderr: string[];
}

export async function runContinuationCli(
  argv: readonly string[],
  deps: ContinuationDeps = {}
): Promise<CliResult> {
  const startMonotonic = deps.startMonotonic ?? performance.now();
  if (argv.length !== 2 || argv[0] !== "--manifest")
    return {
      exitCode: 2,
      stdout: [],
      stderr: ["usage: continueCheckpoint --manifest <checkpoint-continuation-run.json>"]
    };
  let manifest;
  try {
    manifest = parseContinuationManifest(await readManifest(argv[1]));
  } catch {
    return { exitCode: 2, stdout: [], stderr: ["continueCheckpoint: INPUT_INVALID"] };
  }
  try {
    const result = await runContinuation(manifest, { ...deps, startMonotonic });
    if (result.record)
      return { exitCode: result.exitCode, stdout: [JSON.stringify(result.record)], stderr: [] };
    return {
      exitCode: result.exitCode,
      stdout: [],
      stderr: [`continueCheckpoint: ${result.refusal ?? "RECORD_WRITE_FAILED"}`]
    };
  } catch {
    return { exitCode: 4, stdout: [], stderr: ["continueCheckpoint: UNEXPECTED_ERROR"] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = performance.now();
  const controller = new AbortController();
  const unbind = bindProcessSignals(controller);
  void runContinuationCli(process.argv.slice(2), {
    signal: controller.signal,
    startMonotonic: entry
  })
    .then((result) => {
      for (const line of result.stdout) console.log(line);
      for (const line of result.stderr) console.error(line);
      process.exitCode = result.exitCode;
    })
    .finally(unbind);
}
