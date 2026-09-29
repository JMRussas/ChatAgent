import { describe, expect, it, vi } from "vitest";
import { dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { ResourceAdmission, resourceExclusion } from "../../src/routing/resourceAdmission";
import { evidence, now, resources } from "../helpers/dispatchFixtures";

const request = (r = resources()) => ({ resources: r, inputTokens: 100, outputTokens: 50 });
const signal = () => new AbortController().signal;
describe("resource admission", () => {
  it("RES-01: local-only rejects cloud/hybrid/unknown facts independently of price", () => {
    const policy = dispatchPolicySchema.parse({});
    for (const executionScope of ["managed-cloud", "hybrid", "unknown"] as const)
      expect(resourceExclusion(resources({ facts: { executionScope, billingComponents: ["owned-compute"] } }), policy, Date.parse(now)))
        .toBe("EXECUTION_SCOPE_DENIED");
    expect(resourceExclusion(resources(), policy, Date.parse(now))).toBeUndefined();
  });
  it("RES-03/04: zero incremental cost differs from missing/stale price and fixed costs", () => {
    const policy = dispatchPolicySchema.parse({ allowedExecutionScopes: ["self-hosted-remote"], allowedBillingComponents: ["provisioned-capacity"] });
    const r = resources({ facts: { executionScope: "self-hosted-remote", billingComponents: ["provisioned-capacity"] }, fixedCostNote: "Monthly rent is separate" });
    expect(resourceExclusion(r, policy, Date.parse(now))).toBeUndefined();
    expect(resourceExclusion({ ...r, incremental: undefined }, policy, Date.parse(now))).toBe("COST_UNKNOWN_OR_STALE");
    expect(resourceExclusion({ ...r, incremental: { ...r.incremental!, evidence: { ...evidence, expiresAtIso: now } } }, policy, Date.parse(now))).toBe("COST_UNKNOWN_OR_STALE");
  });
  it("RES-02: included subscription work requires known fresh quota", () => {
    const policy = dispatchPolicySchema.parse({ allowedBillingComponents: ["subscription"] });
    const r = resources({ facts: { executionScope: "local-device", billingComponents: ["subscription"] } });
    expect(resourceExclusion(r, policy, Date.parse(now))).toBe("QUOTA_UNKNOWN");
  });
  it("RES-05: reserves a pair atomically and leaves no charge on rejection", () => {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({ maxIncrementalUsd: 1 }), () => Date.parse(now));
    const r = resources({ incremental: { currency: "USD", maxInvocationUsd: 0.6, evidence } });
    expect(() => ledger.reserve([request(r), request(r)])).toThrow("SPEND_LIMIT");
    expect(ledger.snapshot()).toEqual([]);
    ledger.reserve([request(r)]);
    expect(() => ledger.reserve([request(r)])).toThrow("SPEND_LIMIT");
  });
  it("RES-05: fast/deep/retry/summary calls consume one shared allowance", () => {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({}), () => Date.parse(now));
    const r = resources({ quota: { poolId: "shared", unit: "requests", remaining: 3, evidence } });
    ledger.reserve([request(r), request(r)]);
    ledger.reserve([request(r)]);
    expect(() => ledger.reserve([request(r)])).toThrow("QUOTA_EXHAUSTED");
  });
  it("RES-06: cancellation after start retains unsettled spend and quota", async () => {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({ maxIncrementalUsd: 1 }), () => Date.parse(now));
    const r = resources({ incremental: { currency: "USD", maxInvocationUsd: 1, evidence } });
    const [id] = ledger.reserve([request(r)]);
    await ledger.begin(id, signal()); ledger.release(id); ledger.finish(id);
    expect(ledger.snapshot()[0]).toMatchObject({ status: "unsettled", reportedUsd: null, reservedUsd: 1 });
    expect(() => ledger.reserve([request(r)])).toThrow("SPEND_LIMIT");
  });
  it("releases known-unstarted work and reconciles reported consumption", async () => {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({ maxIncrementalUsd: 1 }), () => Date.parse(now));
    const r = resources({ incremental: { currency: "USD", maxInvocationUsd: 1, evidence } });
    const [first] = ledger.reserve([request(r)]); ledger.release(first);
    const [second] = ledger.reserve([request(r)]); await ledger.begin(second, signal());
    ledger.finish(second, { usd: 0, quotaUnits: 0 });
    expect(() => ledger.reserve([request(r)])).not.toThrow();
  });
  it("enforces compute concurrency without reserving execution slots for queued work", async () => {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({}), () => Date.parse(now));
    const r = resources({ compute: { poolId: "gpu", concurrency: 1 } });
    const [a, b] = ledger.reserve([request(r), request(r)]);
    await ledger.begin(a, signal());
    await expect(ledger.begin(b, signal())).rejects.toThrow("COMPUTE_CAPACITY_EXHAUSTED");
    ledger.finish(a);
    const [c] = ledger.reserve([request(r)]); await ledger.begin(c, signal()); ledger.finish(c);
  });
  it("bounds capacity waiting and releases the unstarted reservation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    try {
      const ledger = new ResourceAdmission(dispatchPolicySchema.parse({ quotaExhaustionAction: "wait", waitTimeoutMs: 20 }));
      const r = resources({ compute: { poolId: "gpu", concurrency: 1 } });
      const [a, b] = ledger.reserve([request(r), request(r)]); await ledger.begin(a, signal());
      const blocked = expect(ledger.begin(b, signal())).rejects.toThrow("COMPUTE_CAPACITY_EXHAUSTED");
      await vi.advanceTimersByTimeAsync(30); await blocked;
      expect(ledger.snapshot()[1].status).toBe("released");
    } finally { vi.useRealTimers(); }
  });
});

it("RES-07: quota waiting ends at its deadline without creating a reservation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  try {
    const ledger = new ResourceAdmission(dispatchPolicySchema.parse({ quotaExhaustionAction: "wait", waitTimeoutMs: 20 }));
    const r = resources({ quota: { poolId: "empty", unit: "requests", remaining: 0, evidence } });
    const blocked = expect(ledger.reserveWithWait([request(r)])).rejects.toThrow("QUOTA_EXHAUSTED");
    await vi.advanceTimersByTimeAsync(30); await blocked;
    expect(ledger.snapshot()).toEqual([]);
  } finally { vi.useRealTimers(); }
});
