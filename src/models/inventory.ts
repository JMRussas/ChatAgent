import {
  discoveryLimitsSchema,
  loadDiscoveryLimits,
  type DiscoveryLimits
} from "../config/discoveryLimits";
import { z } from "zod";
import type { ApiKind, Connection } from "./connections";
import type { DiscoveryConfig } from "../config/discoveryConfig";

export interface ModelObservation {
  bindingId: string;
  connectionId: string;
  model: string;
  revision?: string;
  observedAtIso: string;
  expiresAtIso: string;
  source: string;
  installed: "yes" | "no" | "unknown";
  access: "allowed" | "denied" | "unknown";
  health: "reachable" | "unreachable" | "unknown";
  apiCompatibility: string[];
  effectiveContextTokens?: number;
  effectiveOutputTokens?: number;
  /** Safe, non-secret code only -- never a raw provider exception message. */
  lastErrorCode?: string;
}

/** Adapters may cap validity; absent expiry uses the inventory's configured TTL. */
export type DiscoveryObservation = Omit<ModelObservation, "expiresAtIso"> & {
  expiresAtIso?: string;
};
export interface DiscoveryAdapter {
  /** Arrays mean a complete listing. Partial listings must declare complete:false;
   * a failed or over-limit listing must throw rather than silently truncate. */
  discover(
    connection: Connection,
    signal: AbortSignal,
    limits?: DiscoveryLimits
  ): Promise<DiscoveryObservation[] | { observations: DiscoveryObservation[]; complete: boolean }>;
}

/** Offsets are accepted, but the instant must exist: format alone admits +99:99. */
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid instant");
const text = (max: number) => z.string().min(1).max(max);
/** Each row as it must arrive at run time, whatever the adapter's static type says. */
const discoveryObservationSchema = z
  .object({
    // Composed binding keys include the connection id, model and profile.
    bindingId: text(2048),
    connectionId: text(256),
    model: text(512),
    revision: text(256).optional(),
    observedAtIso: instant,
    expiresAtIso: instant.optional(),
    source: text(128),
    installed: z.enum(["yes", "no", "unknown"]),
    access: z.enum(["allowed", "denied", "unknown"]),
    health: z.enum(["reachable", "unreachable", "unknown"]),
    apiCompatibility: z.array(text(64)).max(32),
    effectiveContextTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    effectiveOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional()
  })
  .strict();
const discoveryListingSchema = z.union([
  z.array(z.unknown()),
  z.object({ observations: z.array(z.unknown()), complete: z.boolean() }).strict()
]);
const MAX_CONNECTION_ID = 256;

/** The only codes a refresh status can carry; adapter messages are never kept. */
export const DISCOVERY_FAILURE_CODES = [
  "DISCOVERY_INVALID_SHAPE",
  "DISCOVERY_INVALID_IDENTITY",
  "DISCOVERY_DUPLICATE_BINDING",
  "DISCOVERY_FOREIGN_BINDING",
  "DISCOVERY_FUTURE_OBSERVATION",
  "DISCOVERY_REVERSED_EXPIRY",
  "DISCOVERY_CAPACITY",
  "DISCOVERY_INCOMPLETE",
  "DISCOVERY_INCOMPLETE_LISTING",
  "DISCOVERY_RESPONSE_TOO_LARGE",
  "DISCOVERY_EMPTY_BODY",
  "DISCOVERY_TIMEOUT",
  "DISCOVERY_INVALID_CLOCK",
  "DISCOVERY_FAILED"
] as const;
export type DiscoveryFailureCode = (typeof DISCOVERY_FAILURE_CODES)[number];
const OWNED_CODES: ReadonlySet<string> = new Set(DISCOVERY_FAILURE_CODES);
class DiscoveryRejection extends Error {
  constructor(readonly code: DiscoveryFailureCode) {
    super(code);
  }
}
/** The latest completed refresh of one connection; not real-time readiness. */
export interface DiscoveryRefreshStatus {
  connectionId: string;
  outcome: "succeeded" | "failed" | "partial";
  code: DiscoveryFailureCode | null;
  /** Null when the clock could not be read; the status is still recorded. */
  completedAtIso: string | null;
  /** Published on success; otherwise what is still retained for the connection. */
  observations: number;
}

export type Readiness =
  "disabled" | "unsupported-adapter" | "unchecked" | "stale" | "denied" | "unavailable" | "ready";

/**
 * Precedence is significant and matches spec 03 exactly: disabled,
 * unsupported-adapter, unchecked, stale, denied, unavailable, ready. Ready
 * requires fresh allowed access and reachable health, not merely presence of
 * an observation. Configuration is never treated as evidence of readiness.
 */
export function computeReadiness(input: {
  enabled: boolean;
  adapterImplemented: boolean;
  observation?: ModelObservation;
  nowIso: string;
}): Readiness {
  if (!input.enabled) return "disabled";
  if (!input.adapterImplemented) return "unsupported-adapter";

  const obs = input.observation;
  if (!obs) return "unchecked";
  if (obs.expiresAtIso <= input.nowIso) return "stale";
  if (obs.access === "denied") return "denied";
  if (obs.installed !== "yes" || obs.health !== "reachable" || obs.access !== "allowed")
    return "unavailable";
  return "ready";
}

/** apiKinds with an implemented request-mapping adapter (spec 03/04 boundary: cataloging a
 * transport is not the same as this app being able to send it a chat request). */
const IMPLEMENTED_CHAT_ADAPTERS: ReadonlySet<ApiKind> = new Set([
  "mock",
  "ollama-chat",
  "azure-openai-chat",
  "bedrock-converse"
]);
export function isChatAdapterImplemented(apiKind: ApiKind): boolean {
  return IMPLEMENTED_CHAT_ADAPTERS.has(apiKind);
}

/**
 * Holds fresh-or-stale model observations per binding and orchestrates
 * bounded, cancellable, per-connection-single-flight discovery refreshes.
 * Never mutates catalog preferences; observations are read-only evidence.
 */
export class InventoryStore {
  private readonly observations = new Map<string, ModelObservation>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortControllers = new Set<AbortController>();
  /** Insertion-ordered: an updated entry moves last, and the oldest is evicted first. */
  private readonly refreshStatus = new Map<string, DiscoveryRefreshStatus>();
  private stopped = false;

  constructor(
    private readonly adapters: Partial<Record<ApiKind, DiscoveryAdapter>>,
    private readonly config: DiscoveryConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: DiscoveryLimits = loadDiscoveryLimits()
  ) {
    this.limits = discoveryLimitsSchema.parse(limits);
  }
  retentionStats() {
    return {
      observations: this.observations.size,
      bytes: Buffer.byteLength(JSON.stringify([...this.observations.values()])),
      inFlight: this.inFlight.size,
      refreshStatuses: this.refreshStatus.size,
      ...this.limits
    };
  }

  /** Latest completed attempt per connection, bounded; copies, sorted by connection. */
  refreshStatuses() {
    return {
      connections: [...this.refreshStatus.values()]
        .map((status) => ({ ...status }))
        .sort((a, b) =>
          a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0
        ),
      retained: this.refreshStatus.size,
      limit: this.limits.maxRefreshStatuses
    };
  }

  /** The injected clock, or null if it throws or gives an unrepresentable instant. */
  private readClock(): number | null {
    try {
      const time = this.now().getTime();
      return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : null;
    } catch {
      return null;
    }
  }

  /** Never reads the clock itself, so it cannot fail after a publication. */
  private record(
    connectionId: string,
    outcome: DiscoveryRefreshStatus["outcome"],
    code: DiscoveryFailureCode | null,
    observations: number,
    completedAt: number | null
  ) {
    this.refreshStatus.delete(connectionId);
    this.refreshStatus.set(connectionId, {
      connectionId,
      outcome,
      code,
      completedAtIso: completedAt === null ? null : new Date(completedAt).toISOString(),
      observations
    });
    for (const key of this.refreshStatus.keys()) {
      if (this.refreshStatus.size <= this.limits.maxRefreshStatuses) break;
      this.refreshStatus.delete(key);
    }
  }

  private retainedCount(connectionId: string) {
    let n = 0;
    for (const o of this.observations.values()) if (o.connectionId === connectionId) n++;
    return n;
  }

  getObservation(bindingId: string): ModelObservation | undefined {
    const observation = this.observations.get(bindingId);
    return observation ? structuredClone(observation) : undefined;
  }

  listObservations(): readonly ModelObservation[] {
    return [...this.observations.values()].map((observation) => structuredClone(observation));
  }

  /** Refreshes all given connections, at most `maxConcurrentRequests` at a time. */
  async refreshAll(connections: readonly Connection[]): Promise<void> {
    if (this.stopped) return;
    const queue = [...connections];
    const workerCount = Math.max(1, Math.min(this.config.maxConcurrentRequests, queue.length || 1));
    const workers = Array.from({ length: workerCount }, async () => {
      let next: Connection | undefined;
      while ((next = queue.shift())) {
        await this.refreshConnection(next);
      }
    });
    await Promise.all(workers);
  }

  /** One refresh per connection at a time; a concurrent call joins the in-flight one. */
  refreshConnection(connection: Connection): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.inFlight.get(connection.connectionId);
    if (existing) return existing;

    const promise = this.doRefresh(connection).finally(() =>
      this.inFlight.delete(connection.connectionId)
    );
    this.inFlight.set(connection.connectionId, promise);
    return promise;
  }

  private async doRefresh(connection: Connection): Promise<void> {
    const adapter = this.adapters[connection.apiKind];
    if (!adapter) return;
    const connectionId = connection.connectionId;
    // An unbounded or empty id is never sent to an adapter or kept as a status key, so
    // such a connection has no diagnostic either.
    if (
      typeof connectionId !== "string" ||
      !connectionId ||
      connectionId.length > MAX_CONNECTION_ID
    )
      return;

    const controller = new AbortController();
    this.abortControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    let now: number | null = null;

    try {
      // The single-flight entry is held until the adapter settles, even after a
      // timeout, so discovery of one connection never overlaps itself.
      const listing = await adapter.discover(connection, controller.signal, this.limits);
      if (this.stopped) return;
      // A result that arrives after the timeout is not published.
      if (controller.signal.aborted) throw new DiscoveryRejection("DISCOVERY_TIMEOUT");
      // Sampled once, after the adapter returned: rows made during discovery are not
      // compared with the request's start time.
      now = this.readClock();
      // Without a usable clock nothing is checked or published.
      if (now === null) throw new DiscoveryRejection("DISCOVERY_INVALID_CLOCK");
      const parsed = discoveryListingSchema.safeParse(listing);
      if (!parsed.success) throw new DiscoveryRejection("DISCOVERY_INVALID_SHAPE");
      const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.observations;
      if (!Array.isArray(parsed.data) && !parsed.data.complete)
        throw new DiscoveryRejection("DISCOVERY_INCOMPLETE");
      if (rows.length > this.limits.maxModelsPerConnection)
        throw new DiscoveryRejection("DISCOVERY_CAPACITY");
      // The whole batch is validated before any existing evidence changes.
      const replacement = new Map<string, ModelObservation>();
      for (const row of rows) {
        const valid = discoveryObservationSchema.safeParse(row);
        if (!valid.success) throw new DiscoveryRejection("DISCOVERY_INVALID_SHAPE");
        const observation = valid.data;
        if (observation.connectionId !== connectionId)
          throw new DiscoveryRejection("DISCOVERY_INVALID_IDENTITY");
        if (replacement.has(observation.bindingId))
          throw new DiscoveryRejection("DISCOVERY_DUPLICATE_BINDING");
        const owner = this.observations.get(observation.bindingId);
        if (owner && owner.connectionId !== connectionId)
          throw new DiscoveryRejection("DISCOVERY_FOREIGN_BINDING");
        const observed = Date.parse(observation.observedAtIso);
        if (observed > now!) throw new DiscoveryRejection("DISCOVERY_FUTURE_OBSERVATION");
        const expiry =
          observation.expiresAtIso === undefined ? Infinity : Date.parse(observation.expiresAtIso);
        if (expiry < observed) throw new DiscoveryRejection("DISCOVERY_REVERSED_EXPIRY");
        // Canonical UTC, so readiness can compare instants as strings.
        replacement.set(observation.bindingId, {
          ...observation,
          observedAtIso: new Date(observed).toISOString(),
          expiresAtIso: new Date(Math.min(observed + this.config.ttlMs, expiry)).toISOString()
        });
      }
      // No tombstones: missing observations are unchecked and cannot authorize dispatch.
      const retained = [...this.observations.values()].filter(
        (o) => o.connectionId !== connectionId
      );
      const combined = [...retained, ...replacement.values()];
      if (
        combined.length > this.limits.maxObservations ||
        Buffer.byteLength(JSON.stringify(combined)) > this.limits.maxBytes
      )
        throw new DiscoveryRejection("DISCOVERY_CAPACITY");
      for (const [id, observation] of this.observations)
        if (observation.connectionId === connectionId) this.observations.delete(id);
      for (const [id, observation] of replacement) this.observations.set(id, observation);
      this.record(connectionId, "succeeded", null, replacement.size, now);
    } catch (error) {
      // Failures retain prior observations but never extend their expiration.
      if (this.stopped) return;
      const code: DiscoveryFailureCode =
        error instanceof DiscoveryRejection
          ? error.code
          : timedOut
            ? "DISCOVERY_TIMEOUT"
            : error instanceof Error && OWNED_CODES.has(error.message)
              ? (error.message as DiscoveryFailureCode)
              : "DISCOVERY_FAILED";
      this.record(
        connectionId,
        code === "DISCOVERY_INCOMPLETE" ? "partial" : "failed",
        code,
        this.retainedCount(connectionId),
        now ?? this.readClock()
      );
    } finally {
      clearTimeout(timer);
      this.abortControllers.delete(controller);
    }
  }

  /** Cancels in-flight discovery requests. Idempotent. */
  shutdown(): void {
    this.stopped = true;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }
}
