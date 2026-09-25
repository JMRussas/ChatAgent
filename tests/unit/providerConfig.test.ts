import { afterEach, describe, expect, it } from "vitest";
import { describeProviderConfig, loadRuntimeProviderConfigFromEnv } from "../../src/config/providerConfig";

const keysToReset = [
  "CHAT_FAST_PROVIDER",
  "CHAT_FAST_MODEL",
  "CHAT_DEEP_PROVIDER",
  "CHAT_DEEP_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_VERSION",
  "BEDROCK_REGION",
  "OLLAMA_BASE_URL"
];

afterEach(() => {
  for (const key of keysToReset) {
    delete process.env[key];
  }
});

describe("loadRuntimeProviderConfigFromEnv", () => {
  it("fails fast when a non-mock provider is selected without a model", () => {
    process.env.CHAT_FAST_PROVIDER = "azure";

    expect(() => loadRuntimeProviderConfigFromEnv()).toThrow(/CHAT_FAST_MODEL is required/);
  });

  it("does not require a model for the mock provider", () => {
    process.env.CHAT_FAST_PROVIDER = "mock";

    const config = loadRuntimeProviderConfigFromEnv();
    expect(config.fast.model).toBe("mock-v1");
  });
});

describe("describeProviderConfig", () => {
  it("never includes the Azure API key", () => {
    process.env.CHAT_FAST_PROVIDER = "azure";
    process.env.CHAT_FAST_MODEL = "gpt-4o-mini";
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "super-secret-value-should-never-appear";

    const config = loadRuntimeProviderConfigFromEnv();
    const summary = describeProviderConfig(config);

    expect(summary).not.toContain("super-secret-value-should-never-appear");
    expect(summary).not.toContain(config.azure?.apiKey ?? "");
    expect(summary).toContain("fast=azure/gpt-4o-mini");
    expect(summary).toContain("azure_endpoint=https://example.openai.azure.com");
  });

  it("includes provider/model pairs and region for a mock+bedrock mix", () => {
    process.env.CHAT_FAST_PROVIDER = "mock";
    process.env.CHAT_DEEP_PROVIDER = "bedrock";
    process.env.CHAT_DEEP_MODEL = "anthropic.claude-3-5-sonnet";
    process.env.BEDROCK_REGION = "us-east-1";

    const config = loadRuntimeProviderConfigFromEnv();
    const summary = describeProviderConfig(config);

    expect(summary).toBe(
      "fast=mock/mock-v1 deep=bedrock/anthropic.claude-3-5-sonnet bedrock_region=us-east-1 ollama_base_url=http://localhost:11434"
    );
  });
});
