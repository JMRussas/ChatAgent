/**
 * Operator-triggered, supervised checkpoint run (doc 19).
 *
 *   npx tsx scripts/runCheckpoint.ts --input <checkpoint-run.json>
 *
 * The input file (at most 16 KiB, strict) is the only configuration: it pins the already
 * claimed Hekate task, the worker executable, the linked worktree, the prompt and Git. The
 * script claims, retries, accepts and integrates nothing; SIGINT/SIGTERM/SIGBREAK stop the
 * owned worker. It prints the public budget record only (never prompts, output or stderr).
 *
 * Exit codes: 0 observed zero worker exit (unverified); 1 worker, spawn or cleanup failure;
 * 2 refused or usage error; 3 tripwire or cancel; 4 record write failure. None is a gate.
 */
import { open } from "node:fs/promises";
import {
  CHECKPOINT_LIMITS,
  CheckpointRecordError,
  parseRunInput
} from "../src/checkpoint/checkpointRecord";
import { bindProcessSignals, runCheckpoint } from "../src/checkpoint/checkpointRun";

async function readInput(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new CheckpointRecordError("INPUT_INVALID");
    const buffer = Buffer.alloc(CHECKPOINT_LIMITS.maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CHECKPOINT_LIMITS.maxFileBytes)
      throw new CheckpointRecordError("INPUT_INVALID");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function main(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    console.error("usage: runCheckpoint --input <checkpoint-run.json>");
    process.exitCode = 2;
    return;
  }
  let input;
  try {
    input = parseRunInput(await readInput(argv[1]));
  } catch {
    console.error("runCheckpoint: INPUT_INVALID");
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const unbind = bindProcessSignals(controller);
  try {
    const result = await runCheckpoint(input, { signal: controller.signal });
    if (result.record) console.log(JSON.stringify(result.record));
    else console.error(`runCheckpoint: ${result.refusal ?? "RECORD_WRITE_FAILED"}`);
    process.exitCode = result.exitCode;
  } catch {
    console.error("runCheckpoint: UNEXPECTED_ERROR");
    process.exitCode = 1;
  } finally {
    unbind();
  }
}

void main(process.argv.slice(2));
