/**
 * Read-only development-coordination status from a Hekate managed plan.
 *
 *   HEKATE_PLAN_API_URL=http://127.0.0.1:5100 npx tsx scripts/devcoord.ts status --root <guid> [--json] [--check]
 *
 * It only reads. Output names states, identities and refusal codes; it never
 * prints response bodies, URLs with credentials, or raw errors.
 */
import {
  DevCoordinationError,
  fetchCoordinationStatus,
  type CoordinationStatus
} from "../src/integrations/hekate/devCoordination";

function usage(): never {
  console.error("usage: devcoord status --root <plan-root-guid> [--json] [--check]");
  process.exit(2);
}

// --check: 0 complete; 3 stuck, inconsistent or invalid; 4 work remains.
function checkExitCode(status: CoordinationStatus): number {
  if (status.status === "invalid") return 3;
  const state = status.progress.state;
  if (state === "complete") return 0;
  return state === "stuck" || state === "inconsistent" ? 3 : 4;
}

function render(status: CoordinationStatus): string {
  if (status.status === "invalid")
    return [
      `plan ${status.rootId}: invalid`,
      ...status.errors.map((e) => `  ${e.code}${e.nodeId ? ` (${e.nodeId})` : ""}`)
    ].join("\n");
  const p = status.progress;
  const ready = status.leaves.filter((l) => l.state === "ready").map((l) => l.name ?? l.nodeId);
  return [
    `plan ${status.rootId}: ${status.leaves.length} leaves (execution acknowledgement unknown)`,
    `  progress ${p.state} (root container ${p.rootCompletion}/${p.rootAcceptance})`,
    ...(ready.length ? [`  ready now: ${ready.join(", ")}`] : []),
    ...status.leaves.map((l) =>
      [
        `  ${l.state.padEnd(14)} ${l.nodeId} ${l.name ?? ""}`.trimEnd(),
        l.attemptId ? `attempt ${l.attemptId}#${l.attemptEpoch}` : "",
        l.attemptPins !== "none" ? `pins ${l.attemptPins}` : "",
        l.upstreamChanged ? "upstream changed" : "",
        l.gatesHold ? "" : "gates not holding",
        l.executorRef ? `executor ${l.executorRef}` : "",
        l.artifactRef ? `artifact ${l.artifactRef}` : "",
        l.acceptanceHistorical && l.acceptance
          ? `prior decision ${l.acceptance.decision}@${l.acceptance.attemptEpoch} (historical)`
          : "",
        ...l.blockers.map((b) => `blocked by ${b.predecessorName ?? b.predecessorId} (${b.reason})`)
      ]
        .filter(Boolean)
        .join("  ")
    )
  ].join("\n");
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "status") usage();
  const rootIndex = rest.indexOf("--root");
  const root = rootIndex >= 0 ? rest[rootIndex + 1] : undefined;
  const json = rest.includes("--json");
  const check = rest.includes("--check");
  const known = new Set(["--root", "--json", "--check", root]);
  if (!root || rest.some((arg) => !known.has(arg))) usage();
  try {
    const status = await fetchCoordinationStatus(process.env.HEKATE_PLAN_API_URL, root);
    console.log(json ? JSON.stringify(status, null, 2) : render(status));
    if (check) process.exitCode = checkExitCode(status);
  } catch (error) {
    if (error instanceof DevCoordinationError) {
      console.error(`devcoord: ${error.code}${error.status ? ` ${error.status}` : ""}`);
      process.exit(1);
    }
    console.error("devcoord: UNEXPECTED_ERROR");
    process.exit(1);
  }
}

void main(process.argv.slice(2));
