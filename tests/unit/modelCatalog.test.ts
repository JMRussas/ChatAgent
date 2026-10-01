import { describe, expect, it } from "vitest";
import data from "../../data/model-catalog.json";
import {
  apiKindForEntry,
  connectionIdForEntry,
  describeModelCatalog,
  findModelCandidates,
  loadModelCatalog,
  modelCatalogSchema
} from "../../src/config/modelCatalog";
import { bindingKey } from "../../src/models/connections";
import type { ModelObservation } from "../../src/models/inventory";

describe("model catalog", () => {
  const cliEntry = {
    ...data.models[0],
    id: "subscription-example",
    provider: "cli",
    model: "configured-model",
    cli: {
      adapterId: "example-cli",
      accountProfile: "personal",
      authentication: "subscription-login",
      nonInteractive: "unknown",
      streaming: "unknown",
      outputFormat: "unknown",
      executionMode: "unknown",
      automationSupport: "unknown"
    },
    billing: {
      kind: "subscription",
      quotaPoolId: "personal-subscription",
      exhaustionPolicy: "fail",
      usageBillingFallbackAllowed: false
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
    expect(describeModelCatalog(catalog, config).models[0]).toMatchObject({
      adapterStatus: "not-implemented",
      selectedRoles: []
    });
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
    expect(
      modelCatalogSchema.parse({
        version: 1,
        models: [
          cliEntry,
          { ...cliEntry, id: "work-subscription", cli: { ...cliEntry.cli, accountProfile: "work" } }
        ]
      }).models
    ).toHaveLength(2);
    expect(() =>
      modelCatalogSchema.parse({ version: 1, models: [cliEntry, { ...cliEntry, id: "duplicate" }] })
    ).toThrow();
  });
  it("loads the checked-in catalog and finds the configured coding candidate", async () => {
    const catalog = await loadModelCatalog();
    expect(
      findModelCandidates(catalog, { task: "coding", role: "deep" }).map((entry) => entry.id)
    ).toContain("ollama-qwen25-coder-14b");
    expect(
      findModelCandidates(catalog, { task: "coding", role: "fast" }).map((entry) => entry.id)
    ).not.toContain("ollama-qwen25-coder-14b");
  });

  it("does not confuse unknown capabilities and limits with supported requirements", () => {
    const catalog = modelCatalogSchema.parse(data);
    expect(
      findModelCandidates(catalog, {
        task: "coding",
        role: "deep",
        requiredCapabilities: ["tools"]
      })
    ).toEqual([]);
    expect(
      findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: 100 })
    ).toEqual([]);
    const coding = catalog.models.find((entry) => entry.id === "ollama-qwen25-coder-14b")!;
    coding.capabilities.tools = "supported";
    coding.limits = { contextTokens: 1000, maxOutputTokens: 500 };
    expect(
      findModelCandidates(catalog, {
        task: "coding",
        role: "deep",
        inputTokens: 800,
        outputTokens: 300
      })
    ).toEqual([]);
    expect(
      findModelCandidates(catalog, {
        task: "coding",
        role: "deep",
        inputTokens: 700,
        outputTokens: 300
      })
    ).toEqual([coding]);
    coding.enabled = false;
    expect(
      findModelCandidates(catalog, {
        task: "coding",
        role: "deep",
        requiredCapabilities: ["tools"]
      })
    ).toEqual([]);
    expect(() =>
      findModelCandidates(catalog, { task: "coding", role: "deep", inputTokens: -1 })
    ).toThrow();
  });

  it("rejects duplicate bindings, credential fields, and impossible limits", () => {
    expect(() =>
      modelCatalogSchema.parse({ version: 1, models: [data.models[0], data.models[0]] })
    ).toThrow();
    expect(() =>
      modelCatalogSchema.parse({
        version: 1,
        models: [{ ...data.models[0], apiKey: "not-allowed" }]
      })
    ).toThrow();
    expect(() =>
      modelCatalogSchema.parse({
        version: 1,
        models: [{ ...data.models[0], limits: { contextTokens: 10, maxOutputTokens: 20 } }]
      })
    ).toThrow();
  });

  it("v1 -> v2: derives a stable connectionId/apiKind per entry without rewriting the catalog file (RES-08)", () => {
    const catalog = modelCatalogSchema.parse(data);
    const config = {
      fast: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };

    expect(apiKindForEntry({ provider: "ollama" })).toBe("ollama-chat");
    expect(apiKindForEntry({ provider: "azure" })).toBe("azure-openai-chat");
    expect(apiKindForEntry({ provider: "bedrock" })).toBe("bedrock-converse");
    expect(apiKindForEntry({ provider: "mock" })).toBe("mock");
    expect(connectionIdForEntry({ provider: "ollama" })).toBe("default-ollama");

    const description = describeModelCatalog(catalog, config);
    expect(description.models.find((m) => m.id === "ollama-qwen3-8b")).toMatchObject({
      connectionId: "default-ollama",
      apiKind: "ollama-chat"
    });
    // Never rewritten: the on-disk file is still parsed as version 1 with no connectionId field.
    expect(catalog).not.toHaveProperty("models.0.connectionId");
  });

  it("two connections offering the same model produce separate bindings", () => {
    expect(bindingKey("conn-a", "ollama-chat", "same-model")).not.toBe(
      bindingKey("conn-b", "ollama-chat", "same-model")
    );
  });

  it("computes real readiness from observations instead of a hardcoded value, using the precedence order", () => {
    const catalog = modelCatalogSchema.parse(data);
    const config = {
      fast: { provider: "ollama" as const, model: "qwen3:8b", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };
    const readyObservation: ModelObservation = {
      bindingId: bindingKey("default-ollama", "ollama-chat", "qwen3:8b"),
      connectionId: "default-ollama",
      model: "qwen3:8b",
      observedAtIso: "2026-09-29T00:00:00.000Z",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
      source: "ollama-api-tags",
      installed: "yes",
      access: "allowed",
      health: "reachable",
      apiCompatibility: ["ollama-chat"],
      effectiveContextTokens: 32768
    };

    const ready = describeModelCatalog(catalog, config, { observations: [readyObservation] });
    expect(ready.models.find((m) => m.id === "ollama-qwen3-8b")).toMatchObject({
      availability: "ready",
      observation: {
        installed: "yes",
        access: "allowed",
        health: "reachable",
        effectiveContextTokens: 32768
      }
    });

    const stale = describeModelCatalog(catalog, config, {
      observations: [{ ...readyObservation, expiresAtIso: "2000-01-01T00:00:00.000Z" }]
    });
    expect(stale.models.find((m) => m.id === "ollama-qwen3-8b")?.availability).toBe("stale");

    const denied = describeModelCatalog(catalog, config, {
      observations: [{ ...readyObservation, access: "denied" }]
    });
    expect(denied.models.find((m) => m.id === "ollama-qwen3-8b")?.availability).toBe("denied");

    const disabledCatalog = modelCatalogSchema.parse(data);
    disabledCatalog.models.find((m) => m.id === "ollama-qwen3-8b")!.enabled = false;
    const disabled = describeModelCatalog(disabledCatalog, config, {
      observations: [readyObservation]
    });
    expect(disabled.models.find((m) => m.id === "ollama-qwen3-8b")?.availability).toBe("disabled");
  });

  it("surfaces declared execution/billing/compute facts from the connection, never inferred (RES-01/03)", () => {
    const catalog = modelCatalogSchema.parse(data);
    const config = {
      fast: { provider: "ollama" as const, model: "qwen3:8b", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };
    const localConnection = {
      connectionId: "default-ollama",
      apiKind: "ollama-chat" as const,
      baseUrl: "http://localhost:11434",
      resourceFacts: {
        executionScope: "local-device" as const,
        billingComponents: ["owned-compute" as const]
      },
      quota: {},
      compute: { ownedOrRented: "owned" as const, concurrencyLimit: 1 }
    };

    const description = describeModelCatalog(catalog, config, { connections: [localConnection] });
    const entry = description.models.find((m) => m.id === "ollama-qwen3-8b")!;
    expect(entry).toMatchObject({
      resourceFacts: { executionScope: "local-device", billingComponents: ["owned-compute"] },
      compute: { ownedOrRented: "owned", concurrencyLimit: 1 }
    });

    // No connection supplied for a binding -> no resourceFacts fabricated, not defaulted to "local".
    const withoutConnection = describeModelCatalog(catalog, config);
    expect(withoutConnection.models.find((m) => m.id === "ollama-qwen3-8b")).not.toHaveProperty(
      "resourceFacts"
    );
  });

  it("lists a discovered-but-uncurated model separately, always disabled, never auto-curated", () => {
    const catalog = modelCatalogSchema.parse(data);
    const config = {
      fast: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };
    const uncurated: ModelObservation = {
      bindingId: bindingKey("default-ollama", "ollama-chat", "brand-new-model:1b"),
      connectionId: "default-ollama",
      model: "brand-new-model:1b",
      observedAtIso: "2026-09-29T00:00:00.000Z",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
      source: "ollama-api-tags",
      installed: "yes",
      access: "allowed",
      health: "reachable",
      apiCompatibility: ["ollama-chat"]
    };

    const description = describeModelCatalog(catalog, config, { observations: [uncurated] });
    expect(description.discovered).toEqual([
      {
        connectionId: "default-ollama",
        model: "brand-new-model:1b",
        revision: undefined,
        enabled: false
      }
    ]);
    expect(description.models.some((m) => m.model === "brand-new-model:1b")).toBe(false);
  });

  it("never coerces a missing price into zero, and distinguishes it from a verified zero-cost entry (RES-04)", () => {
    const withoutPricing = data.models[0]; // no `pricing` field at all
    const verifiedZero = {
      ...withoutPricing,
      id: "verified-zero-cost",
      model: "mock-v2",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
        checkedAtIso: "2026-09-29T00:00:00.000Z",
        source: "local compute, verified 2026-09-29"
      }
    };

    const catalog = modelCatalogSchema.parse({
      version: 1,
      models: [withoutPricing, verifiedZero]
    });
    const config = {
      fast: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 },
      deep: { provider: "mock" as const, model: "mock-v1", temperature: 0.2 }
    };
    const description = describeModelCatalog(catalog, config);

    expect(description.models.find((m) => m.id === withoutPricing.id)?.pricing).toBeUndefined();
    expect(description.models.find((m) => m.id === "verified-zero-cost")?.pricing).toEqual({
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      checkedAtIso: "2026-09-29T00:00:00.000Z",
      source: "local compute, verified 2026-09-29"
    });
  });

  it("reports active and unlisted models without exposing provider credentials or claiming health", () => {
    const azureConnection = {
      connectionId: "default-azure",
      apiKind: "azure-openai-chat" as const,
      credentialRef: "AZURE_OPENAI_API_KEY",
      baseUrl: "https://example.test",
      resourceFacts: {
        executionScope: "unknown" as const,
        billingComponents: ["unknown" as const]
      },
      quota: {},
      compute: { ownedOrRented: "unknown" as const }
    };
    const description = describeModelCatalog(
      modelCatalogSchema.parse(data),
      {
        fast: { provider: "ollama", model: "qwen3:8b", temperature: 0.2 },
        deep: { provider: "azure", model: "custom-deployment", temperature: 0.2 },
        azure: { endpoint: "https://example.test", apiKey: "test-secret", apiVersion: "test" }
      },
      {
        connections: [azureConnection],
        observations: [
          {
            bindingId: bindingKey("default-ollama", "ollama-chat", "qwen3:8b"),
            connectionId: "default-ollama",
            model: "qwen3:8b",
            observedAtIso: "2026-09-29T00:00:00.000Z",
            expiresAtIso: "2000-01-01T00:00:00.000Z",
            source: "ollama-api-tags",
            installed: "unknown",
            access: "unknown",
            health: "unreachable",
            apiCompatibility: ["ollama-chat"],
            lastErrorCode: "ECONNREFUSED"
          }
        ]
      }
    );
    expect(description.models.find((entry) => entry.id === "ollama-qwen3-8b")).toMatchObject({
      selectedRoles: ["fast"],
      availability: "stale",
      observation: { lastErrorCode: "ECONNREFUSED" }
    });
    expect(description.unlistedSelections).toEqual([
      { role: "deep", provider: "azure", model: "custom-deployment" }
    ]);
    expect(JSON.stringify(description)).not.toContain("test-secret");
  });
});
