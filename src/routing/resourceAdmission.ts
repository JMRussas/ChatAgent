import {decimalUnits,decimalNumber} from "./decimalAccounting";
import {createHash} from "node:crypto";
import {loadExecutionRetention,type ExecutionRetention} from "../config/executionRetention";
import { randomUUID } from "node:crypto";
import type { BindingResources, DispatchPolicy } from "../config/dispatchConfig";

export class AdmissionError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface ResourceRequest { resources?: BindingResources; inputTokens: number; outputTokens: number }
interface Charge { sequence:number; id: string; request: ResourceRequest; reservedUsd: number | null; units: bigint;
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

type ChargeView=Pick<Charge,"id"|"status"|"reservedUsd"|"reportedUsd"|"started"> & {quotaUnits:number|null};
const view=(c:Charge):ChargeView=>({id:c.id,status:c.status,reservedUsd:c.reservedUsd,reportedUsd:c.reportedUsd,
  quotaUnits:c.request.resources?.quota ? decimalNumber(c.units):null,started:c.started});
const quotaKey=(quota:NonNullable<BindingResources["quota"]>)=>createHash("sha256").update(JSON.stringify(quota)).digest("hex");

/** In-process ledger. Consumed work without usage stays unsettled, including errors
 * and cancellation. Completed IDs retain only bounded diagnostic rows; lifetime
 * spend and one quota fingerprint/total per encountered pool survive that expiry.
 * Pool identities are configuration-owned: changing a snapshot still fails closed;
 * this does not implement rolling-window reconciliation or late usage reports.
 * Restart loses this ledger: it is not an account-wide cap. */
export class ResourceAdmission {
  private charges = new Map<string, Charge>();
  private running = new Map<string, number>();
  private sequence=0;
  private recent=new Map<string,{sequence:number;at:number;value:ChargeView}>();
  private spentUsd=0n;
  private unsettledCount=0;
  private reportedCount=0;
  private unpricedCount=0;
  private quotaTotals=new Map<string,{fingerprint:string;units:bigint}>();
  constructor(readonly policy: DispatchPolicy, private now: () => number = Date.now,
    private retention:ExecutionRetention=loadExecutionRetention(),private retentionClock=Date.now) {}
  private prune() {
    for(const [id,item] of this.recent){
      if(this.retentionClock()-item.at<this.retention.completedTtlMs && this.recent.size<=this.retention.maxCompleted)continue;
      this.recent.delete(id);
    }
  }
  private archive(c:Charge) {
    this.charges.delete(c.id);
    this.recent.set(c.id,{sequence:c.sequence,at:this.retentionClock(),value:view(c)});
    this.prune();
  }
  retentionStats() {
    this.prune();
    return {active:this.charges.size,recent:this.recent.size,computePools:this.running.size,quotaPools:this.quotaTotals.size};
  }
  /** Process-lifetime consumption, independent of recent-history expiry. No refunds. */
  accounting() {
    return {completedUsd:decimalNumber(this.spentUsd),unsettledCount:this.unsettledCount,reportedCount:this.reportedCount,
      unpricedCount:this.unpricedCount,quotaPools:[...this.quotaTotals].map(([poolId,v])=>({poolId,units:decimalNumber(v.units)}))};
  }
  private validate(requests: ResourceRequest[]) {
    const staged = [...this.charges.values()].filter(c => c.status !== "released");
    for (const request of requests) {
      for (const n of [request.inputTokens, request.outputTokens]) if (!Number.isSafeInteger(n) || n < 0) throw new AdmissionError("INVALID_TOKEN_BUDGET");
      const denied = resourceExclusion(request.resources, this.policy, this.now());
      if (denied) throw new AdmissionError(denied);
      const r = request.resources!;
      const reservedUsd = r.incremental && fresh(r.incremental.evidence, this.now()) ? r.incremental.maxInvocationUsd : null;
      const units = r.quota?.unit === "tokens" ? decimalUnits(request.inputTokens) + decimalUnits(request.outputTokens) : decimalUnits(1);
      const charge: Charge = { sequence:++this.sequence,id: randomUUID(), request: structuredClone(request), reservedUsd, units,
        started: false, status: "reserved", reportedUsd: null };
      staged.push(charge);
      if (this.policy.maxIncrementalUsd !== null && staged.reduce((n, c) => n + decimalUnits(c.reportedUsd ?? c.reservedUsd ?? 0), this.spentUsd) > decimalUnits(this.policy.maxIncrementalUsd))
        throw new AdmissionError("SPEND_LIMIT");
      if (r.quota) {
        const same = staged.filter(c => c.request.resources?.quota?.poolId === r.quota!.poolId);
        // Refuse conflicting snapshots instead of treating refresh as a refund.
        const consumed=this.quotaTotals.get(r.quota.poolId);
        if (consumed && consumed.fingerprint!==quotaKey(r.quota) || same.some(c => JSON.stringify(c.request.resources!.quota) !== JSON.stringify(r.quota))) throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
        if (same.reduce((n, c) => n + c.units, consumed?.units ?? 0n) > decimalUnits(r.quota.remaining)) throw new AdmissionError("QUOTA_EXHAUSTED");
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
    if (c && !c.started) { c.status = "released";this.archive(c); }
  }
  async begin(id: string, signal: AbortSignal): Promise<void> {
    const c = this.charges.get(id);
    if (!c || c.status !== "reserved" || c.started) throw new AdmissionError("INVALID_RESERVATION");
    const deadline = Date.now() + this.policy.waitTimeoutMs;
    while (true) {
      if(!this.charges.has(id) || c.started || c.status!=="reserved")throw new AdmissionError("INVALID_RESERVATION");
      if (signal.aborted) { this.release(id); throw new AdmissionError("CANCELLED"); }
      const denied = resourceExclusion(c.request.resources, this.policy, this.now());
      if (denied) { this.release(id); throw new AdmissionError(denied); }
      if (this.policy.maxIncrementalUsd !== null && [...this.charges.values()].filter(v => v.status !== "released")
        .reduce((sum, v) => sum + decimalUnits(v.reportedUsd ?? v.reservedUsd ?? 0), this.spentUsd) > decimalUnits(this.policy.maxIncrementalUsd)) {
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
    if (pool) {
      const remaining=(this.running.get(pool.poolId) ?? 1)-1;
      if(remaining>0)this.running.set(pool.poolId,remaining);else this.running.delete(pool.poolId);
    }
    c.status = "unsettled";
    if (reported && Number.isFinite(reported.usd) && reported.usd >= 0 && Number.isFinite(reported.quotaUnits) && reported.quotaUnits >= 0) {
      c.reportedUsd = reported.usd; c.units = decimalUnits(reported.quotaUnits); c.status = "reported";
    }
    this.spentUsd+=decimalUnits(c.reportedUsd ?? c.reservedUsd ?? 0);
    if(c.status==="reported")this.reportedCount++;else this.unsettledCount++;
    if(c.reportedUsd===null && c.reservedUsd===null)this.unpricedCount++;
    const quota=c.request.resources?.quota;
    if(quota){
      const previous=this.quotaTotals.get(quota.poolId);
      this.quotaTotals.set(quota.poolId,{fingerprint:quotaKey(quota),units:(previous?.units ?? 0n)+c.units});
    }
    this.archive(c);
  }
  /** Active reservations plus bounded recent history, not the lifetime spend total. */
  snapshot() {
    this.prune();
    return [...this.recent.values(),...[...this.charges.values()].map(c=>({sequence:c.sequence,value:view(c)}))]
      .sort((a,b)=>a.sequence-b.sequence).map(item=>({...item.value}));
  }
}
