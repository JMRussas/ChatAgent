import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  budgetRecordPath,
  parseBudgetRecord,
  type BudgetRecord,
  type RunInput
} from "../../src/checkpoint/checkpointRecord";
import {
  PROFILE_TOOLS,
  StreamCounter,
  bindProcessSignals,
  profileArgs,
  runCheckpoint,
  type CheckpointDeps
} from "../../src/checkpoint/checkpointRun";
import type { CoordinationStatus, LeafStatus } from "../../src/integrations/hekate/devCoordination";
import { processTreeTerminator } from "../../src/providers/cli/runner";
import { BASE_REF, FENCE } from "../helpers/checkpointFixtures";
import { leaf } from "../helpers/executiveFixtures";

const WORKER = resolve("tests/helpers/checkpointWorker.mjs");
const EXECUTABLE = realpathSync(process.execPath);
const PROMPT = "PROMPT_SENTINEL do the checkpoint";
let executableSha = "";
beforeAll(() => {
  executableSha = createHash("sha256").update(readFileSync(EXECUTABLE)).digest("hex");
}, 60_000);

const dirs: string[] = [];
const pidsToReap: number[] = [];
afterEach(async () => {
  for (const pid of pidsToReap.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const aliveNow = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function expectGone(pids: number[]) {
  const until = Date.now() + 5000;
  while (pids.some(aliveNow) && Date.now() < until) await delay(50);
  expect(pids.filter(aliveNow)).toEqual([]);
}

const currentLeaf = (over: Partial<LeafStatus> = {}) =>
  leaf(1, "in_progress", {
    attemptPins: "current",
    attemptId: "at-1",
    attemptEpoch: 2,
    contentRevision: 3,
    stateRevision: 4,
    executorRef: "exec-1",
    ...over
  });
const statusOf = (l: LeafStatus): CoordinationStatus => ({
  status: "ok",
  rootId: FENCE.rootId,
  progress: {
    state: "active",
    rootCompletion: "incomplete",
    rootAcceptance: "pending",
    leafCounts: {}
  },
  leaves: [l]
});

async function setup(over: Partial<RunInput> = {}) {
  const base = await mkdtemp(join(realpathSync(tmpdir()), "ckpt-run-"));
  dirs.push(base);
  const worktree = join(base, "wt");
  const recordDir = join(base, "records");
  await mkdir(worktree);
  await mkdir(recordDir);
  await writeFile(join(worktree, ".git"), "gitdir: elsewhere\n");
  const promptFile = join(base, "prompt.txt");
  await writeFile(promptFile, PROMPT);
  const marker = join(base, "marker.txt");
  const pidFile = join(base, "pids.json");
  const input: RunInput = {
    schema: "checkpoint-run/v1",
    runId: randomUUID(),
    unit: "assistant_message_ids_distinct/v1",
    profile: "readonly_smoke",
    identity: {
      rootId: FENCE.rootId,
      nodeId: FENCE.nodeId,
      attemptId: "at-1",
      attemptEpoch: 2,
      contentRevision: 3,
      stateRevision: 4,
      executorRef: "exec-1",
      baseRef: BASE_REF
    },
    executable: { path: EXECUTABLE, sha256: executableSha },
    gitExecutable: { path: EXECUTABLE, sha256: executableSha },
    worktree,
    promptFile,
    promptSha256: createHash("sha256").update(PROMPT).digest("hex"),
    recordDir,
    model: "claude-sonnet-5-5",
    expected: { units: 30 },
    hard: { units: 60, wallMs: 20_000, outputBytes: 1024 * 1024 },
    planApiUrl: "http://127.0.0.1:5100",
    ...over
  };
  const deps = (scenario: string, extra: CheckpointDeps = {}): CheckpointDeps => ({
    launchArgs: [WORKER, scenario, marker, pidFile],
    fetchStatus: async () => statusOf(currentLeaf()),
    gitHead: async () => BASE_REF,
    tickMs: 50,
    ...extra
  });
  const spawns = async () =>
    (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  // The worker writes its pid file once; wait until it parses completely.
  const pids = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const found = JSON.parse(await readFile(pidFile, "utf8")) as {
          child: number;
          grand: number;
        };
        pidsToReap.push(found.child, found.grand);
        return [found.child, found.grand];
      } catch {
        await delay(50);
      }
    }
    throw new Error("the worker never reported its pids");
  };
  const onDisk = async () => {
    const parsed = parseBudgetRecord(await readFile(budgetRecordPath(recordDir, input.runId)));
    if (!parsed.ok) throw new Error("record on disk is invalid");
    return parsed.value;
  };
  return { input, deps, spawns, pids, onDisk, base, recordDir, marker, pidFile };
}

describe("distinct assistant message IDs", () => {
  it("counts a repeated ID once and keeps provider numbers separate and unverified", async () => {
    const env = await setup();
    const result = await runCheckpoint(env.input, env.deps("ids_repeat"));
    expect(result.exitCode).toBe(0);
    expect(result.record).toMatchObject({
      state: "ended",
      stop: { kind: "exited", code: "exited" },
      consumed: { units: 2, counterState: "exact_observed" },
      expectedExceeded: false,
      providerReported: { numTurns: 3, costUsd: 0.0123, status: "unverified" },
      recordTrust: "supplied_not_authenticated",
      writerLiveness: "unknown",
      exit: { code: 0, signal: null }
    });
    expect(await env.onDisk()).toEqual(result.record);
  });

  it("treats invalid provider metadata as null without disturbing observed counts", async () => {
    const env = await setup();
    const result = await runCheckpoint(env.input, env.deps("result_bad"));
    expect(result.record).toMatchObject({
      consumed: { units: 1, counterState: "exact_observed" },
      providerReported: { numTurns: null, costUsd: null }
    });
  });

  it("assembles lines split across chunks and ignores non-assistant objects", () => {
    const counter = new StreamCounter(1024, 10);
    const line = `{"type":"assistant","message":{"id":"abc"}}\r\n{"type":"user"}\n`;
    const buffer = Buffer.from(line);
    for (let i = 0; i < buffer.length; i += 7) counter.push(buffer.subarray(i, i + 7));
    counter.push(Buffer.from('{"type":"assistant","message":{"id":"abc"}}\n\n'));
    counter.end();
    expect([...counter.ids]).toEqual(["abc"]);
    expect(counter.uncertain).toBe(false);
  });
});

describe("hard limits stop the actual owned process tree", () => {
  it("stops on the distinct-ID limit with consumed above hard, whatever the exit status", async () => {
    const env = await setup({
      expected: { units: 2 },
      hard: { units: 3, wallMs: 20_000, outputBytes: 1024 * 1024 }
    });
    const result = await runCheckpoint(env.input, env.deps("flood"));
    expect(result.exitCode).toBe(3);
    expect(result.record).toMatchObject({
      stop: { kind: "tripwire", code: "hard_units" },
      expectedExceeded: true,
      consumed: { units: 4, counterState: "exact_observed" }
    });
    expect(result.record!.consumed.units).toBeGreaterThan(result.record!.hard.units);
    expect(result.record!.exit).not.toBeNull();
    await expectGone(await env.pids());
  }, 30_000);

  it("stops on wall time with no IDs ever emitted", async () => {
    const env = await setup({ hard: { units: 60, wallMs: 400, outputBytes: 1024 * 1024 } });
    const result = await runCheckpoint(env.input, env.deps("wait"));
    expect(result.record).toMatchObject({
      stop: { kind: "tripwire", code: "hard_wall" },
      consumed: { units: 0 }
    });
    await expectGone(await env.pids());
  }, 30_000);

  it("stops on combined stdout and stderr bytes with no IDs ever emitted", async () => {
    const env = await setup({ hard: { units: 60, wallMs: 20_000, outputBytes: 4000 } });
    const result = await runCheckpoint(env.input, env.deps("noise"));
    expect(result.record).toMatchObject({
      stop: { kind: "tripwire", code: "hard_output" },
      consumed: { units: 0 }
    });
    expect(result.record!.consumed.outputBytes).toBeGreaterThan(4000);
    await expectGone(await env.pids());
  }, 30_000);
});

describe("an uncertain counter is a lower bound and stops", () => {
  it.each([
    "bad_malformed",
    "bad_oversize",
    "bad_missing_id",
    "bad_dup_key",
    "bad_id",
    "bad_utf8",
    "unterminated"
  ])(
    "%s",
    async (scenario) => {
      const env = await setup({ maxLineBytes: 256 });
      const result = await runCheckpoint(env.input, env.deps(scenario));
      expect(result.exitCode).toBe(3);
      expect(result.record).toMatchObject({
        stop: { kind: "tripwire", code: "counter_uncertain" },
        consumed: { counterState: "lower_bound" }
      });
      // Only the line before the unreadable one was certain; nothing is guessed after it.
      expect(result.record!.consumed.units).toBe(1);
      if (scenario !== "unterminated") await expectGone(await env.pids());
    },
    30_000
  );
});

describe("preflight refuses before anything is spawned", () => {
  const drift: [string, Partial<LeafStatus>][] = [
    ["attempt", { attemptId: "at-9" }],
    ["epoch", { attemptEpoch: 3 }],
    ["content revision", { contentRevision: 4 }],
    ["executor", { executorRef: "someone-else" }],
    ["pins", { attemptPins: "stale" }],
    ["state", { state: "ready" }],
    ["state revision at start", { stateRevision: 5 }]
  ];
  it.each(drift)("a wrong %s", async (_name, over) => {
    const env = await setup();
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", { fetchStatus: async () => statusOf(currentLeaf(over)) })
    );
    expect(result.exitCode).toBe(2);
    expect(result.record).toMatchObject({
      state: "ended",
      stop: { kind: "refused", code: "authority_mismatch" }
    });
    expect(await env.spawns()).toBe(0);
    expect(await env.onDisk()).toEqual(result.record);
  });

  it("an unreachable or invalid plan API", async () => {
    const env = await setup();
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", {
        fetchStatus: async () => {
          throw new Error("down");
        }
      })
    );
    expect(result.record?.stop).toEqual({ kind: "refused", code: "authority_unavailable" });
    expect(await env.spawns()).toBe(0);
    const invalid = await setup({ planApiUrl: "http://example.com:5100" });
    const second = await runCheckpoint(invalid.input, invalid.deps("wait"));
    expect(second.record?.stop).toEqual({ kind: "refused", code: "authority_unavailable" });
  });

  it("pin, worktree and base mismatches", async () => {
    const prompt = await setup({ promptSha256: "0".repeat(64) });
    expect((await runCheckpoint(prompt.input, prompt.deps("wait"))).record?.stop).toEqual({
      kind: "refused",
      code: "pin_mismatch"
    });
    const exe = await setup();
    exe.input.executable.sha256 = "0".repeat(64);
    expect((await runCheckpoint(exe.input, exe.deps("wait"))).record?.stop.code).toBe(
      "pin_mismatch"
    );
    const head = await setup();
    const moved = await runCheckpoint(
      head.input,
      head.deps("wait", { gitHead: async () => "e".repeat(40) })
    );
    expect(moved.record?.stop.code).toBe("pin_mismatch");
    const main = await setup();
    await rm(join(main.input.worktree, ".git"));
    await mkdir(join(main.input.worktree, ".git"));
    expect((await runCheckpoint(main.input, main.deps("wait"))).record?.stop.code).toBe(
      "worktree_invalid"
    );
    for (const env of [prompt, exe, head, main]) expect(await env.spawns()).toBe(0);
  });

  it("an unconfirmed profile flag fails closed with profile_unsupported", async () => {
    const env = await setup();
    const deps = { ...env.deps("wait"), launchArgs: undefined, confirmFlags: async () => false };
    const result = await runCheckpoint(env.input, deps);
    expect(result.record?.stop).toEqual({ kind: "refused", code: "profile_unsupported" });
    expect(await env.spawns()).toBe(0);
  });

  it("a record directory inside the worktree, and an existing run id, are refused without overwrite", async () => {
    const env = await setup();
    const inside = { ...env.input, recordDir: env.input.worktree };
    expect(await runCheckpoint(inside, env.deps("wait"))).toEqual({
      exitCode: 2,
      record: null,
      refusal: "record_dir_invalid"
    });
    const first = await runCheckpoint(env.input, env.deps("ids_repeat"));
    expect(first.exitCode).toBe(0);
    const before = await readFile(budgetRecordPath(env.recordDir, env.input.runId), "utf8");
    const again = await runCheckpoint(env.input, env.deps("ids_repeat"));
    expect(again).toEqual({ exitCode: 2, record: null, refusal: "run_exists" });
    expect(await readFile(budgetRecordPath(env.recordDir, env.input.runId), "utf8")).toBe(before);
    expect(await env.spawns()).toBe(1);
  });
});

describe("authority during the run", () => {
  it("a changed current claim stops the owned worker", async () => {
    const env = await setup();
    let calls = 0;
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", {
        fetchStatus: async () => statusOf(currentLeaf(++calls > 1 ? { attemptEpoch: 3 } : {}))
      })
    );
    expect(result.exitCode).toBe(3);
    expect(result.record?.stop).toEqual({ kind: "tripwire", code: "authority_changed" });
    await expectGone(await env.pids());
  }, 30_000);

  it("an advancing stateRevision or an unreadable authority is not a stop", async () => {
    const env = await setup();
    let calls = 0;
    const result = await runCheckpoint(
      env.input,
      env.deps("slow_ok", {
        fetchStatus: async () => {
          if (++calls === 1) return statusOf(currentLeaf());
          if (calls === 2) throw new Error("outage");
          return statusOf(currentLeaf({ stateRevision: 99 }));
        }
      })
    );
    expect(calls).toBeGreaterThan(2);
    expect(result.record?.stop).toEqual({ kind: "exited", code: "exited" });
    expect(result.record?.identity.observedStateRevision).toBe(4);
  }, 30_000);
});

describe("cancellation and cleanup", () => {
  it("cancels through an AbortSignal and cleans up child and grandchild", async () => {
    const env = await setup();
    const controller = new AbortController();
    const running = runCheckpoint(env.input, env.deps("wait", { signal: controller.signal }));
    const pids = await env.pids();
    controller.abort();
    const result = await running;
    expect(result.exitCode).toBe(3);
    expect(result.record?.stop).toEqual({ kind: "cancelled", code: "cancelled" });
    await expectGone(pids);
  }, 30_000);

  it("does not spawn when already cancelled", async () => {
    const env = await setup();
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", { signal: AbortSignal.abort() })
    );
    expect(result.record?.stop).toEqual({ kind: "cancelled", code: "cancelled" });
    expect(await env.spawns()).toBe(0);
  });

  it("never claims a clean stop when termination fails, and records the root PID", async () => {
    const env = await setup({ hard: { units: 60, wallMs: 300, outputBytes: 1024 * 1024 } });
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", {
        terminator: {
          terminate: async () => {
            throw new Error("taskkill failed");
          }
        }
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.record?.stop).toEqual({ kind: "failed", code: "cleanup_failed" });
    expect(result.record?.rootPid).toBeGreaterThan(0);
    await env.pids();
  }, 30_000);

  it("reports cleanup_failed when a terminator returns but the process never closes", async () => {
    const env = await setup({ hard: { units: 60, wallMs: 300, outputBytes: 1024 * 1024 } });
    const result = await runCheckpoint(
      env.input,
      env.deps("wait", { terminator: { terminate: async () => undefined }, closeGraceMs: 300 })
    );
    expect(result.record?.stop).toEqual({ kind: "failed", code: "cleanup_failed" });
    await processTreeTerminator.terminate({ pid: result.record!.rootPid! } as never);
    await env.pids();
  }, 30_000);

  it("binds and unbinds process signals to the cancel controller", () => {
    const fake = new EventEmitter();
    const controller = new AbortController();
    const unbind = bindProcessSignals(controller, fake as never, ["SIGINT", "SIGTERM"]);
    expect(fake.listenerCount("SIGINT")).toBe(1);
    fake.emit("SIGTERM");
    expect(controller.signal.aborted).toBe(true);
    unbind();
    expect(fake.listenerCount("SIGINT") + fake.listenerCount("SIGTERM")).toBe(0);
    const real = process.listenerCount("SIGINT");
    bindProcessSignals(new AbortController())();
    expect(process.listenerCount("SIGINT")).toBe(real);
  });
});

describe("no autorun, retry, mutation or leaked content", () => {
  it("spawns exactly once, writes only its own record and uses only the injected read", async () => {
    const env = await setup({ hard: { units: 60, wallMs: 300, outputBytes: 1024 * 1024 } });
    let fetches = 0;
    await runCheckpoint(
      env.input,
      env.deps("wait", {
        fetchStatus: async () => {
          fetches++;
          return statusOf(currentLeaf());
        }
      })
    );
    await delay(300);
    expect(await env.spawns()).toBe(1);
    expect(await readdir(env.recordDir)).toEqual([`${env.input.runId}.budget.json`]);
    expect(fetches).toBeGreaterThan(0);
    await env.pids();
  }, 30_000);

  it("keeps prompt, assistant text, tool results, stderr and result text out of the record", async () => {
    const env = await setup();
    const result = await runCheckpoint(env.input, env.deps("privacy"));
    expect(result.record?.providerReported).toMatchObject({ numTurns: 1, costUsd: 0.5 });
    const files = await Promise.all(
      (await readdir(env.recordDir)).map((f) => readFile(join(env.recordDir, f), "utf8"))
    );
    const everything = files.join("") + JSON.stringify(result);
    for (const sentinel of [
      "PROMPT_SENTINEL",
      "TOOL_SENTINEL",
      "STDERR_SENTINEL",
      "RESULT_SENTINEL",
      env.base
    ])
      expect(everything).not.toContain(sentinel);
  });
});

describe("profile constants", () => {
  it("grants read and search tools only for the smoke and file edit tools only for coding", () => {
    expect(PROFILE_TOOLS).toEqual({
      readonly_smoke: "Read,Grep,Glob",
      coding: "Read,Grep,Glob,Edit,Write"
    });
    for (const profile of ["readonly_smoke", "coding"] as const) {
      const args = profileArgs(profile, "claude-sonnet-5-5");
      expect(args).toEqual([
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-sonnet-5-5",
        "--tools",
        PROFILE_TOOLS[profile],
        "--allowedTools",
        PROFILE_TOOLS[profile]
      ]);
      expect(args.join(" ")).not.toMatch(/Bash|--max-turns|dangerously|bypass|mcp/i);
    }
    expect(profileArgs("coding", "m", 2.5).slice(-2)).toEqual(["--max-budget-usd", "2.5"]);
  });

  it("records a configured provider cap as unverified, not as ChatAgent enforcement", async () => {
    const env = await setup({ providerUsdCap: 2.5 });
    const result = await runCheckpoint(env.input, env.deps("ids_repeat"));
    expect(result.record?.cost).toEqual({ enforcement: "provider_cap_configured_unverified" });
    const none = await setup();
    expect((await runCheckpoint(none.input, none.deps("ids_repeat"))).record?.cost).toEqual({
      enforcement: "none"
    });
  });
});

describe("record shape on disk", () => {
  it("is a valid running record while the worker is alive", async () => {
    const env = await setup();
    const controller = new AbortController();
    const running = runCheckpoint(env.input, env.deps("wait", { signal: controller.signal }));
    await env.pids();
    const live: BudgetRecord = await env.onDisk();
    expect(live).toMatchObject({ state: "running", stop: { kind: "none" }, endedAt: null });
    controller.abort();
    await running;
  }, 30_000);
});
