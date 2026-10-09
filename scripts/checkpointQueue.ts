/**
 * One-shot read-only durable checkpoint review ledger (doc 21).
 *
 *   npx tsx scripts/checkpointQueue.ts --manifest <file> --evaluate
 *   npx tsx scripts/checkpointQueue.ts --manifest <file> --show
 *
 * `--evaluate` reads the trusted manifest, fetches each distinct root once through the loopback
 * plan reader, reads the registered runner records and publishes one `<queueId>.queue.json`
 * generation under a cooperative exclusive lock. `--show` reads only the manifest and the retained
 * ledger and makes no API request and no write. Nothing is claimed, dispatched, accepted,
 * integrated, retried, sent or signalled, and the ledger is not a notification or a wake.
 *
 * Exit codes: 0 only when every entry is accepted; 1 an actionable or uncertain stored outcome;
 * 2 usage or configuration refusal; 4 ownership, ledger or publication failure. Refusals print a
 * closed code on stderr and never a path, manifest value or file content.
 */
import { pathToFileURL } from "node:url";
import {
  CONFIG_CODES,
  QueueError,
  describeLedger,
  evaluateQueue,
  loadManifest,
  showQueue,
  type EvaluateDeps,
  type QueueIo
} from "../src/integrations/hekate/checkpointQueue";

const USAGE = "usage: checkpointQueue --manifest <file> (--evaluate | --show)";

export interface QueueCliDeps extends EvaluateDeps {
  io?: Partial<QueueIo>;
}

export interface CliResult {
  exitCode: 0 | 1 | 2 | 4;
  stdout: string[];
  stderr: string[];
}

function parseArgs(
  argv: readonly string[]
): { manifest: string; mode: "evaluate" | "show" } | null {
  let manifest: string | undefined;
  let mode: "evaluate" | "show" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest" && manifest === undefined && argv[i + 1]) manifest = argv[++i];
    else if ((arg === "--evaluate" || arg === "--show") && mode === undefined)
      mode = arg === "--evaluate" ? "evaluate" : "show";
    else return null;
  }
  return manifest !== undefined && mode !== undefined ? { manifest, mode } : null;
}

export async function runQueueCli(
  argv: readonly string[],
  deps: QueueCliDeps = {}
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const args = parseArgs(argv);
  if (!args) return { exitCode: 2, stdout, stderr: [USAGE] };
  try {
    const loaded = await loadManifest(args.manifest, deps.io);
    if (args.mode === "show") {
      const ledger = await showQueue(loaded, { io: deps.io, deadlineMs: deps.deadlineMs });
      stdout.push(...describeLedger(ledger, "show"));
      return { exitCode: ledger.outcome === "all_accepted" ? 0 : 1, stdout, stderr };
    }
    const result = await evaluateQueue(loaded, deps);
    stdout.push(...describeLedger(result.ledger, "evaluate"));
    if (result.cleanup.length > 0) {
      stderr.push(`checkpointQueue: CLEANUP_INCOMPLETE ${result.cleanup.join(",")}`);
      return { exitCode: 4, stdout, stderr };
    }
    return { exitCode: result.ledger.outcome === "all_accepted" ? 0 : 1, stdout, stderr };
  } catch (error) {
    const code = error instanceof QueueError ? error.code : "WRITE_FAILED";
    stderr.push(`checkpointQueue: ${code}`);
    if (error instanceof QueueError && error.cleanup.length > 0)
      stderr.push(`checkpointQueue: CLEANUP_INCOMPLETE ${error.cleanup.join(",")}`);
    return {
      exitCode: error instanceof QueueError && CONFIG_CODES.includes(code) ? 2 : 4,
      stdout,
      stderr
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runQueueCli(process.argv.slice(2)).then((result) => {
    for (const line of result.stdout) console.log(line);
    for (const line of result.stderr) console.error(line);
    process.exitCode = result.exitCode;
  });
}
