import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  continuationRecordPath,
  runContinuation
} from "../../src/checkpoint/checkpointContinuation";
import { RUN_ID } from "../helpers/checkpointFixtures";
import { git, makeFixture, type Fixture } from "../helpers/continuationFixtures";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    git(f.main, "worktree", "remove", "--force", f.wt);
    await rm(f.root, { recursive: true, force: true });
  }
});
const fixture = () => {
  const f = makeFixture();
  fixtures.push(f);
  return f;
};
const stored = async (f: Fixture) =>
  JSON.parse(await readFile(continuationRecordPath(f.rec, RUN_ID), "utf8"));

describe("independent continuation authority review", () => {
  it.each([{ gatesHold: false }, { upstreamChanged: true }])(
    "stops before the candidate when dependency authority changes after worker exit: %j",
    async (patch) => {
      const f = fixture();
      const deps = f.deps();
      const original = deps.runWorker!;
      deps.runWorker = async (input, workerDeps) => {
        const result = await original(input, workerDeps);
        f.plan.leaf = { ...f.plan.leaf, ...patch };
        return result;
      };
      expect((await runContinuation(f.manifest, deps)).exitCode).toBe(1);
      expect(await stored(f)).toMatchObject({
        phase: "needs_operator",
        reason: "authority_changed",
        sourceRef: null
      });
      expect(git(f.wt, "rev-parse", "HEAD")).toBe(f.baseRef);
      expect(f.plan.posts).toHaveLength(0);
      expect(f.toolLog()).toHaveLength(0);
    },
    120_000
  );

  it("does not verify or gate a finished attempt with a changed executor", async () => {
    const f = fixture();
    f.plan.onPost = () => {
      f.plan.leaf = { ...f.plan.leaf, executorRef: "other-executor" };
    };
    expect((await runContinuation(f.manifest, f.deps())).exitCode).toBe(1);
    expect(await stored(f)).toMatchObject({
      phase: "needs_operator",
      reason: "finish_unconfirmed",
      gate: "not_written"
    });
    expect(f.plan.posts).toHaveLength(1);
    expect(f.toolLog()).toHaveLength(0);
  }, 120_000);
});
