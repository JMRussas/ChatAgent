import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runContinuationCli } from "../../scripts/continueCheckpoint";
import {
  claimKeyOf,
  continuationLeasePath,
  continuationRecordPath,
  parseContinuationRecord,
  runContinuation,
  type ContinuationRecord
} from "../../src/checkpoint/checkpointContinuation";
import { gateRecordPath, gateRecordSchema } from "../../src/checkpoint/checkpointRecord";
import { RUN_ID } from "../helpers/checkpointFixtures";
import { git, makeFixture, type Fixture } from "../helpers/continuationFixtures";

const T = 120_000;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    git(f.main, "worktree", "remove", "--force", f.wt);
    await rm(f.root, { recursive: true, force: true });
  }
});
const fixture = (scenario = "edit") => {
  const f = makeFixture(scenario);
  fixtures.push(f);
  return f;
};

const stored = async (f: Fixture): Promise<ContinuationRecord> => {
  const parsed = parseContinuationRecord(await readFile(continuationRecordPath(f.rec, RUN_ID)));
  if (!parsed.ok) throw new Error("stored record invalid");
  return parsed.value;
};
const gateExists = (f: Fixture) =>
  readFile(gateRecordPath(f.rec, RUN_ID)).then(
    () => true,
    () => false
  );
const commits = (f: Fixture) => Number(git(f.wt, "rev-list", "--count", "HEAD"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("continuation lifecycle with real subprocesses", () => {
  it(
    "worker exit → one candidate → one finish → three external checks → supplied gate",
    async () => {
      const f = fixture();
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(0);
      const record = await stored(f);
      expect(record).toMatchObject({
        phase: "review_pending",
        reason: "checks_passed",
        finish: "confirmed",
        gate: "written",
        checkRole: "mimir_external_checks",
        failureAttribution: "unattributed",
        leadAcceptance: "pending",
        semanticReview: "not_performed",
        delivery: "not_sent",
        wake: "none",
        acknowledgment: "none",
        recordTrust: "supplied_not_authenticated"
      });
      expect(record.worker).toMatchObject({ stop: { kind: "exited" }, exit: { code: 0 } });
      expect(record.checks.map((c) => [c.name, c.result, c.exitCode])).toEqual([
        ["prettier", "pass", 0],
        ["typescript", "pass", 0],
        ["vitest", "pass", 0]
      ]);

      // Exactly one worker and one isolated candidate commit holding only the declared edits.
      expect(f.workerCalls).toBe(1);
      expect(commits(f)).toBe(2);
      const head = git(f.wt, "rev-parse", "HEAD");
      expect(record.sourceRef).toBe(head);
      expect(git(f.wt, "rev-parse", "HEAD^")).toBe(f.baseRef);
      expect(git(f.wt, "show", "--name-status", "--format=", "HEAD").split(/\r?\n/).sort()).toEqual(
        ["A\tsrc/new.ts", "D\tdocs/x.md", "M\tsrc/a.ts"].sort()
      );
      expect(git(f.wt, "status", "--porcelain")).toBe("");
      expect(git(f.main, "rev-parse", "main")).toBe(f.baseRef); // never integrated

      // One finish-only transition; the plan is left at review_pending, never accepted.
      expect(f.plan.posts).toHaveLength(1);
      expect(f.plan.posts[0].url).toMatch(
        /\/api\/plan-contract\/v1\/nodes\/[0-9a-f-]+\/transition$/
      );
      expect(f.plan.posts[0].body).toMatchObject({
        to: "done",
        attemptId: "at-1",
        attemptEpoch: 2,
        artifactRef: head,
        expectedStateRevision: 4,
        actor: "checkpoint-continuation"
      });
      expect(f.plan.leaf.state).toBe("review_pending");

      // Checks started after the worker closed, inside this same awaited call.
      const log = f.toolLog();
      expect(log.map((e) => e.tool)).toEqual(["prettier", "typescript", "vitest"]);
      const exitedAt = f.workerExits()[0];
      for (const entry of log) expect(entry.at).toBeGreaterThanOrEqual(exitedAt);
      expect(log[0].argv).toEqual(["--check", "--ignore-unknown", "src/a.ts", "src/new.ts"]);
      expect(log[1].argv).toEqual(["--project", "tsconfig.json", "--noEmit"]);
      expect(log[2].argv).toEqual(["run", "--maxWorkers=1", "tests/a.test.ts"]);
      expect(Date.parse(record.checks[0].startedAt!)).toBeGreaterThanOrEqual(exitedAt);

      const gate = gateRecordSchema.parse(
        JSON.parse(await readFile(gateRecordPath(f.rec, RUN_ID), "utf8"))
      );
      expect(gate).toMatchObject({
        runId: RUN_ID,
        sourceRef: head,
        outcome: "checks_passed",
        failureAttribution: "unattributed"
      });
      expect(gate.evidenceRefs).toContain("continuation:checks_passed");
      expect(
        await readFile(continuationLeasePath(f.rec, claimKeyOf(f.manifest.run.identity)), "utf8")
      ).toContain(RUN_ID);
      expect(JSON.stringify(record)).not.toContain(f.root);
    },
    T
  );

  it(
    "keeps a retained reservation: a rerun or a new run ID never launches a second worker",
    async () => {
      const f = fixture("none");
      expect((await runContinuation(f.manifest, f.deps())).exitCode).toBe(1);
      expect(f.workerCalls).toBe(1);
      const again = await runContinuation(f.manifest, f.deps());
      expect(again).toMatchObject({ exitCode: 2, refusal: "run_exists" });
      const otherRun = {
        ...f.manifest,
        run: { ...f.manifest.run, runId: "22222222-2222-4222-8222-222222222222" }
      };
      expect(await runContinuation(otherRun, f.deps())).toMatchObject({
        exitCode: 2,
        refusal: "lease_exists"
      });
      expect(f.workerCalls).toBe(1);
    },
    T
  );

  it.each([
    ["no source change", "none", "no_source_change"],
    ["edit outside the declared scope", "outside", "scope_violation"]
  ])(
    "%s stops before any candidate, finish or check",
    async (_name, scenario, reason) => {
      const f = fixture(scenario);
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(1);
      expect(await stored(f)).toMatchObject({ phase: "needs_operator", reason, sourceRef: null });
      expect(commits(f)).toBe(1);
      expect(git(f.wt, "diff", "--cached", "--name-only")).toBe("");
      expect(f.plan.posts).toHaveLength(0);
      expect(f.toolLog()).toHaveLength(0);
      expect(await gateExists(f)).toBe(false);
    },
    T
  );

  it(
    "a failed worker publishes needs_operator without a candidate, finish or check",
    async () => {
      const f = fixture("fail");
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(1);
      expect(await stored(f)).toMatchObject({
        phase: "needs_operator",
        reason: "worker_not_clean",
        worker: { stop: { kind: "failed", code: "exited_nonzero" } }
      });
      expect(f.workerCalls).toBe(1);
      expect(commits(f)).toBe(1);
      expect(f.plan.posts).toHaveLength(0);
      expect(f.toolLog()).toHaveLength(0);
      expect(git(f.wt, "status", "--porcelain")).toContain("src/a.ts"); // work is kept
    },
    T
  );

  it.each([
    ["conflict", "conflict", "finish_conflict", "conflict"],
    ["outage", "outage", "finish_uncertain", "uncertain"],
    ["unconfirmed", "ignored", "finish_unconfirmed", "uncertain"]
  ] as const)(
    "a %s finish stops without replay, checks or a gate and keeps the candidate",
    async (_name, mode, reason, finish) => {
      const f = fixture();
      f.plan.postMode = mode;
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(1);
      const record = await stored(f);
      expect(record).toMatchObject({ phase: "needs_operator", reason, finish });
      expect(record.sourceRef).toBe(git(f.wt, "rev-parse", "HEAD"));
      expect(f.plan.posts).toHaveLength(1);
      expect(f.toolLog()).toHaveLength(0);
      expect(await gateExists(f)).toBe(false);
      expect(commits(f)).toBe(2);
    },
    T
  );

  it(
    "a failed check is unattributed, later checks still run and nothing is accepted",
    async () => {
      const f = fixture();
      f.setMode("prettier", "fail");
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(1);
      const record = await stored(f);
      expect(record).toMatchObject({
        phase: "needs_operator",
        reason: "check_failed",
        gate: "written"
      });
      expect(record.checks.map((c) => c.result)).toEqual(["fail", "pass", "pass"]);
      expect(f.toolLog().map((e) => e.tool)).toEqual(["prettier", "typescript", "vitest"]);
      const gate = JSON.parse(await readFile(gateRecordPath(f.rec, RUN_ID), "utf8"));
      expect(gate).toMatchObject({ outcome: "partial", failureAttribution: "unattributed" });
      expect(JSON.stringify(record)).not.toContain("SECRET_TOOL_TEXT");
      expect(record.checks[0].outputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.plan.leaf.state).toBe("review_pending");
    },
    T
  );

  it(
    "a hung verifier is terminated with its tree; later checks stay unavailable",
    async () => {
      const f = fixture();
      f.setMode("typescript", "hang");
      f.manifest.limits.verifierWallMs = 2_000;
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(1);
      const record = await stored(f);
      expect(record).toMatchObject({
        phase: "needs_operator",
        reason: "check_unavailable",
        gate: "written"
      });
      expect(record.checks.map((c) => [c.result, c.timedOut])).toEqual([
        ["pass", false],
        ["unavailable", true],
        ["unavailable", false]
      ]);
      expect(f.toolLog().map((e) => e.tool)).toEqual(["prettier", "typescript"]);
      const pids = JSON.parse(await readFile(join(f.root, "hang-typescript.pids"), "utf8"));
      expect(alive(pids.child)).toBe(false);
      expect(alive(pids.grand)).toBe(false);
      const gate = JSON.parse(await readFile(gateRecordPath(f.rec, RUN_ID), "utf8"));
      expect(gate.outcome).toBe("partial");
    },
    T
  );

  it(
    "an output flood is cut at the shared verifier byte cap",
    async () => {
      const f = fixture();
      f.setMode("vitest", "flood");
      f.manifest.limits.verifierOutputBytes = 8_192;
      await runContinuation(f.manifest, f.deps());
      const record = await stored(f);
      expect(record.checks[2]).toMatchObject({ result: "unavailable", outputLimited: true });
      expect(record.checks[2].outputBytes).toBeLessThanOrEqual(8_192);
      expect(record.reason).toBe("check_unavailable");
    },
    T
  );

  it(
    "the aggregate deadline stops verification and publishes no gate",
    async () => {
      const f = fixture();
      f.setMode("typescript", "hang");
      const manifest = { ...f.manifest, limits: { ...f.manifest.limits, wallMs: 40_000 } };
      const result = await runContinuation(manifest, f.deps());
      expect(result.exitCode).toBe(1);
      const record = await stored(f);
      expect(record).toMatchObject({
        phase: "needs_operator",
        reason: "deadline_exceeded",
        gate: "not_written",
        finish: "confirmed"
      });
      expect(record.sourceRef).toBe(git(f.wt, "rev-parse", "HEAD"));
      expect(await gateExists(f)).toBe(false);
      expect(f.toolLog().map((e) => e.tool)).toEqual(["prettier", "typescript"]);
      const pids = JSON.parse(await readFile(join(f.root, "hang-typescript.pids"), "utf8"));
      expect(alive(pids.grand)).toBe(false);
      expect(f.plan.posts).toHaveLength(1);
    },
    T
  );

  it(
    "a failed cleanup is reported as a persistence/cleanup failure with no gate",
    async () => {
      const f = fixture();
      f.setMode("vitest", "hang");
      f.manifest.limits.verifierWallMs = 1_500;
      const terminator = {
        terminate: async () => {
          throw new Error("denied");
        }
      };
      const result = await runContinuation(f.manifest, f.deps({ terminator, closeGraceMs: 500 }));
      expect(result.exitCode).toBe(4);
      expect(await stored(f)).toMatchObject({ phase: "needs_operator", reason: "cleanup_failed" });
      expect(await gateExists(f)).toBe(false);
      const pids = JSON.parse(await readFile(join(f.root, "hang-vitest.pids"), "utf8"));
      process.kill(pids.grand);
    },
    T
  );

  it(
    "a lease changed before publication stops further phases and the gate",
    async () => {
      const f = fixture();
      f.plan.onPost = () =>
        writeFileSync(
          continuationLeasePath(f.rec, claimKeyOf(f.manifest.run.identity)),
          JSON.stringify({ runId: RUN_ID, token: "someone-else" })
        );
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(4);
      expect(f.plan.posts).toHaveLength(1);
      expect(f.toolLog()).toHaveLength(0);
      expect(await gateExists(f)).toBe(false);
      // Nothing was published after the lease moved: the last durable phase is the pre-POST one.
      expect(await stored(f)).toMatchObject({ phase: "snapshotting", finish: "attempted" });
    },
    T
  );
});

describe("continuation refusals launch no worker", () => {
  const refusal = async (f: Fixture, code: string, deps = f.deps()) => {
    const result = await runContinuation(f.manifest, deps);
    expect(result).toMatchObject({ exitCode: 2, record: null, refusal: code });
    expect(f.workerCalls).toBe(0);
    expect(f.plan.posts).toHaveLength(0);
    expect(f.toolLog()).toHaveLength(0);
    expect(await gateExists(f)).toBe(false);
  };

  it("refuses an existing continuation record, budget record or gate", async () => {
    for (const name of [
      `${RUN_ID}.continuation.json`,
      `${RUN_ID}.budget.json`,
      `${RUN_ID}.gate.json`
    ]) {
      const f = fixture();
      await writeFile(join(f.rec, name), "{}");
      await refusal(f, "run_exists");
    }
  });

  it("refuses an existing instance or runner claim lease", async () => {
    const key = claimKeyOf(fixture().manifest.run.identity);
    for (const name of [`.continuation-${key}.lease`, `.claim-${key}.lease`]) {
      const f = fixture();
      await writeFile(join(f.rec, name), "{}");
      await refusal(f, "lease_exists");
    }
  });

  it("refuses a dirty start, a staged change and a moved base", async () => {
    const dirty = fixture();
    dirty.write("src/b.ts", "export const b = 2;\n");
    await refusal(dirty, "worktree_dirty");
    const staged = fixture();
    staged.write("src/b.ts", "export const b = 3;\n");
    git(staged.wt, "add", "src/b.ts");
    await refusal(staged, "worktree_dirty");
    const moved = fixture();
    moved.write("src/b.ts", "export const b = 4;\n");
    git(moved.wt, "-c", "user.name=x", "-c", "user.email=x@invalid", "commit", "-qam", "move");
    await refusal(moved, "pin_mismatch");
  });

  it("refuses unsupported pins", async () => {
    const tool = fixture();
    tool.manifest.toolingSha256.vitest = "0".repeat(64);
    await refusal(tool, "pin_mismatch");
    const node = fixture();
    node.manifest.nodeExecutable.sha256 = "0".repeat(64);
    await refusal(node, "pin_mismatch");
    const missing = fixture();
    await rm(join(missing.wt, "node_modules", "prettier", "bin", "prettier.cjs"));
    await refusal(missing, "pin_mismatch");
  });

  it("refuses a stale claim, changed content or executor, an unmet gate and an unavailable plan", async () => {
    for (const patch of [
      { attemptEpoch: 3 },
      { contentRevision: 4 },
      { executorRef: "other" },
      { stateRevision: 9 },
      { attemptPins: "stale" as const },
      { gatesHold: false },
      { state: "review_pending" as const }
    ]) {
      const f = fixture();
      f.plan.leaf = { ...f.plan.leaf, ...patch };
      await refusal(f, "authority_mismatch");
    }
    const down = fixture();
    down.plan.unavailable = true;
    await refusal(down, "authority_unavailable");
  });

  it("refuses a record directory inside the worktree", async () => {
    const f = fixture();
    const inside = join(f.wt, "src", "records");
    await mkdir(inside, { recursive: true });
    f.manifest.run.recordDir = inside;
    await refusal(f, "record_dir_invalid");
  });
});

describe("continueCheckpoint CLI", () => {
  it("prints fixed codes for usage and invalid manifests", async () => {
    expect(await runContinuationCli([])).toMatchObject({ exitCode: 2, stdout: [] });
    expect(await runContinuationCli(["--input", "x"])).toMatchObject({ exitCode: 2 });
    const f = fixture();
    const bad = join(f.root, "bad.json");
    await writeFile(bad, '{"schema":"checkpoint-continuation-run/v1","command":"rm"}');
    expect(await runContinuationCli(["--manifest", bad])).toEqual({
      exitCode: 2,
      stdout: [],
      stderr: ["continueCheckpoint: INPUT_INVALID"]
    });
    const big = join(f.root, "big.json");
    await writeFile(big, " ".repeat(33 * 1024));
    expect((await runContinuationCli(["--manifest", big])).stderr).toEqual([
      "continueCheckpoint: INPUT_INVALID"
    ]);
    expect((await runContinuationCli(["--manifest", join(f.root, "missing.json")])).exitCode).toBe(
      2
    );
  });

  it(
    "runs a manifest file end to end and prints only the public record",
    async () => {
      const f = fixture();
      const file = join(f.root, "manifest.json");
      await writeFile(file, JSON.stringify(f.manifest));
      const result = await runContinuationCli(["--manifest", file], f.deps());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const printed = JSON.parse(result.stdout[0]);
      expect(printed).toMatchObject({ phase: "review_pending", gate: "written" });
      expect(result.stdout[0]).not.toContain(f.root);
      expect(result.stdout[0]).not.toContain("SECRET");
    },
    T
  );

  it(
    "counts manifest-read time against the shared deadline",
    async () => {
      const f = fixture();
      const file = join(f.root, "manifest.json");
      await writeFile(file, JSON.stringify(f.manifest));
      const expired = performance.now() - f.manifest.limits.wallMs - 1;
      const result = await runContinuationCli(
        ["--manifest", file],
        f.deps({ startMonotonic: expired })
      );
      expect(result).toMatchObject({
        exitCode: 2,
        stderr: ["continueCheckpoint: deadline_exceeded"]
      });
      expect(f.workerCalls).toBe(0);
    },
    T
  );
});
