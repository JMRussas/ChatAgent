import { z } from "zod";

export const providerKindSchema = z.enum(["mock", "azure", "bedrock", "ollama"]);

export type ProviderKind = z.infer<typeof providerKindSchema>;

const providerConfigSchema = z.object({
  provider: providerKindSchema,
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2)
});

export interface AzureProviderSettings {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
}

export interface BedrockProviderSettings {
  region: string;
}

export interface OllamaProviderSettings {
  baseUrl: string;
}

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export interface RuntimeProviderConfig {
  fast: ProviderConfig;
  deep: ProviderConfig;
  azure?: AzureProviderSettings;
  bedrock?: BedrockProviderSettings;
  ollama?: OllamaProviderSettings;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readProviderConfigFromPrefix(prefix: "CHAT_FAST" | "CHAT_DEEP"): ProviderConfig {
  const providerRaw = process.env[`${prefix}_PROVIDER`] ?? "mock";
  const provider = providerKindSchema.parse(providerRaw);

  const modelDefault = provider === "mock" ? "mock-v1" : "unset-model";

  return providerConfigSchema.parse({
    provider,
    model: process.env[`${prefix}_MODEL`] ?? modelDefault,
    temperature: toNumber(process.env[`${prefix}_TEMPERATURE`], 0.2)
  });
}

export function loadRuntimeProviderConfigFromEnv(): RuntimeProviderConfig {
  const fast = readProviderConfigFromPrefix("CHAT_FAST");
  const deep = readProviderConfigFromPrefix("CHAT_DEEP");

  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureApiKey = process.env.AZURE_OPENAI_API_KEY;

  const azure =
    azureEndpoint && azureApiKey
      ? {
          endpoint: azureEndpoint,
          apiKey: azureApiKey,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21"
        }
      : undefined;

  const bedrock = process.env.BEDROCK_REGION
    ? {
        region: process.env.BEDROCK_REGION
      }
    : undefined;

  const ollama = {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  };

  return {
    fast,
    deep,
    azure,
    bedrock,
    ollama
  };
}
