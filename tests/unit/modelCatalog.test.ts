import { describe, expect, it } from "vitest";
import data from "../../data/model-catalog.json";
import { describeModelCatalog, findModelCandidates, loadModelCatalog, modelCatalogSchema } from "../../src/config/modelCatalog";

describe("model catalog", () => {
  const cliEntry = {
    ...data.models[0], id: "subscription-example", provider: "cli", model: "configured-model",
    cli: {
      adapterId: "example-cli", accountProfile: "personal", authentication: "subscription-login",
      nonInteractive: "unknown", streaming: "unknown", outputFormat: "unknown",
      executionMode: "unknown", automationSupport: "unknown"
    },
    billing: {
      kind: "subscription", quotaPoolId: "personal-subscription",
      exhaustionPolicy: "fail", usageBillingFallbackAllowed: false
    }
  };

  it("catalogs subscription access without treating an unimplemented CLI as routable", () => {
    const catalog = modelCatalogSchema.parse({ version: 1, models: [cliEntry] });
    expect(catalog.models[0].billing?.kind).toBe("subscription");
    expect(findModelCandidates(catalog, { task: "coding", role: "deep" })).toEqual([]);
    const config = {
      fast: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };
    expect(describeModelCatalog(catalog, config).models[0]).toMatchObject({ adapterStatus: "not-implemented", selectedRoles: [] });
  });

  it("requires explicit subscription metadata and rejects executable commands and stored credentials", () => {
    for (const entry of [
      { ...cliEntry, cli: undefined },
      { ...cliEntry, billing: undefined },
      { ...cliEntry, cli: { ...cliEntry.cli, command: "some-command" } },
      { ...cliEntry, cli: { ...cliEntry.cli, token: "secret" } }
    ]) {
      expect(() => modelCatalogSchema.parse({ version: 1, models: [entry] })).toThrow();
    }
  });

  it("distinguishes CLI adapters and account profiles for the same model", () => {
    expect(modelCatalogSchema.parse({ version: 1, models: [
      cliEntry,
      { ...cliEntry, id: "work-subscription", cli: { ...cliEntry.cli, accountProfile: "work" } }
    ] }).models).toHaveLength(2);
    expect(() => modelCatalogSchema.parse({ version: 1, models: [cliEntry, { ...cliEntry, id: "duplicate" }] })).toThrow();
  });
  it("loads the checked-in catalog and finds the configured coding candidate", async () => {
    const catalog = await loadModelCatalog();
    expect(findModelCandidates(catalog, { task: "coding", role: "deep" }).map((entry) => entry.id))
      .toContain("ollama-qwen25-coder-14b");
    expect(findModelCandidates(catalog, { task: "coding", role: "fast" }).map((entry) => entry.id))
      .not.toContain("ollama-qwen25-coder-14b");
  });

  it("does not confuse unknown capabilities and limits with supported requirements", () => {
    const catalog = modelCatalogSchema.parse(data);
    expect(findModelCandidates(catalog, { task: "coding", role: "deep", requiredCapabilities: ["tools"] })).toEqual([]);
    expect(findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: 100 })).toEqual([]);
    const coding = catalog.models.find((entry) => entry.id === "ollama-qwen25-coder-14b")!;
    coding.capabilities.tools = "supported";
    coding.limits = { contextTokens: 1000, maxOutputTokens: 500 };
    expect(findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: 800, outputTokens: 300 })).toEqual([]);
    expect(findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: 700, outputTokens: 300 })).toEqual([coding]);
    coding.enabled = false;
    expect(findModelCandidates(catalog, { task: "coding", role: "deep", requiredCapabilities: ["tools"] })).toEqual([]);
    expect(() => findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: -1 })).toThrow();
  });

  it("rejects duplicate bindings, credential fields, and impossible limits", () => {
    expect(() => modelCatalogSchema.parse({ version: 1, models: [data.models[0], data.models[0]] })).toThrow();
    expect(() => modelCatalogSchema.parse({ version: 1, models: [{ ...data.models[0], apiKey: "not-allowed" }] })).toThrow();
    expect(() => modelCatalogSchema.parse({ version: 1, models: [{ ...data.models[0], limits: { contextTokens: 10, maxOutputTokens: 20 } }] })).toThrow();
  });

  it("reports active and unlisted models without exposing provider credentials or claiming health", () => {
    const description = describeModelCatalog(modelCatalogSchema.parse(data), {
      fast: { provider: "ollama", model: "qwen3:8b", temperature: 0.2 },
      deep: { provider: "azure", model: "custom-deployment", temperature: 0.2 },
      azure: { endpoint: "https://example.test", apiKey: "test-secret", apiVersion: "test" }
    });
    expect(description.models.find((entry) => entry.id === "ollama-qwen3-8b"))
      .toMatchObject({ selectedRoles: ["fast"], availability: "unchecked" });
    expect(description.unlistedSelections).toEqual([{ role: "deep", provider: "azure", model: "custom-deployment" }]);
    expect(JSON.stringify(description)).not.toContain("test-secret");
  });
});
