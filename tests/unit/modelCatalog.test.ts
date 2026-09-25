import { describe, expect, it } from "vitest";
import data from "../../data/model-catalog.json";
import { describeModelCatalog, findModelCandidates, loadModelCatalog, modelCatalogSchema } from "../../src/config/modelCatalog";

describe("model catalog", () => {
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
