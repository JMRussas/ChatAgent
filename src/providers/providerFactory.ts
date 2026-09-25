import type { RuntimeProviderConfig } from "../config/providerConfig";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";
import { AzureDeepProvider, AzureFastProvider } from "./azureProviders";
import { BedrockDeepProvider, BedrockFastProvider } from "./bedrockProviders";
import { MockDeepProvider, MockFastProvider } from "./mockProviders";
import { OllamaDeepProvider, OllamaFastProvider } from "./ollamaProviders";

interface ProviderPair {
  fastProvider: FastModelProvider;
  deepProvider: DeepModelProvider;
}

function buildFastProvider(config: RuntimeProviderConfig): FastModelProvider {
  const fast = config.fast;

  if (fast.provider === "mock") return new MockFastProvider();

  if (fast.provider === "ollama") {
    return new OllamaFastProvider(config.ollama?.baseUrl ?? "http://localhost:11434", fast.model, fast.temperature);
  }

  if (fast.provider === "azure") {
    if (!config.azure) throw new Error("Azure fast provider selected but Azure settings are missing.");
    return new AzureFastProvider(
      config.azure.endpoint,
      config.azure.apiKey,
      config.azure.apiVersion,
      fast.model,
      fast.temperature
    );
  }

  if (!config.bedrock) throw new Error("Bedrock fast provider selected but Bedrock settings are missing.");
  return new BedrockFastProvider(config.bedrock.region, fast.model, fast.temperature);
}

function buildDeepProvider(config: RuntimeProviderConfig): DeepModelProvider {
  const deep = config.deep;

  if (deep.provider === "mock") return new MockDeepProvider();

  if (deep.provider === "ollama") {
    return new OllamaDeepProvider(config.ollama?.baseUrl ?? "http://localhost:11434", deep.model, deep.temperature);
  }

  if (deep.provider === "azure") {
    if (!config.azure) throw new Error("Azure deep provider selected but Azure settings are missing.");
    return new AzureDeepProvider(
      config.azure.endpoint,
      config.azure.apiKey,
      config.azure.apiVersion,
      deep.model,
      deep.temperature
    );
  }

  if (!config.bedrock) throw new Error("Bedrock deep provider selected but Bedrock settings are missing.");
  return new BedrockDeepProvider(config.bedrock.region, deep.model, deep.temperature);
}

export function buildProviderPair(config: RuntimeProviderConfig): ProviderPair {
  return {
    fastProvider: buildFastProvider(config),
    deepProvider: buildDeepProvider(config)
  };
}
