import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContinuationDeps,
  ContinuationManifest,
  ContinuationResult
} from "../../src/checkpoint/checkpointContinuation";
import * as handoff from "../../src/checkpoint/operatorHandoff";
import { SOURCE_REF } from "../helpers/checkpointFixtures";
import { git, makeFixture, type Fixture } from "../helpers/continuationFixtures";

// Test seam: module mocking replaces only the maintained `runContinuation` here, to inject
// controlled results and exceptions. It proves classification and registry rules, nothing about
// the real coordinator; the integration suite delegates to the actual one.
const seam = vi.hoisted(() => ({
  calls: [] as { manifest: unknown; deps: unknown }[],
  run: null as null | ((manifest: unknown, deps: unknown) => Promise<unknown>)
}));
vi.mock("../../src/checkpoint/checkpointContinuation", async (original) => {
  const actual = await original<typeof import("../../src/checkpoint/checkpointContinuation")>();
  return {
    ...actual,
    runContinuation: (manifest: unknown, deps: unknown) => {
      seam.calls.push({ manifest, deps });
      if (!seam.run) throw new Error("seam not armed");
      return seam.run(manifest, deps);
    }
  };
});

const fixtures: Fixture[] = [];
afterEach(async () => {
  seam.calls.length = 0;
  seam.run = null;
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

const STAMP = "2026-01-01T00:00:00.000Z";
const record = (m: ContinuationManifest, over: Record<string, unknown> = {}) => {
  const id = m.run.identity;
  return {
    schema: "checkpoint-continuation/v1",
    runId: m.run.runId,
    identity: {
      rootId: id.rootId,
      nodeId: id.nodeId,
      attemptId: id.attemptId,
      attemptEpoch: id.attemptEpoch,
      contentRevision: id.contentRevision,
      observedStateRevision: id.stateRevision,
      executorRef: id.executorRef
    },
    baseRef: id.baseRef,
    phase: "needs_operator",
    reason: "check_failed",
    startedAt: STAMP,
    updatedAt: STAMP,
    endedAt: STAMP,
    sourceRef: SOURCE_REF,
    worker: null,
    finish: "confirmed",
    checkRole: "mimir_external_checks",
    checks: [],
    gate: "written",
    failureAttribution: "unattributed",
    leadAcceptance: "pending",
    semanticReview: "not_performed",
    delivery: "not_sent",
    wake: "none",
    acknowledgment: "none",
    recordTrust: "supplied_not_authenticated",
    writerLiveness: "unknown",
    ...over
  };
};
const failed = (f: Fixture, over: Record<string, unknown> = {}) =>
  ({ exitCode: 1, record: record(f.manifest, over) }) as unknown as ContinuationResult;

const arm = (result: unknown) => {
  seam.run = async () => result;
};
const expectation = (f: Fixture, over: Partial<handoff.OwnedExpectation> = {}) => ({
  worktree: f.wt,
  runId: f.manifest.run.runId,
  baseRef: f.baseRef,
  sourceRef: SOURCE_REF,
  ...over
});

describe("owned continuation lifecycle (controlled runContinuation)", () => {
  it("is eligible only after the invocation returns, and settles after that return", async () => {
    const f = fixture();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    seam.run = async () => {
      await gate;
      order.push("returned");
      return failed(f);
    };
    const handle = handoff.startOwnedContinuation(f.manifest);
    void handle.settled.then(() => order.push("settled"));
    await Promise.resolve();
    expect(handle.summary().status).toBe("pending");
    expect(await handoff.consumeOwnedContinuation(handle, expectation(f))).toEqual({
      ok: false,
      refusal: "pending"
    });
    release();
    const summary = await handle.settled;
    expect(order).toEqual(["returned", "settled"]);
    expect(summary).toMatchObject({ status: "eligible", outcome: "check_failed", exitCode: 1 });
    expect(seam.calls).toHaveLength(1);
  });

  it("exposes no factory taking a result, record, promise or injected dependencies", async () => {
    const f = fixture();
    expect(Object.keys(handoff).sort()).toEqual([
      "consumeOwnedContinuation",
      "inspectOwnedContinuation",
      "startOwnedContinuation"
    ]);
    arm(failed(f));
    const injected = { runWorker: vi.fn(), workerDeps: {}, post: vi.fn(), prior: {} };
    await handoff.startOwnedContinuation(f.manifest, injected as never).settled;
    expect(seam.calls[0].deps).toEqual({});
    const controller = new AbortController();
    await handoff.startOwnedContinuation(f.manifest, { signal: controller.signal }).settled;
    expect(Object.keys(seam.calls[1].deps as ContinuationDeps)).toEqual(["signal"]);
  });

  it("refuses a caller-fed promise or result as input and never invokes the coordinator", async () => {
    const f = fixture();
    arm(failed(f));
    for (const supplied of [
      Promise.resolve(failed(f)),
      failed(f),
      record(f.manifest),
      () => undefined,
      null
    ]) {
      const summary = await handoff.startOwnedContinuation(supplied).settled;
      expect(summary).toMatchObject({ status: "refused", refusal: "invalid_input" });
    }
    expect(seam.calls).toHaveLength(0);
  });

  it("rejects supplied terminal bytes and structurally identical handles as forged", async () => {
    const f = fixture();
    arm(failed(f));
    const real = handoff.startOwnedContinuation(f.manifest);
    await real.settled;
    const forgeries: unknown[] = [
      failed(f),
      record(f.manifest),
      { ...real },
      Object.create(real),
      { settled: Promise.resolve(real.summary()), summary: () => real.summary() },
      Object.freeze({ settled: real.settled, summary: real.summary }),
      "handle",
      null
    ];
    for (const forged of forgeries)
      expect(await handoff.consumeOwnedContinuation(forged, expectation(f))).toEqual({
        ok: false,
        refusal: "forged"
      });
    expect(await handoff.inspectOwnedContinuation(real, expectation(f))).toMatchObject({
      ok: true
    });
  });

  it("is one-use: inspect leaves the handle intact and a replay is refused", async () => {
    const f = fixture();
    arm(failed(f));
    const handle = handoff.startOwnedContinuation(f.manifest);
    await handle.settled;
    expect(await handoff.inspectOwnedContinuation(handle, expectation(f))).toMatchObject({
      ok: true
    });
    const first = await handoff.consumeOwnedContinuation(handle, expectation(f));
    expect(first).toMatchObject({
      ok: true,
      provenance: { outcome: "check_failed", authorizesSourceMutation: false }
    });
    expect(handle.summary().status).toBe("consumed");
    for (const again of await Promise.all([
      handoff.consumeOwnedContinuation(handle, expectation(f)),
      handoff.inspectOwnedContinuation(handle, expectation(f))
    ]))
      expect(again).toEqual({ ok: false, refusal: "consumed" });
  });

  it("lets only one of two concurrent consumers win", async () => {
    const f = fixture();
    arm(failed(f));
    const handle = handoff.startOwnedContinuation(f.manifest);
    await handle.settled;
    const results = await Promise.all([
      handoff.consumeOwnedContinuation(handle, expectation(f)),
      handoff.consumeOwnedContinuation(handle, expectation(f))
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses foreign or stale expectations without consuming", async () => {
    const f = fixture();
    arm(failed(f));
    const handle = handoff.startOwnedContinuation(f.manifest);
    await handle.settled;
    const cases: [Partial<handoff.OwnedExpectation>, string][] = [
      [{ worktree: f.main }, "worktree_mismatch"],
      [{ worktree: `${f.wt}-missing` }, "worktree_mismatch"],
      [{ runId: "22222222-2222-4222-8222-222222222222" }, "run_mismatch"],
      [{ baseRef: "e".repeat(40) }, "base_mismatch"],
      [{ sourceRef: "f".repeat(40) }, "source_mismatch"]
    ];
    for (const [over, refusal] of cases)
      expect(await handoff.consumeOwnedContinuation(handle, expectation(f, over))).toEqual({
        ok: false,
        refusal
      });
    expect(handle.summary().status).toBe("eligible");
    expect(await handoff.consumeOwnedContinuation(handle, expectation(f))).toMatchObject({
      ok: true
    });
  });

  it("keeps its private binding when the original manifest and the summary are mutated", async () => {
    const f = fixture();
    arm(failed(f));
    const original = { runId: f.manifest.run.runId, worktree: f.manifest.run.worktree };
    const handle = handoff.startOwnedContinuation(f.manifest);
    f.manifest.run.runId = "33333333-3333-4333-8333-333333333333";
    f.manifest.run.worktree = f.main;
    f.manifest.run.identity.baseRef = "9".repeat(40);
    const summary = handle.summary() as { -readonly [K in keyof handoff.OwnedSummary]: unknown };
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Reflect.set(summary, "status", "eligible")).toBe(false);
    expect(Reflect.set(summary, "sourceRef", "a".repeat(40))).toBe(false);
    await handle.settled;
    const sent = seam.calls[0].manifest as ContinuationManifest;
    expect(sent.run.runId).toBe(original.runId);
    const mutated = expectation(f, { runId: f.manifest.run.runId, worktree: f.main });
    expect(await handoff.inspectOwnedContinuation(handle, mutated)).toMatchObject({ ok: false });
    expect(
      await handoff.consumeOwnedContinuation(handle, {
        ...expectation(f),
        runId: original.runId,
        worktree: original.worktree
      })
    ).toMatchObject({ ok: true, provenance: { runId: original.runId } });
  });

  it("settles refused, never rejecting, when the invocation throws or rejects", async () => {
    const f = fixture();
    seam.run = () => {
      throw new Error("sync boom");
    };
    expect(await handoff.startOwnedContinuation(f.manifest).settled).toMatchObject({
      status: "refused",
      refusal: "invocation_threw"
    });
    seam.run = () => Promise.reject(new Error("async boom"));
    const handle = handoff.startOwnedContinuation(f.manifest);
    expect(await handle.settled).toMatchObject({ status: "refused", refusal: "invocation_threw" });
    expect(await handoff.consumeOwnedContinuation(handle, expectation(f))).toEqual({
      ok: false,
      refusal: "refused"
    });
  });

  it("settles refused when the worktree cannot be canonicalized and does not invoke", async () => {
    const f = fixture();
    arm(failed(f));
    const manifest = structuredClone(f.manifest);
    manifest.run.worktree = `${f.wt}-missing`;
    expect(await handoff.startOwnedContinuation(manifest).settled).toMatchObject({
      status: "refused",
      refusal: "worktree_uncertain"
    });
    expect(seam.calls).toHaveLength(0);
  });
});

describe("terminal classification (controlled results; forged-policy counterexamples)", () => {
  const cases: [string, (f: Fixture) => unknown, string][] = [
    ["a null record with exit 1", () => ({ exitCode: 1, record: null }), "no_record"],
    [
      "a refusal result",
      () => ({ exitCode: 2, record: null, refusal: "worktree_invalid" }),
      "persistence_or_refusal"
    ],
    [
      "a refusal carried on an otherwise exact failed record",
      (f) => ({ ...(failed(f) as object), refusal: "cleanup_failed" }),
      "persistence_or_refusal"
    ],
    [
      "exit 4 with an exact failed record",
      (f) => ({ ...(failed(f) as object), exitCode: 4 }),
      "persistence_or_refusal"
    ],
    ["cleanup_failed", (f) => failed(f, { reason: "cleanup_failed" }), "outcome_excluded"],
    ["lease_changed", (f) => failed(f, { reason: "lease_changed" }), "outcome_excluded"],
    ["internal_error", (f) => failed(f, { reason: "internal_error" }), "outcome_excluded"],
    ["an abort", (f) => failed(f, { reason: "cancelled", gate: "not_written" }), "closure_not_clean"],
    ["a deadline", (f) => failed(f, { reason: "deadline_exceeded" }), "outcome_excluded"],
    ["an unavailable check", (f) => failed(f, { reason: "check_unavailable" }), "outcome_excluded"],
    ["an unknown finish", (f) => failed(f, { finish: "attempted" }), "closure_not_clean"],
    ["no gate", (f) => failed(f, { gate: "not_written" }), "closure_not_clean"],
    ["no source", (f) => failed(f, { sourceRef: null }), "closure_not_clean"],
    [
      "a non-terminal phase",
      (f) => failed(f, { phase: "verifying", reason: "in_progress", endedAt: null, gate: "not_written" }),
      "closure_not_clean"
    ],
    [
      "a different run",
      (f) => failed(f, { runId: "44444444-4444-4444-8444-444444444444" }),
      "record_mismatch"
    ],
    ["a different base", (f) => failed(f, { baseRef: "8".repeat(40) }), "record_mismatch"],
    [
      "a different fence",
      (f) => failed(f, { identity: { ...(record(f.manifest).identity as object), attemptEpoch: 99 } }),
      "record_mismatch"
    ],
    [
      "exit 0 over a failed-check record",
      (f) => ({ ...(failed(f) as object), exitCode: 0 }),
      "outcome_excluded"
    ],
    ["an unparseable record", (f) => failed(f, { extra: true }), "no_record"]
  ];
  it.each(cases)("refuses %s", async (_name, build, refusal) => {
    const f = fixture();
    arm(build(f));
    const handle = handoff.startOwnedContinuation(f.manifest);
    expect(await handle.settled).toMatchObject({ status: "refused", refusal });
    expect(await handoff.consumeOwnedContinuation(handle, expectation(f))).toEqual({
      ok: false,
      refusal: "refused"
    });
  });

  it("negative control: the exact failed-check record is the one accepted shape here", async () => {
    const f = fixture();
    arm(failed(f));
    const handle = handoff.startOwnedContinuation(f.manifest);
    expect(await handle.settled).toMatchObject({
      status: "eligible",
      sourceRef: SOURCE_REF,
      baseRef: f.baseRef
    });
  });
});
