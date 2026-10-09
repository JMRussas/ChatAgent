import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSESSMENT_INPUT_SCHEMA,
  type AssessmentInput,
  type RecoveryAssessment
} from "../../src/integrations/hekate/recoveryAssessment";
import {
  ATTEMPT,
  EPOCH,
  RAW_PLAN,
  ROOT,
  RUNNING,
  SECRETS,
  claude,
  eventsPath,
  planBody,
  planPath,
  tracePath,
  traceRecords,
  upstreamBodies
} from "../helpers/attemptProgressFixtures";

// scripts/assessRecovery.ts (doc 17) as a real subprocess: the pinned node executable with
// the maintained tsx loader, a fake loopback plan API and nothing else. It only reads.
// Exit codes: 0 action none, 4 any other valid assessment, 1 refusal, 2 usage error.
const SENTINEL = "SENTINEL-8e1c-do-not-leak";
const TOKEN = "token-3d7f-secret";
const LAUNCH = "a".repeat(32);
const REF = `git:${"a".repeat(40)}`;
const CONTENT = (
  JSON.parse(RAW_PLAN) as { nodes: { id: string; contentRevision: number }[] }
).nodes.find((n) => n.id === RUNNING)!.contentRevision;

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Seen {
  method: string | undefined;
  path: string;
  headers: IncomingHttpHeaders;
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const records = traceRecords([
  {
    text: claude.assistant([
      { type: "thinking", thinking: SECRETS.thinking },
      claude.text("Reading the test.")
    ])
  },
  { stream: "stderr", text: SECRETS.stderr }
]);

/** A fake plan API answering the fixture observation and recording every request. */
async function planApi(plan = planBody(), traceExtra?: Record<string, unknown>) {
  const answer = upstreamBodies({ records, plan, traceExtra });
  const seen: Seen[] = [];
  const url = await listen(
    createServer((req, res) => {
      seen.push({ method: req.method, path: req.url ?? "", headers: req.headers });
      const body = answer(req.url ?? "");
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(body ?? SECRETS.hekate);
    })
  );
  return { url, seen };
}

/** A loopback port that was bound and released, so nothing is listening on it. */
async function closedPort() {
  const server = createServer();
  const url = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return url;
}

const accepted = () =>
  planBody((node) => {
    node.work = "done";
    node.effectiveAcceptance = "accepted";
    node.artifactRef = REF;
    node.acceptance = {
      decision: "accepted",
      contentRevision: node.contentRevision,
      artifactRef: REF,
      attemptId: node.attemptId,
      attemptEpoch: node.attemptEpoch,
      decidedBy: "lead",
      evidenceRef: null
    };
  });

const run = (args: string[], env: Record<string, string | undefined>, preload: string[] = []) =>
  new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        ...preload.flatMap((p) => ["--import", p]),
        "--import",
        "tsx",
        "scripts/assessRecovery.ts",
        ...args
      ],
      {
        env: { ...process.env, HEKATE_PLAN_API_URL: undefined, BRIDGE_TOKEN: TOKEN, ...env },
        timeout: 90_000
      },
      (error, stdout, stderr) =>
        resolve({ exit: error ? (error.code as number) : 0, stdout, stderr })
    );
  });

const fence = (over: Record<string, string> = {}) =>
  Object.entries({
    "--root": ROOT,
    "--node": RUNNING,
    "--attempt": ATTEMPT,
    "--epoch": String(EPOCH),
    "--content": String(CONTENT),
    ...over
  }).flat();

const lines = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as RecoveryAssessment);

async function tmpFile(name: string, content: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "assess-"));
  dirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

describe("assessRecovery live mode", () => {
  it("reads only the documented plan paths with GET, bounded, with no credentials", async () => {
    const { url, seen } = await planApi();
    const r = await run([...fence(), "--json"], { HEKATE_PLAN_API_URL: url });
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(4);
    const [a] = lines(r.stdout);
    expect(a.attempt).toMatchObject({ workerSource: "in_flight" });
    expect(a.recommendation).toMatchObject({
      action: "wait_and_reobserve",
      automaticAllowed: false
    });
    expect(a.trust).toMatchObject({ workerLiveness: "unknown", usefulProgress: "unknown" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(8);
    const allowed = [planPath, eventsPath(RUNNING), tracePath(RUNNING, ATTEMPT)];
    for (const request of seen) {
      expect(request.method).toBe("GET");
      expect(allowed).toContain(request.path);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
    for (const forbidden of [TOKEN, SECRETS.thinking, SECRETS.stderr, "Reading the test"])
      expect(r.stdout).not.toContain(forbidden);
  });

  it("observes allocated work again at the explicit finite cadence", async () => {
    const { url, seen } = await planApi();
    const started = Date.now();
    const r = await run([...fence(), "--cycles", "2", "--json"], { HEKATE_PLAN_API_URL: url });
    expect(r.exit).toBe(4);
    expect(lines(r.stdout)).toHaveLength(2);
    expect(lines(r.stdout).every((a) => a.recommendation.action === "wait_and_reobserve")).toBe(
      true
    );
    expect(seen.length).toBeLessThanOrEqual(16);
    expect(seen.every((request) => request.method === "GET")).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
  }, 15_000);

  it("prints the same facts as fixed human text", async () => {
    const { url } = await planApi();
    const human = await run(fence(), { HEKATE_PLAN_API_URL: url });
    const json = await run([...fence(), "--json"], { HEKATE_PLAN_API_URL: url });
    const [a] = lines(json.stdout);
    expect(human.exit).toBe(4);
    for (const fact of [
      a.attempt.workerSource,
      a.attempt.claim,
      a.recommendation.action,
      a.recommendation.authority,
      a.host.owner,
      ...a.recommendation.forbidden
    ])
      expect(human.stdout).toContain(fact);
    expect(human.stdout).not.toMatch(/\b(alive|idle|stalled|answered|healthy)\b/);
    expect(human.stdout).not.toContain(SECRETS.thinking);
  });

  it("exits 0 only for a current accepted decision", async () => {
    const { url } = await planApi(accepted(), { status: "exited" });
    const r = await run([...fence(), "--json"], { HEKATE_PLAN_API_URL: url });
    expect(r.exit).toBe(0);
    const [a] = lines(r.stdout);
    expect(a.attempt.workerSource).toBe("accepted_current");
    expect(a.recommendation.action).toBe("none");
  });

  it("stops and re-reads authority when the expected epoch is not the recorded one", async () => {
    const { url } = await planApi(accepted(), { status: "exited" });
    const r = await run([...fence({ "--epoch": String(EPOCH + 1) }), "--json"], {
      HEKATE_PLAN_API_URL: url
    });
    expect(r.exit).toBe(4);
    const [a] = lines(r.stdout);
    expect(a.fence).toEqual({ status: "mismatch", mismatched: ["attemptEpoch"] });
    expect(a.recommendation.action).toBe("stop_and_reread_authority");
  });

  it("reports a closed port as an availability outage, not a worker outcome", async () => {
    const r = await run([...fence(), "--json"], { HEKATE_PLAN_API_URL: await closedPort() });
    expect(r.exit).toBe(4);
    const [a] = lines(r.stdout);
    expect(a.observation).toMatchObject({ status: "failed", faultClass: "availability" });
    expect(a.attempt.workerSource).toBe("unobserved");
    expect(a.recommendation.action).toBe("reobserve_then_escalate");
  });

  it("reports a missing or non-loopback plan API as a configuration fault, unechoed", async () => {
    const urls = [undefined, "http://example.com:5100", `http://user:${SENTINEL}@127.0.0.1:1`];
    for (const url of urls) {
      const r = await run([...fence(), "--json"], { HEKATE_PLAN_API_URL: url });
      expect(r.exit).toBe(4);
      const [a] = lines(r.stdout);
      expect(a.observation.faultClass).toBe("config");
      expect(a.recommendation.action).toBe("escalate_operator");
      expect(r.stdout + r.stderr).not.toMatch(/example\.com|SENTINEL/);
    }
  });

  it("re-observes after an outage at most the requested cycles and stops early otherwise", async () => {
    const closed = await run([...fence(), "--cycles", "2", "--json"], {
      HEKATE_PLAN_API_URL: await closedPort()
    });
    expect(closed.exit).toBe(4);
    expect(lines(closed.stdout)).toHaveLength(2);
    const { url, seen } = await planApi(accepted(), { status: "exited" });
    const settled = await run([...fence(), "--cycles", "3", "--json"], {
      HEKATE_PLAN_API_URL: url
    });
    expect(settled.exit).toBe(0);
    expect(lines(settled.stdout)).toHaveLength(1);
    expect(seen.length).toBeLessThanOrEqual(8);
  }, 15_000);

  it("refuses at the whole-run deadline and discards later results", async () => {
    const hang = createServer(() => undefined);
    const url = await listen(hang);
    // Every timer runs 20 times faster, so the 60 s deadline is reached in a few seconds.
    const faster = `data:text/javascript,${encodeURIComponent(
      "const set = globalThis.setTimeout; globalThis.setTimeout = (f, ms, ...a) => set(f, typeof ms === 'number' ? ms / 20 : ms, ...a);"
    )}`;
    const started = Date.now();
    const args = [...fence(), "--cycles", "6", "--interval-ms", "30000", "--json"];
    const r = await run(args, { HEKATE_PLAN_API_URL: url }, [faster]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toBe("assessRecovery: DEADLINE\n");
    expect(Date.now() - started).toBeLessThan(60_000);
    for (const a of lines(r.stdout)) {
      expect(a.observation).toMatchObject({ faultClass: "availability" });
      expect(a.recommendation.action).toBe("reobserve_then_escalate");
    }
  }, 90_000);

  it("reduces a supplied host status to the allowlist and reconciles its uncertainty", async () => {
    const { url } = await planApi();
    const host = await tmpFile(
      "host.json",
      JSON.stringify({
        rootId: ROOT,
        host: "attached",
        lifecycle: "exited",
        liveness: "exited",
        phase: SENTINEL,
        state: SENTINEL,
        stopReason: SENTINEL,
        launchId: LAUNCH,
        current: null,
        lastRun: { outcome: SENTINEL },
        journal: {
          unresolvedIntent: false,
          uncertainLaunch: true,
          uncertainStop: false,
          malformedRecords: 0
        }
      })
    );
    const r = await run([...fence({ "--launch-id": LAUNCH }), "--host-status", host, "--json"], {
      HEKATE_PLAN_API_URL: url
    });
    expect(r.exit).toBe(4);
    const [a] = lines(r.stdout);
    // The exact matching exited launch does not clear the supplied uncertainty.
    expect(a.fence.status).toBe("match");
    expect(a.host).toMatchObject({
      trust: "supplied_unauthenticated",
      owner: "owner_exited",
      uncertainEffects: true
    });
    expect(a.recommendation.action).toBe("reconcile_uncertain_effects");
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
  });

  it("treats a launch id without a matching host as a fence mismatch", async () => {
    const { url } = await planApi();
    const r = await run([...fence({ "--launch-id": LAUNCH }), "--json"], {
      HEKATE_PLAN_API_URL: url
    });
    expect(r.exit).toBe(4);
    expect(lines(r.stdout)[0].fence).toEqual({ status: "mismatch", mismatched: ["owner"] });
  });

  it.each([
    ["a duplicate key", '{"lifecycle":"running","lifecycle":"exited"}', "INPUT_INVALID"],
    [
      "an invalid shape",
      '{"lifecycle":"running","journal":{"unresolvedIntent":"no"}}',
      "INPUT_INVALID"
    ],
    ["a float", '{"lifecycle":"running","journal":null,"x":1.5}', "INPUT_INVALID"],
    ["an oversized file", " ".repeat(64 * 1024 + 1), "INPUT_TOO_LARGE"]
  ])("refuses a host status file with %s, naming only the code", async (_, content, code) => {
    const { url, seen } = await planApi();
    const host = await tmpFile("host.json", content);
    const r = await run([...fence(), "--host-status", host], { HEKATE_PLAN_API_URL: url });
    expect(r).toMatchObject({ exit: 1, stdout: "", stderr: `assessRecovery: ${code}\n` });
    expect(seen).toHaveLength(0);
  });

  it("refuses an unreadable host status path without naming it", async () => {
    const { url } = await planApi();
    const missing = join(tmpdir(), `no-such-dir-${SENTINEL}`, "host.json");
    const r = await run([...fence(), "--host-status", missing], { HEKATE_PLAN_API_URL: url });
    expect(r).toMatchObject({ exit: 1, stderr: "assessRecovery: INPUT_UNREADABLE\n" });
    expect(r.stderr).not.toContain(SENTINEL);
  });
});

describe("assessRecovery replay mode", () => {
  const input = (edit: (i: AssessmentInput) => void = () => undefined): AssessmentInput => {
    const i: AssessmentInput = {
      schema: ASSESSMENT_INPUT_SCHEMA,
      expected: {
        rootId: ROOT,
        nodeId: RUNNING,
        attemptId: ATTEMPT,
        attemptEpoch: 4,
        contentRevision: 3
      },
      observation: {
        status: "observed",
        observedAt: "2026-10-09T12:00:00.000Z",
        rootId: ROOT,
        nodeId: RUNNING,
        consistency: "current",
        reasons: [],
        task: {
          stateRevision: 16,
          work: "done",
          contentRevision: 3,
          attemptId: ATTEMPT,
          attemptEpoch: 4,
          attemptContentRevision: 3,
          effectiveAcceptance: "accepted"
        },
        selectedAttempt: {
          attemptId: ATTEMPT,
          attemptEpoch: 4,
          scope: "current",
          attemptContentRevision: 3,
          contentPins: "current"
        },
        trace: null,
        acceptance: {
          decision: "accepted",
          contentRevision: 3,
          attemptEpoch: 4,
          attemptId: ATTEMPT,
          taskArtifact: { state: "shown", ref: REF },
          decisionArtifact: { state: "shown", ref: REF }
        },
        evidence: []
      }
    };
    edit(i);
    return i;
  };

  it("assesses a stored input with no request at all and exits by the action", async () => {
    const { url, seen } = await planApi();
    const file = await tmpFile("input.json", JSON.stringify(input()));
    const ok = await run(["--replay", file, "--json"], { HEKATE_PLAN_API_URL: url });
    expect(ok.exit).toBe(0);
    expect(lines(ok.stdout)[0].attempt.workerSource).toBe("accepted_current");
    const again = await run(["--replay", file, "--json"], { HEKATE_PLAN_API_URL: url });
    expect(again.stdout).toBe(ok.stdout);
    const uncertain = await tmpFile(
      "uncertain.json",
      JSON.stringify(
        input((i) => {
          i.host = {
            rootId: ROOT,
            lifecycle: "running",
            launchId: LAUNCH,
            currentNodeId: null,
            stopCode: null,
            journal: {
              unresolvedIntent: true,
              uncertainLaunch: false,
              uncertainStop: false,
              malformedRecords: 0
            }
          };
        })
      )
    );
    const needs = await run(["--replay", uncertain, "--json"], { HEKATE_PLAN_API_URL: url });
    expect(needs.exit).toBe(4);
    expect(lines(needs.stdout)[0].recommendation.action).toBe("reconcile_uncertain_effects");
    expect(seen).toHaveLength(0);
  });

  it("works with no plan API configured and accepts agreeing fence flags", async () => {
    const file = await tmpFile("input.json", JSON.stringify(input()));
    const agreeing = fence({ "--epoch": "4", "--content": "3" });
    expect((await run(["--replay", file, ...agreeing, "--json"], {})).exit).toBe(0);
    const text = await run(["--replay", file], {});
    expect(text.exit).toBe(0);
    expect(text.stdout).toContain("accepted_current");
  });

  it("exits 2 for fence flags that disagree with the recorded input", async () => {
    const file = await tmpFile("input.json", JSON.stringify(input()));
    const r = await run(["--replay", file, ...fence({ "--epoch": "99", "--content": "3" })], {});
    expect(r).toMatchObject({ exit: 2, stdout: "" });
    expect(r.stderr).toMatch(/^usage: assessRecovery/);
  });

  it.each([
    ["a duplicate key", () => '{"schema":"x","schema":"y"}'],
    ["a float", () => JSON.stringify(input()).replace('"attemptEpoch":4', '"attemptEpoch":4.5')],
    ["an unknown key", () => JSON.stringify({ ...input(), extra: SENTINEL })],
    ["not JSON", () => `{"schema":"${SENTINEL}`]
  ])("refuses a replay input with %s without echoing it", async (_, make) => {
    const file = await tmpFile("input.json", make());
    const r = await run(["--replay", file], {});
    expect(r).toMatchObject({ exit: 1, stdout: "", stderr: "assessRecovery: INPUT_INVALID\n" });
  });

  it("refuses an oversized or unreadable replay file", async () => {
    const big = await tmpFile("big.json", Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(await run(["--replay", big], {})).toMatchObject({
      exit: 1,
      stderr: "assessRecovery: INPUT_TOO_LARGE\n"
    });
    expect(await run(["--replay", tmpdir()], {})).toMatchObject({
      exit: 1,
      stderr: "assessRecovery: INPUT_UNREADABLE\n"
    });
  });
});

describe("assessRecovery usage", () => {
  const base = fence();

  it.each([
    ["no arguments", []],
    ["an unknown flag", [...base, "--wake"]],
    ["a repeated flag", [...base, "--node", RUNNING]],
    ["a flag without a value", [...base, "--launch-id"]],
    ["a malformed root", fence({ "--root": SENTINEL })],
    ["a malformed node", fence({ "--node": ROOT.toUpperCase() })],
    ["a non-numeric epoch", fence({ "--epoch": "1.5" })],
    ["a negative epoch", fence({ "--epoch": "-1" })],
    ["a zero content revision", fence({ "--content": "0" })],
    ["an unsafe epoch", fence({ "--epoch": "9007199254740993" })],
    ["an attempt with a space", fence({ "--attempt": "a b" })],
    ["a malformed launch id", [...base, "--launch-id", "ABC"]],
    ["too many cycles", [...base, "--cycles", "7"]],
    ["zero cycles", [...base, "--cycles", "0"]],
    ["too short an interval", [...base, "--interval-ms", "4999"]],
    ["too long an interval", [...base, "--interval-ms", "60001"]],
    ["a missing node", ["--root", ROOT, "--attempt", "none", "--epoch", "0", "--content", "1"]],
    ["a replay with live flags", ["--replay", "x.json", "--cycles", "2"]],
    ["a replay with a host file", ["--replay", "x.json", "--host-status", "h.json"]],
    ["a repeated json flag", [...base, "--json", "--json"]]
  ])("exits 2 for %s without echoing any value", async (_, args) => {
    const r = await run(args, {});
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^usage: assessRecovery/);
    expect(r.stderr).not.toContain(SENTINEL);
  });

  it("accepts none as the expected attempt and reports an unknown node as not found", async () => {
    const { url } = await planApi();
    const node = "00000000-0000-4000-8000-000000000000";
    const r = await run(fence({ "--attempt": "none", "--epoch": "0", "--node": node }), {
      HEKATE_PLAN_API_URL: url
    });
    // The fake plan has no such node: a typed not-found, not a usage error.
    expect(r.exit).toBe(4);
    expect(r.stdout).toContain("not_found");
  });
});
