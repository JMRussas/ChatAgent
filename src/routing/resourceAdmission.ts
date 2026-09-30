import { randomUUID } from "node:crypto";
import type { BindingResources, DispatchPolicy } from "../config/dispatchConfig";

export class AdmissionError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface ResourceRequest { resources?: BindingResources; inputTokens: number; outputTokens: number }
interface Charge { id: string; request: ResourceRequest; reservedUsd: number | null; units: number;
  started: boolean; status: "reserved" | "unsettled" | "released" | "reported"; reportedUsd: number | null; }
export function fresh(e: { checkedAtIso: string; expiresAtIso: string }, now: number) {
  return Date.parse(e.checkedAtIso) <= now && Date.parse(e.expiresAtIso) > now;
}
export function resourceExclusion(r: BindingResources | undefined, policy: DispatchPolicy, now: number): string | undefined {
  if (!r || !fresh(r.evidence, now)) return "RESOURCE_FACTS_UNKNOWN_OR_STALE";
  if (r.facts.executionScope === "unknown" || !policy.allowedExecutionScopes.includes(r.facts.executionScope)) return "EXECUTION_SCOPE_DENIED";
  if (r.facts.billingComponents.some(b => b === "unknown" || !policy.allowedBillingComponents.includes(b))) return "BILLING_MODE_DENIED";
  const cost = r.incremental && fresh(r.incremental.evidence, now) ? r.incremental.maxInvocationUsd : null;
  if (cost === null && (policy.unknownCostAction === "deny" || policy.maxIncrementalUsd !== null)) return "COST_UNKNOWN_OR_STALE";
  if (cost !== null && policy.maxIncrementalUsd !== null && cost > policy.maxIncrementalUsd) return "SPEND_LIMIT";
  if (r.facts.billingComponents.includes("subscription") && !r.quota && r.quotaAdmission !== "adapter-preflight") return "QUOTA_UNKNOWN";
  if (r.quota && !fresh(r.quota.evidence, now)) return "QUOTA_UNKNOWN_OR_STALE";
  return undefined;
}

/** In-process ledger. Consumed work without usage stays unsettled, including errors
 * and cancellation. Restart loses this ledger: it is not an account-wide cap. */
export class ResourceAdmission {
  private charges = new Map<string, Charge>();
  private running = new Map<string, number>();
  constructor(readonly policy: DispatchPolicy, private now: () => number = Date.now) {}
  private validate(requests: ResourceRequest[]) {
    const staged = [...this.charges.values()].filter(c => c.status !== "released");
    for (const request of requests) {
      for (const n of [request.inputTokens, request.outputTokens]) if (!Number.isSafeInteger(n) || n < 0) throw new AdmissionError("INVALID_TOKEN_BUDGET");
      const denied = resourceExclusion(request.resources, this.policy, this.now());
      if (denied) throw new AdmissionError(denied);
      const r = request.resources!;
      const reservedUsd = r.incremental && fresh(r.incremental.evidence, this.now()) ? r.incremental.maxInvocationUsd : null;
      const units = r.quota?.unit === "tokens" ? request.inputTokens + request.outputTokens : 1;
      const charge: Charge = { id: randomUUID(), request: structuredClone(request), reservedUsd, units,
        started: false, status: "reserved", reportedUsd: null };
      staged.push(charge);
      if (this.policy.maxIncrementalUsd !== null && staged.reduce((n, c) => n + (c.reportedUsd ?? c.reservedUsd ?? 0), 0) > this.policy.maxIncrementalUsd)
        throw new AdmissionError("SPEND_LIMIT");
      if (r.quota) {
        const same = staged.filter(c => c.request.resources?.quota?.poolId === r.quota!.poolId);
        // Refuse conflicting snapshots instead of treating refresh as a refund.
        if (same.some(c => JSON.stringify(c.request.resources!.quota) !== JSON.stringify(r.quota))) throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
        if (same.reduce((n, c) => n + c.units, 0) > r.quota.remaining) throw new AdmissionError("QUOTA_EXHAUSTED");
      }
    }
    return staged.slice(staged.length - requests.length);
  }
  check(requests: ResourceRequest[]) {
    this.validate(requests);
    if (this.policy.quotaExhaustionAction !== "wait") for (const request of requests) {
      const pool = request.resources?.compute;
      if (pool && (this.running.get(pool.poolId) ?? 0) >= pool.concurrency) throw new AdmissionError("COMPUTE_CAPACITY_EXHAUSTED");
    }
  }
  reserve(requests: ResourceRequest[]): string[] {
    if (!requests.length) return [];
    const staged = this.validate(requests); // no await: all-or-nothing for a turn
    for (const charge of staged) this.charges.set(charge.id, charge);
    return staged.map(c => c.id);
  }
  async reserveWithWait(requests: ResourceRequest[], signal?: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + this.policy.waitTimeoutMs;
    while (true) {
      if (signal?.aborted) throw new AdmissionError("CANCELLED");
      try { return this.reserve(requests); }
      catch (error) {
        if (!(error instanceof AdmissionError) || error.code !== "QUOTA_EXHAUSTED" ||
          this.policy.quotaExhaustionAction !== "wait" || Date.now() >= deadline) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
  }
  release(id: string) {
    const c = this.charges.get(id);
    if (c && !c.started) c.status = "released";
  }
  async begin(id: string, signal: AbortSignal): Promise<void> {
    const c = this.charges.get(id);
    if (!c || c.status !== "reserved" || c.started) throw new AdmissionError("INVALID_RESERVATION");
    const deadline = Date.now() + this.policy.waitTimeoutMs;
    while (true) {
      if (signal.aborted) { this.release(id); throw new AdmissionError("CANCELLED"); }
      const denied = resourceExclusion(c.request.resources, this.policy, this.now());
      if (denied) { this.release(id); throw new AdmissionError(denied); }
      if (this.policy.maxIncrementalUsd !== null && [...this.charges.values()].filter(v => v.status !== "released")
        .reduce((sum, v) => sum + (v.reportedUsd ?? v.reservedUsd ?? 0), 0) > this.policy.maxIncrementalUsd) {
        this.release(id); throw new AdmissionError("SPEND_LIMIT");
      }
      const pool = c.request.resources?.compute;
      const active = pool ? this.running.get(pool.poolId) ?? 0 : 0;
      const limits = pool ? [...this.charges.values()].filter(v => v.status === "reserved" && v.started &&
        v.request.resources?.compute?.poolId === pool.poolId).map(v => v.request.resources!.compute!.concurrency) : [];
      if (!pool || active < Math.min(pool.concurrency, ...limits)) {
        if (pool) this.running.set(pool.poolId, active + 1);
        c.started = true; return;
      }
      if (this.policy.quotaExhaustionAction !== "wait" || Date.now() >= deadline) {
        this.release(id); throw new AdmissionError("COMPUTE_CAPACITY_EXHAUSTED");
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
  finish(id: string, reported?: { usd: number; quotaUnits: number }) {
    const c = this.charges.get(id);
    if (!c || !c.started || c.status !== "reserved") return;
    const pool = c.request.resources?.compute;
    if (pool) this.running.set(pool.poolId, Math.max(0, (this.running.get(pool.poolId) ?? 1) - 1));
    c.status = "unsettled";
    if (reported && Number.isFinite(reported.usd) && reported.usd >= 0 && Number.isFinite(reported.quotaUnits) && reported.quotaUnits >= 0) {
      c.reportedUsd = reported.usd; c.units = reported.quotaUnits; c.status = "reported";
    }
  }
  snapshot() {
    return [...this.charges.values()].map(c => ({ id: c.id, status: c.status, reservedUsd: c.reservedUsd,
      reportedUsd: c.reportedUsd, quotaUnits: c.request.resources?.quota ? c.units : null, started: c.started }));
  }
}
