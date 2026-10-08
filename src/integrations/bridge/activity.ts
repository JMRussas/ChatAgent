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

const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function unknownAssignment(a: AssignmentExtract): AssignmentReport {
  return {
    id: a.id,
    ageS: null,
    state: "unknown",
    uncorrelated: 0,
    ...(a.incomplete ? { incomplete: a.incomplete } : {})
  };
}

interface Candidate {
  correlation: Correlation;
  ts: number;
}

function classifyAssignment(input: ActivityInput, a: AssignmentExtract): AssignmentReport {
  const { agent, session, nowMs, thresholdMs } = input;
  if (a.incomplete || a.to !== agent) return unknownAssignment(a);
  if (!isTime(a.ts) || a.ts * 1000 > nowMs) return unknownAssignment(a);
  for (const r of [...a.events, ...a.outcomes, ...a.links]) {
    if (!isTime(r.ts) || r.ts * 1000 > nowMs) return unknownAssignment(a);
  }
  const start = a.ts;
  const ageMs = nowMs - start * 1000;
  const ageS = Math.floor(ageMs / 1000);

  const candidates: Candidate[] = [];
  for (const o of a.outcomes) {
    if (o.ts < start) continue;
    if (o.kind !== "blocked" && o.kind !== "completed" && o.kind !== "verified") continue;
    let attribution: Correlation["attribution"] | null = null;
    if (o.actor === agent) attribution = "authenticated";
    else if (
      o.actor === "fenrir" &&
      o.role === agent &&
      (session === undefined || o.session === session)
    ) {
      attribution = "reported";
    }
    if (attribution)
      candidates.push({ ts: o.ts, correlation: { source: "outcome", kind: o.kind, attribution } });
  }
  let uncorrelated = 0;
  for (const l of a.links) {
    if (l.ts < start) continue;
    let attribution: Correlation["attribution"] | null = null;
    if (l.relation === "replies_to" && l.from !== null) {
      if (l.actor === agent && l.from.principal === agent) attribution = "authenticated";
      else if (
        l.actor === "fenrir" &&
        l.from.principal === "fenrir" &&
        l.from.role === agent &&
        (session === undefined || l.from.session === session)
      ) {
        attribution = "reported";
      }
    }
    if (attribution) candidates.push({ ts: l.ts, correlation: { source: "link", attribution } });
    else if (l.actor === agent) uncorrelated++;
  }

  if (candidates.length > 0) {
    const rank = (c: Candidate): number =>
      (c.correlation.attribution === "authenticated" ? 0 : 2) +
      (c.correlation.source === "outcome" ? 0 : 1);
    let best = candidates[0];
    for (const c of candidates) {
      if (rank(c) < rank(best) || (rank(c) === rank(best) && c.ts < best.ts)) best = c;
    }
    return {
      id: a.id,
      ageS,
      state: "correlated_reply_observed",
      correlation: best.correlation,
      uncorrelated
    };
  }
  let state: AssignmentState;
  if (ageMs <= thresholdMs) state = "within_threshold";
  else if (
    a.events.some(
      (e) =>
        (e.kind === "offered" || e.kind === "consumed" || e.kind === "acknowledged") &&
        e.ts >= start
    )
  ) {
    state = "fetched_no_correlated_reply";
  } else state = "unfetched_past_threshold";
  return { id: a.id, ageS, state, uncorrelated };
}

function classifySession(input: ActivityInput): SessionState {
  const { transcript, nowMs, thresholdMs } = input;
  if (!transcript) return "session_unobservable";
  if (transcript.truncated) return "session_unknown";
  const all = transcript.records;
  const conv: TranscriptRecord[] = [];
  let lastAssistantIndex = Infinity;
  let lastAssistantPos = -1;
  all.forEach((r, i) => {
    if (r.malformed || (r.role !== "user" && r.role !== "assistant")) return;
    conv.push(r);
    if (r.role === "assistant") {
      lastAssistantIndex = i;
      lastAssistantPos = conv.length - 1;
    }
  });
  if (conv.length === 0) return "session_unknown";
  for (const r of conv) {
    if (!isTime(r.ts) || r.ts > nowMs) return "session_unknown";
  }
  const bound = Math.min(all.length - 20, lastAssistantIndex);
  for (let i = 0; i < all.length; i++) {
    if (all[i].malformed && i >= bound) return "session_unknown";
  }
  const seenUse = new Set<string>();
  const seenResult = new Set<string>();
  for (const r of conv) {
    for (const id of r.toolUseIds) {
      if (seenUse.has(id)) return "session_unknown";
      seenUse.add(id);
    }
    for (const id of r.toolResultIds) {
      if (seenResult.has(id)) return "session_unknown";
      seenResult.add(id);
    }
  }
  const last = conv[conv.length - 1];
  if (nowMs - (last.ts as number) <= thresholdMs) return "observed_recent_record";
  if (lastAssistantPos >= 0) {
    const ids = conv[lastAssistantPos].toolUseIds;
    if (ids.length > 0) {
      const later = new Set<string>();
      for (let k = lastAssistantPos + 1; k < conv.length; k++) {
        for (const id of conv[k].toolResultIds) later.add(id);
      }
      if (ids.some((id) => !later.has(id))) return "tool_pending_unknown_cause";
    }
  }
  if (last.role === "user" && last.interruptionMarker) return "interrupted_marker_observed";
  if (
    last.role === "assistant" &&
    (last.stopReason === "end_turn" || last.stopReason === "stop_sequence")
  ) {
    return "ended_turn_observed";
  }
  return "session_unknown";
}

/**
 * The classifier (doc 15). Pure and deterministic: it reports a response, a quiet
 * session or a missing reply only when the input establishes it, and anything
 * incomplete or inconsistent is `unknown`.
 */
export function classifyActivity(input: ActivityInput): ActivityReport {
  if (!isTime(input.nowMs) || !isTime(input.thresholdMs)) {
    return {
      agent: input.agent,
      assignments: input.assignments.map(unknownAssignment),
      session: "session_unknown"
    };
  }
  return {
    agent: input.agent,
    assignments: input.assignments.map((a) => classifyAssignment(input, a)),
    session: classifySession(input)
  };
}
