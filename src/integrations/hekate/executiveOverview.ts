import type { CheckpointRecordEntry } from "../../config/checkpointRecordsConfig";
import type { ExecutiveRoot } from "../../config/executiveOverviewConfig";
import {
  readCheckpointBudget,
  type CheckpointBudgetView,
  type ReadBudgetOptions
} from "./checkpointBudget";
import { finalizeAttention, projectAttention, type Attention } from "./checkpointAttention";
import {
  DevCoordinationError,
  fetchCoordinationStatus,
  type CoordinationStatus,
  type DevCoordinationErrorCode,
  type LeafState,
  type LeafStatus,
  type PlanProgressState
} from "./devCoordination";

/**
 * Shared, read-only executive overview over a fixed, operator-configured set of Hekate plan
 * roots. It reuses `fetchCoordinationStatus` and reports recorded PlanStore state only:
 * acceptance is not source integration or deployment, `ready` is not prepared or running,
 * `in_progress` is not a live or useful worker, and budget is explicitly not reported.
 * Nothing here writes, claims, decides, dispatches or reads a worker trace.
 */

export const EXECUTIVE_OVERVIEW_SCHEMA = "executive-overview/v1";
/** Used only when a trusted checkpoint record registry is configured. */
export const EXECUTIVE_OVERVIEW_SCHEMA_V2 = "executive-overview/v2";
/** Used when a registry is configured: v2 plus the closed, bounded `attention` field. */
export const EXECUTIVE_OVERVIEW_SCHEMA_V3 = "executive-overview/v3";

/** Named bounds shared with the UI and the tests. */
export const EXECUTIVE_LIMITS = {
  maxRoots: 8,
  rootTimeoutMs: 5_000,
  overallDeadlineMs: 8_000,
  rootMaxBytes: 2 * 1024 * 1024,
  maxTasks: 100,
  maxBlockers: 10,
  maxProds: 8,
  maxInvalidCodes: 20,
  maxTextChars: 200,
  maxResponseBytes: 1024 * 1024
} as const;

export type ProdKind =
  | "review_needed"
  | "decide_rework"
  | "refresh_inputs"
  | "resolve_dependency"
  | "claim_available"
  | "confirm_worker_liveness"
  | "investigate_plan_state";
export type TaskProd = ProdKind | "none";
export type CheckpointGate = "accepted" | "rejected" | "awaiting_review" | "not_verified";

export interface Prod {
  kind: ProdKind;
  count: number;
}

export interface ExecutiveTask {
  nodeId: string;
  name: string | null;
  state: LeafState;
  executionAcknowledged: "unknown";
  gatesHold: boolean;
  upstreamChanged: boolean;
  attemptPins: LeafStatus["attemptPins"];
  scope: string | null;
  contentRevision: number;
  stateRevision: number;
  attemptId: string | null;
  attemptEpoch: number;
  executorRef: string | null;
  artifactRef: string | null;
  acceptance: LeafStatus["acceptance"];
  acceptanceHistorical?: true;
  blockers: { id: string; name: string | null; gate: string; reason: string }[];
  blockersOmitted: number;
  prod: TaskProd;
  /** Derived only from the current projected state; a historical decision is never a gate. */
  checkpointGate: CheckpointGate;
  /**
   * No consumed or expected budget is inferred from anything the runtime reports. Only a
   * registered, fence-matched runner record (supplied, unauthenticated) changes this, and only
   * in the registry-enabled v2 response.
   */
  budgetEvidence: "not_reported" | "reported" | "unavailable";
  /** v2 only, and only for a task explicitly in the registry. */
  checkpointBudget?: CheckpointBudgetView;
}

export interface ExecutiveRootView {
  rootId: string;
  label: string;
  /** Operator-written configuration, not a verified result. */
  goal: string | null;
  observedAt: string;
  status: "ok" | "invalid" | "unavailable";
  reason: DevCoordinationErrorCode | null;
  invalidCodes: { code: string; nodeId: string | null }[];
  planState: PlanProgressState | null;
  acceptedCounts: { accepted: number; total: number } | null;
  counts: Partial<Record<LeafState, number>>;
  prods: Prod[];
  tasks: ExecutiveTask[];
  tasksOmitted: number;
}

export interface ExecutiveOverview {
  schema:
    | typeof EXECUTIVE_OVERVIEW_SCHEMA
    | typeof EXECUTIVE_OVERVIEW_SCHEMA_V2
    | typeof EXECUTIVE_OVERVIEW_SCHEMA_V3;
  generatedAt: string;
  /** Roots are read independently; their timestamps are not one snapshot. */
  atomic: false;
  roots: ExecutiveRootView[];
  /** v3 only (registry configured): exceptions derived from supplied records. */
  attention?: Attention;
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function clip(value: string): string {
  const chars = Array.from(value.replace(UNSAFE_TEXT, " "));
  return chars.length > EXECUTIVE_LIMITS.maxTextChars
    ? chars.slice(0, EXECUTIVE_LIMITS.maxTextChars).join("")
    : chars.join("");
}
const clipNull = (value: string | null) => (value === null ? null : clip(value));

const PROD_ORDER: ProdKind[] = [
  "review_needed",
  "decide_rework",
  "refresh_inputs",
  "resolve_dependency",
  "claim_available",
  "confirm_worker_liveness",
  "investigate_plan_state"
];

/** Needs-human states first, then blocked, ready, in progress, accepted, cancelled. */
const STATE_ORDER: LeafState[] = [
  "review_pending",
  "rejected",
  "stale",
  "blocked",
  "ready",
  "in_progress",
  "accepted",
  "cancelled"
];

export function prodOf(leaf: Pick<LeafStatus, "state" | "attemptPins">): TaskProd {
  if (leaf.state === "accepted" || leaf.state === "cancelled") return "none";
  if (leaf.state === "stale" || leaf.attemptPins === "stale") return "refresh_inputs";
  switch (leaf.state) {
    case "review_pending":
      return "review_needed";
    case "rejected":
      return "decide_rework";
    case "blocked":
      return "resolve_dependency";
    case "ready":
      return "claim_available";
    case "in_progress":
      return "confirm_worker_liveness";
  }
}

export function checkpointGateOf(state: LeafState): CheckpointGate {
  if (state === "accepted") return "accepted";
  if (state === "rejected") return "rejected";
  if (state === "review_pending") return "awaiting_review";
  return "not_verified";
}

function projectTask(leaf: LeafStatus): ExecutiveTask {
  const acceptance = leaf.acceptance
    ? {
        ...leaf.acceptance,
        artifactRef: clipNull(leaf.acceptance.artifactRef),
        attemptId: clipNull(leaf.acceptance.attemptId),
        decidedBy: clip(leaf.acceptance.decidedBy),
        evidenceRef: clipNull(leaf.acceptance.evidenceRef)
      }
    : null;
  return {
    nodeId: leaf.nodeId,
    name: clipNull(leaf.name),
    state: leaf.state,
    executionAcknowledged: "unknown",
    gatesHold: leaf.gatesHold,
    upstreamChanged: leaf.upstreamChanged,
    attemptPins: leaf.attemptPins,
    scope: clipNull(leaf.scope),
    contentRevision: leaf.contentRevision,
    stateRevision: leaf.stateRevision,
    attemptId: clipNull(leaf.attemptId),
    attemptEpoch: leaf.attemptEpoch,
    executorRef: clipNull(leaf.executorRef),
    artifactRef: clipNull(leaf.artifactRef),
    acceptance,
    ...(leaf.acceptanceHistorical ? { acceptanceHistorical: true as const } : {}),
    blockers: leaf.blockers.slice(0, EXECUTIVE_LIMITS.maxBlockers).map((b) => ({
      id: b.predecessorId,
      name: clipNull(b.predecessorName),
      gate: b.gate,
      reason: clip(b.reason)
    })),
    blockersOmitted: Math.max(0, leaf.blockers.length - EXECUTIVE_LIMITS.maxBlockers),
    prod: prodOf(leaf),
    checkpointGate: checkpointGateOf(leaf.state),
    budgetEvidence: "not_reported"
  };
}

const byUrgency = (a: ExecutiveTask, b: ExecutiveTask) => {
  const rank = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
  if (rank !== 0) return rank;
  const an = a.name ?? "";
  const bn = b.name ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
};

function baseView(
  config: ExecutiveRoot,
  observedAt: string
): Omit<ExecutiveRootView, "status" | "reason"> {
  return {
    rootId: config.rootId,
    label: config.label,
    goal: config.goal ?? null,
    observedAt,
    invalidCodes: [],
    planState: null,
    acceptedCounts: null,
    counts: {},
    prods: [],
    tasks: [],
    tasksOmitted: 0
  };
}

/** An unreadable root: its code only, never an upstream message, URL or body. */
export function unavailableRoot(
  config: ExecutiveRoot,
  reason: DevCoordinationErrorCode,
  observedAt: string
): ExecutiveRootView {
  return { ...baseView(config, observedAt), status: "unavailable", reason };
}

/** Pure projection of one root's coordination status. */
export function projectRoot(
  status: CoordinationStatus,
  config: ExecutiveRoot,
  observedAt: string = new Date().toISOString()
): ExecutiveRootView {
  if (status.rootId !== config.rootId) return unavailableRoot(config, "ROOT_MISMATCH", observedAt);
  if (status.status === "invalid")
    return {
      ...baseView(config, observedAt),
      status: "invalid",
      reason: null,
      invalidCodes: status.errors
        .slice(0, EXECUTIVE_LIMITS.maxInvalidCodes)
        .map((e) => ({ code: clip(e.code), nodeId: e.nodeId })),
      prods: [{ kind: "investigate_plan_state", count: 1 }]
    };
  const all = status.leaves.map(projectTask).sort(byUrgency);
  const counts = { ...status.progress.leafCounts };
  const total = all.length;
  const tally = new Map<ProdKind, number>();
  for (const task of all)
    if (task.prod !== "none") tally.set(task.prod, (tally.get(task.prod) ?? 0) + 1);
  if (status.progress.state === "inconsistent") tally.set("investigate_plan_state", 1);
  const tasks = all.slice(0, EXECUTIVE_LIMITS.maxTasks);
  return {
    ...baseView(config, observedAt),
    status: "ok",
    reason: null,
    planState: status.progress.state,
    acceptedCounts: { accepted: counts.accepted ?? 0, total },
    counts,
    prods: PROD_ORDER.filter((kind) => tally.has(kind))
      .slice(0, EXECUTIVE_LIMITS.maxProds)
      .map((kind) => ({ kind, count: tally.get(kind)! })),
    tasks,
    tasksOmitted: total - tasks.length
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Caps the serialized overview by dropping trailing (least urgent) tasks from the root that
 * lists the most, with an accurate omitted count. The JSON is never truncated.
 */
export function capOverviewBytes(
  overview: ExecutiveOverview,
  maxBytes: number = EXECUTIVE_LIMITS.maxResponseBytes
): ExecutiveOverview {
  if (bytes(overview) <= maxBytes) return overview;
  const roots = overview.roots.map((root) => ({ ...root, tasks: [...root.tasks] }));
  const sizes = roots.map((root) => root.tasks.map((task) => bytes(task) + 1));
  // Drops the last task of the root listing the most; returns its size, or 0 when none is left.
  const dropOne = () => {
    let at = -1;
    for (let i = 0; i < roots.length; i++)
      if (roots[i].tasks.length > 0 && (at < 0 || roots[i].tasks.length >= roots[at].tasks.length))
        at = i;
    if (at < 0) return 0;
    roots[at].tasks.pop();
    roots[at].tasksOmitted++;
    return sizes[at].pop()!;
  };
  const empty = bytes({ ...overview, roots: roots.map((r) => ({ ...r, tasks: [] })) });
  // Slack covers the omitted counters growing by a digit.
  const budget = maxBytes - empty - 16 * roots.length;
  let used = sizes.flat().reduce((sum, size) => sum + size, 0);
  while (used > budget) {
    const dropped = dropOne();
    if (dropped === 0) break;
    used -= dropped;
  }
  const capped = { ...overview, roots };
  while (bytes(capped) > maxBytes && dropOne() > 0);
  return capped;
}

export type FetchStatus = typeof fetchCoordinationStatus;

export interface CollectOptions {
  /** Injectable for tests; the default is the bounded loopback reader. */
  fetchStatus?: FetchStatus;
  now?: () => Date;
  rootTimeoutMs?: number;
  overallDeadlineMs?: number;
  rootMaxBytes?: number;
  maxResponseBytes?: number;
  /**
   * Trusted startup registry of runner records. Absent: the response is the unchanged v1
   * contract. Present (even if no task matches): v2, with one bounded read per registered task.
   */
  checkpointRecords?: readonly CheckpointRecordEntry[];
  budgetRead?: ReadBudgetOptions;
}

/** Looks up only explicitly registered tasks, accepted ones included; nothing is crawled. */
async function attachBudgets(
  view: ExecutiveRootView,
  entries: readonly CheckpointRecordEntry[],
  budgetRead: ReadBudgetOptions
): Promise<void> {
  await Promise.all(
    view.tasks.map(async (task) => {
      const entry = entries.find((e) => e.rootId === view.rootId && e.nodeId === task.nodeId);
      if (!entry) return;
      let budget: CheckpointBudgetView;
      try {
        budget = await readCheckpointBudget(entry, task, budgetRead);
      } catch {
        budget = { state: "unavailable", reason: "unreadable" };
      }
      task.checkpointBudget = budget;
      task.budgetEvidence = budget.state === "reported" ? "reported" : "unavailable";
    })
  );
}

const ERROR_CODES = new Set<string>([
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
  "INVALID_OPTIONS"
]);

function reasonOf(error: unknown): DevCoordinationErrorCode {
  return error instanceof DevCoordinationError && ERROR_CODES.has(error.code)
    ? error.code
    : "UNAVAILABLE";
}

/**
 * Reads every configured root concurrently. One root's failure never changes another's
 * result, and the overall deadline turns roots still pending into TIMEOUT. The overview is
 * always well-formed; a collapsed upstream shows as per-root `unavailable` cards.
 */
export async function collectExecutiveOverview(
  planApiUrl: string,
  roots: readonly ExecutiveRoot[],
  options: CollectOptions = {}
): Promise<ExecutiveOverview> {
  const fetchStatus = options.fetchStatus ?? fetchCoordinationStatus;
  const now = options.now ?? (() => new Date());
  const rootTimeoutMs = options.rootTimeoutMs ?? EXECUTIVE_LIMITS.rootTimeoutMs;
  const rootMaxBytes = options.rootMaxBytes ?? EXECUTIVE_LIMITS.rootMaxBytes;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DevCoordinationError("TIMEOUT")),
      options.overallDeadlineMs ?? EXECUTIVE_LIMITS.overallDeadlineMs
    );
  });
  deadline.catch(() => undefined);
  try {
    const views = await Promise.all(
      roots.map(async (config): Promise<ExecutiveRootView> => {
        try {
          const status = await Promise.race([
            fetchStatus(planApiUrl, config.rootId, {
              timeoutMs: rootTimeoutMs,
              maxBytes: rootMaxBytes
            }),
            deadline
          ]);
          const view = projectRoot(status, config, now().toISOString());
          if (options.checkpointRecords)
            await attachBudgets(view, options.checkpointRecords, options.budgetRead ?? {});
          return view;
        } catch (error) {
          return unavailableRoot(config, reasonOf(error), now().toISOString());
        }
      })
    );
    const maxBytes = options.maxResponseBytes ?? EXECUTIVE_LIMITS.maxResponseBytes;
    const registry = options.checkpointRecords;
    // Attention is derived from the full views, before the cap can omit any task row.
    const capped = capOverviewBytes(
      {
        schema: registry ? EXECUTIVE_OVERVIEW_SCHEMA_V3 : EXECUTIVE_OVERVIEW_SCHEMA,
        generatedAt: now().toISOString(),
        atomic: false,
        roots: views,
        ...(registry ? { attention: projectAttention(views, registry) } : {})
      },
      maxBytes
    );
    return registry ? finalizeAttention(capped, maxBytes) : capped;
  } finally {
    clearTimeout(timer);
  }
}
