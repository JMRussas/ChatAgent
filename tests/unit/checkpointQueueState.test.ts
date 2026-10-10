import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContinuationManifest } from "../../src/checkpoint/checkpointContinuation";
import {
  QUEUE_LIMITS,
  initialRecord,
  parseQueueManifest,
  parseQueueRecord,
  providerCapMicros,
  readyToStart,
  resumable,
  reviewVerdict,
  serializeQueueRecord,
  startOperationKey,
  startRequestBody,
  startedAtFrozenFence,
  todoAtFrozenFence,
  validateQueueItems,
  withTransition,
  type QueueManifest,
  type QueueRecord
} from "../../src/checkpoint/checkpointQueueState";
import { BASE_REF, SOURCE_REF, OTHER_REF } from "../helpers/checkpointFixtures";
import { guid, leaf } from "../helpers/executiveFixtures";

const STAMP = "2026-10-09T10:00:00.000Z";
const sha = (c: string) => c.repeat(64);

function manifest(
  n: number,
  over: Partial<ContinuationManifest["run"]> = {}
): ContinuationManifest {
  return {
    schema: "checkpoint-continuation-run/v1",
    run: {
      schema: "checkpoint-run/v1",
      runId: guid(300, n),
      unit: "assistant_message_ids_distinct/v1",
      profile: "coding",
      identity: {
        rootId: guid(1),
        nodeId: guid(100, n),
        attemptId: `at-${n}`,
        attemptEpoch: 1,
        contentRevision: 1,
        stateRevision: 1,
        executorRef: "exec-1",
        baseRef: BASE_REF
      },
      executable: { path: resolve("/q/node"), sha256: sha("a") },
      gitExecutable: { path: resolve("/q/git"), sha256: sha("b") },
      worktree: resolve(`/q/wt${n}`),
      promptFile: resolve(`/q/prompt${n}`),
      promptSha256: sha("c"),
      recordDir: resolve(`/q/rec${n}`),
      model: "m",
      expected: { units: 5 },
      hard: { units: 10, wallMs: 60_000, outputBytes: 1_000_000 },
      providerUsdCap: 0.1,
      planApiUrl: "http://127.0.0.1:5000",
      ...over
    },
    files: [`src/item${n}.ts`],
    focusedTests: ["tests/a.test.ts"],
    nodeExecutable: { path: resolve("/q/node"), sha256: sha("a") },
    toolingSha256: { prettier: sha("d"), typescript: sha("e"), vitest: sha("f") },
    limits: { wallMs: 180_000, verifierWallMs: 60_000, verifierOutputBytes: 1_000_000 }
  };
}

function queueManifest(count = 2): QueueManifest {
  return {
    schema: "checkpoint-queue-service-manifest/v1",
    queueId: guid(400, 1),
    queueDir: resolve("/q/queue"),
    planApiUrl: "http://127.0.0.1:5000",
    actor: "queue-operator",
    acceptors: ["lead-reviewer"],
    items: Array.from({ length: count }, (_, i) => ({
      manifestPath: resolve(`/q/item${i + 1}.json`),
      manifestSha256: sha("1")
    })),
    limits: {
      wallMs: 600_000,
      pollMs: 1000,
      reviewWaitMs: 60_000,
      totalUnits: 40,
      totalOutputBytes: 8_000_000,
      totalProviderCapMicros: 1_000_000
    }
  };
}

const FENCE = manifest(1).run.identity;

describe("frozen start fence", () => {
  const todo = (over = {}) =>
    leaf(1, "ready", { attemptEpoch: 0, stateRevision: 0, contentRevision: 1, ...over });

  it("accepts ready or blocked TODO at the exact previous epoch and revision only", () => {
    expect(todoAtFrozenFence(todo(), FENCE)).toBe(true);
    expect(todoAtFrozenFence(todo({ state: "blocked", gatesHold: false }), FENCE)).toBe(true);
    for (const over of [
      { contentRevision: 2 },
      { attemptEpoch: 1 },
      { attemptEpoch: 2 },
      { stateRevision: 1 },
      { state: "in_progress" },
      { state: "review_pending" },
      { nodeId: guid(100, 9) }
    ])
      expect(todoAtFrozenFence(todo(over), FENCE), JSON.stringify(over)).toBe(false);
    expect(todoAtFrozenFence(undefined, FENCE)).toBe(false);
  });

  it("starts only a ready node with holding gates and no upstream change", () => {
    expect(readyToStart(todo(), FENCE)).toBe(true);
    expect(readyToStart(todo({ state: "blocked", gatesHold: false }), FENCE)).toBe(false);
    expect(readyToStart(todo({ gatesHold: false }), FENCE)).toBe(false);
    expect(readyToStart(todo({ upstreamChanged: true }), FENCE)).toBe(false);
  });

  it("confirms a start only at the AFTER-start revision, epoch and current pins", () => {
    const started = (over = {}) =>
      leaf(1, "in_progress", {
        attemptPins: "current",
        attemptId: "at-1",
        attemptEpoch: 1,
        contentRevision: 1,
        stateRevision: 1,
        executorRef: "exec-1",
        ...over
      });
    expect(startedAtFrozenFence(started(), FENCE)).toBe(true);
    for (const over of [
      { stateRevision: 2 },
      { stateRevision: 0 },
      { attemptEpoch: 2 },
      { attemptId: "other" },
      { executorRef: "other" },
      { attemptPins: "stale" },
      { gatesHold: false },
      { state: "review_pending" }
    ])
      expect(startedAtFrozenFence(started(over), FENCE), JSON.stringify(over)).toBe(false);
  });

  it("binds the POST to the previous revision and a deterministic per-item key", () => {
    const body = JSON.parse(startRequestBody(guid(400, 1), 0, manifest(1).run, "op")) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      to: "in_progress",
      attemptId: "at-1",
      executorRef: "exec-1",
      operationKey: startOperationKey(guid(400, 1), 0, guid(300, 1)),
      expectedStateRevision: 0,
      actor: "op"
    });
    expect(startOperationKey(guid(400, 1), 1, guid(300, 1))).not.toBe(body.operationKey);
  });
});

describe("review verdict", () => {
  const item = {
    nodeId: guid(100, 1),
    attemptId: "at-1",
    attemptEpoch: 1,
    contentRevision: 1,
    executorRef: "exec-1",
    sourceRef: SOURCE_REF
  };
  const base = {
    attemptPins: "current" as const,
    attemptId: "at-1",
    attemptEpoch: 1,
    contentRevision: 1,
    executorRef: "exec-1",
    stateRevision: 2,
    artifactRef: SOURCE_REF
  };
  const accepted = (over = {}, decision = {}) =>
    leaf(1, "accepted", {
      ...base,
      acceptance: {
        decision: "accepted",
        contentRevision: 1,
        artifactRef: SOURCE_REF,
        attemptId: "at-1",
        attemptEpoch: 1,
        decidedBy: "lead-reviewer",
        evidenceRef: null,
        ...decision
      },
      ...over
    });
  const verdict = (l: ReturnType<typeof leaf> | undefined) =>
    reviewVerdict(l, item, ["lead-reviewer"]);

  it("advances only on the exact accepted source by an allowlisted reviewer", () => {
    expect(verdict(accepted())).toBe("accepted");
    expect(verdict(leaf(1, "review_pending", base))).toBe("pending");
  });

  it("never advances on another artifact, epoch, actor, history or moved pins", () => {
    expect(verdict(leaf(1, "review_pending", { ...base, artifactRef: OTHER_REF }))).toBe(
      "artifact_mismatch"
    );
    expect(verdict(accepted({ artifactRef: OTHER_REF }, { artifactRef: OTHER_REF }))).toBe(
      "artifact_mismatch"
    );
    expect(verdict(accepted({ attemptEpoch: 2 }, { attemptEpoch: 2 }))).toBe("moved");
    expect(verdict(accepted({}, { decidedBy: "intruder" }))).toBe("acceptor_not_allowed");
    expect(verdict(accepted({ acceptanceHistorical: true }))).toBe("moved");
    expect(verdict(accepted({ attemptPins: "stale" }))).toBe("moved");
    expect(verdict(accepted({ upstreamChanged: true }))).toBe("moved");
    expect(verdict(accepted({ contentRevision: 2 }))).toBe("moved");
    expect(verdict(leaf(1, "stale", base))).toBe("moved");
    expect(verdict(leaf(1, "rejected", base))).toBe("rejected");
    expect(verdict(undefined)).toBe("moved");
  });
});

describe("queue manifest", () => {
  const text = (value: unknown) => Buffer.from(JSON.stringify(value));

  it("accepts the closed shape and rejects unknown, duplicate and out-of-range fields", () => {
    expect(parseQueueManifest(text(queueManifest())).items).toHaveLength(2);
    expect(() => parseQueueManifest(text({ ...queueManifest(), extra: 1 }))).toThrow();
    const duplicate = JSON.stringify(queueManifest()).replace('"actor"', '"actor":"x","actor"');
    expect(() => parseQueueManifest(Buffer.from(duplicate))).toThrow();
    const bad = (patch: Partial<QueueManifest["limits"]>) =>
      text({ ...queueManifest(), limits: { ...queueManifest().limits, ...patch } });
    expect(() => parseQueueManifest(bad({ pollMs: 999 }))).toThrow();
    expect(() => parseQueueManifest(bad({ wallMs: 7_200_001 }))).toThrow();
    expect(() => parseQueueManifest(bad({ reviewWaitMs: 1_800_001 }))).toThrow();
    expect(() => parseQueueManifest(text({ ...queueManifest(5) }))).toThrow();
    expect(() => parseQueueManifest(text({ ...queueManifest(), acceptors: ["a", "a"] }))).toThrow();
    const remote = text({ ...queueManifest(), planApiUrl: "http://example.com" });
    expect(() => parseQueueManifest(remote)).toThrow();
    expect(() => parseQueueManifest(Buffer.alloc(QUEUE_LIMITS.maxManifestBytes + 1, 32))).toThrow();
  });
});

describe("item validation and admission", () => {
  const queue = queueManifest();
  const two = [manifest(1), manifest(2)];

  it("accepts independent items with distinct worktrees, nodes and scopes", () => {
    expect(validateQueueItems(queue, two)).toBeNull();
  });

  it("rounds provider caps up to micros without float drift", () => {
    expect(providerCapMicros(0.1)).toBe(100_000);
    expect(providerCapMicros(0.0000011)).toBe(2);
    expect(providerCapMicros(1.2345678)).toBe(1_234_568);
  });

  it("refuses shared identity, overlapping scope, wrong API, missing cap and small wall", () => {
    const refuse = (items: ContinuationManifest[], q = queue) => validateQueueItems(q, items);
    expect(refuse([manifest(1), manifest(1)])).toBe("duplicate_identity");
    const overlap = { ...manifest(2), files: ["src/item1.ts"] };
    expect(refuse([manifest(1), overlap])).toBe("scope_overlap");
    const elsewhere = manifest(2, { planApiUrl: "http://127.0.0.1:1" });
    expect(refuse([manifest(1), elsewhere])).toBe("api_url");
    const uncapped = manifest(2, { providerUsdCap: undefined });
    expect(refuse([manifest(1), uncapped])).toBe("cap_missing");
    const stateless = manifest(2);
    stateless.run.identity.stateRevision = 0;
    expect(refuse([manifest(1), stateless])).toBe("template_invalid");
    expect(refuse(two, { ...queue, limits: { ...queue.limits, wallMs: 200_000 } })).toBe(
      "wall_too_small"
    );
    expect(refuse(two, { ...queue, limits: { ...queue.limits, totalUnits: 19 } })).toBe(
      "admission_exceeded"
    );
    const cheap = { ...queue.limits, totalProviderCapMicros: 199_999 };
    expect(refuse(two, { ...queue, limits: cheap })).toBe("admission_exceeded");
    expect(refuse(two, { ...queue, queueDir: resolve("/q/wt1/inside") })).toBe(
      "queue_dir_in_worktree"
    );
  });
});

describe("queue record", () => {
  const fresh = () => initialRecord(queueManifest(), sha("9"), [manifest(1), manifest(2)], STAMP);
  const bytes = (record: unknown) => Buffer.from(JSON.stringify(record));

  it("round-trips the initial record with fixed trust fields", () => {
    const record = fresh();
    expect(parseQueueRecord(Buffer.from(serializeQueueRecord(record)))).toEqual(record);
    expect(record).toMatchObject({
      recordTrust: "supplied_not_authenticated",
      writerLiveness: "unknown",
      semanticReview: "not_performed",
      delivery: "not_sent",
      wake: "none",
      integration: "not_observed",
      providerCap: "configured_enforcement_unverified"
    });
  });

  it("rejects unknown fields, inconsistent admission and out-of-order item states", () => {
    const record = fresh();
    expect(parseQueueRecord(bytes({ ...record, prompt: "x" }))).toBeUndefined();
    const admitted = { units: 10, outputBytes: 1, providerCapMicros: 1 };
    expect(parseQueueRecord(bytes({ ...record, admitted }))).toBeUndefined();
    const later = { ...record.items[1], state: "starting", start: "attempted" };
    expect(parseQueueRecord(bytes({ ...record, items: [record.items[0], later] }))).toBeUndefined();
    const early = { ...record, phase: "completed", reason: "all_accepted" };
    expect(parseQueueRecord(bytes(early))).toBeUndefined();
  });

  it("stops rather than truncating when the transition history is full", () => {
    let record = fresh();
    for (let i = record.transitions.length; i < QUEUE_LIMITS.maxTransitions; i++)
      record = withTransition(record, {}, STAMP);
    expect(record.transitions).toHaveLength(QUEUE_LIMITS.maxTransitions);
    expect(() => withTransition(record, {}, STAMP)).toThrow(/HISTORY_FULL/);
    const halt = { phase: "needs_operator", reason: "history_full" } as const;
    const stopped = withTransition(record, halt, STAMP, false);
    expect(stopped.transitions).toEqual(record.transitions);
    expect(parseQueueRecord(Buffer.from(serializeQueueRecord(stopped)))).toBeDefined();
  });

  it("resumes only from a clean stopped waiting or pending boundary with room", () => {
    const waiting = (record: QueueRecord): QueueRecord => ({
      ...record,
      items: record.items.map((item, i) =>
        i === 0
          ? {
              ...item,
              state: "waiting_review",
              start: "confirmed",
              continuation: "review_pending",
              continuationReason: "checks_passed",
              sourceRef: SOURCE_REF
            }
          : item
      ),
      admitted: { units: 10, outputBytes: 1_000_000, providerCapMicros: 100_000 }
    });
    const clean = { phase: "stopped", reason: "review_timeout" } as const;
    const stopped = withTransition(waiting(fresh()), clean, STAMP);
    expect(parseQueueRecord(Buffer.from(serializeQueueRecord(stopped)))).toBeDefined();
    expect(resumable(stopped)).toBe(true);
    const live = withTransition(stopped, { phase: "running", reason: "in_progress" }, STAMP);
    expect(resumable(live)).toBe(false);
    expect(resumable({ ...stopped, phase: "needs_operator", reason: "fence_moved" })).toBe(false);
    expect(resumable({ ...stopped, invocations: QUEUE_LIMITS.maxInvocations })).toBe(false);
    const running = {
      ...stopped,
      items: stopped.items.map((item, i) =>
        i === 0 ? { ...item, state: "running" as const } : item
      )
    };
    expect(resumable(running)).toBe(false);
  });
});
