import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

// `devcoord status --check`: an OPT-IN exit code that reflects plan progress, so a script can wait on
// a plan without parsing output. 0 complete; 3 stuck, inconsistent or an invalid plan (operator
// attention); 4 work remains (active, awaiting review or ready). The printed status is unchanged, and
// without --check the exit codes are unchanged. The CLI runs as a subprocess against a loopback server
// serving captured plan-run views (tests/fixtures/hekate/PROVENANCE.md), never modified.
const DIR = "tests/fixtures/hekate/plan-run-v0";
const manifest = JSON.parse(readFileSync(`${DIR}/MANIFEST.json`, "utf8"));
const view = (state: string) => readFileSync(`${DIR}/${state}.plan.raw.json`, "utf8");
const rootOf = (state: string) => manifest.states[state].root as string;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
const serve = async (status: number, body: string) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const devcoord = (args: string[], url: string) =>
  new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/devcoord.ts", ...args],
      { env: { ...process.env, HEKATE_PLAN_API_URL: url } },
      (error, stdout, stderr) =>
        resolve({ exit: error ? (error.code as number) : 0, stdout, stderr })
    );
  });
const run = async (state: string, extra: string[], body = view(state)) =>
  devcoord(["status", "--root", rootOf(state), ...extra], await serve(200, body));

describe("devcoord status --check", () => {
  it.each([
    ["S5", "complete", 0],
    ["S3", "stuck (rejected predecessor)", 3],
    ["S6", "stuck (stale predecessor)", 3],
    ["S1", "active", 4],
    ["S2", "awaiting review", 4]
  ] as const)("%s (%s) exits %i and prints the unchanged status", async (state, _label, exit) => {
    const checked = await run(state, ["--check"]);
    const plain = await run(state, []);
    expect(checked.exit).toBe(exit);
    expect(checked.stderr).toBe("");
    expect(checked.stdout).toBe(plain.stdout);
  });

  it("exits 3 for a plan whose root container and leaves disagree", async () => {
    const v = JSON.parse(view("S5"));
    v.readiness.containers.find((c: { nodeId: string }) => c.nodeId === rootOf("S5")).acceptance =
      "pending";
    expect((await run("S5", ["--check"], JSON.stringify(v))).exit).toBe(3);
  });

  it("exits 4 for a plan whose progress is ready, never as complete", async () => {
    // The captured C1a body (tests/fixtures/hekate/c1-plan-status.raw.json), with its in-progress
    // and review-pending leaves cancelled (node and leaf, as devCoordination.test.ts's synthetic
    // states do): one leaf ready, one accepted, two cancelled, so the plan's progress is "ready".
    const C1_ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
    const v = JSON.parse(readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8"));
    for (const id of [
      "49262a8f-dcae-4e0e-a900-9a1870d38ecb",
      "be0e3cab-738e-4cfb-bb2a-49fa2196a9ba"
    ]) {
      v.nodes.find((n: { id: string }) => n.id === id).work = "cancelled";
      v.readiness.leaves.find((l: { nodeId: string }) => l.nodeId === id).work = "cancelled";
    }
    const url = await serve(200, JSON.stringify(v));
    const plain = await devcoord(["status", "--root", C1_ROOT], url);
    const checked = await devcoord(["status", "--root", C1_ROOT, "--check"], url);
    expect(plain.stdout).toContain("  progress ready (root container incomplete/pending)");
    expect(checked.exit).toBe(4);
    expect(checked.stdout).toBe(plain.stdout);
    expect(checked.stderr).toBe(plain.stderr);
  });

  it("exits 3 for an invalid plan", async () => {
    const v = JSON.parse(view("S1"));
    v.readiness.errors.push({ code: "invalid_graph", message: "x", nodeId: null, relatedId: null });
    const result = await run("S1", ["--check"], JSON.stringify(v));
    expect(result.exit).toBe(3);
    expect(result.stdout).toContain(": invalid");
  });

  it("combines with --json: the same JSON, with the progress exit code", async () => {
    const checked = await run("S3", ["--check", "--json"]);
    const plain = await run("S3", ["--json"]);
    expect(checked.exit).toBe(3);
    expect(JSON.parse(checked.stdout)).toEqual(JSON.parse(plain.stdout));
  });

  it("leaves the exit code unchanged without --check", async () => {
    for (const state of ["S1", "S3", "S5"]) expect((await run(state, [])).exit).toBe(0);
  });

  it("keeps refusals at 1 and usage errors at 2 with --check", async () => {
    const missing = await serve(404, '{"message":"secret detail"}');
    expect(await devcoord(["status", "--root", rootOf("S5"), "--check"], missing)).toEqual({
      exit: 1,
      stdout: "",
      stderr: "devcoord: HTTP_ERROR 404\n"
    });
    const usage = await devcoord(["status", "--root", rootOf("S5"), "--check", "--force"], missing);
    expect(usage).toMatchObject({
      exit: 2,
      stdout: "",
      stderr: expect.stringContaining("usage: devcoord status")
    });
  });
});
