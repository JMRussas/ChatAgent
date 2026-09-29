import { expect, it } from "vitest";
import { loadDispatchConfig, dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { buildProviderRegistry, entryBindingId } from "../../src/providers/providerRegistry";
import { defaultConnectionsFromEnv } from "../../src/models/connections";
import { budget, entry } from "../helpers/dispatchFixtures";

it("defaults to fixed mode and denies implicit cloud/unpriced execution in catalog policy", async () => {
  const config = await loadDispatchConfig({});
  expect(config.mode).toBe("fixed");
  expect(config.policy).toMatchObject({ maxIncrementalUsd: 0, unknownCostAction: "deny", allowedExecutionScopes: ["local-device"],
    allowedBillingComponents: ["owned-compute"], fallbackBindingIds: { fast: [], deep: [] } });
  await expect(loadDispatchConfig({ MODEL_ROUTING_MODE: "typo" })).rejects.toThrow();
  expect(() => dispatchPolicySchema.parse({ maxIncrementalUsd: -1 })).toThrow();
});
it("constructs actual adapters for registered roles and never enables CLI execution", async () => {
  const models = [entry("fast", { roles: ["fast"] }), entry("deep", { roles: ["deep"] }), entry("disabled", { enabled: false }), entry("cli", { provider: "cli", cli: {
    adapterId: "unimplemented", accountProfile: "fixture", authentication: "unknown", nonInteractive: "unknown",
    streaming: "unknown", outputFormat: "unknown", executionMode: "unknown", automationSupport: "unknown"
  } })];
  const config = { fast: { provider: "mock" as const, model: "mock-v1", temperature: 0 }, deep: { provider: "mock" as const, model: "mock-v1", temperature: 0 } };
  const registry = await buildProviderRegistry({ version: 1, models }, defaultConnectionsFromEnv(config, {}), config, budget, {});
  expect(registry.get(entryBindingId(models[0]))?.fast).toBeDefined();
  expect(registry.get(entryBindingId(models[0]))?.deep).toBeUndefined();
  expect(registry.get(entryBindingId(models[1]))?.deep).toBeDefined();
  expect(registry.get(entryBindingId(models[2]))).toBeUndefined();
  expect(registry.get(entryBindingId(models[3]))).toBeUndefined();
});
