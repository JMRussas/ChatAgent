import { decimalUnits, decimalNumber, decimalTelemetry } from "./decimalAccounting";
import { createHash } from "node:crypto";
import { loadExecutionRetention, type ExecutionRetention } from "../config/executionRetention";
import {
  loadQuotaPoolLimits,
  quotaPoolLimitsSchema,
  type QuotaPoolLimits
} from "../config/quotaPoolLimits";
import { randomUUID } from "node:crypto";
import type { BindingResources, DispatchPolicy } from "../config/dispatchConfig";
import { QuotaEnvelopeError, QuotaEnvelopeLedger } from "./quotaEnvelope";

export class AdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface ResourceRequest {
  resources?: BindingResources;
  inputTokens: number;
  outputTokens: number;
}
interface Charge {
  sequence: number;
  id: string;
  request: ResourceRequest;
  reservedUsd: number | null;
  units: bigint;
  started: boolean;
  status: "reserved" | "unsettled" | "released" | "reported";
  reportedUsd: number | null;
  /** The linked charge in the envelope ledger, for envelope-mode bindings. */
  envelopeId?: string;
}
/** Waits up to ms, or until the signal aborts; leaves no timer or listener behind. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
export function fresh(e: { checkedAtIso: string; expiresAtIso: string }, now: number) {
  return Date.parse(e.checkedAtIso) <= now && Date.parse(e.expiresAtIso) > now;
}
export function resourceExclusion(
  r: BindingResources | undefined,
  policy: DispatchPolicy,
  now: number
): string | undefined {
  if (!r || !fresh(r.evidence, now)) return "RESOURCE_FACTS_UNKNOWN_OR_STALE";
  if (
    r.facts.executionScope === "unknown" ||
    !policy.allowedExecutionScopes.includes(r.facts.executionScope)
  )
    return "EXECUTION_SCOPE_DENIED";
  if (
    r.facts.billingComponents.some(
      (b) => b === "unknown" || !policy.allowedBillingComponents.includes(b)
    )
  )
    return "BILLING_MODE_DENIED";
  const cost =
    r.incremental && fresh(r.incremental.evidence, now) ? r.incremental.maxInvocationUsd : null;
  if (cost === null && (policy.unknownCostAction === "deny" || policy.maxIncrementalUsd !== null))
    return "COST_UNKNOWN_OR_STALE";
  if (cost !== null && policy.maxIncrementalUsd !== null && cost > policy.maxIncrementalUsd)
    return "SPEND_LIMIT";
  if (
    r.facts.billingComponents.includes("subscription") &&
    !r.quota &&
    !r.quotaEnvelope &&
    r.quotaAdmission !== "adapter-preflight"
  )
    return "QUOTA_UNKNOWN";
  if (r.quota && !fresh(r.quota.evidence, now)) return "QUOTA_UNKNOWN_OR_STALE";
  return undefined;
}

type ChargeView = Pick<Charge, "id" | "status" | "reservedUsd" | "reportedUsd" | "started"> & {
  quotaUnits: number | null;
};
const view = (c: Charge): ChargeView => ({
  id: c.id,
  status: c.status,
  reservedUsd: c.reservedUsd,
  reportedUsd: c.reportedUsd,
  quotaUnits:
    c.request.resources?.quota || c.request.resources?.quotaEnvelope
      ? decimalNumber(c.units)
      : null,
  started: c.started
});
const quotaKey = (quota: NonNullable<BindingResources["quota"]>) =>
  createHash("sha256").update(JSON.stringify(quota)).digest("hex");

/** In-process ledger. Consumed work without usage stays unsettled, including errors
 * and cancellation. Completed IDs retain only bounded diagnostic rows; lifetime
 * spend and one quota fingerprint/total per encountered pool survive that expiry.
 * Pool identities are configuration-owned: changing a snapshot still fails closed;
 * this does not implement rolling-window reconciliation or late usage reports.
 * Distinct pools are capped: a pool holds a slot while it has a live reservation
 * and permanently once started work settles against it. Totals are never evicted,
 * so a pool identifier beyond the cap is rejected instead of displacing consumption.
 * The ledger cannot tell a renamed pool from a new one: within the cap a new
 * identifier gets its own declared allowance and leaves every existing total intact.
 * Restart loses this ledger: it is not an account-wide cap. */
export class ResourceAdmission {
  private charges = new Map<string, Charge>();
  private running = new Map<string, number>();
  private sequence = 0;
  private recent = new Map<string, { sequence: number; at: number; value: ChargeView }>();
  private spentUsd = 0n;
  private unsettledCount = 0;
  private reportedCount = 0;
  private unpricedCount = 0;
  private quotaTotals = new Map<string, { fingerprint: string; units: bigint }>();
  /** Conservative local accounting for envelope-mode bindings; see quotaEnvelope.ts. */
  private readonly envelopes: QuotaEnvelopeLedger;
  /** Envelope charges finished without usage, kept until a per-call report arrives. */
  private readonly unsettledEnvelopes = new Map<string, string>();
  /** Highest admission time used; a wall clock stepping back holds here. */
  private latestTime = 0;
  constructor(
    readonly policy: DispatchPolicy,
    private now: () => number = Date.now,
    private retention: ExecutionRetention = loadExecutionRetention(),
    private retentionClock = Date.now,
    private quotaPoolLimits: QuotaPoolLimits = loadQuotaPoolLimits()
  ) {
    this.quotaPoolLimits = quotaPoolLimitsSchema.parse(quotaPoolLimits);
    // Fail at startup rather than let arrival order decide which bindings are usable.
    const declared = new Set(
      Object.values(policy.bindings).flatMap((b) => (b.quota ? [b.quota.poolId] : []))
    ).size;
    if (declared > this.quotaPoolLimits.maxPools)
      throw new Error(
        `Dispatch policy declares ${declared} quota pools; ADMISSION_MAX_QUOTA_POOLS allows ${this.quotaPoolLimits.maxPools}`
      );
    // Envelopes are validated as a whole at startup and declared in a fixed order.
    const staticPools = new Set(
      Object.values(policy.bindings).flatMap((b) => (b.quota ? [b.quota.poolId] : []))
    );
    const envelopePools = new Set(policy.quotaEnvelopes.map((e) => e.poolId));
    if (staticPools.size + envelopePools.size > this.quotaPoolLimits.maxPools)
      throw new Error(
        `Dispatch policy declares ${staticPools.size + envelopePools.size} quota pools; ADMISSION_MAX_QUOTA_POOLS allows ${this.quotaPoolLimits.maxPools}`
      );
    for (const pool of envelopePools)
      if (staticPools.has(pool))
        throw new Error(`Quota pool ${pool} is declared both as a static quota and an envelope`);
    this.envelopes = new QuotaEnvelopeLedger({
      maxPools: this.quotaPoolLimits.maxPools,
      maxOpenCharges: 256,
      maxWindows: 2
    });
    const start = this.admissionTime();
    const ordered = [...policy.quotaEnvelopes].sort((a, b) =>
      a.poolId === b.poolId ? a.sequence - b.sequence : a.poolId < b.poolId ? -1 : 1
    );
    for (const envelope of ordered)
      try {
        this.envelopes.declare(envelope, start);
      } catch (error) {
        throw new Error(
          `Quota envelope ${envelope.windowId} for pool ${envelope.poolId} is invalid: ${(error as Error).message}`
        );
      }
    for (const [id, b] of Object.entries(policy.bindings))
      if (
        b.quotaEnvelope &&
        this.envelopes.poolUnit(b.quotaEnvelope.poolId) !== b.quotaEnvelope.unit
      )
        throw new Error(
          `Binding ${id} uses quota envelope pool ${b.quotaEnvelope.poolId}, which is not declared with unit ${b.quotaEnvelope.unit}`
        );
    this.commitTime(start);
  }
  /**
   * The envelope ledger's clock: never earlier than a time already used, so a wall
   * clock stepping back cannot make settlement fail. Reading it changes nothing;
   * commitTime records a time once a change succeeded.
   */
  private admissionTime(raw = this.now()) {
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 8.64e15)
      throw new AdmissionError("INVALID_NOW");
    return Math.max(raw, this.latestTime);
  }
  private commitTime(t: number) {
    this.latestTime = Math.max(this.latestTime, t);
  }
  /** Envelope refusals keep their admission meaning; anything else is invalid input. */
  private static envelopeCode(error: unknown) {
    if (!(error instanceof QuotaEnvelopeError)) throw error;
    return ["QUOTA_EXHAUSTED", "QUOTA_UNKNOWN_OR_STALE", "QUOTA_LEDGER_CAPACITY"].includes(
      error.code
    )
      ? error.code
      : "QUOTA_ENVELOPE_INVALID";
  }
  private static envelopeRequest(request: ResourceRequest) {
    const envelope = request.resources!.quotaEnvelope!;
    const units = envelope.unit === "tokens" ? request.inputTokens + request.outputTokens : 1;
    // Each budget is a safe integer; their sum must be too, or it is no longer exact.
    if (!Number.isSafeInteger(units)) throw new AdmissionError("INVALID_TOKEN_BUDGET");
    return { poolId: envelope.poolId, units };
  }
  /** Pools holding a slot: retained totals plus pools with a live reservation. */
  private trackedQuotaPools(charges: Iterable<Charge> = this.charges.values()) {
    const pools = new Set(this.quotaTotals.keys());
    for (const c of charges) {
      const quota = c.request.resources?.quota;
      if (quota && c.status !== "released") pools.add(quota.poolId);
    }
    return pools;
  }
  private prune() {
    for (const [id, item] of this.recent) {
      if (
        this.retentionClock() - item.at < this.retention.completedTtlMs &&
        this.recent.size <= this.retention.maxCompleted
      )
        continue;
      this.recent.delete(id);
    }
  }
  private archive(c: Charge) {
    this.charges.delete(c.id);
    this.recent.set(c.id, { sequence: c.sequence, at: this.retentionClock(), value: view(c) });
    this.prune();
  }
  retentionStats() {
    this.prune();
    return {
      active: this.charges.size,
      recent: this.recent.size,
      computePools: this.running.size,
      // Declared envelope pools hold their slots too.
      quotaPools: this.trackedQuotaPools().size + this.envelopes.poolIds().length,
      ...(this.envelopes.poolIds().length
        ? { unsettledEnvelopeLinks: this.unsettledEnvelopes.size }
        : {})
    };
  }
  /**
   * Live projection of each envelope pool: local declared-window accounting, not
   * provider-authoritative quota. It lives only in this process and is kept out of
   * persisted telemetry, since a restart loses the ledger it describes.
   */
  envelopeAvailability() {
    const t = this.admissionTime();
    return this.envelopes
      .poolIds()
      .sort()
      .map((poolId) => ({ poolId, ...this.envelopes.available(poolId, t) }));
  }
  /** Process-lifetime consumption, independent of recent-history expiry. No refunds. */
  accounting() {
    const spend = decimalTelemetry(this.spentUsd);
    return {
      completedUsd: spend.value,
      ...(spend.overflow
        ? { completedUsdOverflow: true as const, completedUsdExact: spend.exact }
        : {}),
      unsettledCount: this.unsettledCount,
      reportedCount: this.reportedCount,
      unpricedCount: this.unpricedCount,
      quotaPools: [...this.quotaTotals].map(([poolId, v]) => {
        const quota = decimalTelemetry(v.units);
        return {
          poolId,
          units: quota.value,
          ...(quota.overflow ? { unitsOverflow: true as const, unitsExact: quota.exact } : {})
        };
      })
    };
  }
  private validate(requests: ResourceRequest[]) {
    const staged = [...this.charges.values()].filter((c) => c.status !== "released");
    const pools = this.trackedQuotaPools(staged);
    // One clock reading for the whole decision. Envelope-mode requests use its
    // monotonic form throughout, so freshness and the envelope agree.
    const raw = this.now();
    const anyEnvelope = requests.some((r) => r.resources?.quotaEnvelope);
    const envelopeAt = anyEnvelope ? this.admissionTime(raw) : raw;
    for (const request of requests) {
      for (const n of [request.inputTokens, request.outputTokens])
        if (!Number.isSafeInteger(n) || n < 0) throw new AdmissionError("INVALID_TOKEN_BUDGET");
      const at = request.resources?.quotaEnvelope ? envelopeAt : raw;
      const denied = resourceExclusion(request.resources, this.policy, at);
      if (denied) throw new AdmissionError(denied);
      const r = request.resources!;
      if (r.quota && r.quotaEnvelope) throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
      if (r.quotaEnvelope) {
        const unit = this.envelopes.poolUnit(r.quotaEnvelope.poolId);
        if (!unit) throw new AdmissionError("QUOTA_ENVELOPE_INVALID");
        if (unit !== r.quotaEnvelope.unit) throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
      }
      const reservedUsd =
        r.incremental && fresh(r.incremental.evidence, at) ? r.incremental.maxInvocationUsd : null;
      const units =
        (r.quota?.unit ?? r.quotaEnvelope?.unit) === "tokens"
          ? decimalUnits(request.inputTokens) + decimalUnits(request.outputTokens)
          : decimalUnits(1);
      const charge: Charge = {
        // Identity is assigned only when a reservation commits; validating or
        // refusing a batch allocates nothing.
        sequence: 0,
        id: "",
        request: structuredClone(request),
        reservedUsd,
        units,
        started: false,
        status: "reserved",
        reportedUsd: null
      };
      staged.push(charge);
      if (
        this.policy.maxIncrementalUsd !== null &&
        staged.reduce(
          (n, c) => n + decimalUnits(c.reportedUsd ?? c.reservedUsd ?? 0),
          this.spentUsd
        ) > decimalUnits(this.policy.maxIncrementalUsd)
      )
        throw new AdmissionError("SPEND_LIMIT");
      if (r.quota) {
        // Claim the slot at reservation: settlement must always have room to record.
        // A static pool never shares an id with an envelope pool, and both kinds
        // count against the one pool cap.
        if (this.envelopes.poolUnit(r.quota.poolId))
          throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
        if (
          !pools.has(r.quota.poolId) &&
          pools.size + this.envelopes.poolIds().length >= this.quotaPoolLimits.maxPools
        )
          throw new AdmissionError("QUOTA_POOL_CAPACITY");
        pools.add(r.quota.poolId);
        const same = staged.filter((c) => c.request.resources?.quota?.poolId === r.quota!.poolId);
        // Refuse conflicting snapshots instead of treating refresh as a refund.
        const consumed = this.quotaTotals.get(r.quota.poolId);
        if (
          (consumed && consumed.fingerprint !== quotaKey(r.quota)) ||
          same.some((c) => JSON.stringify(c.request.resources!.quota) !== JSON.stringify(r.quota))
        )
          throw new AdmissionError("QUOTA_SNAPSHOT_CONFLICT");
        if (
          same.reduce((n, c) => n + c.units, consumed?.units ?? 0n) >
          decimalUnits(r.quota.remaining)
        )
          throw new AdmissionError("QUOTA_EXHAUSTED");
      }
    }
    // Envelope pools: the same checks reserve() will make, changing nothing.
    const envelopeRequests = requests.filter((r) => r.resources?.quotaEnvelope);
    if (envelopeRequests.length) {
      const batch = envelopeRequests.map(ResourceAdmission.envelopeRequest);
      try {
        this.envelopes.check(batch, envelopeAt);
      } catch (error) {
        throw new AdmissionError(ResourceAdmission.envelopeCode(error));
      }
    }
    return { charges: staged.slice(staged.length - requests.length), envelopeAt };
  }
  check(requests: ResourceRequest[]) {
    this.validate(requests);
    if (this.policy.quotaExhaustionAction !== "wait")
      for (const request of requests) {
        const pool = request.resources?.compute;
        if (pool && (this.running.get(pool.poolId) ?? 0) >= pool.concurrency)
          throw new AdmissionError("COMPUTE_CAPACITY_EXHAUSTED");
      }
  }
  reserve(requests: ResourceRequest[]): string[] {
    if (!requests.length) return [];
    // No await: all-or-nothing for a turn.
    const { charges: staged, envelopeAt: t } = this.validate(requests);
    // Identities first: nothing after the envelope commit can fail.
    const ids = staged.map(() => randomUUID());
    // Both ledgers commit only after every check of both has passed.
    const envelopeCharges = staged.filter((c) => c.request.resources?.quotaEnvelope);
    if (envelopeCharges.length) {
      let envelopeIds: string[];
      try {
        envelopeIds = this.envelopes.reserve(
          envelopeCharges.map((c) => ResourceAdmission.envelopeRequest(c.request)),
          t
        );
      } catch (error) {
        throw new AdmissionError(ResourceAdmission.envelopeCode(error));
      }
      envelopeCharges.forEach((c, i) => (c.envelopeId = envelopeIds[i]));
      this.commitTime(t);
    }
    staged.forEach((charge, i) => {
      charge.sequence = ++this.sequence;
      charge.id = ids[i];
      this.charges.set(charge.id, charge);
    });
    return staged.map((c) => c.id);
  }
  async reserveWithWait(requests: ResourceRequest[], signal?: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + this.policy.waitTimeoutMs;
    while (true) {
      if (signal?.aborted) throw new AdmissionError("CANCELLED");
      try {
        return this.reserve(requests);
      } catch (error) {
        if (
          !(error instanceof AdmissionError) ||
          error.code !== "QUOTA_EXHAUSTED" ||
          this.policy.quotaExhaustionAction !== "wait" ||
          Date.now() >= deadline
        )
          throw error;
        await abortableSleep(10, signal);
      }
    }
  }
  release(id: string) {
    const c = this.charges.get(id);
    if (c && !c.started) {
      if (c.envelopeId) this.envelopes.release(c.envelopeId);
      c.status = "released";
      this.archive(c);
    }
  }
  async begin(id: string, signal: AbortSignal): Promise<void> {
    const c = this.charges.get(id);
    if (!c || c.status !== "reserved" || c.started) throw new AdmissionError("INVALID_RESERVATION");
    const deadline = Date.now() + this.policy.waitTimeoutMs;
    while (true) {
      if (!this.charges.has(id) || c.started || c.status !== "reserved")
        throw new AdmissionError("INVALID_RESERVATION");
      if (signal.aborted) {
        this.release(id);
        throw new AdmissionError("CANCELLED");
      }
      // One reading per attempt; envelope charges use its monotonic form throughout.
      const raw = this.now();
      const at = c.envelopeId ? this.admissionTime(raw) : raw;
      const denied = resourceExclusion(c.request.resources, this.policy, at);
      if (denied) {
        this.release(id);
        throw new AdmissionError(denied);
      }
      if (
        this.policy.maxIncrementalUsd !== null &&
        [...this.charges.values()]
          .filter((v) => v.status !== "released")
          .reduce(
            (sum, v) => sum + decimalUnits(v.reportedUsd ?? v.reservedUsd ?? 0),
            this.spentUsd
          ) > decimalUnits(this.policy.maxIncrementalUsd)
      ) {
        this.release(id);
        throw new AdmissionError("SPEND_LIMIT");
      }
      const pool = c.request.resources?.compute;
      const active = pool ? (this.running.get(pool.poolId) ?? 0) : 0;
      const limits = pool
        ? [...this.charges.values()]
            .filter(
              (v) =>
                v.status === "reserved" &&
                v.started &&
                v.request.resources?.compute?.poolId === pool.poolId
            )
            .map((v) => v.request.resources!.compute!.concurrency)
        : [];
      if (!pool || active < Math.min(pool.concurrency, ...limits)) {
        // The envelope rechecks its window and debit before anything starts.
        if (c.envelopeId) {
          try {
            this.envelopes.begin(c.envelopeId, at);
          } catch (error) {
            const reason = ResourceAdmission.envelopeCode(error);
            this.release(id);
            throw new AdmissionError(reason);
          }
          this.commitTime(at);
        }
        if (pool) this.running.set(pool.poolId, active + 1);
        c.started = true;
        return;
      }
      if (this.policy.quotaExhaustionAction !== "wait" || Date.now() >= deadline) {
        this.release(id);
        throw new AdmissionError("COMPUTE_CAPACITY_EXHAUSTED");
      }
      await abortableSleep(10, signal);
    }
  }
  finish(id: string, reported?: { usd: number; quotaUnits: number }) {
    const c = this.charges.get(id);
    if (!c || !c.started || c.status !== "reserved") return;
    // One report decision for both ledgers: valid only if both amounts are.
    const valid =
      !!reported &&
      Number.isFinite(reported.usd) &&
      reported.usd >= 0 &&
      Number.isFinite(reported.quotaUnits) &&
      reported.quotaUnits >= 0;
    if (c.envelopeId) {
      // Validated before either ledger changes. If the envelope ledger still
      // refuses, nothing changes anywhere: the charge stays started and holds its
      // compute, so its identity is never lost and finish can be retried.
      const t = this.admissionTime();
      this.envelopes.finish(c.envelopeId, t, valid ? reported!.quotaUnits : undefined);
      this.commitTime(t);
      if (!valid) this.unsettledEnvelopes.set(c.id, c.envelopeId);
    }
    this.settle(c, valid ? reported : undefined);
  }
  /**
   * Applies a delayed per-call quota report to an envelope charge that finished
   * without one, exactly once. Anything else changes nothing.
   */
  reportQuotaUsage(id: string, quotaUnits: number): boolean {
    const envelopeId = this.unsettledEnvelopes.get(id);
    if (!envelopeId || !Number.isFinite(quotaUnits) || quotaUnits < 0) return false;
    const t = this.admissionTime();
    const applied = this.envelopes.report(envelopeId, quotaUnits, t);
    // The link is retired only once the report is confirmed applied.
    if (applied) {
      this.commitTime(t);
      this.unsettledEnvelopes.delete(id);
    }
    return applied;
  }
  private settle(c: Charge, reported?: { usd: number; quotaUnits: number }) {
    const pool = c.request.resources?.compute;
    if (pool) {
      const remaining = (this.running.get(pool.poolId) ?? 1) - 1;
      if (remaining > 0) this.running.set(pool.poolId, remaining);
      else this.running.delete(pool.poolId);
    }
    c.status = "unsettled";
    if (reported) {
      c.reportedUsd = reported.usd;
      c.units = decimalUnits(reported.quotaUnits);
      c.status = "reported";
    }
    this.spentUsd += decimalUnits(c.reportedUsd ?? c.reservedUsd ?? 0);
    if (c.status === "reported") this.reportedCount++;
    else this.unsettledCount++;
    if (c.reportedUsd === null && c.reservedUsd === null) this.unpricedCount++;
    const quota = c.request.resources?.quota;
    if (quota) {
      const previous = this.quotaTotals.get(quota.poolId);
      this.quotaTotals.set(quota.poolId, {
        fingerprint: quotaKey(quota),
        units: (previous?.units ?? 0n) + c.units
      });
    }
    this.archive(c);
  }
  /** Active reservations plus bounded recent history, not the lifetime spend total. */
  snapshot() {
    this.prune();
    return [
      ...this.recent.values(),
      ...[...this.charges.values()].map((c) => ({ sequence: c.sequence, value: view(c) }))
    ]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({ ...item.value }));
  }
}
