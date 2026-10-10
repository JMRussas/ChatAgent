import { realpath } from "node:fs/promises";
import {
  continuationManifestSchema,
  continuationRecordAnySchema,
  runContinuation,
  type ContinuationManifest,
  type ContinuationResult
} from "./checkpointContinuation";

/**
 * Owned completion provenance for one in-process `runContinuation` invocation.
 *
 * The only creator is `startOwnedContinuation`, which itself calls the maintained
 * `runContinuation` once. A handle is a key into private module state; a result, record, promise
 * or structurally identical object is never in that map and so can never become a handle.
 * Provenance is cooperative and same-process: no actor authentication, sandbox or global lock.
 * Consuming a handle is one-use provenance only. It does NOT authorize any source write; the
 * fenced operator leaf, fresh Git/source facts and the worktree conflict lease belong to the
 * mutator that follows.
 */

export type OwnedOutcome = "checks_passed" | "check_failed";

export type OwnedRefusal =
  | "invalid_input"
  | "worktree_uncertain"
  | "invocation_threw"
  | "no_record"
  | "persistence_or_refusal"
  | "record_mismatch"
  | "closure_not_clean"
  | "outcome_excluded";

export type OwnedStatus = "pending" | "eligible" | "consumed" | "refused";

/** Bounded facts only: a fresh frozen copy each time, never the private state. */
export interface OwnedSummary {
  readonly status: OwnedStatus;
  readonly refusal: OwnedRefusal | null;
  readonly runId: string | null;
  readonly baseRef: string | null;
  readonly sourceRef: string | null;
  readonly outcome: OwnedOutcome | null;
  readonly exitCode: number | null;
}

export interface OwnedContinuationHandle {
  /** Notification only: resolves, never rejects, after the actual invocation has returned. */
  readonly settled: Promise<OwnedSummary>;
  readonly summary: () => OwnedSummary;
}

export interface OwnedContinuationOptions {
  signal?: AbortSignal;
}

export interface OwnedExpectation {
  worktree: string;
  runId: string;
  baseRef: string;
  sourceRef: string;
}

export type OwnedCheckRefusal =
  | "forged"
  | "pending"
  | "consumed"
  | "refused"
  | "worktree_mismatch"
  | "run_mismatch"
  | "base_mismatch"
  | "source_mismatch";

export interface OwnedProvenance {
  readonly worktree: string;
  readonly runId: string;
  readonly baseRef: string;
  readonly sourceRef: string;
  readonly outcome: OwnedOutcome;
  readonly authorizesSourceMutation: false;
}

export type OwnedCheck =
  { ok: true; provenance: OwnedProvenance } | { ok: false; refusal: OwnedCheckRefusal };

interface HandleState {
  status: OwnedStatus;
  refusal: OwnedRefusal | null;
  worktree: string | null;
  runId: string | null;
  baseRef: string | null;
  sourceRef: string | null;
  outcome: OwnedOutcome | null;
  exitCode: number | null;
}

const owned = new WeakMap<object, HandleState>();

const summarize = (state: HandleState): OwnedSummary =>
  Object.freeze({
    status: state.status,
    refusal: state.refusal,
    runId: state.runId,
    baseRef: state.baseRef,
    sourceRef: state.sourceRef,
    outcome: state.outcome,
    exitCode: state.exitCode
  });

const refuse = (state: HandleState, refusal: OwnedRefusal) => {
  state.status = "refused";
  state.refusal = refusal;
};

/** Exact terminal match of the awaited result against the private binding, or the refusal. */
function classify(
  run: ContinuationManifest["run"],
  result: ContinuationResult
): { outcome: OwnedOutcome; sourceRef: string } | OwnedRefusal {
  if (result.refusal !== undefined) return "persistence_or_refusal";
  if (result.exitCode !== 0 && result.exitCode !== 1) return "persistence_or_refusal";
  const parsed = continuationRecordAnySchema.safeParse(structuredClone(result.record));
  if (!parsed.success) return "no_record";
  const record = parsed.data;
  const id = run.identity;
  const matches =
    record.runId === run.runId &&
    record.baseRef === id.baseRef &&
    record.identity.rootId === id.rootId &&
    record.identity.nodeId === id.nodeId &&
    record.identity.attemptId === id.attemptId &&
    record.identity.attemptEpoch === id.attemptEpoch &&
    record.identity.contentRevision === id.contentRevision &&
    record.identity.observedStateRevision === id.stateRevision &&
    record.identity.executorRef === id.executorRef;
  if (!matches) return "record_mismatch";
  const terminal = record.phase === "review_pending" || record.phase === "needs_operator";
  if (!terminal || record.endedAt === null || record.sourceRef === null) return "closure_not_clean";
  if (record.finish !== "confirmed" || record.gate !== "written") return "closure_not_clean";
  if (result.exitCode === 0)
    return record.phase === "review_pending" && record.reason === "checks_passed"
      ? { outcome: "checks_passed", sourceRef: record.sourceRef }
      : "outcome_excluded";
  // Exit 1 is eligible only as a genuinely failed external check; every other stop is excluded.
  return record.phase === "needs_operator" && record.reason === "check_failed"
    ? { outcome: "check_failed", sourceRef: record.sourceRef }
    : "outcome_excluded";
}

async function execute(
  state: HandleState,
  input: unknown,
  options: OwnedContinuationOptions
): Promise<void> {
  let manifest: ContinuationManifest;
  try {
    const parsed = continuationManifestSchema.safeParse(structuredClone(input));
    if (!parsed.success) return refuse(state, "invalid_input");
    manifest = parsed.data;
  } catch {
    return refuse(state, "invalid_input");
  }
  state.runId = manifest.run.runId;
  state.baseRef = manifest.run.identity.baseRef;
  try {
    state.worktree = await realpath(manifest.run.worktree);
  } catch {
    return refuse(state, "worktree_uncertain");
  }
  let result: ContinuationResult;
  try {
    result = await runContinuation(manifest, options.signal ? { signal: options.signal } : {});
  } catch {
    return refuse(state, "invocation_threw");
  }
  state.exitCode = result.exitCode;
  let verdict: ReturnType<typeof classify>;
  try {
    verdict = classify(manifest.run, result);
  } catch {
    verdict = "record_mismatch";
  }
  if (typeof verdict === "string") return refuse(state, verdict);
  state.sourceRef = verdict.sourceRef;
  state.outcome = verdict.outcome;
  state.status = "eligible";
}

/**
 * Starts one maintained continuation and returns its owned handle. The manifest is copied and
 * parsed before use, so later caller mutation cannot change the binding. Never throws.
 */
export function startOwnedContinuation(
  manifest: unknown,
  options: OwnedContinuationOptions = {}
): OwnedContinuationHandle {
  const state: HandleState = {
    status: "pending",
    refusal: null,
    worktree: null,
    runId: null,
    baseRef: null,
    sourceRef: null,
    outcome: null,
    exitCode: null
  };
  const settled = execute(state, manifest, { signal: options.signal }).then(
    () => summarize(state),
    () => {
      refuse(state, "invocation_threw");
      return summarize(state);
    }
  );
  const handle: OwnedContinuationHandle = Object.freeze({
    settled,
    summary: () => summarize(state)
  });
  owned.set(handle, state);
  return handle;
}

async function check(
  handle: unknown,
  expected: OwnedExpectation,
  consume: boolean
): Promise<OwnedCheck> {
  let worktree: string;
  try {
    worktree = await realpath(expected.worktree);
  } catch {
    return { ok: false, refusal: "worktree_mismatch" };
  }
  // No await below: the checks and the one-use mark are a single synchronous step.
  const state = typeof handle === "object" && handle !== null ? owned.get(handle) : undefined;
  if (!state) return { ok: false, refusal: "forged" };
  if (state.status === "pending") return { ok: false, refusal: "pending" };
  if (state.status === "consumed") return { ok: false, refusal: "consumed" };
  if (
    state.status !== "eligible" ||
    state.worktree === null ||
    state.runId === null ||
    state.baseRef === null ||
    state.sourceRef === null ||
    state.outcome === null
  )
    return { ok: false, refusal: "refused" };
  if (state.worktree !== worktree) return { ok: false, refusal: "worktree_mismatch" };
  if (state.runId !== expected.runId) return { ok: false, refusal: "run_mismatch" };
  if (state.baseRef !== expected.baseRef) return { ok: false, refusal: "base_mismatch" };
  if (state.sourceRef !== expected.sourceRef) return { ok: false, refusal: "source_mismatch" };
  if (consume) state.status = "consumed";
  return {
    ok: true,
    provenance: Object.freeze({
      worktree: state.worktree,
      runId: state.runId,
      baseRef: state.baseRef,
      sourceRef: state.sourceRef,
      outcome: state.outcome,
      authorizesSourceMutation: false as const
    })
  };
}

/** Read-only check against the expected binding; consumes nothing. */
export const inspectOwnedContinuation = (handle: unknown, expected: OwnedExpectation) =>
  check(handle, expected, false);

/** One-use provenance consume. It is not source-mutation authorization. */
export const consumeOwnedContinuation = (handle: unknown, expected: OwnedExpectation) =>
  check(handle, expected, true);
