import {
  RoleObservationError,
  createRoleObserver,
  type AiSnapshot,
  type ObservedTraceRecord,
  type RoleObservation,
  type RoleObserver
} from "./roleObservation";

/**
 * Read-only, allowlisted progress view of one Hekate plan node's selected attempt.
 *
 * It reuses the role observer's single bounded observation and projects it for a browser:
 * identities, enums, numbers, hashes, citations and a small public activity list. The
 * collector's raw evidence, prompt, event payloads, refs and trace text never leave this
 * module. Nothing here writes, claims, reviews, launches a process or calls a model, and
 * worker liveness and useful progress stay "unknown".
 */

export const ATTEMPT_PROGRESS_SCHEMA = "attempt-progress/v1";

export const ATTEMPT_PROGRESS_LIMITS = {
  /** Newest public activity items kept; earlier ones are only counted. */
  maxItems: 20,
  /** Characters kept of one worker text statement. */
  maxTextChars: 400,
  /** Content blocks inspected in one assistant record. */
  maxBlocksPerRecord: 50,
  maxEvents: 50,
  maxReasons: 32,
  /** The serialized projection; far below the browser's 1 MiB read bound. */
  maxBodyBytes: 512 * 1024,
  /** Concurrent observations the service starts; one observer is created for each. */
  maxConcurrent: 2,
  observer: { timeoutMs: 10_000, maxPages: 8, maxBytes: 4 * 1024 * 1024 }
} as const;

export type AttemptProgressErrorCode = "INVALID_OBSERVATION" | "TOO_LARGE";

/** A projection refusal; it never carries observed content. */
export class AttemptProgressError extends Error {
  constructor(readonly code: AttemptProgressErrorCode) {
    super(code);
    this.name = "AttemptProgressError";
  }
}

/**
 * A reference shown only when it is a lowercase hex SHA-1/SHA-256 digest (the native Git
 * artifact id), an explicit `git:<40 hex>` or `sha256:<64 hex>` digest;
 * otherwise withheld.
 */
export type RefView = { state: "none" } | { state: "shown"; ref: string } | { state: "withheld" };

export type ActivityItem =
  | { traceSeq: number; index: number; kind: "text"; text: string; textClipped: boolean }
  | { traceSeq: number; index: number; kind: "tool_use"; tool: string };

export interface PublicActivity {
  /** Worker statements are claims, not verification and not the review decision. */
  trust: "untrusted_inert_unverified_worker_claims";
  source: "complete_stdout_claude_stream_json_assistant_records";
  items: ActivityItem[];
  /** Items found before the newest-first cap; `omittedItems` of them are not listed. */
  totalItems: number;
  omittedItems: number;
  counts: {
    stdoutRecords: number;
    assistantRecords: number;
    /** Complete JSON records that are not a supported assistant record. */
    otherRecords: number;
    /** Cut, redacted, malformed or incomplete stdout records; their content is not read. */
    unavailableRecords: number;
    /** Names outside the bounded worker tool policy, and empty text blocks. */
    withheldItems: number;
  };
  /** False when the trace or content inspection is capped or records are unavailable. */
  complete: boolean;
}

export interface AttemptProgress {
  schema: typeof ATTEMPT_PROGRESS_SCHEMA;
  observedAt: string;
  rootId: string;
  nodeId: string;
  projectId: string;
  consistency: RoleObservation["consistency"];
  reasons: string[];
  task: {
    work: RoleObservation["task"]["work"];
    stateRevision: number;
    contentRevision: number;
    attemptId: string | null;
    attemptEpoch: number;
    attemptContentRevision: number | null;
    attemptPrereqDigest: string | null;
    effectiveAcceptance: RoleObservation["task"]["effectiveAcceptance"];
  };
  bindings: {
    before: Binding;
    after: Binding | null;
  };
  selectedAttempt: {
    attemptId: string;
    attemptEpoch: number;
    scope: "current" | "historical";
    sourceEventSeq: number | null;
    attemptContentRevision: number | null;
    contentPins: "current" | "stale" | "unknown";
  } | null;
  trace: {
    status: string;
    integrity: string;
    claimLinkage: "matched" | "unavailable";
    recordCount: number;
    firstSeq: number | null;
    lastSeq: number | null;
    pages: number;
    capped: boolean;
    truncated: boolean;
    metadataStable: boolean;
    streams: { stdout: number; stderr: number; hekate: number };
    exitCode: number | null;
  } | null;
  /** The recorded PlanStore decision and linkage; separate from worker claims. */
  acceptance: {
    source: "plan_store_recorded_decision";
    decision: "accepted" | "rejected" | null;
    contentRevision: number | null;
    attemptEpoch: number | null;
    attemptId: string | null;
    taskArtifact: RefView;
    decisionArtifact: RefView;
    evidence: RefView;
  };
  evidence: { ref: number; endpoint: string; sha256: string }[];
  assessment: {
    workerLiveness: "unknown";
    usefulProgress: "unknown";
    basis: string;
  };
  activity: PublicActivity | null;
  /** Shared AI metadata; claim keys are removed and the event list is capped. */
  aiSnapshot: AiSnapshot;
  aiSnapshotEventsOmitted: number;
  trust: {
    activity: "unverified_worker_claims";
    acceptance: "plan_store_recorded_decision";
    verifier: "not_reported";
  };
}

interface Binding {
  stateRevision: number;
  contentRevision: number;
  work: string;
  attemptId: string | null;
  attemptEpoch: number;
}

/** Names from the maintained bounded Claude worker's fixed tool policy. */
const PUBLIC_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];
const HEX_DIGEST_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|git:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ATTEMPT_ID = /^[\x21-\x7e]{1,200}$/;
const ENDPOINT = /^\/api\/plan-contract\/v1\/[A-Za-z0-9/_%.?=-]{1,400}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// C0/C1 controls other than tab and newline, line/paragraph separators and bidi controls.
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const bad = () => new AttemptProgressError("INVALID_OBSERVATION");
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw bad();
  return v;
};
const nullableInt = (v: unknown) => (v === null ? null : int(v));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw bad();
  return v as T;
};
const attemptId = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !ATTEMPT_ID.test(v)) throw bad();
  return v;
};
const refView = (v: unknown): RefView => {
  if (v === null || v === undefined) return { state: "none" };
  return typeof v === "string" && HEX_DIGEST_REF.test(v)
    ? { state: "shown", ref: v }
    : { state: "withheld" };
};
const binding = (v: unknown): Binding => {
  if (!isObject(v)) throw bad();
  return {
    stateRevision: int(v.stateRevision),
    contentRevision: int(v.contentRevision),
    work: oneOf(v.work, ["todo", "in_progress", "done", "cancelled"]),
    attemptId: attemptId(v.attemptId),
    attemptEpoch: int(v.attemptEpoch)
  };
};

const clip = (text: string, max: number) => {
  const chars = Array.from(text.replace(UNSAFE_TEXT, ""));
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), clipped: true }
    : { text: chars.join(""), clipped: false };
};

/**
 * Public activity from complete, uncut, unredacted stdout records that are one JSON
 * assistant record with matching message role: top-level `message.content` text and names of
 * `tool_use` blocks. Thinking, tool inputs and results, user/system content, stderr,
 * Hekate diagnostics and every malformed or incomplete record are never exposed.
 * A JSON fragment is not salvaged: a line split across records is simply unavailable.
 */
export function projectPublicActivity(
  records: readonly ObservedTraceRecord[],
  traceComplete: boolean
): PublicActivity {
  return {
    trust: "untrusted_inert_unverified_worker_claims",
    source: "complete_stdout_claude_stream_json_assistant_records",
    items: [],
    totalItems: 0,
    omittedItems: 0,
    counts: {
      stdoutRecords: 0,
      assistantRecords: 0,
      otherRecords: 0,
      unavailableRecords: 0,
      withheldItems: 0
    },
    complete: false
  };
}

function projectAiSnapshot(snapshot: AiSnapshot): { copy: AiSnapshot; omitted: number } {
  const copy = structuredClone(snapshot);
  const loose = copy as unknown;
  if (!isObject(loose) || !isObject(loose.facts) || !Array.isArray(loose.facts.events)) throw bad();
  if (copy.facts.trace) copy.facts.trace.claimKey = null;
  const events = copy.facts.events;
  const omitted = Math.max(0, events.length - ATTEMPT_PROGRESS_LIMITS.maxEvents);
  copy.facts.events = events.slice(omitted);
  return { copy, omitted };
}

/** Pure allowlisted projection of one observation; throws AttemptProgressError. */
export function projectAttemptProgress(
  observation: RoleObservation,
  expected: { rootId: string; nodeId: string }
): AttemptProgress {
  const o = observation as unknown;
  if (!isObject(o) || o.schema !== "role-observation/v1") throw bad();
  if (o.rootId !== expected.rootId || o.nodeId !== expected.nodeId) throw bad();
  const task = o.task;
  if (!isObject(task) || task.rootId !== expected.rootId || task.nodeId !== expected.nodeId)
    throw bad();
  if (typeof task.projectId !== "string" || typeof o.observedAt !== "string") throw bad();
  const consistency = oneOf(o.consistency, ["current", "stale", "partial"] as const);
  if (!Array.isArray(o.reasons) || !isObject(o.bindings) || !isObject(o.assessment)) throw bad();
  if (o.assessment.workerLiveness !== "unknown" || o.assessment.usefulProgress !== "unknown")
    throw bad();
  const reasons = o.reasons
    .filter((r): r is string => typeof r === "string" && REASON.test(r))
    .slice(0, ATTEMPT_PROGRESS_LIMITS.maxReasons);

  const sel = o.selectedAttempt;
  let selectedAttempt: AttemptProgress["selectedAttempt"] = null;
  if (sel !== null) {
    if (!isObject(sel)) throw bad();
    const id = attemptId(sel.attemptId);
    if (id === null) throw bad();
    selectedAttempt = {
      attemptId: id,
      attemptEpoch: int(sel.attemptEpoch),
      scope: oneOf(sel.scope, ["current", "historical"] as const),
      sourceEventSeq: nullableInt(sel.sourceEventSeq),
      attemptContentRevision: nullableInt(sel.attemptContentRevision),
      contentPins: oneOf(sel.contentPins, ["current", "stale", "unknown"] as const)
    };
  }

  let trace: AttemptProgress["trace"] = null;
  let activity: PublicActivity | null = null;
  const t = o.trace;
  if (t !== null) {
    if (!isObject(t) || !Array.isArray(t.records)) throw bad();
    if (
      selectedAttempt === null ||
      t.attemptId !== selectedAttempt.attemptId ||
      t.attemptEpoch !== selectedAttempt.attemptEpoch
    )
      throw bad();
    const records = t.records as ObservedTraceRecord[];
    const streams = { stdout: 0, stderr: 0, hekate: 0 };
    for (const r of records) {
      if (!isObject(r) || !(r.stream in streams)) throw bad();
      streams[r.stream as keyof typeof streams]++;
    }
    const exit = isObject(t.exit) ? t.exit : null;
    const capped = t.capped === true;
    const truncated = t.truncated === true;
    const metadataStable = t.metadataStable === true;
    trace = {
      status: oneOf(t.status, ["running", "exited", "unfinished", "not_captured"] as const),
      integrity: oneOf(t.integrity, ["verified", "unverified", "none"] as const),
      claimLinkage: oneOf(t.claimLinkage, ["matched", "unavailable"] as const),
      recordCount: records.length,
      firstSeq: records.length ? int(records[0].seq) : null,
      lastSeq: records.length ? int(records[records.length - 1].seq) : null,
      pages: int(t.pages),
      capped,
      truncated,
      metadataStable,
      streams,
      exitCode: exit && exit.code !== null ? int(exit.code) : null
    };
    activity = projectPublicActivity(
      records,
      !capped && !truncated && metadataStable && t.integrity === "verified"
    );
  }

  const acceptance = isObject(task.acceptance) ? task.acceptance : null;
  const evidence = Array.isArray(o.evidence) ? o.evidence : [];
  const { copy: aiSnapshot, omitted } = projectAiSnapshot(o.aiSnapshot as AiSnapshot);

  const after = o.bindings.after;
  const result: AttemptProgress = {
    schema: ATTEMPT_PROGRESS_SCHEMA,
    observedAt: o.observedAt,
    rootId: expected.rootId,
    nodeId: expected.nodeId,
    projectId: task.projectId,
    consistency,
    reasons,
    task: {
      work: oneOf(task.work, ["todo", "in_progress", "done", "cancelled"] as const),
      stateRevision: int(task.stateRevision),
      contentRevision: int(task.contentRevision),
      attemptId: attemptId(task.attemptId),
      attemptEpoch: int(task.attemptEpoch),
      attemptContentRevision: nullableInt(task.attemptContentRevision),
      attemptPrereqDigest:
        typeof task.attemptPrereqDigest === "string" && DIGEST.test(task.attemptPrereqDigest)
          ? task.attemptPrereqDigest
          : null,
      effectiveAcceptance: oneOf(task.effectiveAcceptance, [
        "none",
        "accepted",
        "rejected",
        "stale"
      ] as const)
    },
    bindings: { before: binding(o.bindings.before), after: after === null ? null : binding(after) },
    selectedAttempt,
    trace,
    acceptance: {
      source: "plan_store_recorded_decision",
      decision: acceptance ? oneOf(acceptance.decision, ["accepted", "rejected"] as const) : null,
      contentRevision: acceptance ? int(acceptance.contentRevision) : null,
      attemptEpoch: acceptance ? int(acceptance.attemptEpoch) : null,
      attemptId: acceptance ? attemptId(acceptance.attemptId) : null,
      taskArtifact: refView(task.artifactRef),
      decisionArtifact: refView(acceptance?.artifactRef),
      evidence: refView(acceptance?.evidenceRef)
    },
    evidence: evidence.map((e: unknown, position: number) => {
      if (!isObject(e) || typeof e.endpoint !== "string" || typeof e.sha256 !== "string")
        throw bad();
      if (!DIGEST.test(e.sha256)) throw bad();
      // The citation is only the digest; the endpoint is shown when it has the plan-API shape.
      return {
        ref: position,
        endpoint: ENDPOINT.test(e.endpoint) ? e.endpoint : "withheld",
        sha256: e.sha256
      };
    }),
    assessment: {
      workerLiveness: "unknown",
      usefulProgress: "unknown",
      basis:
        "Trace records show observed activity only; they do not prove current liveness or useful progress."
    },
    activity,
    aiSnapshot,
    aiSnapshotEventsOmitted: omitted,
    trust: {
      activity: "unverified_worker_claims",
      acceptance: "plan_store_recorded_decision",
      verifier: "not_reported"
    }
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > ATTEMPT_PROGRESS_LIMITS.maxBodyBytes)
    throw new AttemptProgressError("TOO_LARGE");
  return result;
}

const ROLE_REASONS = new Set<string>([
  "INVALID_URL",
  "INVALID_ROOT",
  "INVALID_RESPONSE",
  "INVALID_NUMBER",
  "DUPLICATE_KEY",
  "UNSAFE_KEY",
  "UNSUPPORTED_CONTRACT",
  "ROOT_MISMATCH",
  "RESPONSE_TOO_LARGE",
  "TIMEOUT",
  "UNAVAILABLE",
  "HTTP_ERROR",
  "INVALID_OPTIONS",
  "BUSY",
  "INVALID_NODE",
  "INVALID_ATTEMPT",
  "IDENTITY_MISMATCH",
  "CURSOR_STALLED",
  "INVALID_SEQUENCE",
  "PAGE_LIMIT"
]);

export type AttemptProgressResponse =
  | { status: 200; body: AttemptProgress }
  | { status: 404; body: { code: "NODE_NOT_FOUND" } }
  | { status: 503; body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE"; reason: string } };

export interface AttemptProgressService {
  read(rootId: string, nodeId: string): Promise<AttemptProgressResponse>;
}

export interface AttemptProgressServiceOptions {
  /** One observer per observation. Injectable for tests; the default is the bounded collector. */
  createObserver?: () => RoleObserver;
  maxConcurrent?: number;
}

const unavailable = (reason: string): AttemptProgressResponse => ({
  status: 503,
  body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason }
});

/**
 * The service for the trusted configured plan API. Each read creates a fresh bounded
 * observer (at most 8 GETs, 4 MiB and 10 s), runs it once and projects the result. A
 * closed or unreachable API is reported as unavailable; nothing is restarted or retried.
 * The reason is a fixed code, never an upstream body, URL or message.
 */
export function createAttemptProgressService(
  planApiUrl: string,
  options: AttemptProgressServiceOptions = {}
): AttemptProgressService {
  const createObserver =
    options.createObserver ??
    (() => createRoleObserver(planApiUrl, ATTEMPT_PROGRESS_LIMITS.observer));
  const maxConcurrent = options.maxConcurrent ?? ATTEMPT_PROGRESS_LIMITS.maxConcurrent;
  let active = 0;
  return {
    async read(rootId, nodeId) {
      if (active >= maxConcurrent) return unavailable("BUSY");
      active++;
      try {
        const observation = await createObserver().observe(rootId, nodeId);
        return { status: 200, body: projectAttemptProgress(observation, { rootId, nodeId }) };
      } catch (error) {
        if (error instanceof RoleObservationError) {
          if (error.code === "NODE_NOT_FOUND")
            return { status: 404, body: { code: "NODE_NOT_FOUND" } };
          return unavailable(ROLE_REASONS.has(error.code) ? error.code : "UNAVAILABLE");
        }
        if (error instanceof AttemptProgressError) return unavailable(error.code);
        return unavailable("UNAVAILABLE");
      } finally {
        active--;
      }
    }
  };
}
