import { describe, expect, it } from "vitest";
import {
  QuotaEnvelopeError,
  QuotaEnvelopeLedger,
  type QuotaEnvelope
} from "../../src/routing/quotaEnvelope";

const T0 = Date.parse("2026-10-07T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();

/** Window n spans [T0 + n hours, T0 + (n+1) hours), declared with long-lived evidence. */
const envelope = (n: number, over: Partial<QuotaEnvelope> = {}): QuotaEnvelope => ({
  poolId: "pool",
  windowId: `w${n}`,
  sequence: n + 1,
  startsAt: at(T0 + n * HOUR),
  resetsAt: at(T0 + (n + 1) * HOUR),
  allowance: 10,
  unit: "requests",
  scope: { kind: "account" },
  evidence: { checkedAtIso: at(T0 - HOUR), expiresAtIso: at(T0 + 100 * HOUR) },
  ...over
});
const ledger = (limits?: ConstructorParameters<typeof QuotaEnvelopeLedger>[0]) =>
  new QuotaEnvelopeLedger(limits);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof QuotaEnvelopeError) return error.code;
    throw error;
  }
  return "OK";
};
/** Public state, to show a refusal changed nothing. */
const state = (l: QuotaEnvelopeLedger, now: number) =>
  JSON.stringify([l.snapshot(), l.available("pool", now)]);
const remaining = (l: QuotaEnvelopeLedger, now: number) => l.available("pool", now);

describe("declaring envelopes", () => {
  it("refuses observation-shaped input and malformed envelopes without any state", () => {
    const l = ledger();
    const observation = {
      version: "quota-observation-v1",
      identity: { sourceId: "s", poolId: "pool", limitId: "l" },
      window: { kind: "fixed", startsAt: at(T0), resetsAt: at(T0 + HOUR) },
      measure: { kind: "quantitative", unit: "requests", limit: 10, used: 0, remaining: 10 },
      coverage: { kind: "unknown" },
      clocks: { sourceAsOf: at(T0), receivedAt: at(T0) }
    };
    for (const bad of [
      observation,
      { ...envelope(0), measure: observation.measure },
      envelope(0, { resetsAt: at(T0) }),
      envelope(0, { allowance: -1 }),
      envelope(0, { allowance: Number.NaN }),
      envelope(0, { sequence: 0 }),
      envelope(0, { evidence: { checkedAtIso: at(T0), expiresAtIso: at(T0) } }),
      envelope(0, { startsAt: "2026-10-07T00:00:00+99:99" })
    ])
      expect(code(() => l.declare(bad, T0))).toBe("INVALID_ENVELOPE");
    for (const now of [Number.NaN, -1, 1.5, 9e15])
      expect(code(() => l.declare(envelope(0), now))).toBe("INVALID_NOW");
    expect(l.snapshot()).toEqual([]);
    expect(remaining(l, T0)).toEqual({ status: "unavailable", reason: "UNKNOWN_POOL" });
  });

  it("is idempotent for an identical window and refuses any other change to it", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const before = state(l, T0);
    l.declare(envelope(0), T0);
    expect(state(l, T0)).toBe(before);
    for (const over of [
      { allowance: 20 },
      { resetsAt: at(T0 + 2 * HOUR) },
      { sequence: 5 },
      { unit: "tokens" as const },
      { scope: { kind: "single-credential" as const, credentialId: "cred-secret" } },
      { evidence: { checkedAtIso: at(T0 - 2 * HOUR), expiresAtIso: at(T0 + 100 * HOUR) } }
    ])
      expect(
        code(() => l.declare(envelope(0, over), T0)),
        JSON.stringify(over)
      ).toBe("QUOTA_ENVELOPE_CONFLICT");
    expect(state(l, T0)).toBe(before);
    // Newer evidence for the same window refreshes it, and nothing else.
    l.declare(
      envelope(0, { evidence: { checkedAtIso: at(T0), expiresAtIso: at(T0 + 200 * HOUR) } }),
      T0
    );
    expect(remaining(l, T0)).toMatchObject({ status: "available", remaining: "10" });
  });

  it("orders successors strictly and never lets a pool change unit, scope or overlap", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const before = state(l, T0);
    for (const bad of [
      envelope(1, { sequence: 1 }), // not above the high-water mark
      envelope(1, { startsAt: at(T0 + HOUR / 2) }), // overlaps window 0
      envelope(1, { unit: "tokens" }),
      envelope(1, { scope: { kind: "single-credential", credentialId: "x" } })
    ])
      expect(code(() => l.declare(bad, T0))).toBe("QUOTA_ENVELOPE_CONFLICT");
    expect(state(l, T0)).toBe(before);
  });

  it("keeps the high-water mark after pruning, so a forgotten window cannot return", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1), T0);
    // Window 0 has ended at T0+2h; declaring window 2 drops it.
    l.declare(envelope(2), T0 + 2 * HOUR);
    expect(l.snapshot()[0].windows.map((w) => w.windowId)).toEqual(["w1", "w2"]);
    expect(code(() => l.declare(envelope(0), T0 + 2 * HOUR))).toBe("QUOTA_ENVELOPE_CONFLICT");
    expect(code(() => l.declare(envelope(3, { sequence: 2 }), T0 + 2 * HOUR))).toBe(
      "QUOTA_ENVELOPE_CONFLICT"
    );
  });

  it("refuses a window transition it cannot make room for, preserving the high-water mark", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1), T0); // a future window while window 0 is active
    const before = state(l, T0);
    // Window 0 is active and not ended: it cannot be dropped for window 2.
    expect(code(() => l.declare(envelope(2), T0))).toBe("QUOTA_LEDGER_CAPACITY");
    expect(state(l, T0)).toBe(before);
    expect(l.snapshot()[0].highWater).toBe(2);
    // A started charge in window 1 keeps it from being dropped later, too.
    const [id] = l.reserve([{ poolId: "pool", units: 1 }], T0 + HOUR);
    l.begin(id, T0 + HOUR);
    l.declare(envelope(2), T0 + 2 * HOUR); // drops window 0
    expect(code(() => l.declare(envelope(3), T0 + 3 * HOUR))).toBe("QUOTA_LEDGER_CAPACITY");
  });

  it("keeps credential identities out of snapshots and errors", () => {
    const l = ledger();
    l.declare(
      envelope(0, { scope: { kind: "single-credential", credentialId: "cred-secret" } }),
      T0
    );
    expect(JSON.stringify(l.snapshot())).not.toContain("cred-secret");
    try {
      l.declare(
        envelope(0, {
          allowance: 3,
          scope: { kind: "single-credential", credentialId: "cred-secret" }
        }),
        T0
      );
    } catch (error) {
      expect(String(error)).not.toContain("cred-secret");
    }
  });
});

describe("reserving and settling against a window", () => {
  it("admits up to the allowance exactly, all or nothing", () => {
    const l = ledger();
    l.declare(envelope(0, { allowance: 0.3, unit: "tokens" }), T0);
    // 0.1 + 0.2 is exactly 0.3 in decimal units, not 0.30000000000000004.
    l.reserve(
      [
        { poolId: "pool", units: 0.1 },
        { poolId: "pool", units: 0.2 }
      ],
      T0
    );
    expect(remaining(l, T0)).toMatchObject({ remaining: "0" });
    const before = state(l, T0);
    expect(code(() => l.reserve([{ poolId: "pool", units: 1e-300 }], T0))).toBe("QUOTA_EXHAUSTED");
    for (const bad of [Number.NaN, -1, Infinity, "1" as unknown as number])
      expect(code(() => l.reserve([{ poolId: "pool", units: bad }], T0))).toBe("INVALID_UNITS");
    expect(code(() => l.reserve([], T0))).toBe("INVALID_UNITS");
    expect(code(() => l.reserve([{ poolId: "other", units: 0 }], T0))).toBe("UNKNOWN_POOL");
    expect(state(l, T0)).toBe(before);
  });

  it("refuses outside the window or with stale evidence, without falling back", () => {
    const l = ledger();
    l.declare(
      envelope(0, { evidence: { checkedAtIso: at(T0 - 1), expiresAtIso: at(T0 + HOUR / 2) } }),
      T0 - 1
    );
    expect(code(() => l.reserve([{ poolId: "pool", units: 1 }], T0 - 1))).toBe(
      "QUOTA_UNKNOWN_OR_STALE"
    );
    expect(code(() => l.reserve([{ poolId: "pool", units: 1 }], T0 + HOUR / 2))).toBe(
      "QUOTA_UNKNOWN_OR_STALE"
    );
    expect(remaining(l, T0 + HOUR)).toEqual({
      status: "unavailable",
      reason: "QUOTA_UNKNOWN_OR_STALE"
    });
  });

  it("does not reset when time passes without a declared next window", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.reserve([{ poolId: "pool", units: 10 }], T0);
    expect(code(() => l.reserve([{ poolId: "pool", units: 1 }], T0 + HOUR))).toBe(
      "QUOTA_UNKNOWN_OR_STALE"
    );
  });

  it("releases only unstarted reservations, exactly", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const [a, b] = l.reserve(
      [
        { poolId: "pool", units: 3 },
        { poolId: "pool", units: 4 }
      ],
      T0
    );
    l.begin(b, T0);
    l.release(a);
    expect(remaining(l, T0)).toMatchObject({ remaining: "6" });
    expect(code(() => l.release(a))).toBe("UNKNOWN_CHARGE");
    expect(code(() => l.release(b))).toBe("INVALID_CHARGE_STATE");
  });

  it("keeps unreported usage at its estimate and applies one delayed report exactly once", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 4 }], T0);
    l.begin(id, T0);
    l.finish(id, T0);
    expect(remaining(l, T0)).toMatchObject({ remaining: "6" });
    expect(l.snapshot()[0].open).toMatchObject({ unsettled: 1 });
    const before = state(l, T0);
    for (const bad of [-1, Number.NaN, "2" as unknown as number])
      expect(code(() => l.report(id, bad, T0))).toBe("INVALID_REPORT");
    expect(state(l, T0)).toBe(before);
    expect(l.report(id, 2, T0)).toBe(true);
    expect(remaining(l, T0)).toMatchObject({ remaining: "8" });
    const after = state(l, T0);
    // Duplicate, unknown and late reports change nothing.
    expect(l.report(id, 1, T0)).toBe(false);
    expect(l.report("never-issued", 1, T0)).toBe(false);
    expect(state(l, T0)).toBe(after);
  });

  it("ignores reports for reserved or still-running charges", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const [reserved, running] = l.reserve(
      [
        { poolId: "pool", units: 2 },
        { poolId: "pool", units: 3 }
      ],
      T0
    );
    l.begin(running, T0);
    const before = state(l, T0);
    expect(l.report(reserved, 0, T0)).toBe(false);
    expect(l.report(running, 0, T0)).toBe(false);
    expect(state(l, T0)).toBe(before);
  });

  it("finalizes reported usage at finish, and a malformed report leaves the charge open", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 4 }], T0);
    l.begin(id, T0);
    expect(code(() => l.finish(id, T0, -1))).toBe("INVALID_REPORT");
    expect(l.snapshot()[0].open).toMatchObject({ started: 1 });
    l.finish(id, T0, 3);
    expect(remaining(l, T0)).toMatchObject({ remaining: "7" });
    expect(l.report(id, 1, T0)).toBe(false);
    expect(code(() => l.finish(id, T0, 1))).toBe("UNKNOWN_CHARGE");
  });

  it("keeps debt from usage beyond the allowance and refuses new work", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 2 }], T0);
    l.begin(id, T0);
    l.finish(id, T0, 13);
    expect(remaining(l, T0)).toMatchObject({ remaining: "0", debt: "3" });
    // In debt, nothing new is admitted, not even a zero-unit reservation.
    for (const units of [0, 1e-9])
      expect(code(() => l.reserve([{ poolId: "pool", units }], T0))).toBe("QUOTA_EXHAUSTED");
  });

  it("refuses at the open-charge cap without evicting anything", () => {
    const l = ledger({ maxPools: 4, maxOpenCharges: 2, maxWindows: 2 });
    l.declare(envelope(0), T0);
    l.reserve(
      [
        { poolId: "pool", units: 1 },
        { poolId: "pool", units: 1 }
      ],
      T0
    );
    const before = state(l, T0);
    expect(code(() => l.reserve([{ poolId: "pool", units: 1 }], T0))).toBe("QUOTA_LEDGER_CAPACITY");
    expect(state(l, T0)).toBe(before);
  });

  it("caps pools", () => {
    const l = ledger({ maxPools: 1, maxOpenCharges: 4, maxWindows: 2 });
    l.declare(envelope(0), T0);
    expect(code(() => l.declare(envelope(0, { poolId: "second" }), T0))).toBe(
      "QUOTA_POOL_CAPACITY"
    );
    expect(
      code(() => new QuotaEnvelopeLedger({ maxPools: 0, maxOpenCharges: 1, maxWindows: 2 }))
    ).toBe("INVALID_LIMITS");
  });
});

describe("window resets", () => {
  it("carries unstarted reservations across several boundaries, counted once, released once", () => {
    const l = ledger({ maxPools: 4, maxOpenCharges: 8, maxWindows: 3 });
    l.declare(envelope(0), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 4 }], T0);
    l.declare(envelope(1), T0);
    // A future window takes nothing early.
    expect(remaining(l, T0)).toMatchObject({ windowId: "w0", remaining: "6" });
    expect(remaining(l, T0 + HOUR)).toMatchObject({ windowId: "w1", remaining: "6" });
    l.declare(envelope(2), T0 + HOUR);
    expect(remaining(l, T0 + 2 * HOUR)).toMatchObject({ windowId: "w2", remaining: "6" });
    l.release(id);
    expect(remaining(l, T0 + 2 * HOUR)).toMatchObject({ remaining: "10" });
    expect(code(() => l.release(id))).toBe("UNKNOWN_CHARGE");
  });

  it("counts a started charge in the window it started in and in the next one", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 3 }], T0);
    l.begin(id, T0);
    expect(remaining(l, T0 + HOUR)).toMatchObject({ windowId: "w1", remaining: "7" });
    // Its final amount is recorded in both windows it straddled.
    l.finish(id, T0 + HOUR, 2);
    expect(l.snapshot()[0].windows.map((w) => w.finalUsed)).toEqual(["2", "2"]);
    expect(remaining(l, T0 + HOUR)).toMatchObject({ remaining: "8" });
  });

  it("refuses to start carried work that exceeds the new window, and keeps the debt visible", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1, { allowance: 2 }), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 5 }], T0);
    const boundary = T0 + HOUR;
    expect(remaining(l, boundary)).toMatchObject({ windowId: "w1", remaining: "0", debt: "3" });
    const before = state(l, boundary);
    expect(code(() => l.begin(id, boundary))).toBe("QUOTA_EXHAUSTED");
    expect(state(l, boundary)).toBe(before);
    // One millisecond earlier it is still window 0, where it fits.
    const earlier = ledger();
    earlier.declare(envelope(0), T0);
    earlier.declare(envelope(1, { allowance: 2 }), T0);
    const [same] = earlier.reserve([{ poolId: "pool", units: 5 }], T0);
    expect(code(() => earlier.begin(same, boundary - 1))).toBe("OK");
  });

  it("applies a delayed report after a reset in every window the charge straddled", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1, { allowance: 1 }), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 2 }], T0);
    l.begin(id, T0);
    l.finish(id, T0);
    expect(l.report(id, 4, T0 + HOUR)).toBe(true);
    expect(l.snapshot()[0].windows.map((w) => w.finalUsed)).toEqual(["4", "4"]);
    expect(remaining(l, T0 + HOUR)).toMatchObject({ remaining: "0", debt: "3" });
  });
});

it("returns snapshots the caller cannot use to change the ledger", () => {
  const l = ledger();
  l.declare(envelope(0), T0);
  l.reserve([{ poolId: "pool", units: 1 }], T0);
  const snapshot = l.snapshot();
  snapshot[0].windows[0].allowance = "1000";
  snapshot[0].open.units = "0";
  snapshot.pop();
  expect(remaining(l, T0)).toMatchObject({ remaining: "9" });
  expect(l.snapshot()[0].windows[0].allowance).toBe("10");
});

describe("time and identity", () => {
  it("refuses a clock that moves backwards, so a charge cannot finalize before its window", () => {
    const l = ledger();
    l.declare(envelope(0), T0);
    l.declare(envelope(1), T0);
    const [id] = l.reserve([{ poolId: "pool", units: 3 }], T0 + HOUR);
    l.begin(id, T0 + HOUR);
    const before = state(l, T0 + HOUR);
    expect(code(() => l.finish(id, T0 + HOUR - 1, 1))).toBe("CLOCK_REGRESSION");
    expect(code(() => l.reserve([{ poolId: "pool", units: 1 }], T0))).toBe("CLOCK_REGRESSION");
    expect(code(() => l.available("pool", T0))).toBe("CLOCK_REGRESSION");
    expect(state(l, T0 + HOUR)).toBe(before);
    l.finish(id, T0 + HOUR, 1);
    expect(l.snapshot()[0].windows.map((w) => w.finalUsed)).toEqual(["0", "1"]);
  });

  it("applies a successor only from its declaration onward", () => {
    const l = ledger();
    // A pool's first window may already have started.
    l.declare(envelope(0), T0 + 10);
    const [id] = l.reserve([{ poolId: "pool", units: 2 }], T0 + HOUR - 10);
    l.begin(id, T0 + HOUR - 10);
    // The window ends with no successor; the charge finishes in the gap and is
    // counted in the window it started in.
    l.finish(id, T0 + HOUR + 10, 2);
    expect(l.snapshot()[0].windows[0].finalUsed).toBe("2");
    const before = state(l, T0 + HOUR + 20);
    // A backdated successor would leave that usage uncounted in it: refused.
    expect(code(() => l.declare(envelope(1), T0 + HOUR + 20))).toBe("QUOTA_ENVELOPE_CONFLICT");
    expect(state(l, T0 + HOUR + 20)).toBe(before);
    l.declare(envelope(1, { startsAt: at(T0 + HOUR + 20) }), T0 + HOUR + 20);
    expect(remaining(l, T0 + HOUR + 20)).toMatchObject({ windowId: "w1", remaining: "10" });
  });

  it("issues distinct ids that are never reused, so stale reports cannot match", () => {
    const l = ledger({ maxPools: 4, maxOpenCharges: 100, maxWindows: 2 });
    l.declare(envelope(0, { allowance: 1000 }), T0);
    const first = l.reserve([{ poolId: "pool", units: 1 }], T0);
    first.forEach((id) => l.release(id));
    const ids = l.reserve(
      Array.from({ length: 50 }, () => ({ poolId: "pool", units: 1 })),
      T0
    );
    expect(new Set([...first, ...ids]).size).toBe(51);
    expect(l.report(first[0], 1, T0)).toBe(false);
  });

  it("refreshes evidence only forward and never extends freshness by a conflicting refresh", () => {
    const l = ledger();
    const evidence = { checkedAtIso: at(T0), expiresAtIso: at(T0 + HOUR / 2) };
    l.declare(envelope(0, { evidence }), T0);
    const before = state(l, T0);
    for (const refresh of [
      { checkedAtIso: at(T0), expiresAtIso: at(T0 + HOUR) }, // same check, other expiry
      { checkedAtIso: at(T0 + 1), expiresAtIso: at(T0 + HOUR / 4) }, // newer check, shorter
      { checkedAtIso: at(T0 - 1), expiresAtIso: at(T0 + HOUR) } // older check
    ])
      expect(code(() => l.declare(envelope(0, { evidence: refresh }), T0 + 1))).toBe(
        "QUOTA_ENVELOPE_CONFLICT"
      );
    expect(state(l, T0)).toBe(before);
    // The original expiry still applies.
    expect(remaining(l, T0 + HOUR / 2)).toEqual({
      status: "unavailable",
      reason: "QUOTA_UNKNOWN_OR_STALE"
    });
    // A genuine refresh does extend it.
    const fresh = ledger();
    fresh.declare(envelope(0, { evidence }), T0);
    fresh.declare(
      envelope(0, { evidence: { checkedAtIso: at(T0 + 1), expiresAtIso: at(T0 + HOUR) } }),
      T0 + 1
    );
    expect(remaining(fresh, T0 + HOUR / 2)).toMatchObject({ status: "available" });
  });
});
