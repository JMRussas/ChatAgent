/**
 * Read-only development-coordination status from a Hekate managed plan.
 *
 *   HEKATE_PLAN_API_URL=http://127.0.0.1:5100 npx tsx scripts/devcoord.ts status --root <guid> [--json]
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
  console.error("usage: devcoord status --root <plan-root-guid> [--json]");
  process.exit(2);
}

function render(status: CoordinationStatus): string {
  if (status.status === "invalid")
    return [
      `plan ${status.rootId}: invalid`,
      ...status.errors.map((e) => `  ${e.code}${e.nodeId ? ` (${e.nodeId})` : ""}`)
    ].join("\n");
  return [
    `plan ${status.rootId}: ${status.leaves.length} leaves (execution acknowledgement unknown)`,
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
        l.blockers.length ? `blockers ${l.blockers.length}` : ""
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
  const known = new Set(["--root", "--json", root]);
  if (!root || rest.some((arg) => !known.has(arg))) usage();
  try {
    const status = await fetchCoordinationStatus(process.env.HEKATE_PLAN_API_URL, root);
    console.log(json ? JSON.stringify(status, null, 2) : render(status));
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
