import {
  discoveryLimitsSchema,
  loadDiscoveryLimits,
  type DiscoveryLimits
} from "../config/discoveryLimits";
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
      ...this.limits
    };
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

    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const listing = await adapter.discover(connection, controller.signal, this.limits);
      if (this.stopped || controller.signal.aborted) return;
      const results = Array.isArray(listing) ? listing : listing.observations;
      if (!Array.isArray(listing) && !listing.complete) return;
      if (results.length > this.limits.maxModelsPerConnection) throw Error("DISCOVERY_CAPACITY");
      const replacement = new Map<string, ModelObservation>();
      for (const observation of results) {
        if (
          observation.connectionId !== connection.connectionId ||
          !observation.bindingId ||
          !observation.model ||
          (this.observations.has(observation.bindingId) &&
            this.observations.get(observation.bindingId)!.connectionId !== connection.connectionId)
        )
          throw Error("DISCOVERY_INVALID_IDENTITY");
        const observed = Date.parse(observation.observedAtIso);
        if (!Number.isFinite(observed)) throw Error("DISCOVERY_INVALID_TIME");
        const expiry =
          observation.expiresAtIso === undefined ? Infinity : Date.parse(observation.expiresAtIso);
        const expiresAtIso = new Date(
          Number.isFinite(expiry) || expiry === Infinity
            ? Math.min(observed + this.config.ttlMs, expiry)
            : observed
        ).toISOString();
        replacement.set(observation.bindingId, structuredClone({ ...observation, expiresAtIso }));
      }
      // No tombstones: missing observations are unchecked and cannot authorize dispatch.
      const retained = [...this.observations.values()].filter(
        (o) => o.connectionId !== connection.connectionId
      );
      const combined = [...retained, ...replacement.values()];
      if (
        combined.length > this.limits.maxObservations ||
        Buffer.byteLength(JSON.stringify(combined)) > this.limits.maxBytes
      )
        throw Error("DISCOVERY_CAPACITY");
      // Validate the complete replacement before changing any existing evidence.
      for (const [id, observation] of this.observations)
        if (observation.connectionId === connection.connectionId) this.observations.delete(id);
      for (const [id, observation] of replacement) this.observations.set(id, observation);
    } catch {
      // Failures retain prior observations but never extend their expiration.
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
