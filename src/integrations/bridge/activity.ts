/**
 * Initial-response detection for bridge assignments (CA-ISSUE-004, doc 15).
 *
 * The types here are the sanitized metadata the readers produce: identifiers,
 * timestamps, kinds and principals only, never message or transcript text. The
 * classifier answers one question per assignment: has the addressed role recorded a
 * response that is explicitly correlated with it? It never reports a role as alive,
 * idle or stalled, and incomplete input is always `unknown`.
 */

/** One bridge event on a message: when the bridge stored, offered or recorded it. */
export interface BridgeEvent {
  kind: string;
  /** Seconds since the epoch, as the bridge records it. */
  ts: number;
}

/** The role and session a message or outcome declares, from `meta` or `details`. */
export interface DeclaredIdentity {
  role?: string;
  session?: string;
}

/** An outcome recorded on the assignment (`bridge_outcome`). */
export interface OutcomeRecord extends DeclaredIdentity {
  kind: string;
  /** The authenticated principal that recorded it. */
  actor: string;
  ts: number;
}

/** A message that links to the assignment (`GET /api/links`, target type message). */
export interface LinkRecord {
  relation: string;
  /** The authenticated principal that recorded the link. */
  actor: string;
  ts: number;
  /** The linking message, when it was read; null when the bound stopped the read. */
  from: (DeclaredIdentity & { uid: string; sender: string; principal: string | null }) | null;
}

/** Why an assignment's input is incomplete; its state is then `unknown`. */
export type IncompleteReason =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "TOO_LARGE"
  | "INVALID_RESPONSE"
  | "OVER_CAP";

/** Everything read about one assignment, or why it could not all be read. */
export interface AssignmentExtract {
  /** The id the caller named. */
  id: string;
  uid: string | null;
  /** When it was sent, in seconds since the epoch; null if unread. */
  ts: number | null;
  to: string | null;
  sender: string | null;
  principal: string | null;
  ackRequired: boolean;
  events: BridgeEvent[];
  outcomes: OutcomeRecord[];
  links: LinkRecord[];
  /** Absent when the input is complete. */
  incomplete?: IncompleteReason;
}

/** One transcript line, reduced to metadata. */
export interface TranscriptRecord {
  /** Milliseconds since the epoch; null when absent or invalid. */
  ts: number | null;
  type: string;
  role?: "user" | "assistant";
  stopReason?: string;
  toolUseIds: string[];
  toolResultIds: string[];
  /** A user text block equal to Claude Code's interruption marker. */
  interruptionMarker: boolean;
  /** The line was oversized or not a JSON object; nothing else is known about it. */
  malformed?: true;
}

export interface TranscriptExtract {
  records: TranscriptRecord[];
  /** The window began mid-file or dropped lines, so earlier records are missing. */
  truncated: boolean;
}

export type AssignmentState =
  | "unknown"
  | "correlated_reply_observed"
  | "within_threshold"
  | "unfetched_past_threshold"
  | "fetched_no_correlated_reply";

export type SessionState =
  | "session_unobservable"
  | "session_unknown"
  | "observed_recent_record"
  | "tool_pending_unknown_cause"
  | "interrupted_marker_observed"
  | "ended_turn_observed";

/** How a correlated response was established. */
export interface Correlation {
  source: "outcome" | "link";
  /** The outcome kind, for an outcome. */
  kind?: string;
  /** `reported` when the operator credential recorded it for the role. */
  attribution: "authenticated" | "reported";
}

export interface AssignmentReport {
  id: string;
  /** Seconds since it was sent; null when unknown. */
  ageS: number | null;
  state: AssignmentState;
  correlation?: Correlation;
  /** Links at the assignment from the role that do not correlate. */
  uncorrelated: number;
  incomplete?: IncompleteReason;
}

export interface ActivityReport {
  agent: string;
  assignments: AssignmentReport[];
  session: SessionState;
}

export interface ActivityInput {
  /** The addressed role. */
  agent: string;
  /** The role's declared session, when known. */
  session?: string;
  assignments: AssignmentExtract[];
  /** Absent when no transcript was given. */
  transcript?: TranscriptExtract;
  nowMs: number;
  thresholdMs: number;
}

/**
 * The classifier. A deliberate, conservative stub until the classifier task fills it
 * (doc 15): every assignment is `unknown` and the session is `session_unknown`, so it
 * can never report a response, a quiet session or a missing reply that it has not
 * established.
 */
export function classifyActivity(input: ActivityInput): ActivityReport {
  return {
    agent: input.agent,
    assignments: input.assignments.map((a) => ({
      id: a.id,
      ageS: null,
      state: "unknown",
      uncorrelated: 0,
      ...(a.incomplete ? { incomplete: a.incomplete } : {})
    })),
    session: "session_unknown"
  };
}
