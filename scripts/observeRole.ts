/**
 * Bounded read-only observation of one Hekate plan node, as JSON snapshots.
 *
 *   npx tsx scripts/observeRole.ts --root <guid> --node <guid> [--base <url>] [--cycles 1] [--interval-ms 1000]
 *
 * The base defaults to HEKATE_PLAN_API_URL. Observations run serially, at most 20,
 * at least 250 ms apart (at most 60 s). It only issues GETs, prints one JSON snapshot
 * per line, and exits 1 on the first typed refusal. There is no indefinite monitor.
 */
import {
  createRoleObserver,
  RoleObservationError
} from "../src/integrations/hekate/roleObservation";

const MAX_CYCLES = 20;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;

function usage(): never {
  console.error(
    "usage: observeRole --root <guid> --node <guid> [--base <url>] [--cycles 1..20] [--interval-ms 250..60000]"
  );
  process.exit(2);
}

function wholeNumber(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const n = /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) usage();
  return n;
}

async function main(argv: string[]) {
  const values = new Map<string, string>();
  const known = new Set(["--root", "--node", "--base", "--cycles", "--interval-ms"]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.has(flag) || value === undefined || values.has(flag)) usage();
    values.set(flag, value);
  }
  const root = values.get("--root");
  const node = values.get("--node");
  if (!root || !node) usage();
  const cycles = wholeNumber(values.get("--cycles"), 1, 1, MAX_CYCLES);
  const intervalMs = wholeNumber(
    values.get("--interval-ms"),
    1_000,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS
  );
  try {
    const observer = createRoleObserver(values.get("--base") ?? process.env.HEKATE_PLAN_API_URL);
    for (let i = 0; i < cycles; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      console.log(JSON.stringify(await observer.observe(root, node)));
    }
  } catch (error) {
    if (error instanceof RoleObservationError) {
      console.error(`observeRole: ${error.code}${error.status ? ` ${error.status}` : ""}`);
      process.exit(1);
    }
    console.error("observeRole: UNEXPECTED_ERROR");
    process.exit(1);
  }
}

void main(process.argv.slice(2));
