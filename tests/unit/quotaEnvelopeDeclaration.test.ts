import { describe, expect, it } from "vitest";
import { dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { AdmissionError, ResourceAdmission } from "../../src/routing/resourceAdmission";
import type { QuotaEnvelope } from "../../src/routing/quotaEnvelope";
import { evidence, resources } from "../helpers/dispatchFixtures";

// Runtime declarations for envelope pools that configuration already declared, on the
// real ledger: the wrapper adds pool and clock checks and changes no ledger rule.
const T0 = Date.parse("2026-10-07T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const longEvidence = {
  ...evidence,
  checkedAtIso: at(T0 - HOUR),
  expiresAtIso: at(T0 + 100 * HOUR)
};
const envelope = (n: number, over: Partial<QuotaEnvelope> = {}): QuotaEnvelope => ({
  poolId: "env",
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
const request = () => ({
  resources: resources({
    evidence: longEvidence,
    incremental: { currency: "USD", maxInvocationUsd: 0, evidence: longEvidence },
    quotaEnvelope: { poolId: "env", unit: "requests" }
  }),
  inputTokens: 100,
  outputTokens: 50
});
function admission(envelopes: QuotaEnvelope[] = [envelope(0)], policy = {}) {
  const clock = { now: T0 };
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({ quotaEnvelopes: envelopes, ...policy }),
    () => clock.now
  );
  return { ledger, clock };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AdmissionError) return error.code;
    throw error;
  }
  return "OK";
};
const state = (l: ResourceAdmission) =>
  JSON.stringify([l.envelopeAvailability(), l.snapshot(), l.retentionStats(), l.accounting()]);
const signal = () => new AbortController().signal;
const remaining = (l: ResourceAdmission) => l.envelopeAvailability()[0];

describe("runtime quota-window declarations", () => {
  it("refuses unknown and static pools without adding a pool", () => {
    const { ledger } = admission([envelope(0)], {
      bindings: {
        s: resources({ quota: { poolId: "static", unit: "requests", remaining: 5, evidence } })
      }
    });
    const before = state(ledger);
    for (const poolId of ["static", "new-pool"])
      expect(code(() => ledger.declareQuotaEnvelope(envelope(1, { poolId })))).toBe(
        "QUOTA_DECLARATION_POOL_UNKNOWN"
      );
    expect(state(ledger)).toBe(before);
    expect(ledger.envelopeAvailability().map((p) => p.poolId)).toEqual(["env"]);
  });

  it.each([
    ["null", null],
    ["an array", [envelope(1)]],
    ["a string", "w1"],
    ["an extra field", { ...envelope(1), note: "x" }],
    [
      "an observation-shaped payload",
      {
        poolId: "env",
        windowId: "w1",
        window: { kind: "fixed", startsAt: at(T0 + HOUR), resetsAt: at(T0 + 2 * HOUR) },
        measure: { kind: "headroom", usedPercentage: 10 },
        sourceAsOf: at(T0)
      }
    ],
    ["a negative allowance", envelope(1, { allowance: -1 })],
    ["a reset at its start", envelope(1, { resetsAt: at(T0 + HOUR) })],
    [
      "evidence that expires before its check",
      envelope(1, { evidence: { checkedAtIso: at(T0), expiresAtIso: at(T0 - 1) } })
    ]
  ] as [string, unknown][])("refuses %s as invalid without change", (_label, payload) => {
    const { ledger } = admission();
    const before = state(ledger);
    expect(code(() => ledger.declareQuotaEnvelope(payload))).toBe("QUOTA_DECLARATION_INVALID");
    expect(state(ledger)).toBe(before);
  });

  it("leaves an identical re-declaration unchanged and keeps spend", async () => {
    const { ledger } = admission();
    const [id] = ledger.reserve([request()]);
    await ledger.begin(id, signal());
    ledger.finish(id);
    const before = state(ledger);
    expect(ledger.declareQuotaEnvelope(envelope(0))).toEqual({ outcome: "unchanged" });
    expect(state(ledger)).toBe(before);
    expect(remaining(ledger)).toMatchObject({ windowId: "w0", remaining: "9" });
  });

  it("refreshes only to newer evidence for the same allowance, keeping spend", async () => {
    const { ledger } = admission();
    const [id] = ledger.reserve([request()]);
    await ledger.begin(id, signal());
    const newer = { checkedAtIso: at(T0), expiresAtIso: at(T0 + 200 * HOUR) };
    expect(ledger.declareQuotaEnvelope(envelope(0, { evidence: newer }))).toEqual({
      outcome: "refreshed"
    });
    expect(remaining(ledger)).toMatchObject({ windowId: "w0", remaining: "9" });
    const before = state(ledger);
    for (const stale of [
      envelope(0), // older evidence than the refreshed window
      envelope(0, { evidence: newer, allowance: 20 }), // allowance never changes
      envelope(0, { evidence: { checkedAtIso: at(T0 + 1), expiresAtIso: at(T0 + 150 * HOUR) } })
    ])
      expect(code(() => ledger.declareQuotaEnvelope(stale))).toBe("QUOTA_DECLARATION_CONFLICT");
    expect(state(ledger)).toBe(before);
  });

  it.each([
    ["an overlapping successor", envelope(1, { startsAt: at(T0 + HOUR / 2) })],
    ["a successor without a higher sequence", envelope(1, { sequence: 1 })],
    ["a changed unit", envelope(1, { unit: "tokens" })],
    ["a changed scope", envelope(1, { scope: { kind: "single-credential", credentialId: "c" } })],
    ["changed bounds for an existing window", envelope(0, { resetsAt: at(T0 + 2 * HOUR) })]
  ] as [string, QuotaEnvelope][])("refuses %s as a conflict without change", (_label, payload) => {
    const { ledger } = admission();
    const before = state(ledger);
    expect(code(() => ledger.declareQuotaEnvelope(payload))).toBe("QUOTA_DECLARATION_CONFLICT");
    expect(state(ledger)).toBe(before);
  });

  it("refuses a backdated successor that would start before now", () => {
    const { ledger, clock } = admission();
    clock.now = T0 + HOUR + HOUR / 2; // w0 has ended; a successor starting at T0+1h is backdated
    const before = state(ledger);
    expect(code(() => ledger.declareQuotaEnvelope(envelope(1)))).toBe("QUOTA_DECLARATION_CONFLICT");
    expect(state(ledger)).toBe(before);
    expect(
      ledger.declareQuotaEnvelope(
        envelope(1, { startsAt: at(clock.now), resetsAt: at(T0 + 3 * HOUR) })
      )
    ).toEqual({ outcome: "declared" });
  });

  it("carries reserved, started and unsettled charges into a declared successor and applies a late report", async () => {
    const { ledger, clock } = admission();
    const [reserved, started, unsettled] = ledger.reserve([request(), request(), request()]);
    await ledger.begin(started, signal());
    await ledger.begin(unsettled, signal());
    ledger.finish(unsettled);
    expect(ledger.declareQuotaEnvelope(envelope(1))).toEqual({ outcome: "declared" });
    expect(remaining(ledger)).toMatchObject({ windowId: "w0", remaining: "7" });
    clock.now = T0 + HOUR;
    // Every open charge counts against the newly active window too.
    expect(remaining(ledger)).toMatchObject({ windowId: "w1", remaining: "7" });
    expect(ledger.reportQuotaUsage(unsettled, 1)).toBe(true);
    expect(remaining(ledger)).toMatchObject({ windowId: "w1", remaining: "7" });
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(0);
    ledger.release(reserved);
    expect(remaining(ledger)).toMatchObject({ windowId: "w1", remaining: "8" });
  });

  it("accepts exactly one of two conflicting declarations made in the same turn", async () => {
    const { ledger } = admission();
    const results = await Promise.all(
      [5, 7].map((allowance) =>
        Promise.resolve().then(() =>
          code(() => ledger.declareQuotaEnvelope(envelope(1, { allowance })))
        )
      )
    );
    expect(results).toEqual(["OK", "QUOTA_DECLARATION_CONFLICT"]);
    // The envelope ledger's own snapshot shows which allowance was accepted.
    const windows = (
      ledger as unknown as { envelopes: { snapshot(): { windows: { allowance: string }[] }[] } }
    ).envelopes.snapshot()[0].windows;
    expect(windows.map((w) => w.allowance)).toEqual(["10", "5"]);
  });

  it("refuses a third retained window while the oldest is still referenced", async () => {
    const { ledger, clock } = admission([envelope(0), envelope(1)]);
    const [id] = ledger.reserve([request()]);
    await ledger.begin(id, signal());
    ledger.finish(id); // unsettled, started in w0
    clock.now = T0 + HOUR + HOUR / 2;
    const before = state(ledger);
    expect(code(() => ledger.declareQuotaEnvelope(envelope(2)))).toBe("QUOTA_DECLARATION_CAPACITY");
    expect(state(ledger)).toBe(before);
    expect(ledger.reportQuotaUsage(id, 1)).toBe(true);
    expect(ledger.declareQuotaEnvelope(envelope(2))).toEqual({ outcome: "declared" });
  });

  it("commits no clock on refusal and holds time when the wall clock steps back", () => {
    const { ledger, clock } = admission([envelope(0, { resetsAt: at(T0 + 2 * HOUR) })]);
    // A refused declaration at a later time must not advance the admission clock.
    clock.now = T0 + 5 * HOUR;
    expect(
      code(() =>
        ledger.declareQuotaEnvelope(
          envelope(1, { startsAt: at(T0 + HOUR), resetsAt: at(T0 + 6 * HOUR) })
        )
      )
    ).toBe("QUOTA_DECLARATION_CONFLICT");
    clock.now = T0 + HOUR / 2;
    expect(remaining(ledger)).toMatchObject({ status: "available", windowId: "w0" });
    // A successful change commits its time; a wall clock that then steps back is held.
    clock.now = T0 + HOUR;
    ledger.reserve([request()]);
    clock.now = T0;
    expect(
      ledger.declareQuotaEnvelope(
        envelope(1, { startsAt: at(T0 + 2 * HOUR), resetsAt: at(T0 + 3 * HOUR) })
      )
    ).toEqual({ outcome: "declared" });
    // An unusable clock refuses without change.
    clock.now = T0 + HOUR;
    const before = state(ledger);
    clock.now = Number.NaN;
    expect(
      code(() =>
        ledger.declareQuotaEnvelope(
          envelope(2, { startsAt: at(T0 + 3 * HOUR), resetsAt: at(T0 + 4 * HOUR) })
        )
      )
    ).toBe("QUOTA_DECLARATION_CLOCK_UNAVAILABLE");
    clock.now = T0 + HOUR;
    expect(state(ledger)).toBe(before);
  });
});
