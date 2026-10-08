import { z } from "zod";

/**
 * Read-only development-coordination status from a Hekate managed plan
 * (`GET /api/plan-contract/v1/plans/{rootId}`).
 *
 * It projects each leaf's state, exact identities and blockers. It never claims,
 * finishes, decides or writes anything; those mutations belong to the Hekate
 * supervisor and the reviewing lead. Execution acknowledgement is reported as
 * unknown: a claim or an in-progress state is allocation, not proof that a worker
 * started, and no source here states otherwise.
 */

export const PLAN_CONTRACT = "plan-contract/v1";

export type DevCoordinationErrorCode =
  | "INVALID_URL"
  | "INVALID_ROOT"
  | "INVALID_RESPONSE"
  | "INVALID_NUMBER"
  | "DUPLICATE_KEY"
  | "UNSAFE_KEY"
  | "UNSUPPORTED_CONTRACT"
  | "ROOT_MISMATCH"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "HTTP_ERROR"
  | "INVALID_OPTIONS";

/** A refusal with a stable code; it never carries a response body or URL. */
export class DevCoordinationError extends Error {
  constructor(
    readonly code: DevCoordinationErrorCode,
    /** The HTTP status, for HTTP_ERROR only. */
    readonly status?: number
  ) {
    super(code);
    this.name = "DevCoordinationError";
  }
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 10_000;
const MAX_ITEMS = 100_000;

/**
 * Strict JSON for counters and keys. Every number must be an exact safe integer
 * (no fraction, exponent, -0 or unsafe magnitude), and no object may repeat a key
 * (escaped spellings included) or use `__proto__`. The raw text is scanned, so a
 * value hidden behind a later duplicate is still seen. JSON.parse then checks syntax.
 */
function parseStrictJson(text: string): unknown {
  const stack: { keys?: Set<string>; expectKey: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = true;
    } else if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        let key: string;
        try {
          key = JSON.parse(text.slice(start, i + 1)) as string;
        } catch {
          throw new DevCoordinationError("INVALID_RESPONSE");
        }
        if (key === "__proto__") throw new DevCoordinationError("UNSAFE_KEY");
        if (top.keys.has(key)) throw new DevCoordinationError("DUPLICATE_KEY");
        top.keys.add(key);
        top.expectKey = false;
      }
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const token = /^[-+0-9.eE]+/.exec(text.slice(i, i + 32))![0];
      if (!/^(?:0|-?[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token)))
        throw new DevCoordinationError("INVALID_NUMBER");
      i += token.length - 1;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DevCoordinationError("INVALID_RESPONSE");
  }
}

const MAX_TIMEOUT_MS = 60_000;
/** A bound must be a whole number from 1 to its ceiling; anything else is refused. */
function assertBound(value: unknown, ceiling: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new DevCoordinationError("INVALID_OPTIONS");
}

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const text = z.string().max(65_536);
const count = (min: number) => z.number().int().min(min);
const work = z.enum(["todo", "in_progress", "done", "cancelled"]);
const gate = z.enum(["completed", "accepted"]);
const effective = z.enum(["none", "accepted", "rejected", "stale"]);

const nodeSchema = z
  .object({
    id: guid,
    parentId: guid.nullable(),
    nodeType: text,
    name: text.nullable(),
    value: text.nullable(),
    contentAttributes: z.record(text),
    siblingOrder: z.number().int(),
    contentRevision: count(1),
    stateRevision: count(0),
    work,
    attemptId: text.nullable(),
    attemptEpoch: count(0),
    artifactRef: text.nullable(),
    executorRef: text.nullable(),
    attemptContentRevision: count(1).nullable(),
    attemptPrereqDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    acceptance: z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        contentRevision: count(1),
        artifactRef: text.nullable(),
        attemptId: text.nullable(),
        attemptEpoch: count(0),
        decidedBy: text,
        evidenceRef: text.nullable()
      })
      .strict()
      .nullable(),
    effectiveAcceptance: effective
  })
  .strict();
const blockerSchema = z.object({ ownerId: guid, predecessorId: guid, gate, reason: text }).strict();
export const planViewSchema = z
  .object({
    contractVersion: z.string(),
    outcome: z.null(),
    rootId: guid,
    projectId: guid,
    defaultGate: gate,
    nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
    dependencies: z
      .array(z.object({ predecessorId: guid, successorId: guid, gate: gate.nullable() }).strict())
      .max(MAX_ITEMS),
    readiness: z
      .object({
        contractVersion: z.string(),
        rootId: guid,
        errors: z
          .array(
            z
              .object({
                code: text,
                message: text,
                nodeId: guid.nullable(),
                relatedId: guid.nullable()
              })
              .strict()
          )
          .max(MAX_ITEMS),
        leaves: z
          .array(
            z
              .object({
                nodeId: guid,
                name: text.nullable(),
                work,
                ready: z.boolean(),
                gatesHold: z.boolean(),
                upstreamChanged: z.boolean(),
                attemptId: text.nullable(),
                attemptEpoch: count(0),
                blockers: z.array(blockerSchema).max(MAX_ITEMS)
              })
              .strict()
          )
          .max(MAX_NODES),
        containers: z
          .array(
            z
              .object({
                nodeId: guid,
                name: text.nullable(),
                completion: z.enum(["empty", "incomplete", "complete"]),
                acceptance: z.enum(["empty", "pending", "accepted", "rejected"]),
                gatesHold: z.boolean()
              })
              .strict()
          )
          .max(MAX_NODES)
      })
      .strict()
  })
  .strict();
export type PlanView = z.infer<typeof planViewSchema>;

export type LeafState =
  | "ready"
  | "blocked"
  | "in_progress"
  | "review_pending"
  | "accepted"
  | "rejected"
  | "stale"
  | "cancelled";

export interface LeafStatus {
  nodeId: string;
  name: string | null;
  state: LeafState;
  /** No source states whether a worker actually started; never inferred. */
  executionAcknowledged: "unknown";
  /** Readiness facts, reported independently of the state. */
  gatesHold: boolean;
  upstreamChanged: boolean;
  /**
   * The current attempt's inputs: `current` only if its pins exist, its content
   * revision is unchanged and nothing upstream changed; `stale` otherwise; `unknown`
   * for an attempt without pins (recorded before pinning); `none` with no attempt.
   */
  attemptPins: "current" | "stale" | "unknown" | "none";
  scope: string | null;
  contentRevision: number;
  stateRevision: number;
  attemptId: string | null;
  attemptEpoch: number;
  executorRef: string | null;
  artifactRef: string | null;
  acceptance: PlanView["nodes"][number]["acceptance"];
  /**
   * Present (and true) only when `acceptance` is a strictly older attempt's
   * decision (Hekate plan 038): history, not this attempt's outcome.
   */
  acceptanceHistorical?: true;
  blockers: (PlanView["readiness"]["leaves"][number]["blockers"][number] & {
    predecessorName: string | null;
  })[];
}

/**
 * Plan-level progress, read from PlanStore's own root container verdict and the
 * leaf states, never inferred from a claim outcome: `no_ready_work` alone is not
 * completion. `complete` needs the root container complete and accepted AND every
 * leaf accepted; `inconsistent` means those two disagree, so neither is claimed.
 * Otherwise the most actionable condition wins: `active` (a leaf in progress),
 * `awaiting_review`, `ready`, else `stuck` (nothing ready, running or awaiting
 * review: blocked, rejected, stale or cancelled work remains).
 */
export type PlanProgressState =
  "complete" | "inconsistent" | "active" | "awaiting_review" | "ready" | "stuck";

export interface PlanProgress {
  state: PlanProgressState;
  rootCompletion: PlanView["readiness"]["containers"][number]["completion"];
  rootAcceptance: PlanView["readiness"]["containers"][number]["acceptance"];
  leafCounts: Partial<Record<LeafState, number>>;
}

export type CoordinationStatus =
  | { status: "invalid"; rootId: string; errors: { code: string; nodeId: string | null }[] }
  | { status: "ok"; rootId: string; progress: PlanProgress; leaves: LeafStatus[] };

function progressOf(
  root: PlanView["readiness"]["containers"][number],
  leaves: LeafStatus[]
): PlanProgress {
  const leafCounts: Partial<Record<LeafState, number>> = {};
  for (const leaf of leaves) leafCounts[leaf.state] = (leafCounts[leaf.state] ?? 0) + 1;
  const containerDone = root.completion === "complete" && root.acceptance === "accepted";
  const leavesDone = leaves.length > 0 && leaves.every((l) => l.state === "accepted");
  const has = (state: LeafState) => (leafCounts[state] ?? 0) > 0;
  const state: PlanProgressState =
    containerDone && leavesDone
      ? "complete"
      : containerDone !== leavesDone
        ? "inconsistent"
        : has("in_progress")
          ? "active"
          : has("review_pending")
            ? "awaiting_review"
            : has("ready")
              ? "ready"
              : "stuck";
  return { state, rootCompletion: root.completion, rootAcceptance: root.acceptance, leafCounts };
}

/** Validates a raw plan view for the requested root and projects each leaf. */
export function coordinationStatus(
  raw: string,
  requestedRoot: string,
  maxBytes = MAX_RESPONSE_BYTES
): CoordinationStatus {
  if (!guid.safeParse(requestedRoot).success) throw new DevCoordinationError("INVALID_ROOT");
  assertBound(maxBytes, MAX_RESPONSE_BYTES);
  if (typeof raw !== "string") throw new DevCoordinationError("INVALID_RESPONSE");
  // Bounded before any scanning.
  if (Buffer.byteLength(raw, "utf8") > maxBytes)
    throw new DevCoordinationError("RESPONSE_TOO_LARGE");
  const parsed = planViewSchema.safeParse(parseStrictJson(raw));
  if (!parsed.success) throw new DevCoordinationError("INVALID_RESPONSE");
  const view = parsed.data;
  if (view.contractVersion !== PLAN_CONTRACT || view.readiness.contractVersion !== PLAN_CONTRACT)
    throw new DevCoordinationError("UNSUPPORTED_CONTRACT");
  if (view.rootId !== requestedRoot || view.readiness.rootId !== requestedRoot)
    throw new DevCoordinationError("ROOT_MISMATCH");
  const nodes = new Map(view.nodes.map((n) => [n.id, n]));
  if (nodes.size !== view.nodes.length) throw new DevCoordinationError("INVALID_RESPONSE");
  // Structure: one root, every reference to a node of this plan.
  const root = nodes.get(view.rootId);
  const known = (id: string | null) => id === null || nodes.has(id);
  if (
    !root ||
    root.parentId !== null ||
    view.nodes.some((n) => n.id !== view.rootId && (n.parentId === null || !known(n.parentId))) ||
    view.dependencies.some((d) => !nodes.has(d.predecessorId) || !nodes.has(d.successorId)) ||
    view.readiness.errors.some((e) => !known(e.nodeId) || !known(e.relatedId))
  )
    throw new DevCoordinationError("INVALID_RESPONSE");
  // Readiness errors mean the plan cannot be evaluated; no leaf state is inferred.
  if (view.readiness.errors.length)
    return {
      status: "invalid",
      rootId: view.rootId,
      errors: view.readiness.errors.map((e) => ({ code: e.code, nodeId: e.nodeId }))
    };
  // The hierarchy is one tree: every node reaches the root without a cycle.
  for (const node of view.nodes) {
    const visited = new Set<string>();
    let current: (typeof view.nodes)[number] | undefined = node;
    while (current && current.id !== view.rootId) {
      if (visited.has(current.id)) throw new DevCoordinationError("INVALID_RESPONSE");
      visited.add(current.id);
      current = current.parentId === null ? undefined : nodes.get(current.parentId);
    }
    if (!current) throw new DevCoordinationError("INVALID_RESPONSE");
  }
  // Every node is exactly one leaf or one container. As in Hekate's IsContainer,
  // a container is the root or a node with children, so a childless node listed
  // as a container cannot hide pending leaf work. The root is never a leaf.
  const parents = new Set(view.nodes.flatMap((n) => (n.parentId === null ? [] : [n.parentId])));
  const leafIds = view.readiness.leaves.map((l) => l.nodeId);
  const containerIds = view.readiness.containers.map((c) => c.nodeId);
  const classified = new Set([...leafIds, ...containerIds]);
  if (
    classified.size !== leafIds.length + containerIds.length ||
    classified.size !== nodes.size ||
    [...classified].some((id) => !nodes.has(id)) ||
    leafIds.includes(view.rootId) ||
    leafIds.some((id) => parents.has(id)) ||
    !containerIds.includes(view.rootId) ||
    containerIds.some((id) => id !== view.rootId && !parents.has(id)) ||
    view.readiness.leaves.some((l) =>
      l.blockers.some((b) => !nodes.has(b.ownerId) || !nodes.has(b.predecessorId))
    )
  )
    throw new DevCoordinationError("INVALID_RESPONSE");
  const seen = new Set<string>();
  const leaves = view.readiness.leaves.map((leaf): LeafStatus => {
    const node = nodes.get(leaf.nodeId);
    // Each readiness leaf must be a known node, listed once, with matching state.
    if (
      !node ||
      seen.has(leaf.nodeId) ||
      node.work !== leaf.work ||
      node.attemptId !== leaf.attemptId ||
      node.attemptEpoch !== leaf.attemptEpoch
    )
      throw new DevCoordinationError("INVALID_RESPONSE");
    seen.add(leaf.nodeId);
    // A current decision must be the recorded decision on this attempt; a payload
    // that advertises one without it is contradictory, not accepted.
    if (node.effectiveAcceptance === "accepted" || node.effectiveAcceptance === "rejected") {
      const a = node.acceptance;
      if (
        node.work !== "done" ||
        !a ||
        a.decision !== node.effectiveAcceptance ||
        a.contentRevision !== node.contentRevision ||
        a.artifactRef !== node.artifactRef ||
        a.attemptId !== node.attemptId ||
        a.attemptEpoch !== node.attemptEpoch
      )
        throw new DevCoordinationError("INVALID_RESPONSE");
    }
    return {
      nodeId: node.id,
      name: node.name,
      state: stateOf(node, leaf.ready, leaf.upstreamChanged),
      executionAcknowledged: "unknown",
      gatesHold: leaf.gatesHold,
      upstreamChanged: leaf.upstreamChanged,
      attemptPins: pinsOf(node, leaf.upstreamChanged),
      scope: node.contentAttributes.scope ?? null,
      contentRevision: node.contentRevision,
      stateRevision: node.stateRevision,
      attemptId: node.attemptId,
      attemptEpoch: node.attemptEpoch,
      executorRef: node.executorRef,
      artifactRef: node.artifactRef,
      acceptance: node.acceptance,
      ...(olderAttemptDecision(node) ? { acceptanceHistorical: true as const } : {}),
      blockers: leaf.blockers.map((b) => ({
        ...b,
        predecessorName: nodes.get(b.predecessorId)!.name
      }))
    };
  });
  const rootContainer = view.readiness.containers.find((c) => c.nodeId === view.rootId)!;
  return { status: "ok", rootId: view.rootId, progress: progressOf(rootContainer, leaves), leaves };
}

function pinsOf(node: PlanView["nodes"][number], upstreamChanged: boolean) {
  if (node.attemptId === null || node.work === "todo" || node.work === "cancelled")
    return "none" as const;
  if (node.attemptContentRevision === null || node.attemptPrereqDigest === null)
    return "unknown" as const;
  return node.attemptContentRevision === node.contentRevision && !upstreamChanged
    ? ("current" as const)
    : ("stale" as const);
}

/**
 * Hekate plan 038: a valid decision recorded for a strictly older positive attempt
 * epoch is history, so the current Done attempt awaits review. Epochs only grow and
 * the producer refuses a decision for a future epoch, so an older epoch is another
 * attempt even when its attempt id is reused. Same-epoch drift, a missing decision and
 * an epoch below 1 or not older stay stale (fail closed).
 */
function olderAttemptDecision(node: PlanView["nodes"][number]): boolean {
  const a = node.acceptance;
  return (
    node.work === "done" &&
    node.effectiveAcceptance === "stale" &&
    a !== null &&
    (a.decision === "accepted" || a.decision === "rejected") &&
    Number.isSafeInteger(a.attemptEpoch) &&
    a.attemptEpoch >= 1 &&
    a.attemptEpoch < node.attemptEpoch
  );
}

function stateOf(
  node: PlanView["nodes"][number],
  ready: boolean,
  upstreamChanged: boolean
): LeafState {
  switch (node.work) {
    case "cancelled":
      return "cancelled";
    case "todo":
      return ready ? "ready" : "blocked";
    case "in_progress":
      return "in_progress";
    case "done":
      // Never accepted: an older attempt's decision, even an acceptance, is history.
      if (olderAttemptDecision(node)) return "review_pending";
      // An acceptance whose inputs have since changed is not shown as current.
      if (node.effectiveAcceptance === "accepted" && upstreamChanged) return "stale";
      return node.effectiveAcceptance === "none" ? "review_pending" : node.effectiveAcceptance;
  }
}

/** Only http to a literal loopback address; names are not resolved or trusted. */
export function planApiBase(url: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new DevCoordinationError("INVALID_URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new DevCoordinationError("INVALID_URL");
  return parsed.origin;
}

/**
 * Reads one plan view: no redirects, a time limit, and a byte cap enforced while
 * reading. Refusals carry codes only.
 */
export async function fetchCoordinationStatus(
  baseUrl: string | undefined,
  rootId: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<CoordinationStatus> {
  const base = planApiBase(baseUrl);
  if (!guid.safeParse(rootId).success) throw new DevCoordinationError("INVALID_ROOT");
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertBound(maxBytes, MAX_RESPONSE_BYTES);
  assertBound(timeoutMs, MAX_TIMEOUT_MS);
  // One deadline for the whole exchange: headers and every body read.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base}/api/plan-contract/v1/plans/${rootId}`, {
      redirect: "error",
      signal,
      headers: { accept: "application/json" }
    });
  } catch (error) {
    throw new DevCoordinationError(
      (error as Error).name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE"
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new DevCoordinationError("HTTP_ERROR", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DevCoordinationError("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DevCoordinationError("TIMEOUT");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DevCoordinationError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DevCoordinationError) throw error;
    throw new DevCoordinationError(
      (error as Error).name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE"
    );
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new DevCoordinationError("INVALID_RESPONSE");
  }
  return coordinationStatus(body, rootId, maxBytes);
}
