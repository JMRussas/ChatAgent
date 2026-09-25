import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeProviderConfigFromEnv } from "../../src/config/providerConfig";
import { buildProviderPair } from "../../src/providers/providerFactory";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { OllamaDeepProvider, OllamaFastProvider } from "../../src/providers/ollamaProviders";

const keysToReset = [
  "CHAT_FAST_PROVIDER",
  "CHAT_FAST_MODEL",
  "CHAT_FAST_TEMPERATURE",
  "CHAT_DEEP_PROVIDER",
  "CHAT_DEEP_MODEL",
  "CHAT_DEEP_TEMPERATURE",
  "OLLAMA_BASE_URL"
];

afterEach(() => {
  for (const key of keysToReset) {
    delete process.env[key];
  }
});

describe("provider factory", () => {
  it("defaults to mock providers", () => {
    const config = loadRuntimeProviderConfigFromEnv();
    const providers = buildProviderPair(config);

    expect(providers.fastProvider).toBeInstanceOf(MockFastProvider);
    expect(providers.deepProvider).toBeInstanceOf(MockDeepProvider);
  });

  it("supports mix and match between ollama fast and mock deep", () => {
    process.env.CHAT_FAST_PROVIDER = "ollama";
    process.env.CHAT_FAST_MODEL = "llama3.1:8b";
    process.env.CHAT_DEEP_PROVIDER = "mock";

    const config = loadRuntimeProviderConfigFromEnv();
    const providers = buildProviderPair(config);

    expect(providers.fastProvider).toBeInstanceOf(OllamaFastProvider);
    expect(providers.deepProvider).toBeInstanceOf(MockDeepProvider);
  });

  it("supports mix and match between mock fast and ollama deep", () => {
    process.env.CHAT_FAST_PROVIDER = "mock";
    process.env.CHAT_DEEP_PROVIDER = "ollama";
    process.env.CHAT_DEEP_MODEL = "qwen2.5:7b";

    const config = loadRuntimeProviderConfigFromEnv();
    const providers = buildProviderPair(config);

    expect(providers.fastProvider).toBeInstanceOf(MockFastProvider);
    expect(providers.deepProvider).toBeInstanceOf(OllamaDeepProvider);
  });
});
