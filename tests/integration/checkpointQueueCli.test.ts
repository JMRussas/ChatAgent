import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runQueueCli, type QueueCliDeps } from "../../scripts/checkpointQueue";
import { ledgerPath, lockPath, parseLedger } from "../../src/integrations/hekate/checkpointQueue";
import type { CoordinationStatus } from "../../src/integrations/hekate/devCoordination";
import { FENCE, SOURCE_REF, STAMP, makeRecord } from "../helpers/checkpointFixtures";
import { ROOT_A, guid, leaf } from "../helpers/executiveFixtures";

const QUEUE = guid(9);
const FENCED = { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3, artifactRef: SOURCE_REF };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Setup {
  dir: string;
  manifest: string;
  deps: QueueCliDeps;
  requests: string[];
  leaves: ReturnType<typeof leaf>[];
}

async function setup(label = "ready task"): Promise<Setup> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "ckpt-queue-"));
  dirs.push(dir);
  const reviewPath = join(dir, "review.budget.json");
  const runningPath = join(dir, "running.budget.json");
  const ended = makeRecord({ identity: { ...FENCE, nodeId: guid(100, 2), observedStateRevision: 4, executorRef: "e" } });
  const live = makeRecord({
    runId: guid(7),
    identity: { ...FENCE, nodeId: guid(100, 3), observedStateRevision: 4, executorRef: "e" },
    state: "running",
    stop: { kind: "none", code: "none" },
    exit: null,
    endedAt: null
  });
  await writeFile(reviewPath, JSON.stringify(ended));
  await writeFile(runningPath, JSON.stringify(live));
  const entry = (n: number, text: string, expected: object, recordPath: string | null) => ({
    entryId: guid(10 + n),
    rootId: ROOT_A,
    nodeId: guid(100, n),
    label: text,
    expected,
    recordPath
  });
  const fenced = { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3 };
  const manifestFile = join(dir, "queue.manifest.json");
  await writeFile(
    manifestFile,
    JSON.stringify({
      schema: "checkpoint-queue-manifest/v1",
      queueId: QUEUE,
      planApiUrl: "http://127.0.0.1:5000",
      ledgerDir: dir,
      entries: [
        entry(1, label, { attemptId: null, attemptEpoch: 0, contentRevision: 1 }, null),
        entry(2, "review task", fenced, reviewPath),
        entry(3, "running task", fenced, runningPath)
      ]
    })
  );
  const leaves = [leaf(1, "ready"), leaf(2, "in_progress", FENCED), leaf(3, "in_progress", FENCED)];
  const requests: string[] = [];
  const deps: QueueCliDeps = {
    now: () => new Date(STAMP),
    fetchStatus: async (url, rootId) => {
      requests.push(`GET ${url} ${rootId}`);
      return { status: "ok", rootId, leaves } as unknown as CoordinationStatus;
    }
  };
  return { dir, manifest: manifestFile, deps, requests, leaves };
}

const evaluate = (s: Setup, extra: QueueCliDeps = {}) =>
  runQueueCli(["--manifest", s.manifest, "--evaluate"], { ...s.deps, ...extra });
const show = (s: Setup) => runQueueCli(["--show", "--manifest", s.manifest], {});
const files = async (dir: string) => (await readdir(dir)).sort();

describe("checkpointQueue CLI", () => {
  it("publishes, reports every affected entry and fetches each root once", async () => {
    const s = await setup();
    const result = await evaluate(s);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([]);
    const text = result.stdout.join("\n");
    expect(text).toContain("outcome review_required");
    expect(text).toContain("state ready_unclaimed reason prepare_or_claim_outside_tool");
    expect(text).toContain("state review_pending reason awaiting_independent_review");
    expect(text).toContain("state running_recorded reason liveness_unknown");
    expect(text).toContain("delivery not_sent; notification none; wake none; acknowledgment none");
    expect(s.requests).toEqual([`GET http://127.0.0.1:5000 ${ROOT_A}`]);
    const names = await files(s.dir);
    expect(names).toContain(`${QUEUE}.queue.json`);
    expect(names.filter((n) => n.endsWith(".lock") || n.endsWith(".tmp"))).toEqual([]);
    const stored = await readFile(ledgerPath(s.dir, QUEUE), "utf8");
    expect(stored.endsWith("}\n")).toBe(true);
    expect(parseLedger(Buffer.from(stored)).generation).toBe(1);
    expect(stored).not.toContain("987654321");
  });

  it("increases generation, preserves stateSince, and show prints it without an API read", async () => {
    const s = await setup();
    await evaluate(s);
    const first = parseLedger(await readFile(ledgerPath(s.dir, QUEUE)));
    await evaluate(s, { now: () => new Date("2026-10-09T12:00:00.000Z") });
    const second = parseLedger(await readFile(ledgerPath(s.dir, QUEUE)));
    expect(second.generation).toBe(2);
    expect(second.evaluatedAt).toBe("2026-10-09T12:00:00.000Z");
    expect(second.entries.map((e) => e.stateSince)).toEqual(first.entries.map((e) => e.stateSince));
    const requestsBefore = s.requests.length;
    const shown = await show(s);
    expect(shown.exitCode).toBe(1);
    expect(shown.stdout.join("\n")).toContain("retained observation, not current state");
    expect(shown.stdout.join("\n")).toContain("generation 2");
    expect(s.requests.length).toBe(requestsBefore);

    // A changed observation resets state metadata.
    s.leaves[0] = leaf(1, "blocked");
    await evaluate(s, { now: () => new Date("2026-10-09T13:00:00.000Z") });
    const third = parseLedger(await readFile(ledgerPath(s.dir, QUEUE)));
    expect(third.entries[0]).toMatchObject({
      state: "blocked",
      firstSeenAt: first.entries[0].firstSeenAt,
      stateSince: "2026-10-09T13:00:00.000Z"
    });
    expect(third.entries[1].stateSince).toBe(first.entries[1].stateSince);
  });

  it("exits 0 only when every entry has a current accepted decision", async () => {
    const s = await setup();
    const accepted = (n: number) =>
      leaf(n, "accepted", {
        ...FENCED,
        acceptance: { decision: "accepted", contentRevision: 3, artifactRef: SOURCE_REF, attemptId: "at-1", attemptEpoch: 2, decidedBy: "lead", evidenceRef: null }
      });
    s.leaves.splice(0, 3, accepted(1), accepted(2), accepted(3));
    // Entry 1 still expects a null attempt, so its accepted decision is on a moved fence.
    expect((await evaluate(s)).exitCode).toBe(1);
    expect(parseLedger(await readFile(ledgerPath(s.dir, QUEUE))).entries[0].reason).toBe("fence_moved");
    const fenced = '{"attemptId":"at-1","attemptEpoch":2,"contentRevision":3}';
    const nullFence = '{"attemptId":null,"attemptEpoch":0,"contentRevision":1}';
    await writeFile(s.manifest, (await readFile(s.manifest, "utf8")).replace(nullFence, fenced));
    await rm(ledgerPath(s.dir, QUEUE));
    const clean = await evaluate(s);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout.join("\n")).toContain("outcome all_accepted");
    expect((await show(s)).exitCode).toBe(0);
  });

  it("refuses a held or crash-retained lock without touching it", async () => {
    const s = await setup();
    await writeFile(lockPath(s.dir, QUEUE), "someone-else\n");
    const result = await evaluate(s);
    expect(result).toMatchObject({ exitCode: 4, stderr: ["checkpointQueue: LOCK_BUSY"] });
    expect(await readFile(lockPath(s.dir, QUEUE), "utf8")).toBe("someone-else\n");
    expect(s.requests).toEqual([]);
    expect(await files(s.dir)).not.toContain(`${QUEUE}.queue.json`);
  });

  it("retains a lock whose token was replaced and reports it", async () => {
    const s = await setup();
    const result = await evaluate(s, {
      io: {
        link: async (from, to) => {
          await writeFile(lockPath(s.dir, QUEUE), "replaced\n");
          const { link } = await import("node:fs/promises");
          return link(from, to);
        }
      }
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr.join("\n")).toContain("lock_token_changed");
    expect(await readFile(lockPath(s.dir, QUEUE), "utf8")).toBe("replaced\n");
  });

  it.each([
    ["malformed", "{not json"],
    ["wrong schema", JSON.stringify({ schema: "checkpoint-queue/v2" })],
    ["oversized", " ".repeat(70 * 1024)]
  ])("refuses a %s prior ledger without overwriting it", async (_name, bytes) => {
    const s = await setup();
    await writeFile(ledgerPath(s.dir, QUEUE), bytes);
    const result = await evaluate(s);
    expect(result.exitCode).toBe(4);
    expect(result.stderr[0]).toMatch(/LEDGER_(INVALID|UNSUPPORTED_SCHEMA|TOO_LARGE)/);
    expect(await readFile(ledgerPath(s.dir, QUEUE), "utf8")).toBe(bytes);
    expect((await files(s.dir)).filter((n) => /\.(lock|tmp)$/.test(n))).toEqual([]);
    expect((await show(s)).exitCode).toBe(4);
  });

  it("requires a new queue id when the manifest changes", async () => {
    const s = await setup();
    await evaluate(s);
    const before = await readFile(ledgerPath(s.dir, QUEUE), "utf8");
    const changed = (await readFile(s.manifest, "utf8")).replace("ready task", "renamed task");
    await writeFile(s.manifest, changed);
    for (const result of [await evaluate(s), await show(s)])
      expect(result).toMatchObject({ exitCode: 4, stderr: ["checkpointQueue: LEDGER_MANIFEST_CHANGED"] });
    expect(await readFile(ledgerPath(s.dir, QUEUE), "utf8")).toBe(before);
  });

  it("refuses publication when the ledger moved after observation", async () => {
    const s = await setup();
    await evaluate(s);
    const result = await evaluate(s, {
      io: {
        open: (async (path: string, flags?: string, mode?: number) => {
          const handle = await (await import("node:fs/promises")).open(path, flags as string, mode);
          if (String(path).endsWith(".tmp"))
            await writeFile(ledgerPath(s.dir, QUEUE), "externally changed");
          return handle;
        }) as never
      }
    });
    expect(result).toMatchObject({ exitCode: 4, stderr: ["checkpointQueue: LEDGER_MOVED"] });
    expect(await readFile(ledgerPath(s.dir, QUEUE), "utf8")).toBe("externally changed");
    expect((await files(s.dir)).filter((n) => /\.(lock|tmp)$/.test(n))).toEqual([]);
  });

  it("refuses a racing initial creator without replacing it", async () => {
    const s = await setup();
    const result = await evaluate(s, {
      io: {
        open: (async (path: string, flags?: string, mode?: number) => {
          const handle = await (await import("node:fs/promises")).open(path, flags as string, mode);
          if (String(path).endsWith(".tmp")) await writeFile(ledgerPath(s.dir, QUEUE), "racer");
          return handle;
        }) as never
      }
    });
    expect(result).toMatchObject({ exitCode: 4, stderr: ["checkpointQueue: LEDGER_MOVED"] });
    expect(await readFile(ledgerPath(s.dir, QUEUE), "utf8")).toBe("racer");
  });

  it("never publishes after the deadline and cleans its own temp and lock", async () => {
    const s = await setup();
    let clock = 0;
    let wrote = false;
    const result = await evaluate(s, {
      monotonicMs: () => clock,
      io: {
        open: (async (path: string, flags?: string, mode?: number) => {
          if (String(path).endsWith(".tmp")) wrote = true;
          return (await import("node:fs/promises")).open(path, flags as string, mode);
        }) as never,
        lstat: (async (path: string) => {
          if (wrote && String(path).endsWith(".queue.json")) clock = 60_000;
          return (await import("node:fs/promises")).lstat(path);
        }) as never
      }
    });
    expect(result).toMatchObject({ exitCode: 4, stderr: ["checkpointQueue: DEADLINE"] });
    expect(await files(s.dir)).not.toContain(`${QUEUE}.queue.json`);
    expect((await files(s.dir)).filter((n) => /\.(lock|tmp)$/.test(n))).toEqual([]);
  });

  it("explains an unreachable plan rather than carrying old data", async () => {
    const s = await setup();
    await evaluate(s);
    const result = await evaluate(s, {
      fetchStatus: async () => {
        throw new Error("down");
      }
    });
    expect(result.exitCode).toBe(1);
    const ledger = parseLedger(await readFile(ledgerPath(s.dir, QUEUE)));
    expect(ledger.outcome).toBe("unobservable");
    expect(ledger.entries.every((e) => e.reason === "plan_unavailable" && e.observed === null)).toBe(true);
    expect(ledger.entries.every((e) => e.runId === null && e.gate.state === "none")).toBe(true);
  });

  it("refuses usage and configuration errors with codes only", async () => {
    const s = await setup();
    for (const argv of [[], ["--evaluate"], ["--manifest", s.manifest], ["--manifest", s.manifest, "--evaluate", "--show"], ["--manifest", s.manifest, "--once"]])
      expect((await runQueueCli(argv, {})).exitCode).toBe(2);
    const bad = join(s.dir, "bad.json");
    await writeFile(bad, JSON.stringify({ schema: "checkpoint-queue-manifest/v1", secret: "do-not-echo" }));
    const result = await runQueueCli(["--manifest", bad, "--evaluate"], s.deps);
    expect(result).toMatchObject({ exitCode: 2, stderr: ["checkpointQueue: MANIFEST_INVALID"] });
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
    expect((await runQueueCli(["--manifest", join(s.dir, "missing.json"), "--show"], {})).exitCode).toBe(2);
  });
});
