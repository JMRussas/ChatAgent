import { describe, expect, it, vi } from "vitest";
import { bindingResourcesSchema, dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { AdmissionError, ResourceAdmission } from "../../src/routing/resourceAdmission";
import { fromConfiguredQuota } from "../../src/routing/quotaObservation";
import type { QuotaEnvelope } from "../../src/routing/quotaEnvelope";
import { evidence, resources } from "../helpers/dispatchFixtures";

// Envelope-mode admission: conservative local accounting against declared windows,
// wired beside the existing money, compute and static-quota checks.
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
const enveloped = (poolId = "env", unit: "requests" | "tokens" = "requests") =>
  resources({
    evidence: longEvidence,
    incremental: { currency: "USD", maxInvocationUsd: 0, evidence: longEvidence },
    quotaEnvelope: { poolId, unit }
  });
const request = (r = enveloped(), inputTokens = 100, outputTokens = 50) => ({
  resources: r,
  inputTokens,
  outputTokens
});
function admission(
  envelopes: QuotaEnvelope[] = [envelope(0)],
  policy: Record<string, unknown> = {},
  maxPools = 8
) {
  const clock = { now: T0 };
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({ quotaEnvelopes: envelopes, ...policy }),
    () => clock.now,
    undefined,
    undefined,
    { maxPools }
  );
  return { ledger, clock };
}
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AdmissionError) return error.code;
    throw error;
  }
  return "OK";
};
const state = (l: ResourceAdmission) =>
  JSON.stringify([l.envelopeAvailability(), l.snapshot(), l.retentionStats(), l.accounting()]);
const signal = () => new AbortController().signal;

describe("configuration", () => {
  it("refuses envelope configurations that are incomplete, mixed or over the pool cap", () => {
    expect(() => admission([], { bindings: { b: enveloped() } })).toThrow(/not declared with unit/);
    expect(() => admission([envelope(0)], { bindings: { b: enveloped("env", "tokens") } })).toThrow(
      /not declared with unit/
    );
    expect(() =>
      admission([envelope(0)], {
        bindings: {
          b: resources({ quota: { poolId: "env", unit: "requests", remaining: 5, evidence } })
        }
      })
    ).toThrow(/both as a static quota and an envelope/);
    expect(() =>
      admission(
        [envelope(0)],
        {
          bindings: {
            s: resources({ quota: { poolId: "static", unit: "requests", remaining: 5, evidence } })
          }
        },
        1
      )
    ).toThrow(/ADMISSION_MAX_QUOTA_POOLS allows 1/);
    // A successor that already started before startup is a backdated declaration.
    const clock = { now: T0 + 90 * 60_000 };
    expect(
      () =>
        new ResourceAdmission(
          dispatchPolicySchema.parse({ quotaEnvelopes: [envelope(0), envelope(1)] }),
          () => clock.now
        )
    ).toThrow(/Quota envelope w1 for pool env is invalid/);
    expect(() =>
      bindingResourcesSchema.parse({
        ...enveloped(),
        quota: { poolId: "p", unit: "requests", remaining: 1, evidence }
      })
    ).toThrow(/static quota or an envelope/);
  });

  it("leaves envelope-free configurations exactly as before", () => {
    const { ledger } = admission([]);
    expect(ledger.retentionStats()).not.toHaveProperty("unsettledEnvelopeLinks");
    expect(Object.keys(ledger.accounting())).not.toContain("quotaEnvelopes");
    expect(ledger.envelopeAvailability()).toEqual([]);
  });

  it("never maps an envelope as a configured static quota observation", () => {
    expect(() => fromConfiguredQuota({ poolId: "env", unit: "requests" } as never, at(T0))).toThrow(
      "STATIC_QUOTA_REQUIRED"
    );
  });
});

describe("reserving", () => {
  it("dry runs change nothing, including identity and sequence", async () => {
    const { ledger } = admission();
    const before = state(ledger);
    ledger.check([request()]);
    expect(state(ledger)).toBe(before);
    const [id] = ledger.reserve([request()]);
    // The first committed reservation is still sequence 1: checks allocated nothing.
    expect(ledger.snapshot()).toMatchObject([{ id, status: "reserved" }]);
  });

  it("commits money and envelope reservations together or not at all", async () => {
    const exhausted = admission([envelope(0, { allowance: 1 })]);
    exhausted.ledger.reserve([request()]);
    const before = state(exhausted.ledger);
    expect(await code(() => exhausted.ledger.reserve([request()]))).toBe("QUOTA_EXHAUSTED");
    expect(state(exhausted.ledger)).toBe(before);

    const priced = resources({
      evidence: longEvidence,
      quotaEnvelope: { poolId: "env", unit: "requests" },
      incremental: { currency: "USD", maxInvocationUsd: 2, evidence: longEvidence }
    });
    const spend = admission([envelope(0)], {
      maxIncrementalUsd: 1,
      allowedBillingComponents: ["owned-compute"]
    });
    const spendBefore = state(spend.ledger);
    expect(await code(() => spend.ledger.reserve([request(priced)]))).toBe("SPEND_LIMIT");
    expect(state(spend.ledger)).toBe(spendBefore);
  });

  it("refuses a batch across two pools when either cannot take it", async () => {
    const { ledger } = admission([envelope(0), envelope(0, { poolId: "other", allowance: 0 })]);
    const before = state(ledger);
    expect(await code(() => ledger.reserve([request(), request(enveloped("other"))]))).toBe(
      "QUOTA_EXHAUSTED"
    );
    expect(state(ledger)).toBe(before);
  });

  it("refuses a combined token budget that is no longer exact", async () => {
    const { ledger } = admission([envelope(0, { unit: "tokens", allowance: 1e20 })]);
    const before = state(ledger);
    expect(
      await code(() =>
        ledger.reserve([request(enveloped("env", "tokens"), Number.MAX_SAFE_INTEGER, 2)])
      )
    ).toBe("INVALID_TOKEN_BUDGET");
    expect(state(ledger)).toBe(before);
    ledger.reserve([request(enveloped("env", "tokens"), 100, 50)]);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "99999999999999999850" });
  });

  it("checks runtime resources against the declared pools, not only configured bindings", async () => {
    const { ledger } = admission();
    const before = state(ledger);
    const both = {
      ...enveloped(),
      quota: { poolId: "p", unit: "requests" as const, remaining: 9, evidence: longEvidence }
    };
    expect(await code(() => ledger.reserve([request(both)]))).toBe("QUOTA_SNAPSHOT_CONFLICT");
    expect(await code(() => ledger.reserve([request(enveloped("missing"))]))).toBe(
      "QUOTA_ENVELOPE_INVALID"
    );
    expect(await code(() => ledger.reserve([request(enveloped("env", "tokens"))]))).toBe(
      "QUOTA_SNAPSHOT_CONFLICT"
    );
    const staticOnEnvelope = {
      ...enveloped(),
      quotaEnvelope: undefined,
      quota: { poolId: "env", unit: "requests" as const, remaining: 9, evidence: longEvidence }
    };
    expect(await code(() => ledger.reserve([request(staticOnEnvelope)]))).toBe(
      "QUOTA_SNAPSHOT_CONFLICT"
    );
    expect(state(ledger)).toBe(before);
  });
});

describe("starting and settling", () => {
  it("rechecks the envelope before starting, and a refusal releases everything", async () => {
    const { ledger, clock } = admission([envelope(0), envelope(1, { allowance: 0 })]);
    const r = enveloped();
    const [id] = ledger.reserve([request({ ...r, compute: { poolId: "gpu", concurrency: 1 } })]);
    clock.now = T0 + HOUR; // the carried reservation exceeds window 1
    expect(await code(() => ledger.begin(id, signal()))).toBe("QUOTA_EXHAUSTED");
    expect(ledger.snapshot()).toMatchObject([{ id, status: "released", started: false }]);
    expect(ledger.retentionStats().computePools).toBe(0);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ windowId: "w1", remaining: "0" });
    expect(ledger.envelopeAvailability()[0]).not.toHaveProperty("debt", expect.anything());
  });

  it("releases unstarted work exactly and keeps started work debited", async () => {
    const { ledger } = admission();
    const [a, b] = ledger.reserve([request(), request()]);
    await ledger.begin(b, signal());
    ledger.release(a);
    ledger.release(b); // started: not released
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "9" });
  });

  it("uses one report decision for both ledgers and links unreported work until its report", async () => {
    const { ledger } = admission();
    const [reported, malformed, silent] = ledger.reserve([request(), request(), request()]);
    for (const id of [reported, malformed, silent]) await ledger.begin(id, signal());
    ledger.finish(reported, { usd: 0, quotaUnits: 0 });
    // A malformed report is no report, in both ledgers alike.
    ledger.finish(malformed, { usd: Number.NaN, quotaUnits: 0 });
    ledger.finish(silent);
    expect(ledger.snapshot().map((c) => c.status)).toEqual(["reported", "unsettled", "unsettled"]);
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(2);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "8" });
    expect(ledger.reportQuotaUsage(silent, 0)).toBe(true);
    expect(ledger.reportQuotaUsage(silent, 0)).toBe(false);
    expect(ledger.reportQuotaUsage(reported, 0)).toBe(false);
    expect(ledger.reportQuotaUsage(malformed, Number.NaN)).toBe(false);
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(1);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "9" });
  });

  it("keeps a link whose report the envelope did not apply", async () => {
    const { ledger } = admission();
    const [id] = ledger.reserve([request()]);
    await ledger.begin(id, signal());
    ledger.finish(id);
    const envelopes = (ledger as unknown as { envelopes: { report: () => boolean } }).envelopes;
    const spy = vi.spyOn(envelopes, "report").mockReturnValueOnce(false);
    expect(ledger.reportQuotaUsage(id, 1)).toBe(false);
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(1);
    spy.mockRestore();
    expect(ledger.reportQuotaUsage(id, 1)).toBe(true);
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(0);
  });

  it("changes nothing if envelope settlement fails, and can be retried", async () => {
    const { ledger } = admission();
    const r = { ...enveloped(), compute: { poolId: "gpu", concurrency: 1 } };
    const [id] = ledger.reserve([request(r)]);
    await ledger.begin(id, signal());
    const envelopes = (ledger as unknown as { envelopes: { finish: () => void } }).envelopes;
    const spy = vi.spyOn(envelopes, "finish").mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    const before = state(ledger);
    expect(() => ledger.finish(id)).toThrow("unexpected");
    expect(state(ledger)).toBe(before);
    expect(ledger.retentionStats()).toMatchObject({ computePools: 1, unsettledEnvelopeLinks: 0 });
    spy.mockRestore();
    ledger.finish(id);
    expect(ledger.retentionStats()).toMatchObject({ computePools: 0, unsettledEnvelopeLinks: 1 });
  });

  it("holds time when the wall clock steps back, so settlement never fails on it", async () => {
    const { ledger, clock } = admission();
    clock.now = T0 + 1000;
    const [id] = ledger.reserve([request()]);
    clock.now = T0; // the wall clock steps back
    await ledger.begin(id, signal());
    expect(() => ledger.finish(id, { usd: 0, quotaUnits: 1 })).not.toThrow();
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "9" });
  });

  it("projects envelope pools without credentials, outside persisted accounting", () => {
    const { ledger } = admission([
      envelope(0, { scope: { kind: "single-credential", credentialId: "cred-secret" } })
    ]);
    ledger.reserve([request()]);
    expect(ledger.envelopeAvailability()).toEqual([
      { poolId: "env", status: "available", windowId: "w0", remaining: "9", debt: undefined }
    ]);
    expect(JSON.stringify([ledger.envelopeAvailability(), ledger.accounting()])).not.toContain(
      "cred-secret"
    );
  });
});

it("counts declared envelope pools in the pool inventory", () => {
  const { ledger } = admission([envelope(0), envelope(0, { poolId: "second" })]);
  expect(ledger.retentionStats()).toMatchObject({ quotaPools: 2, unsettledEnvelopeLinks: 0 });
});

describe("linked-ledger paths", () => {
  const computeShared = (poolId = "env") => ({
    ...enveloped(poolId),
    compute: { poolId: "gpu", concurrency: 1 }
  });

  it("refuses work that waited for compute across a window boundary, releasing both", async () => {
    const { ledger, clock } = admission([envelope(0), envelope(1, { allowance: 1 })], {
      quotaExhaustionAction: "wait",
      waitTimeoutMs: 5000
    });
    const [first, second] = ledger.reserve([request(computeShared()), request(computeShared())]);
    await ledger.begin(first, signal());
    const waiting = code(() => ledger.begin(second, signal()));
    await new Promise((r) => setTimeout(r, 30)); // second is waiting for compute
    clock.now = T0 + HOUR; // window 1: first (open) and second exceed allowance 1
    ledger.finish(first); // frees compute; first stays debited, unreported
    expect(await waiting).toBe("QUOTA_EXHAUSTED");
    expect(ledger.snapshot().find((c) => c.id === second)).toMatchObject({
      status: "released",
      started: false
    });
    expect(ledger.retentionStats().computePools).toBe(0);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ windowId: "w1", remaining: "0" });
  });

  it("aborting a compute or quota wait releases everything and reserves nothing", async () => {
    const { ledger } = admission([envelope(0, { allowance: 2 })], {
      quotaExhaustionAction: "wait",
      waitTimeoutMs: 5000
    });
    const [held, queued] = ledger.reserve([request(computeShared()), request(computeShared())]);
    await ledger.begin(held, signal());
    const computeAbort = new AbortController();
    const computeWait = code(() => ledger.begin(queued, computeAbort.signal));
    await new Promise((r) => setTimeout(r, 30));
    computeAbort.abort();
    expect(await computeWait).toBe("CANCELLED");
    expect(ledger.snapshot().find((c) => c.id === queued)).toMatchObject({ status: "released" });
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "1" });
    // The pool is now short of room for two: waiting for quota, then aborting.
    const before = state(ledger);
    const quotaAbort = new AbortController();
    const quotaWait = code(() => ledger.reserveWithWait([request(), request()], quotaAbort.signal));
    await new Promise((r) => setTimeout(r, 30));
    quotaAbort.abort();
    expect(await quotaWait).toBe("CANCELLED");
    expect(state(ledger)).toBe(before);
  });

  it("applies a delayed report after the diagnostic history has evicted the charge", async () => {
    const clock = { now: T0 };
    const ledger = new ResourceAdmission(
      dispatchPolicySchema.parse({ quotaEnvelopes: [envelope(0)] }),
      () => clock.now,
      { maxCompleted: 1, completedTtlMs: 1, maxMetrics: 1 },
      () => clock.now
    );
    const [early, later] = ledger.reserve([request(), request()]);
    for (const id of [early, later]) await ledger.begin(id, signal());
    ledger.finish(early);
    clock.now += 10;
    ledger.finish(later);
    expect(ledger.snapshot().map((c) => c.id)).not.toContain(early);
    expect(ledger.reportQuotaUsage(early, 0)).toBe(true);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({ remaining: "9" });
  });

  it("refuses new work at the open-charge cap without evicting, and one report frees one slot", async () => {
    const { ledger, clock } = admission([envelope(0, { allowance: 1000 })]);
    const ids: string[] = [];
    for (let i = 0; i < 256; i++) {
      const [id] = ledger.reserve([request()]);
      await ledger.begin(id, signal());
      ledger.finish(id);
      ids.push(id);
    }
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(256);
    expect(await code(() => ledger.reserve([request()]))).toBe("QUOTA_LEDGER_CAPACITY");
    expect(ledger.reportQuotaUsage(ids[0], 1)).toBe(true);
    expect(await code(() => ledger.reserve([request()]))).toBe("OK");
    expect(await code(() => ledger.reserve([request()]))).toBe("QUOTA_LEDGER_CAPACITY");
    // Time passing retires nothing: the window ends, the links and debits remain.
    clock.now = T0 + 10 * HOUR;
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(255);
    expect(ledger.envelopeAvailability()[0]).toMatchObject({
      status: "unavailable",
      reason: "QUOTA_UNKNOWN_OR_STALE"
    });
    expect(ledger.reportQuotaUsage(ids[1], 1)).toBe(true);
    expect(ledger.retentionStats().unsettledEnvelopeLinks).toBe(254);
  });

  it("reserves a batch over a static pool and an envelope pool together or not at all", async () => {
    const staticResources = (remaining: number) => ({
      ...enveloped(),
      quotaEnvelope: undefined,
      quota: { poolId: "static", unit: "requests" as const, remaining, evidence: longEvidence }
    });
    const exhaustedStatic = admission([envelope(0)]);
    const before = state(exhaustedStatic.ledger);
    expect(
      await code(() => exhaustedStatic.ledger.reserve([request(staticResources(0)), request()]))
    ).toBe("QUOTA_EXHAUSTED");
    expect(state(exhaustedStatic.ledger)).toBe(before);

    const exhaustedEnvelope = admission([envelope(0, { allowance: 0 })]);
    const emptyBefore = state(exhaustedEnvelope.ledger);
    expect(
      await code(() => exhaustedEnvelope.ledger.reserve([request(staticResources(5)), request()]))
    ).toBe("QUOTA_EXHAUSTED");
    expect(state(exhaustedEnvelope.ledger)).toBe(emptyBefore);

    const both = admission([envelope(0)]);
    both.ledger.reserve([request(staticResources(5)), request()]);
    expect(both.ledger.retentionStats()).toMatchObject({ active: 2, quotaPools: 2 });
  });
});
