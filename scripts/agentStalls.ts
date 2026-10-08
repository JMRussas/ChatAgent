/**
 * Read-only initial-response check for named bridge assignments (doc 15).
 *
 *   BRIDGE_URL=http://127.0.0.1:8791 BRIDGE_TOKEN=... npx tsx scripts/agentStalls.ts \
 *     --agent <role> --assignment <id> [--assignment <id> ...] [--threshold-min 15]
 *     [--deadline-s 30] [--transcript <path> --session <id>] [--json]
 *
 * It only reads, polls nothing and wakes nothing. Output is metadata only: ids, ages,
 * states and counts, never message or transcript text, and never the token.
 * Exit codes: 0 every assignment has an observed correlated reply or is within the
 * threshold; 4 any other state; 1 a refusal; 2 a usage error. One deadline covers
 * every read, and the process stops at --deadline-s plus one second even when a
 * filesystem read has not returned.
 */
import { classifyActivity, type ActivityReport } from "../src/integrations/bridge/activity";
import {
  BridgeReadError,
  MAX_ASSIGNMENTS,
  MAX_DEADLINE_MS,
  readAssignments
} from "../src/integrations/bridge/bridgeReader";
import { readTranscript, TranscriptReadError } from "../src/integrations/bridge/transcriptReader";

function usage(): never {
  console.error(
    "usage: agentStalls --agent <role> --assignment <id> [--assignment <id> ...] [--threshold-min <1-1440>] [--deadline-s <1-120>] [--transcript <path> --session <id>] [--json]"
  );
  process.exit(2);
}

interface Args {
  agent: string;
  assignments: string[];
  thresholdMin: number;
  deadlineS: number;
  transcript?: string;
  session?: string;
  json: boolean;
}

function parse(argv: string[]): Args {
  const out: Partial<Args> & { assignments: string[]; json: boolean } = {
    assignments: [],
    json: false
  };
  const int = (v: string | undefined, max: number) => {
    if (!v || !/^[1-9][0-9]{0,4}$/.test(v) || Number(v) > max) usage();
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--json":
        out.json = true;
        continue;
      case "--agent":
        if (!value || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || out.agent) usage();
        out.agent = value;
        break;
      case "--assignment":
        if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) usage();
        out.assignments.push(value);
        break;
      case "--threshold-min":
        out.thresholdMin = int(value, 1440);
        break;
      case "--deadline-s":
        out.deadlineS = int(value, MAX_DEADLINE_MS / 1000);
        break;
      case "--transcript":
        if (!value || out.transcript) usage();
        out.transcript = value;
        break;
      case "--session":
        if (!value || !/^[A-Za-z0-9-]{1,64}$/.test(value) || out.session) usage();
        out.session = value;
        break;
      default:
        usage();
    }
    i++;
  }
  if (
    !out.agent ||
    out.assignments.length === 0 ||
    out.assignments.length > MAX_ASSIGNMENTS ||
    new Set(out.assignments).size !== out.assignments.length ||
    Boolean(out.transcript) !== Boolean(out.session)
  )
    usage();
  return {
    agent: out.agent,
    assignments: out.assignments,
    thresholdMin: out.thresholdMin ?? 15,
    deadlineS: out.deadlineS ?? 30,
    json: out.json,
    ...(out.transcript ? { transcript: out.transcript, session: out.session } : {})
  };
}

function render(report: ActivityReport): string {
  return [
    `agent ${report.agent}  session ${report.session}`,
    ...report.assignments.map(
      (a) =>
        `  ${a.id}  ${a.state}` +
        (a.ageS === null ? "" : `  age ${a.ageS}s`) +
        (a.correlation
          ? `  via ${a.correlation.source}${a.correlation.kind ? ` ${a.correlation.kind}` : ""} (${a.correlation.attribution})`
          : "") +
        (a.uncorrelated ? `  uncorrelated ${a.uncorrelated}` : "") +
        (a.incomplete ? `  incomplete ${a.incomplete}` : "")
    )
  ].join("\n");
}

function exitCode(report: ActivityReport): number {
  return report.assignments.every(
    (a) => a.state === "correlated_reply_observed" || a.state === "within_threshold"
  )
    ? 0
    : 4;
}

/** The grace after the deadline before the process stops, for an in-flight check. */
const HARD_STOP_GRACE_MS = 1000;

async function main(argv: string[]) {
  const args = parse(argv);
  const deadlineMs = args.deadlineS * 1000;
  // One deadline covers the bridge and the transcript. The readers check it between
  // steps, but filesystem I/O cannot be interrupted, so the process itself stops at
  // the deadline rather than waiting for a read that has not returned.
  const deadline = AbortSignal.timeout(deadlineMs);
  const hardStop = setTimeout(() => {
    console.error("agentStalls: DEADLINE");
    process.exit(1);
  }, deadlineMs + HARD_STOP_GRACE_MS);
  try {
    const assignments = await readAssignments(
      process.env.BRIDGE_URL,
      process.env.BRIDGE_TOKEN,
      args.assignments,
      { deadline }
    );
    const transcript =
      args.transcript && args.session
        ? await readTranscript(args.transcript, args.session, { deadline })
        : undefined;
    const report = classifyActivity({
      agent: args.agent,
      ...(args.session ? { session: args.session } : {}),
      assignments,
      ...(transcript ? { transcript } : {}),
      nowMs: Date.now(),
      thresholdMs: args.thresholdMin * 60_000
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
    process.exitCode = exitCode(report);
  } catch (error) {
    if (error instanceof BridgeReadError || error instanceof TranscriptReadError) {
      console.error(`agentStalls: ${error.code}`);
      process.exit(1);
    }
    console.error("agentStalls: UNEXPECTED_ERROR");
    process.exit(1);
  } finally {
    clearTimeout(hardStop);
  }
}

void main(process.argv.slice(2));
