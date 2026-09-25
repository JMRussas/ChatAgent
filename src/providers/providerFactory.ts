import type { RuntimeProviderConfig } from "../config/providerConfig";
import { parsePositiveIntEnv } from "../config/runtimeEnv";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";
import { AzureDeepProvider, AzureFastProvider } from "./azureProviders";
import { BedrockDeepProvider, BedrockFastProvider } from "./bedrockProviders";
import { MockDeepProvider, MockFastProvider } from "./mockProviders";
import { OllamaDeepProvider, OllamaFastProvider } from "./ollamaProviders";

interface ProviderPair {
  fastProvider: FastModelProvider;
  deepProvider: DeepModelProvider;
}

function resolveOllamaFastTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_FAST_TIMEOUT_MS, 10_000, 500, 120_000);
}

function resolveOllamaDeepTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_DEEP_TIMEOUT_MS, 10_000, 500, 240_000);
}

function resolveOllamaFastNumPredict(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_FAST_NUM_PREDICT, 384, 32, 4096);
}

function resolveOllamaDeepNumPredict(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_DEEP_NUM_PREDICT, 768, 64, 8192);
}

function buildFastProvider(config: RuntimeProviderConfig): FastModelProvider {
  const fast = config.fast;

  if (fast.provider === "mock") return new MockFastProvider();

  if (fast.provider === "ollama") {
    return new OllamaFastProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      fast.model,
      fast.temperature,
      resolveOllamaFastTimeoutMs(),
      resolveOllamaFastNumPredict()
    );
  }

  if (fast.provider === "azure") {
    if (!config.azure) {
      throw new Error(
        "CHAT_FAST_PROVIDER=azure requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to be set (see .env.example)."
      );
    }
    return new AzureFastProvider(
      config.azure.endpoint,
      config.azure.apiKey,
      config.azure.apiVersion,
      fast.model,
      fast.temperature
    );
  }

  if (!config.bedrock) {
    throw new Error("CHAT_FAST_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example).");
  }
  return new BedrockFastProvider(config.bedrock.region, fast.model, fast.temperature);
}

function buildDeepProvider(config: RuntimeProviderConfig): DeepModelProvider {
  const deep = config.deep;

  if (deep.provider === "mock") return new MockDeepProvider();

  if (deep.provider === "ollama") {
    return new OllamaDeepProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      deep.model,
      deep.temperature,
      resolveOllamaDeepTimeoutMs(),
      resolveOllamaDeepNumPredict()
    );
  }

  if (deep.provider === "azure") {
    if (!config.azure) {
      throw new Error(
        "CHAT_DEEP_PROVIDER=azure requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to be set (see .env.example)."
      );
    }
    return new AzureDeepProvider(
      config.azure.endpoint,
      config.azure.apiKey,
      config.azure.apiVersion,
      deep.model,
      deep.temperature
    );
  }

  if (!config.bedrock) {
    throw new Error("CHAT_DEEP_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example).");
  }
  return new BedrockDeepProvider(config.bedrock.region, deep.model, deep.temperature);
}

export function buildProviderPair(config: RuntimeProviderConfig): ProviderPair {
  return {
    fastProvider: buildFastProvider(config),
    deepProvider: buildDeepProvider(config)
  };
}
