import { describe, expect, it } from "vitest";
import { bindingKey, defaultConnectionsFromEnv, UNKNOWN_RESOURCE_FACTS } from "../../src/models/connections";
import type { RuntimeProviderConfig } from "../../src/config/providerConfig";

const baseConfig: RuntimeProviderConfig = {
  fast: { provider: "ollama", model: "qwen3:8b", temperature: 0.2 },
  deep: { provider: "ollama", model: "qwen3:8b", temperature: 0.2 }
};

describe("defaultConnectionsFromEnv", () => {
  it("never infers execution scope or billing from a localhost URL or provider name (RES-08)", () => {
    const connections = defaultConnectionsFromEnv(baseConfig, {});
    const ollama = connections.find((c) => c.connectionId === "default-ollama")!;

    expect(ollama.baseUrl).toBe("http://localhost:11434");
    expect(ollama.resourceFacts).toEqual(UNKNOWN_RESOURCE_FACTS);
  });

  it("uses declared execution scope and billing components only when explicitly configured", () => {
    const connections = defaultConnectionsFromEnv(baseConfig, {
      OLLAMA_EXECUTION_SCOPE: "local-device",
      OLLAMA_BILLING_COMPONENTS: "owned-compute"
    });
    const ollama = connections.find((c) => c.connectionId === "default-ollama")!;

    expect(ollama.resourceFacts).toEqual({ executionScope: "local-device", billingComponents: ["owned-compute"] });
  });

  it("rejects an invalid declared execution scope rather than silently ignoring it", () => {
    expect(() => defaultConnectionsFromEnv(baseConfig, { OLLAMA_EXECUTION_SCOPE: "definitely-local" })).toThrow();
  });

  it("supports two bindings on localhost with different declared execution (RES-01 data-model requirement)", () => {
    // Two logical connections at the same localhost endpoint, one declared
    // verified-local and one declared cloud-backed -- proves the model can
    // keep them distinct; admission policy on this data is spec 04's job.
    const local = defaultConnectionsFromEnv(baseConfig, { OLLAMA_EXECUTION_SCOPE: "local-device" })
      .find((c) => c.connectionId === "default-ollama")!;
    const cloud = { ...local, connectionId: "ollama-cloud-alias", resourceFacts: { executionScope: "managed-cloud" as const, billingComponents: ["subscription" as const] } };

    expect(bindingKey(local.connectionId, "ollama-chat", "gemma4")).not.toBe(bindingKey(cloud.connectionId, "ollama-chat", "gemma4:cloud"));
    expect(local.resourceFacts.executionScope).toBe("local-device");
    expect(cloud.resourceFacts.executionScope).toBe("managed-cloud");
  });

  it("represents owned/rented compute separately from incremental billing components (RES-03)", () => {
    const connections = defaultConnectionsFromEnv(baseConfig, {
      OLLAMA_EXECUTION_SCOPE: "self-hosted-remote",
      OLLAMA_BILLING_COMPONENTS: "owned-compute"
    });
    const ollama = connections.find((c) => c.connectionId === "default-ollama")!;

    // A self-hosted-remote GPU with owned-compute billing must not be conflated
    // with managed-cloud per-token billing -- distinct fields, not one enum.
    expect(ollama.resourceFacts.executionScope).toBe("self-hosted-remote");
    expect(ollama.resourceFacts.billingComponents).toEqual(["owned-compute"]);
    expect(ollama.compute).toEqual({ ownedOrRented: "unknown" });
  });

  it("references credentials by name only, never by value", () => {
    const azureConfig: RuntimeProviderConfig = {
      ...baseConfig,
      fast: { provider: "azure", model: "gpt-fast", temperature: 0.2 },
      azure: { endpoint: "https://example.test", apiKey: "super-secret-value", apiVersion: "2024-10-21" }
    };
    const connections = defaultConnectionsFromEnv(azureConfig, {});
    const azure = connections.find((c) => c.connectionId === "default-azure")!;

    expect(azure.credentialRef).toBe("AZURE_OPENAI_API_KEY");
    expect(JSON.stringify(connections)).not.toContain("super-secret-value");
  });

  it("produces a distinct binding key per connection/apiKind/model combination", () => {
    expect(bindingKey("c1", "ollama-chat", "m1")).not.toBe(bindingKey("c2", "ollama-chat", "m1"));
    expect(bindingKey("c1", "ollama-chat", "m1")).not.toBe(bindingKey("c1", "azure-openai-chat", "m1"));
    expect(bindingKey("c1", "ollama-chat", "m1")).toBe(bindingKey("c1", "ollama-chat", "m1"));
  });
});
