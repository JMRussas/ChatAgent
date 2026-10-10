import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeOwnedContinuation,
  startOwnedContinuation,
  type OwnedExpectation
} from "../../src/checkpoint/operatorHandoff";
import { git, makeFixture, type Fixture } from "../helpers/continuationFixtures";

// Test seam: module mocking only supplies the fixture-owned trusted dependencies (actual Git,
// scripted CLI, stub verifiers, PlanStub) to the ACTUAL `runContinuation`. The production factory
// accepts no dependencies. This proves nothing about a real provider or retained store.
const seam = vi.hoisted(() => ({
  deps: {} as import("../../src/checkpoint/checkpointContinuation").ContinuationDeps
}));
vi.mock("../../src/checkpoint/checkpointContinuation", async (original) => {
  const actual = await original<typeof import("../../src/checkpoint/checkpointContinuation")>();
  return {
    ...actual,
    runContinuation: (manifest: never, deps: object) =>
      actual.runContinuation(manifest, { ...seam.deps, ...deps })
  };
});

const T = 120_000;
const fixtures: Fixture[] = [];
afterEach(async () => {
  seam.deps = {};
  for (const f of fixtures.splice(0)) {
    git(f.main, "worktree", "remove", "--force", f.wt);
    await rm(f.root, { recursive: true, force: true });
  }
});
const fixture = () => {
  const f = makeFixture();
  fixtures.push(f);
  seam.deps = f.deps();
  return f;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Bounded poll for an externally observable condition; never a sleep used as proof. */
const until = async (condition: () => Promise<boolean>, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not observed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const expectation = (f: Fixture, sourceRef: string): OwnedExpectation => ({
  worktree: f.wt,
  runId: f.manifest.run.runId,
  baseRef: f.baseRef,
  sourceRef
});
const tree = (f: Fixture) => [git(f.wt, "rev-parse", "HEAD"), git(f.wt, "status", "--porcelain")];

describe("owned continuation with real subprocesses", () => {
  it(
    "stays pending while the external verifier is held and settles only after its tree closed",
    async () => {
      const f = fixture();
      f.setMode("typescript", "hang");
      const controller = new AbortController();
      const handle = startOwnedContinuation(f.manifest, { signal: controller.signal });
      let settled = false;
      void handle.settled.then(() => (settled = true));
      const pidFile = join(f.root, "hang-typescript.pids");
      await until(() =>
        access(pidFile).then(
          () => true,
          () => false
        )
      );
      const pids = JSON.parse(await readFile(pidFile, "utf8"));
      expect(alive(pids.child)).toBe(true);
      const before = tree(f);

      // Nothing supplied or fabricated while the real invocation is still running can bypass it.
      const expected = expectation(f, before[0]);
      for (const bypass of [{ ...handle }, { settled: Promise.resolve(handle.summary()) }])
        expect(await consumeOwnedContinuation(bypass, expected)).toEqual({
          ok: false,
          refusal: "forged"
        });
      expect(await consumeOwnedContinuation(handle, expected)).toEqual({
        ok: false,
        refusal: "pending"
      });
      expect(handle.summary().status).toBe("pending");
      expect(settled).toBe(false);
      expect(tree(f)).toEqual(before);

      controller.abort();
      const summary = await handle.settled;
      // The notification fired only after the root verifier and its descendants were gone.
      expect(alive(pids.child)).toBe(false);
      expect(alive(pids.grand)).toBe(false);
      expect(summary.status).toBe("refused");
      expect(await consumeOwnedContinuation(handle, expected)).toEqual({
        ok: false,
        refusal: "refused"
      });
    },
    T
  );

  it(
    "a genuinely failed external check is eligible once, bound to the exact source",
    async () => {
      const f = fixture();
      f.setMode("vitest", "fail");
      const handle = startOwnedContinuation(f.manifest);
      const summary = await handle.settled;
      const head = git(f.wt, "rev-parse", "HEAD");
      expect(summary).toMatchObject({
        status: "eligible",
        outcome: "check_failed",
        exitCode: 1,
        sourceRef: head,
        baseRef: f.baseRef
      });
      expect(head).not.toBe(f.baseRef);

      const stale = { ...expectation(f, head), sourceRef: f.baseRef };
      expect(await consumeOwnedContinuation(handle, stale)).toEqual({
        ok: false,
        refusal: "source_mismatch"
      });
      expect(
        await consumeOwnedContinuation(handle, { ...expectation(f, head), worktree: f.main })
      ).toEqual({ ok: false, refusal: "worktree_mismatch" });
      expect(
        await consumeOwnedContinuation(handle, {
          ...expectation(f, head),
          runId: "55555555-5555-4555-8555-555555555555"
        })
      ).toEqual({ ok: false, refusal: "run_mismatch" });

      const before = tree(f);
      const consumed = await consumeOwnedContinuation(handle, expectation(f, head));
      expect(consumed).toMatchObject({
        ok: true,
        provenance: { sourceRef: head, authorizesSourceMutation: false }
      });
      expect(tree(f)).toEqual(before);
      expect(await consumeOwnedContinuation(handle, expectation(f, head))).toEqual({
        ok: false,
        refusal: "consumed"
      });
    },
    T
  );

  it(
    "a fully passing run is eligible as checks_passed",
    async () => {
      const f = fixture();
      const handle = startOwnedContinuation(f.manifest);
      expect(await handle.settled).toMatchObject({
        status: "eligible",
        outcome: "checks_passed",
        exitCode: 0
      });
    },
    T
  );

  it(
    "a failed pre-run refusal from the actual coordinator is never eligible",
    async () => {
      const f = fixture();
      f.manifest.run.identity.baseRef = "a".repeat(40);
      const handle = startOwnedContinuation(f.manifest);
      expect(await handle.settled).toMatchObject({ status: "refused", exitCode: 2 });
      expect(await consumeOwnedContinuation(handle, expectation(f, "a".repeat(40)))).toEqual({
        ok: false,
        refusal: "refused"
      });
    },
    T
  );
});
