import { afterEach, expect, it, vi } from "vitest";
import { ResourceAdmission, type ResourceRequest } from "../../src/routing/resourceAdmission";
import { dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { loadQuotaPoolLimits } from "../../src/config/quotaPoolLimits";
import { resources, evidence, now } from "../helpers/dispatchFixtures";

const retention = { maxCompleted: 2, completedTtlMs: 10, maxMetrics: 2 };
const signal = () => new AbortController().signal;
const pool = (poolId: string, remaining = 3): ResourceRequest => ({
  resources: resources({ quota: { poolId, unit: "requests", remaining, evidence } }),
  inputTokens: 100,
  outputTokens: 50
});
const ledgerWith = (maxPools: number, policy = {}) =>
  new ResourceAdmission(
    dispatchPolicySchema.parse(policy),
    () => Date.parse(now),
    retention,
    Date.now,
    { maxPools }
  );
const consume = async (ledger: ResourceAdmission, request: ResourceRequest) => {
  const [id] = ledger.reserve([request]);
  await ledger.begin(id, signal());
  ledger.finish(id);
};
afterEach(() => vi.useRealTimers());

it("repeated pools share one slot and a new pool at capacity is rejected", async () => {
  const ledger = ledgerWith(2);
  for (let i = 0; i < 3; i++) await consume(ledger, pool("a"));
  await consume(ledger, pool("b"));
  expect(ledger.retentionStats().quotaPools).toBe(2);
  const before = ledger.accounting();
  expect(() => ledger.reserve([pool("c")])).toThrow("QUOTA_POOL_CAPACITY");
  expect(() => ledger.check([pool("c")])).toThrow("QUOTA_POOL_CAPACITY");
  expect(ledger.accounting()).toEqual(before);
  expect(ledger.retentionStats()).toMatchObject({ active: 0, quotaPools: 2 });
  // Retained pools keep their exact consumption and remain usable within allowance.
  expect(before.quotaPools).toEqual([
    { poolId: "a", units: 3 },
    { poolId: "b", units: 1 }
  ]);
  expect(() => ledger.reserve([pool("a")])).toThrow("QUOTA_EXHAUSTED");
  expect(() => ledger.reserve([pool("b")])).not.toThrow();
});

it("a live reservation holds its slot and only an unstarted release frees it", async () => {
  const ledger = ledgerWith(1);
  const [held] = ledger.reserve([pool("a")]);
  expect(ledger.retentionStats().quotaPools).toBe(1);
  expect(() => ledger.reserve([pool("b")])).toThrow("QUOTA_POOL_CAPACITY");
  ledger.release(held);
  expect(ledger.retentionStats().quotaPools).toBe(0);

  const [started] = ledger.reserve([pool("b")]);
  await ledger.begin(started, signal());
  ledger.release(started); // Started work cannot give its slot back.
  expect(() => ledger.reserve([pool("a")])).toThrow("QUOTA_POOL_CAPACITY");
  ledger.finish(started, { usd: 0, quotaUnits: 0 });
  // A settled pool stays retained even at zero reported units: its snapshot still binds.
  expect(ledger.accounting().quotaPools).toEqual([{ poolId: "b", units: 0 }]);
  expect(() => ledger.reserve([pool("a")])).toThrow("QUOTA_POOL_CAPACITY");
  expect(() => ledger.reserve([pool("b", 10)])).toThrow("QUOTA_SNAPSHOT_CONFLICT");
});

it("settlement always records consumption for pools admitted up to the limit", async () => {
  const ledger = ledgerWith(3);
  const ids = ledger.reserve([pool("a"), pool("b"), pool("c")]);
  expect(() => ledger.reserve([pool("d")])).toThrow("QUOTA_POOL_CAPACITY");
  for (const id of ids.reverse()) {
    await ledger.begin(id, signal());
    ledger.finish(id, { usd: 0, quotaUnits: 0.5 });
  }
  expect(ledger.retentionStats()).toMatchObject({ active: 0, quotaPools: 3 });
  expect(ledger.accounting().quotaPools.map((p) => [p.poolId, p.units])).toEqual([
    ["c", 0.5],
    ["b", 0.5],
    ["a", 0.5]
  ]);
});

it("rejects a batch atomically when any member needs a pool beyond the limit", async () => {
  const ledger = ledgerWith(2);
  await consume(ledger, pool("a"));
  const before = { stats: ledger.retentionStats(), accounting: ledger.accounting() };
  expect(() => ledger.reserve([pool("a"), pool("b"), pool("c")])).toThrow("QUOTA_POOL_CAPACITY");
  expect({ stats: ledger.retentionStats(), accounting: ledger.accounting() }).toEqual(before);
  // The same batch may introduce one new pool, counted once however often it repeats.
  expect(ledger.reserve([pool("a"), pool("b"), pool("b")])).toHaveLength(3);
  expect(ledger.retentionStats().quotaPools).toBe(2);
});

it("conflicting snapshots fail closed at capacity instead of freeing or resetting a pool", async () => {
  const ledger = ledgerWith(2);
  await consume(ledger, pool("consumed", 1));
  const [pending] = ledger.reserve([pool("pending")]);
  for (const changed of [pool("consumed", 100), pool("pending", 100)])
    expect(() => ledger.reserve([changed])).toThrow("QUOTA_SNAPSHOT_CONFLICT");
  const refreshed = pool("consumed", 1);
  refreshed.resources!.quota!.evidence = { ...evidence, checkedAtIso: "2026-09-29T11:30:00.000Z" };
  expect(() => ledger.reserve([refreshed])).toThrow("QUOTA_SNAPSHOT_CONFLICT");
  expect(() => ledger.reserve([pool("consumed", 1)])).toThrow("QUOTA_EXHAUSTED");
  expect(ledger.retentionStats().quotaPools).toBe(2);
  ledger.release(pending);
  // The unconsumed pool's slot is reusable; the consumed pool's never is.
  expect(() => ledger.reserve([pool("pending", 100)])).not.toThrow();
  expect(() => ledger.reserve([pool("other")])).toThrow("QUOTA_POOL_CAPACITY");
});

it("configuration churn cannot evict or reset consumed allowance", async () => {
  let clock = 0;
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({}),
    () => Date.parse(now),
    retention,
    () => clock,
    { maxPools: 4 }
  );
  await consume(ledger, pool("account", 1));
  const admitted: string[] = [];
  for (let i = 0; i < 50; i++) {
    clock += 11; // Diagnostic rows expire; pool totals must not.
    try {
      await consume(ledger, pool(`account-renamed-${i}`, 1));
      admitted.push(`account-renamed-${i}`);
    } catch (error) {
      expect((error as Error).message).toBe("QUOTA_POOL_CAPACITY");
    }
    expect(ledger.retentionStats().quotaPools).toBeLessThanOrEqual(4);
  }
  // Each identifier admitted within the limit carried its own declared allowance;
  // none of them displaced or refunded an earlier total.
  expect(admitted).toEqual(["account-renamed-0", "account-renamed-1", "account-renamed-2"]);
  expect(ledger.snapshot()).toEqual([]);
  expect(ledger.accounting().quotaPools).toEqual(
    ["account", ...admitted].map((poolId) => ({ poolId, units: 1 }))
  );
  for (const poolId of ["account", ...admitted])
    expect(() => ledger.reserve([pool(poolId, 1)])).toThrow("QUOTA_EXHAUSTED");
});

it("does not wait for pool capacity that only an operator can restore", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({ quotaExhaustionAction: "wait", waitTimeoutMs: 1000 }),
    undefined,
    retention,
    Date.now,
    { maxPools: 1 }
  );
  ledger.reserve([pool("a")]);
  let settled = false;
  const blocked = ledger.reserveWithWait([pool("b")]).catch((error: Error) => {
    settled = true;
    return error.message;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  expect(await blocked).toBe("QUOTA_POOL_CAPACITY");
  expect(ledger.retentionStats()).toMatchObject({ active: 1, quotaPools: 1 });
});

it("pools without quota do not occupy slots", async () => {
  const ledger = ledgerWith(1);
  await consume(ledger, pool("a"));
  const unmetered = { resources: resources(), inputTokens: 100, outputTokens: 50 };
  for (let i = 0; i < 5; i++) await consume(ledger, unmetered);
  expect(ledger.retentionStats().quotaPools).toBe(1);
});

it("validates the limit and rejects a policy declaring more pools than it allows", () => {
  expect(loadQuotaPoolLimits({})).toEqual({ maxPools: 100 });
  expect(loadQuotaPoolLimits({ ADMISSION_MAX_QUOTA_POOLS: "3" }).maxPools).toBe(3);
  for (const bad of ["0", "-1", "1.5", "many", "10001"])
    expect(() => loadQuotaPoolLimits({ ADMISSION_MAX_QUOTA_POOLS: bad })).toThrow();
  const bindings = {
    one: pool("shared").resources,
    two: pool("shared").resources,
    three: pool("separate").resources
  };
  expect(() => ledgerWith(2, { bindings })).not.toThrow();
  expect(() => ledgerWith(1, { bindings })).toThrow("ADMISSION_MAX_QUOTA_POOLS");
});

it("validates explicit constructor limits", () => {
  for (const maxPools of [NaN, Infinity, 0, -1, 1.5, 10001])
    expect(() => ledgerWith(maxPools)).toThrow();
});

it("captures limits independently of caller mutation", () => {
  const limits = { maxPools: 1 };
  const ledger = new ResourceAdmission(
    dispatchPolicySchema.parse({}),
    () => Date.parse(now),
    retention,
    Date.now,
    limits
  );
  ledger.reserve([pool("a")]);
  limits.maxPools = NaN;
  expect(() => ledger.reserve([pool("b")])).toThrow("QUOTA_POOL_CAPACITY");
  expect(ledger.retentionStats().quotaPools).toBe(1);
});
