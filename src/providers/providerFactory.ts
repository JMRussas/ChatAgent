import type { VerifiedThinking } from "../config/thinkingConfig";
import { loadContextBudgetConfigFromEnv, type ContextBudgetConfig } from "../config/contextConfig";
import type { RuntimeProviderConfig } from "../config/providerConfig";
import { parsePositiveIntEnv } from "../config/runtimeEnv";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";
import { AzureDeepProvider, AzureFastProvider } from "./azureProviders";
import {
  AZURE_DEFAULT_TIMEOUT_MS,
  BEDROCK_DEFAULT_TIMEOUT_MS,
  type ProviderTimeouts
} from "../config/providerConfig";
import { assertProviderTimeoutMs } from "../config/runtimeEnv";
import { BedrockDeepProvider, BedrockFastProvider } from "./bedrockProviders";
import { MockDeepProvider, MockFastProvider } from "./mockProviders";
import { OllamaDeepProvider, OllamaFastProvider } from "./ollamaProviders";

interface ProviderPair {
  fastProvider: FastModelProvider;
  deepProvider: DeepModelProvider;
}

/** A role's deadline from validated settings; hand-built values are checked too. */
function roleTimeout(
  settings: ProviderTimeouts,
  role: "fast" | "deep",
  fallback: number,
  provider: string
) {
  const value = role === "fast" ? settings.fastTimeoutMs : settings.deepTimeoutMs;
  return value === undefined
    ? fallback
    : assertProviderTimeoutMs(value, `${provider}.${role}TimeoutMs`);
}

function resolveOllamaFastTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_FAST_TIMEOUT_MS, 10_000, 500, 120_000);
}

function resolveOllamaDeepTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.OLLAMA_DEEP_TIMEOUT_MS, 10_000, 500, 240_000);
}

export function buildFastProvider(
  config: RuntimeProviderConfig,
  contextBudget: ContextBudgetConfig,
  thinking: VerifiedThinking
): FastModelProvider {
  const fast = config.fast;

  if (fast.provider === "mock") return new MockFastProvider();

  if (fast.provider === "ollama") {
    return new OllamaFastProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      fast.model,
      fast.temperature,
      resolveOllamaFastTimeoutMs(),
      contextBudget.fastOutputTokens,
      thinking.fast
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
      roleTimeout(config.azure, "fast", AZURE_DEFAULT_TIMEOUT_MS, "azure"),
      contextBudget.fastOutputTokens
    );
  }

  if (!config.bedrock) {
    throw new Error(
      "CHAT_FAST_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example)."
    );
  }
  return new BedrockFastProvider(
    config.bedrock.region,
    fast.model,
    fast.temperature,
    contextBudget.fastOutputTokens,
    roleTimeout(config.bedrock, "fast", BEDROCK_DEFAULT_TIMEOUT_MS, "bedrock")
  );
}

export function buildDeepProvider(
  config: RuntimeProviderConfig,
  contextBudget: ContextBudgetConfig,
  thinking: VerifiedThinking
): DeepModelProvider {
  const deep = config.deep;

  if (deep.provider === "mock") return new MockDeepProvider();

  if (deep.provider === "ollama") {
    return new OllamaDeepProvider(
      config.ollama?.baseUrl ?? "http://localhost:11434",
      deep.model,
      deep.temperature,
      resolveOllamaDeepTimeoutMs(),
      contextBudget.deepOutputTokens,
      thinking.deep
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
      roleTimeout(config.azure, "deep", AZURE_DEFAULT_TIMEOUT_MS, "azure"),
      contextBudget.deepOutputTokens
    );
  }

  if (!config.bedrock) {
    throw new Error(
      "CHAT_DEEP_PROVIDER=bedrock requires BEDROCK_REGION to be set (see .env.example)."
    );
  }
  return new BedrockDeepProvider(
    config.bedrock.region,
    deep.model,
    deep.temperature,
    contextBudget.deepOutputTokens,
    roleTimeout(config.bedrock, "deep", BEDROCK_DEFAULT_TIMEOUT_MS, "bedrock")
  );
}

export function buildProviderPair(
  config: RuntimeProviderConfig,
  contextBudget: ContextBudgetConfig = loadContextBudgetConfigFromEnv({
    ...process.env,
    CHAT_FAST_PROVIDER: config.fast.provider,
    CHAT_DEEP_PROVIDER: config.deep.provider
  }),
  thinking: VerifiedThinking = {}
): ProviderPair {
  return {
    fastProvider: buildFastProvider(config, contextBudget, thinking),
    deepProvider: buildDeepProvider(config, contextBudget, thinking)
  };
}
