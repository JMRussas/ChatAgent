import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTINUATION_RECORD_SCHEMA,
  CONTINUATION_RECORD_SCHEMA_V2,
  continuationRecordPath,
  parseContinuationRecord,
  runContinuation,
  type ContinuationDeps,
  type ContinuationRecord,
  type ContinuationRecordV2
} from "../../src/checkpoint/checkpointContinuation";
import { runQueueService } from "../../src/checkpoint/checkpointQueueService";
import { gateRecordPath, gateRecordSchema } from "../../src/checkpoint/checkpointRecord";
import type { fetchCoordinationStatus } from "../../src/integrations/hekate/devCoordination";
import { RUN_ID } from "../helpers/checkpointFixtures";
import {
  git,
  makeFixture,
  type Fixture,
  type FixtureOptions
} from "../helpers/continuationFixtures";
import {
  makeQueueFixture,
  waitForRecord,
  type QueueFixture
} from "../helpers/queueServiceFixtures";

/**
 * Real Git, real owned child processes and a loopback-free plan stub. The `prettier` tool in these
 * tests is a LABELLED STUB unless the test says it uses the real pinned package, and the worker is
 * a local stand-in: none of this is model proof or acceptance evidence.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const fixtures: Fixture[] = [];
const queues: QueueFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    git(f.main, "worktree", "remove", "--force", f.wt);
    await rm(f.root, { recursive: true, force: true });
  }
  for (const q of queues.splice(0)) await q.cleanup();
});

const fixture = (scenario = "edit", options: FixtureOptions = { formatting: true }) => {
  const f = makeFixture(scenario, options);
  fixtures.push(f);
  return f;
};

const stored = async (f: Fixture): Promise<ContinuationRecord> => {
  const parsed = parseContinuationRecord(await readFile(continuationRecordPath(f.rec, RUN_ID)));
  if (!parsed.ok) throw new Error("stored record invalid");
  return parsed.value;
};
const asV2 = (record: ContinuationRecord | null): ContinuationRecordV2 => {
  if (record?.schema !== CONTINUATION_RECORD_SCHEMA_V2) throw new Error("expected a v2 record");
  return record;
};
const gateExists = (f: Fixture) => existsSync(gateRecordPath(f.rec, RUN_ID));
const commits = (f: Fixture) => Number(git(f.wt, "rev-list", "--count", "HEAD"));
const head = (f: Fixture) => git(f.wt, "rev-parse", "HEAD");
const prettierRuns = (f: Fixture) => f.toolLog().filter((e) => e.tool === "prettier");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `action` at the first authority read after the raw commit exists, before any formatter. */
const afterRaw = (f: Fixture, action: () => void): ContinuationDeps => {
  let fired = false;
  return {
    fetchStatus: async (..._args: Parameters<typeof fetchCoordinationStatus>) => {
      if (!fired && commits(f) > 1) {
        fired = true;
        action();
      }
      return f.plan.fetchStatus();
    }
  };
};

/** A refused or stopped run keeps the raw commit and the dirty tree and never reaches the finish. */
const expectStoppedAfterRaw = async (f: Fixture, reason: string) => {
  const record = asV2(await stored(f));
  expect(record).toMatchObject({ phase: "needs_operator", reason, finish: "not_attempted" });
  expect(record.sourceRef).toBeNull();
  expect(record.rawRef).toBe(head(f));
  expect(commits(f)).toBe(2);
  expect(f.plan.posts).toHaveLength(0);
  expect(gateExists(f)).toBe(false);
  expect(git(f.main, "rev-parse", "main")).toBe(f.baseRef);
  return record;
};

describe("scoped formatting commits", () => {
  it("makes a raw functional commit and a separate formatting-only commit, then one final POST", async () => {
    const f = fixture();
    f.setMode("prettier", "format");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(0);
    const record = asV2(await stored(f));
    expect(record).toMatchObject({
      phase: "review_pending",
      reason: "checks_passed",
      finish: "confirmed",
      gate: "written"
    });
    expect(record.formatting).toMatchObject({
      mode: "prettier_write_declared/v1",
      state: "committed",
      ran: true,
      eligible: 2,
      unsupported: 0,
      changed: 2,
      exitCode: 0
    });

    // raw (base → raw) and formatting-only (raw → final) commits.
    expect(commits(f)).toBe(3);
    const final = head(f);
    const raw = git(f.wt, "rev-parse", "HEAD^");
    expect(git(f.wt, "rev-parse", "HEAD^^")).toBe(f.baseRef);
    expect(record.rawRef).toBe(raw);
    expect(record.sourceRef).toBe(final);
    expect(raw).not.toBe(final);
    expect(git(f.wt, "show", "--name-status", "--format=", raw).split(/\r?\n/).sort()).toEqual(
      ["A\tsrc/new.ts", "D\tdocs/x.md", "M\tsrc/a.ts"].sort()
    );
    expect(git(f.wt, "show", "--name-status", "--format=", final).split(/\r?\n/).sort()).toEqual([
      "M\tsrc/a.ts",
      "M\tsrc/new.ts"
    ]);
    expect(git(f.wt, "diff-tree", "--no-commit-id", "--raw", "-r", "HEAD")).not.toMatch(
      /:100644 100755|:100755 100644|:120000/
    );
    expect(git(f.wt, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.wt, "src", "a.ts"), "utf8")).toContain("// formatted");

    // Exactly one finish-only POST, naming the FINAL candidate; the gate binds the same ref.
    expect(f.plan.posts).toHaveLength(1);
    expect(f.plan.posts[0].body).toMatchObject({ to: "done", artifactRef: final });
    expect(JSON.stringify(f.plan.posts)).not.toContain(raw);
    expect(f.plan.leaf.artifactRef).toBe(final);
    const gate = gateRecordSchema.parse(
      JSON.parse(await readFile(gateRecordPath(f.rec, RUN_ID), "utf8"))
    );
    expect(gate).toMatchObject({ sourceRef: final, outcome: "checks_passed" });

    // Write with the explicit pinned options, then an independent check with the same options.
    const runs = prettierRuns(f);
    expect(runs).toHaveLength(2);
    const [write, check] = runs.map((e) => e.argv);
    expect(write.slice(0, 5)).toEqual([
      "--config",
      join(f.wt, ".prettierrc.json"),
      "--no-editorconfig",
      "--ignore-path",
      join(f.wt, ".prettierignore")
    ]);
    expect(write.slice(5)).toEqual([
      "--write",
      "--ignore-unknown",
      "--no-error-on-unmatched-pattern",
      "src/a.ts",
      "src/new.ts"
    ]);
    expect(check.slice(0, 5)).toEqual(write.slice(0, 5));
    expect(check.slice(5)).toEqual(["--check", "--ignore-unknown", "src/a.ts", "src/new.ts"]);
    expect(f.toolLog().map((e) => e.tool)).toEqual([
      "prettier",
      "prettier",
      "typescript",
      "vitest"
    ]);
  });

  it("finishes once on the raw commit when the formatter changes nothing", async () => {
    const f = fixture();
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(0);
    const record = asV2(await stored(f));
    expect(record.formatting).toMatchObject({ state: "unchanged", ran: true, changed: 0 });
    expect(commits(f)).toBe(2);
    expect(record.rawRef).toBe(head(f));
    expect(record.sourceRef).toBe(record.rawRef);
    expect(f.plan.posts).toHaveLength(1);
    expect(f.plan.posts[0].body).toMatchObject({ artifactRef: head(f) });
  });

  it("preserves deleted and unsupported files and never launches the formatter for them", async () => {
    const f = fixture("none");
    f.manifest.files.push("docs/n.txt");
    f.afterWorker = () => {
      rmSync(join(f.wt, "docs", "x.md"));
      f.write("docs/n.txt", "plain notes\n");
    };
    f.setMode("prettier", "format");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(0);
    const record = asV2(await stored(f));
    expect(record.formatting).toMatchObject({
      state: "unchanged",
      ran: false,
      eligible: 0,
      unsupported: 1,
      changed: 0
    });
    expect(prettierRuns(f)).toEqual([]);
    expect(commits(f)).toBe(2);
    expect(record.sourceRef).toBe(record.rawRef);
    expect(existsSync(join(f.wt, "docs", "x.md"))).toBe(false);
    expect(readFileSync(join(f.wt, "docs", "n.txt"), "utf8")).toBe("plain notes\n");
    expect(f.plan.posts).toHaveLength(1);
  });

  it("keeps the opt-out v1 wire shape, argv and single commit exactly as before", async () => {
    const f = fixture("edit", {});
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(0);
    const record = await stored(f);
    expect(record.schema).toBe(CONTINUATION_RECORD_SCHEMA);
    const text = await readFile(continuationRecordPath(f.rec, RUN_ID), "utf8");
    expect(text).not.toMatch(/rawRef|formatting|format_/);
    expect(commits(f)).toBe(2);
    expect(record.sourceRef).toBe(head(f));
    expect(prettierRuns(f).map((e) => e.argv)).toEqual([
      ["--check", "--ignore-unknown", "src/a.ts", "src/new.ts"]
    ]);
  });
});

describe("formatter tamper, failure and ownership", () => {
  it.each([
    ["untracked file", "format-untracked"],
    ["extra file edit", "format-extra"],
    ["deletion", "format-delete"],
    ["staging", "format-stage"]
  ])("rejects a formatter that leaves %s and keeps the raw commit", async (_name, mode) => {
    const f = fixture();
    f.setMode("prettier", mode);
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "scope_violation");
    expect(record.formatting).toMatchObject({ state: "failed", ran: true });
    // Dirty data is preserved: nothing was reset, cleaned or retried.
    expect(git(f.wt, "status", "--porcelain")).not.toBe("");
    expect(prettierRuns(f)).toHaveLength(1);
    if (mode === "format-untracked") expect(existsSync(join(f.wt, "src", "stray.ts"))).toBe(true);
  });

  it.each([
    ["pinned config edit", "format-config"],
    ["shadow config", "format-shadow"]
  ])("stops when the formatter leaves a %s", async (_name, mode) => {
    const f = fixture();
    f.setMode("prettier", mode);
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    await expectStoppedAfterRaw(f, "source_changed");
    expect(f.plan.posts).toHaveLength(0);
  });

  const tampers: [string, (f: Fixture) => void, string][] = [
    [
      "authority claim",
      (f) => {
        f.plan.leaf = { ...f.plan.leaf, attemptEpoch: 99 };
      },
      "authority_changed"
    ],
    [
      "HEAD",
      (f) => {
        git(f.wt, "commit", "--allow-empty", "-q", "-m", "moved");
      },
      "source_changed"
    ],
    ["pinned config", (f) => f.write(".prettierrc.json", "{}\n"), "source_changed"],
    ["tracked scope", (f) => f.write("src/a.ts", "export const a = 7;\n"), "source_changed"],
    ["untracked file", (f) => f.write("src/stray.ts", "export {};\n"), "source_changed"],
    [
      "staged content",
      (f) => {
        f.write("src/b.ts", "export const b = 2;\n");
        git(f.wt, "add", "src/b.ts");
      },
      "source_changed"
    ]
  ];

  it.each(tampers)(
    "fails closed when the %s changes after the raw commit",
    async (_n, tamper, reason) => {
      const f = fixture();
      const result = await runContinuation(f.manifest, f.deps(afterRaw(f, () => tamper(f))));
      expect(result.exitCode).toBe(1);
      const record = asV2(await stored(f));
      expect(record).toMatchObject({ phase: "needs_operator", reason, finish: "not_attempted" });
      expect(record.sourceRef).toBeNull();
      expect(prettierRuns(f)).toEqual([]);
      expect(f.plan.posts).toHaveLength(0);
      expect(gateExists(f)).toBe(false);
    }
  );

  it("stops when an eligible file gains bytes between the formatter and git add", async () => {
    const f = fixture();
    f.setMode("prettier", "format");
    let fired = false;
    const injected = "// injected\n";
    const deps: ContinuationDeps = {
      fetchStatus: async (..._args: Parameters<typeof fetchCoordinationStatus>) => {
        // The first authority read after the formatter ran is the one right before `git add`.
        if (!fired && prettierRuns(f).length > 0) {
          fired = true;
          appendFileSync(join(f.wt, "src", "a.ts"), injected);
        }
        return f.plan.fetchStatus();
      }
    };
    const result = await runContinuation(f.manifest, f.deps(deps));
    expect(fired).toBe(true);
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "scope_violation");
    expect(record.formatting).toMatchObject({ state: "failed", ran: true });
    expect(prettierRuns(f)).toHaveLength(1);
    // Raw source and the concurrent mutation are retained in the dirty tree; nothing was committed.
    expect(git(f.wt, "show", `${record.rawRef}:src/a.ts`)).not.toContain(injected.trim());
    expect(await readFile(join(f.wt, "src", "a.ts"), "utf8")).toContain(injected);
    expect(git(f.wt, "status", "--porcelain")).not.toBe("");
  });

  it("stops before the formatting commit when the claim is superseded after staging", async () => {
    const f = fixture();
    f.setMode("prettier", "format");
    let fired = false;
    const deps: ContinuationDeps = {
      fetchStatus: async (..._args: Parameters<typeof fetchCoordinationStatus>) => {
        if (!fired && git(f.wt, "diff", "--cached", "--name-only") !== "") {
          fired = true;
          f.plan.leaf = { ...f.plan.leaf, attemptEpoch: 99 };
        }
        return f.plan.fetchStatus();
      }
    };
    const result = await runContinuation(f.manifest, f.deps(deps));
    expect(fired).toBe(true);
    expect(result.exitCode).toBe(1);
    await expectStoppedAfterRaw(f, "authority_changed");
    expect(prettierRuns(f)).toHaveLength(1);
  });

  it("refuses a changed pinned Prettier executable before running it", async () => {
    const f = fixture();
    f.afterWorker = () => f.write("node_modules/prettier/bin/prettier.cjs", "process.exit(0);\n");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "format_unavailable");
    expect(record.formatting).toMatchObject({ state: "unavailable", ran: false });
    expect(prettierRuns(f)).toEqual([]);
  });

  it("records a failing formatter by reason only, without echoing its output", async () => {
    const f = fixture();
    f.setMode("prettier", "write-fail");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "format_failed");
    expect(record.formatting).toMatchObject({ state: "failed", ran: true, exitCode: 1 });
    expect(await readFile(continuationRecordPath(f.rec, RUN_ID), "utf8")).not.toContain(
      "SECRET_TOOL_TEXT"
    );
  });

  it("times out a hanging formatter and cleans up its owned process tree", async () => {
    const f = fixture();
    f.manifest.formatting!.wallMs = 1500;
    f.setMode("prettier", "write-hang");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "format_unavailable");
    expect(record.formatting).toMatchObject({ state: "unavailable", timedOut: true });
    const pids = JSON.parse(readFileSync(join(f.root, "hang-prettier.pids"), "utf8")) as {
      child: number;
      grand: number;
    };
    for (let i = 0; i < 50 && (alive(pids.child) || alive(pids.grand)); i++) await sleep(100);
    expect(alive(pids.child)).toBe(false);
    expect(alive(pids.grand)).toBe(false);
  });

  it("stops a formatter that floods past its output bound", async () => {
    const f = fixture();
    f.setMode("prettier", "write-flood");
    const result = await runContinuation(f.manifest, f.deps());
    expect(result.exitCode).toBe(1);
    const record = await expectStoppedAfterRaw(f, "format_unavailable");
    expect(record.formatting).toMatchObject({ state: "unavailable", outputLimited: true });
    expect(record.formatting.outputBytes).toBeGreaterThan(0);
  });

  it("aborts a running formatter on cancellation and leaves no owned process behind", async () => {
    const f = fixture();
    f.setMode("prettier", "write-hang");
    const abort = new AbortController();
    const pidFile = join(f.root, "hang-prettier.pids");
    const running = runContinuation(f.manifest, f.deps({ signal: abort.signal }));
    for (let i = 0; i < 300 && !existsSync(pidFile); i++) await sleep(100);
    expect(existsSync(pidFile)).toBe(true);
    abort.abort();
    const result = await running;
    expect(result.exitCode).toBe(1);
    await expectStoppedAfterRaw(f, "cancelled");
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; grand: number };
    for (let i = 0; i < 50 && (alive(pids.child) || alive(pids.grand)); i++) await sleep(100);
    expect(alive(pids.child)).toBe(false);
    expect(alive(pids.grand)).toBe(false);
  });
});

const require = createRequire(import.meta.url);
const prettierDir = (() => {
  try {
    const dir = dirname(require.resolve("prettier/package.json"));
    return existsSync(join(dir, "bin", "prettier.cjs")) ? dir : undefined;
  } catch {
    return undefined;
  }
})();

describe("real pinned Prettier regression", () => {
  // Capability skip: the package must be resolvable and copyable as regular files (no links).
  it.skipIf(prettierDir === undefined)(
    "formats an unformatted declared file into a separate commit that an independent check accepts",
    async () => {
      const f = fixture("none");
      const dest = join(f.wt, "node_modules", "prettier");
      rmSync(dest, { recursive: true, force: true });
      cpSync(prettierDir!, dest, { recursive: true, dereference: true });
      f.manifest.toolingSha256.prettier = createHash("sha256")
        .update(readFileSync(join(dest, "bin", "prettier.cjs")))
        .digest("hex");
      f.afterWorker = () => f.write("src/a.ts", "export   const a   =  2\n");
      const result = await runContinuation(f.manifest, f.deps());
      expect(result.exitCode).toBe(0);
      const record = asV2(await stored(f));
      expect(record.formatting).toMatchObject({ state: "committed", changed: 1, exitCode: 0 });
      expect(commits(f)).toBe(3);
      expect(readFileSync(join(f.wt, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
      expect(git(f.wt, "show", "--name-status", "--format=", "HEAD")).toBe("M\tsrc/a.ts");
      expect(f.plan.posts).toHaveLength(1);
      expect(f.plan.posts[0].body).toMatchObject({ artifactRef: head(f) });
    }
  );
});

describe("queue service with formatting", () => {
  it("records the final formatted candidate and posts only that ref", async () => {
    const fx = await makeQueueFixture(1, { formatting: true });
    queues.push(fx);
    const running = runQueueService(fx.bytes(), "arm", fx.deps());
    const review = await waitForRecord(fx, (r) => r.items[0].state === "waiting_review");
    const wt = fx.worktree(0);
    const final = git(wt, "rev-parse", "HEAD");
    expect(git(wt, "rev-list", "--count", "HEAD")).toBe("3");
    expect(review.items[0]).toMatchObject({
      continuation: "review_pending",
      continuationReason: "checks_passed",
      sourceRef: final
    });
    const manifest = fx.items[0];
    const parsed = parseContinuationRecord(
      readFileSync(continuationRecordPath(manifest.run.recordDir, manifest.run.runId))
    );
    if (!parsed.ok) throw new Error("stored record invalid");
    const record = asV2(parsed.value);
    expect(record.formatting.state).toBe("committed");
    expect(record.rawRef).toBe(git(wt, "rev-parse", "HEAD^"));
    expect(record.sourceRef).toBe(final);
    const transitions = fx.plan.posts(0).filter((r) => r.body?.to === "done");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].body).toMatchObject({ artifactRef: final });
    fx.plan.accept(0);
    expect((await running).exitCode).toBe(0);
  });
});
