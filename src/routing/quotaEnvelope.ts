import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decimalUnits } from "./decimalAccounting";

/**
 * Conservative local accounting against operator-declared fixed-window quota
 * envelopes. This is NOT authoritative provider reconciliation: the only authority
 * is an explicit configured envelope, nothing here reads provider aggregate
 * observations, and nothing is refunded on the strength of one. Admission uses it
 * for bindings that opt in with resources.quotaEnvelope.
 *
 * Every open charge (reserved, started, or finished without reported usage) counts
 * once against the window active at the time of the check. A reservation therefore
 * carries into a newly active window by construction, and a started charge that
 * straddles a reset counts in the window it started in and in every later window
 * while it stays open. Per-call reported usage from a call's own response finalizes
 * that one charge; it is distinct from provider aggregate observations. Debt beyond
 * an allowance is kept, never clamped. Every refusal leaves the state unchanged.
 */

export type QuotaEnvelopeErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_LIMITS"
  | "INVALID_NOW"
  | "CLOCK_REGRESSION"
  | "INVALID_UNITS"
  | "INVALID_REPORT"
  | "UNKNOWN_POOL"
  | "UNKNOWN_CHARGE"
  | "INVALID_CHARGE_STATE"
  | "QUOTA_ENVELOPE_CONFLICT"
  | "QUOTA_UNKNOWN_OR_STALE"
  | "QUOTA_EXHAUSTED"
  | "QUOTA_LEDGER_CAPACITY"
  | "QUOTA_POOL_CAPACITY";

/** A refusal with a stable code; it never echoes credential identities. */
export class QuotaEnvelopeError extends Error {
  constructor(readonly code: QuotaEnvelopeErrorCode) {
    super(code);
    this.name = "QuotaEnvelopeError";
  }
}

const MAX_INSTANT = 8.64e15;
const iso = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid instant");
const label = z.string().min(1).max(200);

/** One declared window. Strict: an observation-shaped payload cannot pass. */
export const quotaEnvelopeSchema = z
  .object({
    poolId: label,
    windowId: label,
    /** Explicit successor order; each new window of a pool must exceed every earlier one. */
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    startsAt: iso,
    resetsAt: iso,
    allowance: z.number().finite().nonnegative(),
    unit: z.enum(["requests", "tokens"]),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("account") }).strict(),
      z.object({ kind: z.literal("single-credential"), credentialId: label }).strict()
    ]),
    evidence: z.object({ checkedAtIso: iso, expiresAtIso: iso }).strict()
  })
  .strict();
export type QuotaEnvelope = z.infer<typeof quotaEnvelopeSchema>;

export const quotaEnvelopeLimitsSchema = z
  .object({
    maxPools: z.number().int().min(1).max(10_000),
    maxOpenCharges: z.number().int().min(1).max(10_000),
    maxWindows: z.number().int().min(2).max(16)
  })
  .strict();
export type QuotaEnvelopeLimits = z.infer<typeof quotaEnvelopeLimitsSchema>;
export const DEFAULT_QUOTA_ENVELOPE_LIMITS: QuotaEnvelopeLimits = Object.freeze({
  maxPools: 64,
  maxOpenCharges: 256,
  maxWindows: 2
});

interface Window {
  windowId: string;
  sequence: number;
  startsAt: number;
  resetsAt: number;
  allowance: bigint;
  checkedAt: number;
  expiresAt: number;
  /** Finalized usage counted in this window. */
  finalUsed: bigint;
  /** The declaration, canonicalized, for idempotency and conflict checks. */
  fingerprint: string;
}
interface Charge {
  id: string;
  poolId: string;
  units: bigint;
  state: "reserved" | "started" | "unsettled";
  /** Window sequence active when the charge started. */
  startedIn?: number;
}
interface Pool {
  unit: QuotaEnvelope["unit"];
  /** Canonical scope; never exposed. */
  scope: string;
  /** Highest sequence ever declared, kept after old windows are dropped. */
  highWater: number;
  windows: Window[];
}

export interface PoolAvailability {
  status: "available" | "unavailable";
  reason?: "QUOTA_UNKNOWN_OR_STALE" | "UNKNOWN_POOL";
  windowId?: string;
  /** Exact decimal strings. remaining is 0 while in debt. */
  remaining?: string;
  debt?: string;
}

const SCALE = 324;
/** Exact decimal spelling of internal units. */
function decimal(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(SCALE + 1, "0");
  const fraction = digits.slice(-SCALE).replace(/0+$/, "");
  return (negative ? "-" : "") + digits.slice(0, -SCALE) + (fraction ? "." + fraction : "");
}
function instant(value: string) {
  return new Date(value).getTime();
}
function assertNow(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_INSTANT)
    throw new QuotaEnvelopeError("INVALID_NOW");
}
function units(value: unknown, code: "INVALID_UNITS" | "INVALID_REPORT"): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new QuotaEnvelopeError(code);
  return decimalUnits(value);
}

export class QuotaEnvelopeLedger {
  private readonly pools = new Map<string, Pool>();
  private readonly charges = new Map<string, Charge>();
  private readonly limits: QuotaEnvelopeLimits;
  /** Charge ids are a per-ledger prefix plus a counter: never reused, never colliding. */
  private readonly idPrefix = randomUUID();
  private nextId = 0n;
  /** The latest time a change was accepted; changes may not move it backwards. */
  private latest = 0;

  constructor(limits: QuotaEnvelopeLimits = DEFAULT_QUOTA_ENVELOPE_LIMITS) {
    const parsed = quotaEnvelopeLimitsSchema.safeParse(limits);
    if (!parsed.success) throw new QuotaEnvelopeError("INVALID_LIMITS");
    this.limits = parsed.data;
  }

  /**
   * Every operation takes the caller's clock, which must not be earlier than the
   * latest accepted change: an earlier time could finalize a charge before the
   * window it started in. Successful changes advance it. available() is a
   * non-mutating projection: it is checked against the latest change but does not
   * advance it, so reads at different times do not order later changes.
   */
  private clock(now: number) {
    assertNow(now);
    if (now < this.latest) throw new QuotaEnvelopeError("CLOCK_REGRESSION");
  }

  /**
   * Declares a window. Re-declaring an identical window is a no-op; the same
   * window with only newer evidence refreshes the evidence. Anything else about an
   * existing window, a change of unit or scope, an overlap, or a sequence at or
   * below the pool's high-water mark (even for a dropped window) is a conflict.
   */
  declare(raw: unknown, now: number): void {
    this.clock(now);
    const parsed = quotaEnvelopeSchema.safeParse(raw);
    if (!parsed.success) throw new QuotaEnvelopeError("INVALID_ENVELOPE");
    const e = parsed.data;
    const startsAt = instant(e.startsAt),
      resetsAt = instant(e.resetsAt),
      checkedAt = instant(e.evidence.checkedAtIso),
      expiresAt = instant(e.evidence.expiresAtIso);
    if (resetsAt <= startsAt || expiresAt <= checkedAt)
      throw new QuotaEnvelopeError("INVALID_ENVELOPE");
    const scope = JSON.stringify(
      e.scope.kind === "account" ? ["account"] : ["single-credential", e.scope.credentialId]
    );
    const fingerprint = JSON.stringify([
      e.windowId,
      e.sequence,
      startsAt,
      resetsAt,
      decimal(decimalUnits(e.allowance)),
      e.unit,
      scope
    ]);
    const pool = this.pools.get(e.poolId);
    if (!pool && this.pools.size >= this.limits.maxPools)
      throw new QuotaEnvelopeError("QUOTA_POOL_CAPACITY");
    if (pool && (pool.unit !== e.unit || pool.scope !== scope))
      throw new QuotaEnvelopeError("QUOTA_ENVELOPE_CONFLICT");
    const existing = pool?.windows.find((w) => w.windowId === e.windowId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new QuotaEnvelopeError("QUOTA_ENVELOPE_CONFLICT");
      // The allowance never changes. Identical evidence is a no-op; newer evidence
      // (a later check, an expiry no earlier) refreshes it; anything else conflicts.
      const same = checkedAt === existing.checkedAt && expiresAt === existing.expiresAt;
      const newer = checkedAt > existing.checkedAt && expiresAt >= existing.expiresAt;
      if (!same && !newer) throw new QuotaEnvelopeError("QUOTA_ENVELOPE_CONFLICT");
      existing.checkedAt = checkedAt;
      existing.expiresAt = expiresAt;
      this.latest = now;
      return;
    }
    if (pool) {
      const last = pool.windows.at(-1);
      // A successor applies from its declaration onward: a backdated start would
      // leave usage finalized before it was declared uncounted in that window.
      if (e.sequence <= pool.highWater || (last && startsAt < last.resetsAt) || startsAt < now)
        throw new QuotaEnvelopeError("QUOTA_ENVELOPE_CONFLICT");
    }
    const windows = [...(pool?.windows ?? [])];
    // Room for the new window: drop the oldest only if it is no longer active and
    // no open charge started in it.
    if (windows.length >= this.limits.maxWindows) {
      const oldest = windows[0];
      const active = pool ? this.activeWindow(pool, now) : undefined;
      const referenced = [...this.charges.values()].some(
        (c) => c.poolId === e.poolId && c.startedIn === oldest.sequence
      );
      if (oldest === active || referenced || now < oldest.resetsAt)
        throw new QuotaEnvelopeError("QUOTA_LEDGER_CAPACITY");
      windows.shift();
    }
    windows.push({
      windowId: e.windowId,
      sequence: e.sequence,
      startsAt,
      resetsAt,
      allowance: decimalUnits(e.allowance),
      checkedAt,
      expiresAt,
      finalUsed: 0n,
      fingerprint
    });
    this.pools.set(e.poolId, { unit: e.unit, scope, highWater: e.sequence, windows });
    this.latest = now;
  }

  /** The latest declared window that has started; a future window is never active early. */
  private activeWindow(pool: Pool, now: number): Window | undefined {
    for (let i = pool.windows.length - 1; i >= 0; i--)
      if (pool.windows[i].startsAt <= now) return pool.windows[i];
    return undefined;
  }
  /** The active window only if it is current and its evidence fresh. */
  private validWindow(poolId: string, now: number): Window {
    const pool = this.pools.get(poolId);
    if (!pool) throw new QuotaEnvelopeError("UNKNOWN_POOL");
    const w = this.activeWindow(pool, now);
    if (!w || now >= w.resetsAt || now < w.checkedAt || now >= w.expiresAt)
      throw new QuotaEnvelopeError("QUOTA_UNKNOWN_OR_STALE");
    return w;
  }
  private openFor(poolId: string) {
    return [...this.charges.values()].filter((c) => c.poolId === poolId);
  }
  /** Everything counted against the active window: finalized usage plus every open charge. */
  private debit(poolId: string, w: Window) {
    return this.openFor(poolId).reduce((n, c) => n + c.units, w.finalUsed);
  }

  /** Every check reserve() makes, with no change at all: a dry run. */
  check(requests: readonly { poolId: string; units: number }[], now: number): void {
    this.stage(requests, now);
  }

  /** Reserves all requests or none. Returns charge ids in request order. */
  reserve(requests: readonly { poolId: string; units: number }[], now: number): string[] {
    const staged = this.stage(requests, now);
    // Every check passed: commit together. Counter ids cannot fail or collide.
    const ids = staged.map(() => `${this.idPrefix}:${++this.nextId}`);
    staged.forEach((s, i) =>
      this.charges.set(ids[i], { id: ids[i], poolId: s.poolId, units: s.units, state: "reserved" })
    );
    this.latest = now;
    return ids;
  }

  private stage(requests: readonly { poolId: string; units: number }[], now: number) {
    this.clock(now);
    if (!Array.isArray(requests) || !requests.length) throw new QuotaEnvelopeError("INVALID_UNITS");
    const staged = requests.map((r) => {
      if (typeof r !== "object" || r === null || typeof r.poolId !== "string")
        throw new QuotaEnvelopeError("INVALID_UNITS");
      return { poolId: r.poolId, units: units(r.units, "INVALID_UNITS") };
    });
    for (const poolId of new Set(staged.map((s) => s.poolId))) {
      const w = this.validWindow(poolId, now);
      const adding = staged.filter((s) => s.poolId === poolId);
      if (this.openFor(poolId).length + adding.length > this.limits.maxOpenCharges)
        throw new QuotaEnvelopeError("QUOTA_LEDGER_CAPACITY");
      if (adding.reduce((n, s) => n + s.units, this.debit(poolId, w)) > w.allowance)
        throw new QuotaEnvelopeError("QUOTA_EXHAUSTED");
    }
    return staged;
  }

  /** Declared pools, for configuration checks. */
  poolIds(): string[] {
    return [...this.pools.keys()];
  }
  /** A declared pool's unit, or undefined. */
  poolUnit(poolId: string): QuotaEnvelope["unit"] | undefined {
    return this.pools.get(poolId)?.unit;
  }

  /** Returns an unstarted reservation exactly; nothing was consumed. */
  release(id: string): void {
    const c = this.charges.get(id);
    if (!c) throw new QuotaEnvelopeError("UNKNOWN_CHARGE");
    if (c.state !== "reserved") throw new QuotaEnvelopeError("INVALID_CHARGE_STATE");
    this.charges.delete(id);
  }

  /**
   * Starts a reservation only while its pool's active window is valid and the
   * active window's debit, which already includes this charge, is within allowance.
   */
  begin(id: string, now: number): void {
    this.clock(now);
    const c = this.charges.get(id);
    if (!c) throw new QuotaEnvelopeError("UNKNOWN_CHARGE");
    if (c.state !== "reserved") throw new QuotaEnvelopeError("INVALID_CHARGE_STATE");
    const w = this.validWindow(c.poolId, now);
    if (this.debit(c.poolId, w) > w.allowance) throw new QuotaEnvelopeError("QUOTA_EXHAUSTED");
    c.state = "started";
    c.startedIn = w.sequence;
    this.latest = now;
  }

  /**
   * Ends a started charge. With per-call reported usage it is final at that amount;
   * without, it stays open at its estimate until a report arrives.
   */
  finish(id: string, now: number, reported?: number): void {
    this.clock(now);
    const c = this.charges.get(id);
    if (!c) throw new QuotaEnvelopeError("UNKNOWN_CHARGE");
    if (c.state !== "started") throw new QuotaEnvelopeError("INVALID_CHARGE_STATE");
    if (reported === undefined) {
      c.state = "unsettled";
      this.latest = now;
      return;
    }
    this.finalize(c, units(reported, "INVALID_REPORT"), now);
  }

  /**
   * Applies a delayed per-call report to an open, unsettled charge exactly once.
   * Reports for unknown, final or not-yet-finished charges change nothing.
   */
  report(id: string, value: number, now: number): boolean {
    this.clock(now);
    const amount = units(value, "INVALID_REPORT");
    const c = this.charges.get(id);
    if (!c || c.state !== "unsettled") return false;
    this.finalize(c, amount, now);
    return true;
  }

  /** Counts a final amount in every retained window from its start through the active one. */
  private finalize(c: Charge, amount: bigint, now: number) {
    const pool = this.pools.get(c.poolId)!;
    const active = this.activeWindow(pool, now)?.sequence ?? c.startedIn!;
    for (const w of pool.windows)
      if (w.sequence >= c.startedIn! && w.sequence <= active) w.finalUsed += amount;
    this.charges.delete(c.id);
    this.latest = now;
  }

  available(poolId: string, now: number): PoolAvailability {
    this.clock(now);
    let w: Window;
    try {
      w = this.validWindow(poolId, now);
    } catch (error) {
      const code = (error as QuotaEnvelopeError).code;
      return {
        status: "unavailable",
        reason: code === "UNKNOWN_POOL" ? "UNKNOWN_POOL" : "QUOTA_UNKNOWN_OR_STALE"
      };
    }
    const left = w.allowance - this.debit(poolId, w);
    return {
      status: "available",
      windowId: w.windowId,
      remaining: decimal(left > 0n ? left : 0n),
      debt: left < 0n ? decimal(-left) : undefined
    };
  }

  /** Bounded public state; credential identities never appear. */
  snapshot() {
    return [...this.pools]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([poolId, pool]) => {
        const open = this.openFor(poolId);
        return {
          poolId,
          unit: pool.unit,
          scope: JSON.parse(pool.scope)[0] as "account" | "single-credential",
          highWater: pool.highWater,
          windows: pool.windows.map((w) => ({
            windowId: w.windowId,
            sequence: w.sequence,
            startsAt: new Date(w.startsAt).toISOString(),
            resetsAt: new Date(w.resetsAt).toISOString(),
            allowance: decimal(w.allowance),
            finalUsed: decimal(w.finalUsed),
            evidence: {
              checkedAt: new Date(w.checkedAt).toISOString(),
              expiresAt: new Date(w.expiresAt).toISOString()
            }
          })),
          open: {
            reserved: open.filter((c) => c.state === "reserved").length,
            started: open.filter((c) => c.state === "started").length,
            unsettled: open.filter((c) => c.state === "unsettled").length,
            units: decimal(open.reduce((n, c) => n + c.units, 0n))
          }
        };
      });
  }
}
