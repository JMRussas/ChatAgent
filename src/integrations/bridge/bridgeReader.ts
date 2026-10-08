import type {
  AssignmentExtract,
  BridgeEvent,
  DeclaredIdentity,
  IncompleteReason,
  LinkRecord,
  OutcomeRecord
} from "./activity";

/**
 * Reads the bridge evidence for named assignments (doc 15). It only reads: one
 * `GET /api/evidence` per assignment, one `GET /api/links` for it, and the linking
 * messages of its `replies_to` links. Every request goes to a literal loopback
 * origin, follows no redirect, shares one whole-run deadline and has its own time
 * limit and byte cap. Only allowlisted metadata is kept; message text, outcome
 * details beyond a declared role and session, and references are dropped as each
 * response is parsed. The token is sent only as the Authorization header and never
 * appears in a URL, an error or the output.
 */

export type BridgeReadErrorCode =
  "INVALID_URL" | "MISSING_TOKEN" | "INVALID_ASSIGNMENT" | "DEADLINE";

/** A refusal of the whole read, with a stable code and nothing else. */
export class BridgeReadError extends Error {
  constructor(readonly code: BridgeReadErrorCode) {
    super(code);
    this.name = "BridgeReadError";
  }
}

export const MAX_ASSIGNMENTS = 32;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RECORDS = 200;
export const MAX_REPLY_READS = 8;
export const MAX_DEADLINE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_STRING = 256;

/** Only http to a literal loopback address; names are not resolved or trusted. */
export function bridgeApiBase(url: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new BridgeReadError("INVALID_URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  )
    throw new BridgeReadError("INVALID_URL");
  return parsed.origin;
}

/** One assignment's input stops here; the others are still read. */
class Incomplete extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
  }
}

interface Request {
  base: string;
  token: string;
  deadline: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

async function getJson(req: Request, path: string): Promise<unknown> {
  const signal = AbortSignal.any([req.deadline, AbortSignal.timeout(req.timeoutMs)]);
  const failed = () => {
    if (req.deadline.aborted) return new BridgeReadError("DEADLINE");
    return new Incomplete(signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
  };
  let response: Response;
  try {
    response = await fetch(`${req.base}${path}`, {
      redirect: "error",
      signal,
      headers: { accept: "application/json", authorization: `Bearer ${req.token}` }
    });
  } catch {
    throw failed();
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new Incomplete("NOT_FOUND");
    if (response.status === 401 || response.status === 403) throw new Incomplete("FORBIDDEN");
    throw new Incomplete("HTTP_ERROR");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Incomplete("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > req.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Incomplete("TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Incomplete) throw error;
    throw failed();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Incomplete("INVALID_RESPONSE");
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_STRING)
    throw new Incomplete("INVALID_RESPONSE");
  return v;
}

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Incomplete("INVALID_RESPONSE");
  return v;
}

function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Incomplete("INVALID_RESPONSE");
  if (v.length > MAX_RECORDS) throw new Incomplete("OVER_CAP");
  return v;
}

/** A declared role and session, kept only when both are short plain strings. */
function declared(v: unknown): DeclaredIdentity {
  if (!isObject(v)) return {};
  const out: DeclaredIdentity = {};
  if (typeof v.role === "string" && v.role.length > 0 && v.role.length <= 64) out.role = v.role;
  if (typeof v.session === "string" && v.session.length > 0 && v.session.length <= 64)
    out.session = v.session;
  return out;
}

function principalOf(m: Record<string, unknown>): string | null {
  return m.authenticated_principal === null || m.authenticated_principal === undefined
    ? null
    : str(m.authenticated_principal);
}

function result(body: unknown): unknown {
  if (!isObject(body) || !("result" in body)) throw new Incomplete("INVALID_RESPONSE");
  return body.result;
}

async function readOne(req: Request, id: string): Promise<AssignmentExtract> {
  const evidence = result(await getJson(req, `/api/evidence?message_id=${encodeURIComponent(id)}`));
  if (!isObject(evidence) || !isObject(evidence.message)) throw new Incomplete("INVALID_RESPONSE");
  const m = evidence.message;
  // The response must be about the message that was asked for.
  if (m.id !== Number(id)) throw new Incomplete("INVALID_RESPONSE");
  const uid = str(m.uid);
  const events: BridgeEvent[] = list(evidence.events).map((e) => {
    if (!isObject(e)) throw new Incomplete("INVALID_RESPONSE");
    return { kind: str(e.kind), ts: num(e.ts) };
  });
  const outcomes: OutcomeRecord[] = list(evidence.outcomes).map((o) => {
    if (!isObject(o)) throw new Incomplete("INVALID_RESPONSE");
    return { kind: str(o.kind), actor: str(o.actor), ts: num(o.ts), ...declared(o.details) };
  });

  const found = list(
    result(
      await getJson(req, `/api/links?target_type=message&target_ref=${encodeURIComponent(uid)}`)
    )
  ).map((l) => {
    // Every link must point at this assignment.
    if (!isObject(l) || l.target_type !== "message" || l.target_ref !== uid)
      throw new Incomplete("INVALID_RESPONSE");
    return {
      relation: str(l.relation),
      actor: str(l.actor),
      ts: num(l.ts),
      fromUid: str(l.message_id)
    };
  });
  const replies = found.filter((l) => l.relation === "replies_to");
  if (replies.length > MAX_REPLY_READS) throw new Incomplete("OVER_CAP");
  const links: LinkRecord[] = [];
  for (const l of found) {
    let from: LinkRecord["from"] = null;
    if (l.relation === "replies_to") {
      const linked = result(
        await getJson(req, `/api/evidence?message_id=${encodeURIComponent(l.fromUid)}`)
      );
      if (!isObject(linked) || !isObject(linked.message)) throw new Incomplete("INVALID_RESPONSE");
      const lm = linked.message;
      // The linking message read must be the one the link names.
      if (lm.uid !== l.fromUid) throw new Incomplete("INVALID_RESPONSE");
      from = {
        uid: l.fromUid,
        sender: str(lm.sender),
        principal: principalOf(lm),
        ...declared(lm.meta)
      };
    }
    links.push({ relation: l.relation, actor: l.actor, ts: l.ts, from });
  }

  return {
    id,
    uid,
    ts: num(m.ts),
    to: str(m.to),
    sender: str(m.sender),
    principal: principalOf(m),
    ackRequired: m.ack_required === true,
    events,
    outcomes,
    links
  };
}

/**
 * Reads the named assignments in order. A failure on one assignment marks only that
 * assignment incomplete; the whole-run deadline refuses the whole read. A caller that
 * also reads other sources passes its own `deadline` signal so that one deadline
 * covers them all; otherwise `deadlineMs` starts one here.
 */
export async function readAssignments(
  baseUrl: string | undefined,
  token: string | undefined,
  ids: readonly string[],
  options: {
    deadlineMs?: number;
    deadline?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
  } = {}
): Promise<AssignmentExtract[]> {
  const base = bridgeApiBase(baseUrl);
  if (!token) throw new BridgeReadError("MISSING_TOKEN");
  if (
    ids.length === 0 ||
    ids.length > MAX_ASSIGNMENTS ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[1-9][0-9]{0,15}$/.test(id))
  )
    throw new BridgeReadError("INVALID_ASSIGNMENT");
  const deadlineMs = Math.min(options.deadlineMs ?? 30_000, MAX_DEADLINE_MS);
  const req: Request = {
    base,
    token,
    deadline: options.deadline ?? AbortSignal.timeout(deadlineMs),
    timeoutMs: Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
    maxBytes: Math.min(options.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES)
  };
  const out: AssignmentExtract[] = [];
  for (const id of ids) {
    try {
      out.push(await readOne(req, id));
    } catch (error) {
      if (!(error instanceof Incomplete)) throw error;
      out.push({
        id,
        uid: null,
        ts: null,
        to: null,
        sender: null,
        principal: null,
        ackRequired: false,
        events: [],
        outcomes: [],
        links: [],
        incomplete: error.reason
      });
    }
  }
  return out;
}
