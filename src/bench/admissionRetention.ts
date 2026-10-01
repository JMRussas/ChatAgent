/** Repeatable, provider-free retained-heap measurement; run with --expose-gc. */
import { ResourceAdmission } from "../routing/resourceAdmission";
import { dispatchPolicySchema, bindingResourcesSchema } from "../config/dispatchConfig";
if (!global.gc) throw Error("Run Node with --expose-gc");
const now = Date.now();
const evidence = {
  source: "memory-measurement",
  kind: "configured" as const,
  checkedAtIso: new Date(now - 1000).toISOString(),
  expiresAtIso: new Date(now + 3600000).toISOString()
};
const resources = bindingResourcesSchema.parse({
  facts: { executionScope: "local-device", billingComponents: ["owned-compute"] },
  evidence,
  incremental: { currency: "USD", maxInvocationUsd: 0, evidence },
  quota: { poolId: "fixture", unit: "requests", remaining: 1000000, evidence },
  compute: { poolId: "fixture", concurrency: 1 },
  fixedCostNote: "x".repeat(32000)
});
const ledger = new ResourceAdmission(dispatchPolicySchema.parse({}), () => now, {
  maxCompleted: 100,
  completedTtlMs: 300000,
  maxMetrics: 100
});
const signal = new AbortController().signal;
const samples = [];
for (let batch = 0; batch < 6; batch++) {
  for (let i = 0; i < 5000; i++) {
    const [id] = ledger.reserve([{ resources, inputTokens: 100, outputTokens: 50 }]);
    await ledger.begin(id, signal);
    ledger.finish(id);
  }
  global.gc();
  samples.push({
    completed: (batch + 1) * 5000,
    heapUsed: process.memoryUsage().heapUsed,
    ...ledger.retentionStats()
  });
}
console.log(
  JSON.stringify(
    {
      scope: "ResourceAdmission only; timeline, dead letters and other runtime stores excluded",
      node: process.version,
      recentLimit: 100,
      requestNoteBytes: 32000,
      samples,
      accounting: ledger.accounting()
    },
    null,
    2
  )
);
