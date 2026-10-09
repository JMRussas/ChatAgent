import { z } from "zod";
import { ATTEMPT_PROGRESS_SCHEMA, type AttemptProgressResponse } from "./attemptProgress";
import { parseStrictJson } from "./devCoordination";

/**
 * recovery-assessment/v1 (doc 17): a pure, read-only reconciliation of what the plan
 * record and one observation say about a node, against the attempt, epoch, content
 * revision and owner the caller expects.
 *
 * It separates observation failures (outage, bound, contract, configuration) from
 * recorded worker or source outcomes, and recommends one bounded action for a named
 * role. Every action has `automaticAllowed: false`. Nothing here claims, resets,
 * relaunches, retries, stops or writes anything, reads a clock, a file or the network,
 * or invokes a model. Worker liveness and useful progress stay `unknown`, worker text is
 * never read, and host input is supplied by the caller and never authenticated.
 */

export const ASSESSMENT_SCHEMA = "recovery-assessment/v1";
export const ASSESSMENT_INPUT_SCHEMA = "recovery-assessment-input/v1";

export const ASSESSMENT_LIMITS = {
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 16 * 1024,
  maxReasons: 32,
  maxCitations: 16,
  maxCycles: 6,
  minIntervalMs: 5_000,
  maxIntervalMs: 60_000,
  /** The whole CLI run; the process itself stops `hardStopGraceMs` later. */
  deadlineMs: 60_000,
  hardStopGraceMs: 1_000
} as const;

export const FORBIDDEN_ACTIONS = [
  "blind_relaunch",
  "automatic_source_retry",
  "reset_in_progress_node",
  "restart_unknown_owner",
  "second_owner",
  "mutate_plan_state"
] as const;

export type AssessmentErrorCode = "input_invalid" | "output_too_large";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AssessmentErrorCode };

const FAULT_REASONS = {
  availability: ["TIMEOUT", "UNAVAILABLE", "HTTP_ERROR", "BUSY"],
  bound_exceeded: ["RESPONSE_TOO_LARGE", "PAGE_LIMIT", "TOO_LARGE"],
  contract: [
    "INVALID_RESPONSE",
    "INVALID_NUMBER",
    "DUPLICATE_KEY",
    "UNSAFE_KEY",
    "UNSUPPORTED_CONTRACT",
    "ROOT_MISMATCH",
    "IDENTITY_MISMATCH",
    "CURSOR_STALLED",
    "INVALID_SEQUENCE",
    "INVALID_ATTEMPT",
    "INVALID_NODE",
    "INVALID_OBSERVATION"
  ],
  config: ["INVALID_URL", "INVALID_ROOT", "INVALID_OPTIONS"]
} as const;

export type FaultClass = keyof typeof FAULT_REASONS | "not_found" | "unrecognized" | "none";
export type FailureReason =
  (typeof FAULT_REASONS)[keyof typeof FAULT_REASONS][number] | "NODE_NOT_FOUND" | "UNRECOGNIZED";

const REASON_CLASS = new Map<string, FaultClass>(
  Object.entries(FAULT_REASONS).flatMap(([cls, reasons]) =>
    reasons.map((reason) => [reason, cls as FaultClass] as const)
  )
);

/** Reasons the role observer itself can record on a successful observation. */
const OBSERVER_REASONS = new Set([
  "events_metadata_changed",
  "events_truncated",
  "attempt_content_stale",
  "trace_prompt_changed",
  "trace_metadata_changed",
  "trace_truncated",
  "trace_capped",
  "trace_integrity_unverified",
  "trace_integrity_none",
  "trace_not_captured",
  "trace_unfinished",
  "plan_readiness_errors",
  "node_missing_after",
  "events_ahead_of_plan"
]);
const DRIFT_KEYS = new Set([
  "rootId",
  "nodeId",
  "projectId",
  "parentId",
  "name",
  "executorRef",
  "artifactRef",
  "acceptance",
  "effectiveAcceptance",
  "attemptContentRevision",
  "attemptPrereqDigest",
  "stateRevision",
  "contentRevision",
  "work",
  "attemptId",
  "attemptEpoch"
]);

const PRECLAIM_CODES = [
  "spec_pending",
  "spec_mismatch",
  "base_not_chained",
  "node_run_root_exists",
  "preflight_refused"
] as const;
const STOP_CODES = [...PRECLAIM_CODES, "UNRECOGNIZED"] as const;
const LIFECYCLES = [
  "no_host",
  "host_mismatch",
  "running",
  "dispatching",
  "stop_requested",
  "unverified",
  "owner_gone",
  "stopped",
  "failed",
  "exited",
  "unrecognized"
] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAUNCH_ID = /^[0-9a-f]{32}$/;
const ATTEMPT_ID = /^[\x21-\x7e]{1,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|git:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const OBSERVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PLAN_API = "/api/plan-contract/v1/";

const guid = z.string().regex(GUID);
const whole = (min: number) =>
  z.number().refine((n) => Number.isSafeInteger(n) && n >= min, { message: "invalid" });
const attemptId = z.string().regex(ATTEMPT_ID);
const work = z.enum(["todo", "in_progress", "done", "cancelled"]);
const refView = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("shown"), ref: z.string().regex(DIGEST_REF) }).strict(),
  z.object({ state: z.literal("withheld") }).strict()
]);
type RefViewInput = z.infer<typeof refView>;
const citationSchema = z
  .object({ ref: whole(0), endpoint: z.string().max(700), sha256: z.string().regex(SHA256) })
  .strict();

const observedSchema = z
  .object({
    status: z.literal("observed"),
    observedAt: z.string().regex(OBSERVED_AT),
    rootId: guid,
    nodeId: guid,
    consistency: z.enum(["current", "stale", "partial"]),
    reasons: z.array(z.string().max(100)).max(ASSESSMENT_LIMITS.maxReasons),
    task: z
      .object({
        work,
        stateRevision: whole(0),
        contentRevision: whole(1),
        attemptId: attemptId.nullable(),
        attemptEpoch: whole(0),
        attemptContentRevision: whole(1).nullable(),
        effectiveAcceptance: z.enum(["none", "accepted", "rejected", "stale"])
      })
      .strict(),
    taskArtifact: refView.optional(),
    selectedAttempt: z
      .object({
        attemptId,
        attemptEpoch: whole(0),
        scope: z.enum(["current", "historical"]),
        attemptContentRevision: whole(1).nullable(),
        contentPins: z.enum(["current", "stale", "unknown"])
      })
      .strict()
      .nullable(),
    trace: z
      .object({
        status: z.enum(["running", "exited", "unfinished", "not_captured"]),
        integrity: z.enum(["verified", "unverified", "none"]),
        claimLinkage: z.enum(["matched", "unavailable"]),
        capped: z.boolean(),
        truncated: z.boolean(),
        metadataStable: z.boolean(),
        exitCode: z.number().int().safe().nullable(),
        recordCount: whole(0)
      })
      .strict()
      .nullable(),
    acceptance: z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        contentRevision: whole(0),
        attemptEpoch: whole(0),
        attemptId: attemptId.nullable(),
        taskArtifact: refView,
        decisionArtifact: refView
      })
      .strict()
      .nullable(),
    evidence: z.array(citationSchema).max(ASSESSMENT_LIMITS.maxCitations)
  })
  .strict();

const failedSchema = z
  .object({
    status: z.literal("failed"),
    httpStatus: z.union([z.literal(404), z.literal(503)]),
    reason: z.string().max(200)
  })
  .strict();

const hostSchema = z
  .object({
    rootId: guid.nullable(),
    lifecycle: z.enum(LIFECYCLES),
    launchId: z.string().regex(LAUNCH_ID).nullable(),
    currentNodeId: guid.nullable(),
    stopCode: z.enum(STOP_CODES).nullable(),
    journal: z
      .object({
        unresolvedIntent: z.boolean(),
        uncertainLaunch: z.boolean(),
        uncertainStop: z.boolean(),
        malformedRecords: whole(0)
      })
      .strict()
      .nullable()
  })
  .strict();

const inputSchema = z
  .object({
    schema: z.literal(ASSESSMENT_INPUT_SCHEMA),
    expected: z
      .object({
        rootId: guid,
        nodeId: guid,
        attemptId: attemptId.nullable(),
        attemptEpoch: whole(0),
        contentRevision: whole(1),
        launchId: z.string().regex(LAUNCH_ID).optional()
      })
      .strict(),
    observation: z.discriminatedUnion("status", [observedSchema, failedSchema]),
    host: hostSchema.optional()
  })
  .strict();

export type AssessmentInput = z.infer<typeof inputSchema>;
export type ExpectedFence = AssessmentInput["expected"];
export type ObservedInput = z.infer<typeof observedSchema>;
export type HostInput = z.infer<typeof hostSchema>;

/** Only the plan-contract GET paths the role observer issues for this exact subject. */
function canonicalEndpoint(
  endpoint: string,
  rootId: string,
  nodeId: string,
  selectedId: string | null
): boolean {
  if (endpoint === `${PLAN_API}plans/${rootId}`) return true;
  const node = `${PLAN_API}nodes/${nodeId}`;
  const cursor = /^(?:0|[1-9][0-9]{0,15})$/;
  const safeCursor = (value: string) => cursor.test(value) && Number.isSafeInteger(Number(value));
  if (endpoint.startsWith(`${node}/events?afterSeq=`))
    return safeCursor(endpoint.slice(`${node}/events?afterSeq=`.length));
  const trace = /^([A-Za-z0-9%._~!*'()-]{1,600})\/trace(?:\?afterSeq=([0-9]{1,16}))?$/.exec(
    endpoint.startsWith(`${node}/attempts/`) ? endpoint.slice(`${node}/attempts/`.length) : ""
  );
  if (!trace || (trace[2] !== undefined && !safeCursor(trace[2]))) return false;
  try {
    return selectedId !== null && decodeURIComponent(trace[1]) === selectedId;
  } catch {
    return false;
  }
}

const observerReason = (reason: string): string =>
  OBSERVER_REASONS.has(reason) || (reason.startsWith("drift_") && DRIFT_KEYS.has(reason.slice(6)))
    ? reason
    : "UNRECOGNIZED";

/** Unknown 503 reasons become the fixed UNRECOGNIZED; the string itself is never kept. */
const failureReason = (reason: string): FailureReason =>
  REASON_CLASS.has(reason) ? (reason as FailureReason) : "UNRECOGNIZED";

/** Strict validation plus canonical, closed-vocabulary values; null when invalid. */
function validateInput(raw: unknown): AssessmentInput | null {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const input = parsed.data;
  const o = input.observation;
  if (o.status === "failed") {
    if (o.httpStatus === 404) {
      if (o.reason !== "NODE_NOT_FOUND") return null;
      return { ...input, observation: o };
    }
    return { ...input, observation: { ...o, reason: failureReason(o.reason) } };
  }
  if (
    o.evidence.some(
      (c) =>
        !canonicalEndpoint(
          c.endpoint,
          o.rootId,
          o.nodeId,
          o.selectedAttempt?.attemptId ?? o.task.attemptId
        )
    )
  )
    return null;
  return { ...input, observation: { ...o, reasons: o.reasons.map(observerReason) } };
}

const invalid = (): { ok: false; error: "input_invalid" } => ({
  ok: false,
  error: "input_invalid"
});

/**
 * Strict, bounded parse of a stored `recovery-assessment-input/v1`. Bytes are decoded as
 * fatal UTF-8 without BOM removal; numbers must be exact safe integers and keys unique.
 */
export function parseAssessmentInput(source: string | Uint8Array): Result<AssessmentInput> {
  try {
    let text: string;
    if (typeof source === "string") {
      if (Buffer.byteLength(source, "utf8") > ASSESSMENT_LIMITS.maxInputBytes) return invalid();
      text = source;
    } else {
      if (source.byteLength > ASSESSMENT_LIMITS.maxInputBytes) return invalid();
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
    }
    const input = validateInput(parseStrictJson(text));
    return input ? { ok: true, value: input } : invalid();
  } catch {
    return invalid();
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function pickRef(view: unknown): RefViewInput {
  if (isObject(view) && view.state === "shown" && typeof view.ref === "string")
    return DIGEST_REF.test(view.ref) ? { state: "shown", ref: view.ref } : { state: "withheld" };
  return isObject(view) && view.state === "none" ? { state: "none" } : { state: "withheld" };
}

/**
 * Allowlisted extraction of the dispatch status body: lifecycle, root, launch id, current
 * node id, a known pre-claim stop code and the journal summary. Everything else, including
 * every free string, is dropped. Invalid shapes are refused, never defaulted.
 */
export function extractHostInput(raw: unknown): Result<HostInput> {
  if (!isObject(raw)) return invalid();
  const lifecycle = (LIFECYCLES as readonly unknown[]).includes(raw.lifecycle)
    ? raw.lifecycle
    : "unrecognized";
  const text = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  const stop = raw.stopReason;
  let journal: unknown = null;
  if (raw.journal !== null && raw.journal !== undefined) {
    if (!isObject(raw.journal)) return invalid();
    journal = {
      unresolvedIntent: raw.journal.unresolvedIntent,
      uncertainLaunch: raw.journal.uncertainLaunch,
      uncertainStop: raw.journal.uncertainStop,
      malformedRecords: raw.journal.malformedRecords
    };
  }
  const parsed = hostSchema.safeParse({
    rootId: text(raw.rootId, GUID),
    lifecycle,
    launchId: text(raw.launchId, LAUNCH_ID),
    currentNodeId: isObject(raw.current) ? text(raw.current.nodeId, GUID) : null,
    stopCode:
      typeof stop !== "string" || stop === ""
        ? null
        : (PRECLAIM_CODES as readonly string[]).includes(stop)
          ? stop
          : "UNRECOGNIZED",
    journal
  });
  return parsed.success ? { ok: true, value: parsed.data } : invalid();
}

/**
 * Allowlisted extraction of an `attempt-progress/v1` service response (or its typed
 * failure) into a replayable input. It drops activity, aiSnapshot, prompts, trace text,
 * errors, withheld refs and every unlisted key, and keeps only canonical citations.
 */
export function extractAssessmentInput(request: {
  expected: ExpectedFence;
  response: AttemptProgressResponse;
  host?: HostInput;
}): Result<AssessmentInput> {
  const { expected, response, host } = request;
  const envelope = { schema: ASSESSMENT_INPUT_SCHEMA, expected, ...(host ? { host } : {}) };
  const finish = (observation: unknown) => {
    const input = validateInput({ ...envelope, observation });
    return input ? ({ ok: true, value: input } as const) : invalid();
  };
  const r = response as unknown;
  if (!isObject(r)) return invalid();
  if (r.status === 404) {
    if (!isObject(r.body) || r.body.code !== "NODE_NOT_FOUND") return invalid();
    return finish({ status: "failed", httpStatus: 404, reason: "NODE_NOT_FOUND" });
  }
  if (r.status === 503) {
    if (
      !isObject(r.body) ||
      r.body.code !== "ATTEMPT_PROGRESS_UNAVAILABLE" ||
      typeof r.body.reason !== "string"
    )
      return invalid();
    const reason = isObject(r.body) && typeof r.body.reason === "string" ? r.body.reason : "";
    return finish({ status: "failed", httpStatus: 503, reason: failureReason(reason) });
  }
  if (r.status !== 200 || !isObject(r.body) || !isObject(r.body.task)) return invalid();
  const p = r.body;
  if (
    p.schema !== ATTEMPT_PROGRESS_SCHEMA ||
    !Array.isArray(p.reasons) ||
    p.reasons.length > ASSESSMENT_LIMITS.maxReasons ||
    !Array.isArray(p.evidence) ||
    p.evidence.length > ASSESSMENT_LIMITS.maxCitations
  )
    return invalid();
  const t = p.task as Record<string, unknown>;
  const sel = isObject(p.selectedAttempt) ? p.selectedAttempt : null;
  const tr = isObject(p.trace) ? p.trace : null;
  const acc = isObject(p.acceptance) && p.acceptance.decision ? p.acceptance : null;
  const citations = (Array.isArray(p.evidence) ? p.evidence : [])
    .filter(
      (e): e is { ref: number; endpoint: string; sha256: string } =>
        isObject(e) &&
        typeof e.endpoint === "string" &&
        typeof p.rootId === "string" &&
        typeof p.nodeId === "string" &&
        canonicalEndpoint(
          e.endpoint,
          p.rootId,
          p.nodeId,
          typeof sel?.attemptId === "string"
            ? sel.attemptId
            : typeof t.attemptId === "string"
              ? t.attemptId
              : null
        )
    )
    .map((e) => ({ ref: e.ref, endpoint: e.endpoint, sha256: e.sha256 }));
  return finish({
    status: "observed",
    observedAt: p.observedAt,
    rootId: p.rootId,
    nodeId: p.nodeId,
    consistency: p.consistency,
    reasons: (Array.isArray(p.reasons) ? p.reasons : [])
      .map((x) => (typeof x === "string" ? observerReason(x) : "UNRECOGNIZED"))
      .slice(0, ASSESSMENT_LIMITS.maxReasons),
    task: {
      work: t.work,
      stateRevision: t.stateRevision,
      contentRevision: t.contentRevision,
      attemptId: t.attemptId,
      attemptEpoch: t.attemptEpoch,
      attemptContentRevision: t.attemptContentRevision,
      effectiveAcceptance: t.effectiveAcceptance
    },
    taskArtifact: pickRef(isObject(p.acceptance) ? p.acceptance.taskArtifact : null),
    selectedAttempt: sel && {
      attemptId: sel.attemptId,
      attemptEpoch: sel.attemptEpoch,
      scope: sel.scope,
      attemptContentRevision: sel.attemptContentRevision,
      contentPins: sel.contentPins
    },
    trace: tr && {
      status: tr.status,
      integrity: tr.integrity,
      claimLinkage: tr.claimLinkage,
      capped: tr.capped,
      truncated: tr.truncated,
      metadataStable: tr.metadataStable,
      exitCode: tr.exitCode,
      recordCount: tr.recordCount
    },
    acceptance: acc && {
      decision: acc.decision,
      contentRevision: acc.contentRevision,
      attemptEpoch: acc.attemptEpoch,
      attemptId: acc.attemptId,
      taskArtifact: pickRef(acc.taskArtifact),
      decisionArtifact: pickRef(acc.decisionArtifact)
    },
    evidence: citations.slice(0, ASSESSMENT_LIMITS.maxCitations)
  });
}

export type FenceField =
  "rootId" | "nodeId" | "attemptId" | "attemptEpoch" | "contentRevision" | "owner";

export type WorkerSource =
  | "not_assessed"
  | "unobserved"
  | "no_attempt"
  | "in_flight"
  | "awaiting_review"
  | "accepted_current"
  | "rejected_current"
  | "decision_historical"
  | "decision_stale"
  | "pins_stale"
  | "cancelled"
  | "inconsistent";

export type Claim =
  | "not_assessed"
  | "none_since_fence"
  | "claimed_trace_linked"
  | "claimed_trace_unlinked"
  | "claimed_trace_unavailable";

export type DecisionState =
  "none" | "current" | "historical" | "stale" | "inconsistent" | "unverified";

export type Owner =
  | "not_supplied"
  | "no_host"
  | "host_mismatch"
  | "owner_dispatching_this_node"
  | "owner_dispatching_other_node"
  | "owner_idle_between_nodes"
  | "owner_stop_requested"
  | "owner_unverified"
  | "owner_gone"
  | "owner_exited";

export type RecommendedAction =
  | "none"
  | "wait_and_reobserve"
  | "reobserve_then_escalate"
  | "lead_review_required"
  | "repair_observer_or_contract"
  | "operator_decides_new_attempt"
  | "escalate_operator"
  | "reconcile_uncertain_effects"
  | "stop_and_reread_authority";

export type Authority = "none" | "none_then_operator" | "lead" | "operator";

export type RecommendationCode =
  | "fence_mismatch"
  | "observation_failed"
  | "observation_stale"
  | "observation_partial"
  | "uncertain_effects"
  | "host_not_supplied"
  | "owner_not_dispatching_this_node"
  | "owner_stop_requested"
  | "owner_dispatching_unclaimed_node"
  | "known_preclaim_code"
  | "preclaim_code_with_claimed_attempt"
  | "unrecognized_host_code"
  | "journal_not_reported"
  | "decision_historical_only"
  | "decision_binding_unverified"
  | "cause_typing_not_available";

const ACTION_AUTHORITY: Record<RecommendedAction, Authority> = {
  none: "none",
  wait_and_reobserve: "none",
  reobserve_then_escalate: "none_then_operator",
  lead_review_required: "lead",
  repair_observer_or_contract: "operator",
  operator_decides_new_attempt: "operator",
  escalate_operator: "operator",
  reconcile_uncertain_effects: "operator",
  stop_and_reread_authority: "operator"
};

const SUMMARY: Record<RecommendedAction, (node: string) => string> = {
  none: (n) => `Node ${n}: no recovery action is recommended from the recorded facts.`,
  wait_and_reobserve: (n) =>
    `Node ${n}: work is allocated; observe again later. Allocation is not proof that a worker started.`,
  reobserve_then_escalate: (n) =>
    `Node ${n}: the observation did not complete. Re-run at most 3 times, at least 5 seconds apart, then escalate to an operator. This is not a worker or source outcome.`,
  lead_review_required: (n) =>
    `Node ${n}: the lead reviews the recorded state; no decision applies to this attempt and content.`,
  repair_observer_or_contract: (n) =>
    `Node ${n}: the observation failed on a bound or contract. An operator opens a separate repair task; do not retry a model against the existing inputs.`,
  operator_decides_new_attempt: (n) =>
    `Node ${n}: an operator decides on a new attempt after inspecting the retained evidence; a new attempt needs an explicit supported state or content change.`,
  escalate_operator: (n) =>
    `Node ${n}: an operator inspects PlanStore and the owner. Do not reset or relaunch.`,
  reconcile_uncertain_effects: (n) =>
    `Node ${n}: the supplied journal reports an unresolved or uncertain effect. An operator reconciles it first; every forbidden action stays in force.`,
  stop_and_reread_authority: (n) =>
    `Node ${n}: the observed record is not the expected one. Stop and re-read the authoritative attempt, epoch, content revision and owner.`
};

export interface Citation {
  ref: number;
  endpoint: string;
  sha256: string;
}

export interface RecoveryAssessment {
  schema: typeof ASSESSMENT_SCHEMA;
  subject: {
    rootId: string;
    nodeId: string;
    attemptId: string | null;
    attemptEpoch: number;
    contentRevision: number;
    launchId: string | null;
  };
  recorded:
    | (ObservedInput["task"] & {
        rootId: string;
        nodeId: string;
        taskArtifact: RefViewInput;
        decisionArtifact: RefViewInput;
      })
    | null;
  fence: { status: "match" | "mismatch" | "unchecked"; mismatched: FenceField[] };
  observation: {
    status: "observed" | "failed";
    faultClass: FaultClass;
    faultSide: "unattributed" | "not_applicable";
    reason: FailureReason | null;
    consistency: "current" | "stale" | "partial" | null;
    reasons: string[];
    observedAt: string | null;
    clockDomain: "observer_process_wall_clock_at_observation_end";
  };
  attempt: {
    workerSource: WorkerSource;
    claim: Claim;
    decision: {
      state: DecisionState;
      decision: "accepted" | "rejected" | null;
      causeTyping: "not_available" | null;
    };
  };
  host: {
    supplied: boolean;
    trust: "supplied_unauthenticated" | "not_supplied";
    owner: Owner;
    uncertainEffects: boolean;
    stopCode: "none" | "known_preclaim_code" | "unrecognized_code";
  };
  recommendation: {
    action: RecommendedAction;
    authority: Authority;
    automaticAllowed: false;
    forbidden: readonly (typeof FORBIDDEN_ACTIONS)[number][];
    codes: RecommendationCode[];
    summary: string;
  };
  evidence: { completeness: "complete" | "partial" | "stale" | "none"; citations: Citation[] };
  trust: {
    workerLiveness: "unknown";
    usefulProgress: "unknown";
    workerStatements: "not_read";
  };
}

function deriveOwner(host: HostInput | undefined, rootId: string, nodeId: string): Owner {
  if (!host) return "not_supplied";
  if (host.lifecycle === "no_host") return "no_host";
  if (host.lifecycle === "host_mismatch" || (host.rootId !== null && host.rootId !== rootId))
    return "host_mismatch";
  if (host.rootId === null || host.launchId === null) return "owner_unverified";
  switch (host.lifecycle) {
    case "dispatching":
      if (host.currentNodeId === null) return "owner_unverified";
      return host.currentNodeId === nodeId
        ? "owner_dispatching_this_node"
        : "owner_dispatching_other_node";
    case "running":
      return "owner_idle_between_nodes";
    case "stop_requested":
      return "owner_stop_requested";
    case "owner_gone":
      return "owner_gone";
    case "stopped":
    case "failed":
    case "exited":
      return "owner_exited";
    default:
      return "owner_unverified";
  }
}

interface Classification {
  source: WorkerSource;
  claim: Claim;
  decision: RecoveryAssessment["attempt"]["decision"];
  codes: RecommendationCode[];
}

/** The recorded plan node is authoritative; the host and trace never overrule it. */
function classifyAttempt(o: ObservedInput): Classification {
  const { task, selectedAttempt: sel, acceptance: acc } = o;
  const codes: RecommendationCode[] = [];
  const make = (
    source: WorkerSource,
    state: DecisionState,
    claim: Claim = claimOf(o)
  ): Classification => {
    if (state === "unverified") codes.push("decision_binding_unverified");
    if (state === "historical") codes.push("decision_historical_only");
    const rejected = source === "rejected_current";
    if (rejected) codes.push("cause_typing_not_available");
    return {
      source,
      claim,
      decision: {
        state,
        decision: state === "current" || state === "unverified" ? (acc?.decision ?? null) : null,
        causeTyping: rejected ? "not_available" : null
      },
      codes
    };
  };
  const decisionState: DecisionState = acc ? "historical" : "none";
  const attempt = task.attemptId;
  const selectedMatches =
    attempt !== null &&
    sel !== null &&
    sel.scope === "current" &&
    sel.attemptId === attempt &&
    sel.attemptEpoch === task.attemptEpoch;
  const differs = (pin: number | null) => pin !== null && pin !== task.contentRevision;
  const pinsStale =
    attempt !== null &&
    (differs(task.attemptContentRevision) ||
      (selectedMatches && (sel.contentPins === "stale" || differs(sel.attemptContentRevision))));

  switch (task.work) {
    case "cancelled":
      return make("cancelled", decisionState);
    case "todo":
      if (attempt !== null || (acc && acc.attemptEpoch > task.attemptEpoch))
        return make("inconsistent", "inconsistent");
      return make("no_attempt", decisionState);
    case "in_progress":
      if (attempt === null || !selectedMatches || (acc && acc.attemptEpoch >= task.attemptEpoch))
        return make("inconsistent", "inconsistent");
      return make(pinsStale ? "pins_stale" : "in_flight", decisionState);
    case "done":
      break;
  }

  if (attempt === null) return make("inconsistent", "inconsistent");
  if (!acc) {
    if (task.effectiveAcceptance !== "none") return make("inconsistent", "inconsistent");
    return make(pinsStale ? "pins_stale" : "awaiting_review", "none");
  }
  if (acc.attemptEpoch > task.attemptEpoch) return make("inconsistent", "inconsistent");
  if (acc.attemptEpoch < task.attemptEpoch)
    return acc.attemptEpoch > 0
      ? make("decision_historical", "historical")
      : make("inconsistent", "inconsistent");
  if (acc.attemptId !== attempt) return make("decision_stale", "stale");
  if (pinsStale) return make("pins_stale", "stale");
  if (acc.contentRevision !== task.contentRevision || task.effectiveAcceptance === "stale")
    return make("decision_stale", "stale");
  if (task.effectiveAcceptance !== acc.decision) return make("inconsistent", "inconsistent");
  const bound =
    selectedMatches &&
    sel.contentPins === "current" &&
    sel.attemptContentRevision === task.contentRevision &&
    task.attemptContentRevision === task.contentRevision &&
    acc.taskArtifact.state === "shown" &&
    acc.decisionArtifact.state === "shown" &&
    acc.taskArtifact.ref === acc.decisionArtifact.ref &&
    (o.taskArtifact === undefined ||
      (o.taskArtifact.state === "shown" && o.taskArtifact.ref === acc.taskArtifact.ref));
  if (!bound) return make("decision_stale", "unverified");
  return make(acc.decision === "accepted" ? "accepted_current" : "rejected_current", "current");
}

function claimOf(o: ObservedInput): Claim {
  const { task, trace } = o;
  if (task.attemptId === null) return task.work === "todo" ? "none_since_fence" : "not_assessed";
  if (trace === null) return "claimed_trace_unavailable";
  return trace.claimLinkage === "matched" ? "claimed_trace_linked" : "claimed_trace_unlinked";
}

function actionFor(
  c: Classification,
  owner: Owner,
  codes: RecommendationCode[]
): RecommendedAction {
  switch (c.source) {
    case "accepted_current":
      return "none";
    case "no_attempt":
      if (owner === "owner_dispatching_this_node") {
        codes.push("owner_dispatching_unclaimed_node");
        return "wait_and_reobserve";
      }
      return "none";
    case "in_flight":
      if (owner === "owner_dispatching_this_node") return "wait_and_reobserve";
      if (owner === "not_supplied") {
        codes.push("host_not_supplied");
        return "wait_and_reobserve";
      }
      codes.push(
        owner === "owner_stop_requested"
          ? "owner_stop_requested"
          : "owner_not_dispatching_this_node"
      );
      return "escalate_operator";
    case "awaiting_review":
    case "decision_historical":
    case "decision_stale":
      return "lead_review_required";
    case "rejected_current":
    case "pins_stale":
    case "cancelled":
      return "operator_decides_new_attempt";
    default:
      return "escalate_operator";
  }
}

/** Pure, deterministic assessment of one validated input. */
export function assessRecovery(raw: unknown): Result<RecoveryAssessment> {
  const input = validateInput(raw);
  if (!input) return invalid();
  const { expected, observation, host } = input;

  const owner = deriveOwner(host, expected.rootId, expected.nodeId);
  const journal = host?.journal ?? null;
  const uncertainEffects =
    journal !== null &&
    (journal.unresolvedIntent ||
      journal.uncertainLaunch ||
      journal.uncertainStop ||
      journal.malformedRecords > 0);
  const stopCode: RecoveryAssessment["host"]["stopCode"] =
    host?.stopCode == null
      ? "none"
      : host.stopCode === "UNRECOGNIZED"
        ? "unrecognized_code"
        : "known_preclaim_code";

  const mismatched: FenceField[] = [];
  if (observation.status === "observed") {
    const t = observation.task;
    if (observation.rootId !== expected.rootId) mismatched.push("rootId");
    if (observation.nodeId !== expected.nodeId) mismatched.push("nodeId");
    if (t.attemptId !== expected.attemptId) mismatched.push("attemptId");
    if (t.attemptEpoch !== expected.attemptEpoch) mismatched.push("attemptEpoch");
    if (t.contentRevision !== expected.contentRevision) mismatched.push("contentRevision");
  }
  if (
    expected.launchId !== undefined &&
    (host?.launchId !== expected.launchId || host.rootId !== expected.rootId)
  )
    mismatched.push("owner");

  const codes: RecommendationCode[] = [];
  let source: WorkerSource = "not_assessed";
  let claim: Claim = "not_assessed";
  let decision: Classification["decision"] = { state: "none", decision: null, causeTyping: null };
  let action: RecommendedAction;
  let faultClass: FaultClass = "none";
  let reason: FailureReason | null = null;
  let completeness: RecoveryAssessment["evidence"]["completeness"] = "none";

  if (observation.status === "failed") {
    reason = observation.reason as FailureReason;
    faultClass =
      observation.httpStatus === 404 ? "not_found" : (REASON_CLASS.get(reason) ?? "unrecognized");
    source = "unobserved";
  } else {
    completeness =
      observation.consistency === "current"
        ? "complete"
        : observation.consistency === "stale"
          ? "stale"
          : "partial";
  }

  if (mismatched.length > 0) {
    source = "not_assessed";
    action = "stop_and_reread_authority";
    codes.push("fence_mismatch");
  } else if (observation.status === "failed") {
    codes.push("observation_failed");
    action =
      faultClass === "availability"
        ? "reobserve_then_escalate"
        : faultClass === "config" || faultClass === "not_found"
          ? "escalate_operator"
          : "repair_observer_or_contract";
  } else if (observation.consistency === "stale") {
    codes.push("observation_stale");
    action = "reobserve_then_escalate";
  } else {
    const c = classifyAttempt(observation);
    ({ source, claim, decision } = c);
    codes.push(...c.codes);
    if (observation.consistency === "partial") codes.push("observation_partial");
    const next = actionFor(c, owner, codes);
    action = uncertainEffects ? "reconcile_uncertain_effects" : next;
    if (stopCode === "known_preclaim_code")
      codes.push(
        claim === "none_since_fence" ? "known_preclaim_code" : "preclaim_code_with_claimed_attempt"
      );
  }
  if (uncertainEffects) codes.push("uncertain_effects");
  if (stopCode === "unrecognized_code") codes.push("unrecognized_host_code");
  if (host && journal === null) codes.push("journal_not_reported");

  const observed = observation.status === "observed" ? observation : null;
  const assessment: RecoveryAssessment = {
    schema: ASSESSMENT_SCHEMA,
    subject: {
      rootId: expected.rootId,
      nodeId: expected.nodeId,
      attemptId: expected.attemptId,
      attemptEpoch: expected.attemptEpoch,
      contentRevision: expected.contentRevision,
      launchId: expected.launchId ?? null
    },
    recorded: observed
      ? {
          rootId: observed.rootId,
          nodeId: observed.nodeId,
          ...observed.task,
          taskArtifact: observed.taskArtifact ??
            observed.acceptance?.taskArtifact ?? { state: "withheld" },
          decisionArtifact: observed.acceptance?.decisionArtifact ?? { state: "none" }
        }
      : null,
    fence: {
      status: mismatched.length > 0 ? "mismatch" : observed ? "match" : "unchecked",
      mismatched
    },
    observation: {
      status: observation.status,
      faultClass,
      faultSide:
        faultClass === "contract" || faultClass === "unrecognized"
          ? "unattributed"
          : "not_applicable",
      reason,
      consistency: observed?.consistency ?? null,
      reasons: observed?.reasons ?? [],
      observedAt: observed?.observedAt ?? null,
      clockDomain: "observer_process_wall_clock_at_observation_end"
    },
    attempt: { workerSource: source, claim, decision },
    host: {
      supplied: host !== undefined,
      trust: host ? "supplied_unauthenticated" : "not_supplied",
      owner,
      uncertainEffects,
      stopCode
    },
    recommendation: {
      action,
      authority: ACTION_AUTHORITY[action],
      automaticAllowed: false,
      forbidden: FORBIDDEN_ACTIONS,
      codes: [...new Set(codes)],
      summary: SUMMARY[action](expected.nodeId)
    },
    evidence: { completeness, citations: observed ? observed.evidence : [] },
    trust: { workerLiveness: "unknown", usefulProgress: "unknown", workerStatements: "not_read" }
  };
  if (Buffer.byteLength(JSON.stringify(assessment), "utf8") > ASSESSMENT_LIMITS.maxOutputBytes)
    return { ok: false, error: "output_too_large" };
  return { ok: true, value: assessment };
}

/** 0 only when no action is recommended; any other valid assessment is 4. */
export const assessmentExitCode = (a: RecoveryAssessment): 0 | 4 =>
  a.recommendation.action === "none" ? 0 : 4;

/** Fixed-format text carrying the same facts as the JSON; ids, enums and integers only. */
export function renderAssessment(a: RecoveryAssessment): string {
  const lines = [
    `${a.schema}  root ${a.subject.rootId}  node ${a.subject.nodeId}`,
    `expected  attempt ${a.subject.attemptId ?? "none"}  epoch ${a.subject.attemptEpoch}  content ${a.subject.contentRevision}  launch ${a.subject.launchId ?? "none"}`,
    `fence  ${a.fence.status}${a.fence.mismatched.length ? `  differs ${a.fence.mismatched.join(",")}` : ""}`,
    `observation  ${a.observation.status}  fault ${a.observation.faultClass}  reason ${a.observation.reason ?? "none"}  consistency ${a.observation.consistency ?? "none"}  observed ${a.observation.observedAt ?? "none"}`,
    `observation reasons  ${a.observation.reasons.join(",") || "none"}`,
    `attempt  source ${a.attempt.workerSource}  claim ${a.attempt.claim}  decision ${a.attempt.decision.state} ${a.attempt.decision.decision ?? "none"}  cause typing ${a.attempt.decision.causeTyping ?? "n/a"}`,
    `host  ${a.host.trust}  owner ${a.host.owner}  uncertain effects ${a.host.uncertainEffects ? "yes" : "no"}  stop code ${a.host.stopCode}`,
    `action  ${a.recommendation.action}  authority ${a.recommendation.authority}  automatic allowed false`,
    `codes  ${a.recommendation.codes.join(",") || "none"}`,
    `forbidden  ${a.recommendation.forbidden.join(",")}`,
    `evidence  ${a.evidence.completeness}  ${a.evidence.citations.length} citations`,
    `trust  worker liveness unknown  useful progress unknown  worker statements not read`,
    a.recommendation.summary
  ];
  if (a.recorded) {
    lines.push(
      `recorded  state revision ${a.recorded.stateRevision}  attempt ${a.recorded.attemptId ?? "none"}  epoch ${a.recorded.attemptEpoch}  content ${a.recorded.contentRevision}`
    );
    lines.push(
      `artifacts  task ${a.recorded.taskArtifact.state === "shown" ? a.recorded.taskArtifact.ref : a.recorded.taskArtifact.state}  decision ${a.recorded.decisionArtifact.state === "shown" ? a.recorded.decisionArtifact.ref : a.recorded.decisionArtifact.state}`
    );
  }
  return lines.join("\n");
}
