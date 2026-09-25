import type { ContextBudgetConfig } from "../config/contextConfig";
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

// OLLAMA_*_NUM_PREDICT stays authoritative when explicitly set (backward
// compatibility, spec 01 budget policy); otherwise the shared output budget applies.
function resolveOllamaFastNumPredict(contextBudget: ContextBudgetConfig): number {
  if (process.env.OLLAMA_FAST_NUM_PREDICT !== undefined) {
    return parsePositiveIntEnv(process.env.OLLAMA_FAST_NUM_PREDICT, 384, 32, 4096);
  }
  return contextBudget.fastOutputTokens;
}

function resolveOllamaDeepNumPredict(contextBudget: ContextBudgetConfig): number {
  if (process.env.OLLAMA_DEEP_NUM_PREDICT !== undefined) {
    return parsePositiveIntEnv(process.env.OLLAMA_DEEP_NUM_PREDICT, 768, 64, 8192);
  }
  return contextBudget.deepOutputTokens;
}

function buildFastProvider(config: RuntimeProviderConfig, contextBudget: ContextBudgetConfig): FastModelProvider {
  const fast = config.fast;

  if (fast.provider === "mock") return new MockFastProvider();

  if (fast.provider === "ollama") {
    return new OllamaFastProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      fast.model,
      fast.temperature,
      resolveOllamaFastTimeoutMs(),
      resolveOllamaFastNumPredict(contextBudget)
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
      fast.temperature,
      10_000,
      contextBudget.fastOutputTokens
    );
  }

  if (!config.bedrock) {
    throw new Error("CHAT_FAST_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example).");
  }
  return new BedrockFastProvider(config.bedrock.region, fast.model, fast.temperature, contextBudget.fastOutputTokens);
}

function buildDeepProvider(config: RuntimeProviderConfig, contextBudget: ContextBudgetConfig): DeepModelProvider {
  const deep = config.deep;

  if (deep.provider === "mock") return new MockDeepProvider();

  if (deep.provider === "ollama") {
    return new OllamaDeepProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      deep.model,
      deep.temperature,
      resolveOllamaDeepTimeoutMs(),
      resolveOllamaDeepNumPredict(contextBudget)
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
      deep.temperature,
      10_000,
      contextBudget.deepOutputTokens
    );
  }

  if (!config.bedrock) {
    throw new Error("CHAT_DEEP_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example).");
  }
  return new BedrockDeepProvider(config.bedrock.region, deep.model, deep.temperature, contextBudget.deepOutputTokens);
}

// Matches the documented defaults in contextConfig.ts / .env.example so callers
// that predate spec 01 (and existing tests) keep working without passing one.
const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  windowTokens: 8192,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 2048
};

export function buildProviderPair(config: RuntimeProviderConfig, contextBudget: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET): ProviderPair {
  return {
    fastProvider: buildFastProvider(config, contextBudget),
    deepProvider: buildDeepProvider(config, contextBudget)
  };
}
