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
export type DiscoveryObservation = Omit<ModelObservation, "expiresAtIso"> & { expiresAtIso?: string };
export interface DiscoveryAdapter {
  discover(connection: Connection, signal: AbortSignal): Promise<DiscoveryObservation[]>;
}

export type Readiness = "disabled" | "unsupported-adapter" | "unchecked" | "stale" | "denied" | "unavailable" | "ready";

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
  if (obs.installed !== "yes" || obs.health !== "reachable" || obs.access !== "allowed") return "unavailable";
  return "ready";
}

/** apiKinds with an implemented request-mapping adapter (spec 03/04 boundary: cataloging a
 * transport is not the same as this app being able to send it a chat request). */
const IMPLEMENTED_CHAT_ADAPTERS: ReadonlySet<ApiKind> = new Set(["mock", "ollama-chat", "azure-openai-chat", "bedrock-converse"]);
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
    private readonly now: () => Date = () => new Date()
  ) {}

  getObservation(bindingId: string): ModelObservation | undefined {
    return this.observations.get(bindingId);
  }

  listObservations(): readonly ModelObservation[] {
    return [...this.observations.values()];
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

    const promise = this.doRefresh(connection).finally(() => this.inFlight.delete(connection.connectionId));
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
      const results = await adapter.discover(connection, controller.signal);
      const seen = new Set<string>();

      // Global TTL is an upper bound, never an extension of adapter validity.
      for (const observation of results) {
        const observed = Date.parse(observation.observedAtIso);
        const adapterExpiry = observation.expiresAtIso === undefined ? Infinity : Date.parse(observation.expiresAtIso);
        // Invalid explicit validity fails closed instead of becoming fresh evidence.
        const expiresAtIso = new Date(Number.isFinite(adapterExpiry) || adapterExpiry === Infinity
          ? Math.min(observed + this.config.ttlMs, adapterExpiry) : observed).toISOString();
        const stamped = { ...observation, expiresAtIso };
        this.observations.set(stamped.bindingId, stamped);
        seen.add(stamped.bindingId);
      }

      // A successful full listing marks previously-observed, now-disappeared
      // bindings for this connection as absent rather than leaving stale "yes".
      const nowIso = this.now().toISOString();
      for (const [bindingId, observation] of this.observations) {
        if (observation.connectionId === connection.connectionId && observation.installed === "yes" && !seen.has(bindingId)) {
          this.observations.set(bindingId, { ...observation, installed: "no", health: "unreachable", observedAtIso: nowIso, expiresAtIso: nowIso });
        }
      }
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
