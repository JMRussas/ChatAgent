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

  const modelRaw = process.env[`${prefix}_MODEL`];

  // Fail fast on a missing model rather than silently sending a placeholder
  // model name to a real provider. "mock" is exempt because it never makes
  // an external call.
  if (provider !== "mock" && !modelRaw) {
    throw new Error(
      `${prefix}_MODEL is required when ${prefix}_PROVIDER=${provider}. Set it in your environment or .env file.`
    );
  }

  return providerConfigSchema.parse({
    provider,
    model: modelRaw ?? "mock-v1",
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

/**
 * A safe, secret-free one-line summary of the active provider configuration,
 * suitable for startup logs. Deliberately excludes AZURE_OPENAI_API_KEY (and
 * anything else that could be a credential) so this can always be logged
 * without redaction risk. Endpoints/base URLs and region names are included
 * since they are not secrets.
 */
export function describeProviderConfig(config: RuntimeProviderConfig): string {
  const parts = [
    `fast=${config.fast.provider}/${config.fast.model}`,
    `deep=${config.deep.provider}/${config.deep.model}`
  ];

  if (config.azure) {
    parts.push(`azure_endpoint=${config.azure.endpoint}`);
  }

  if (config.bedrock) {
    parts.push(`bedrock_region=${config.bedrock.region}`);
  }

  if (config.ollama) {
    parts.push(`ollama_base_url=${config.ollama.baseUrl}`);
  }

  return parts.join(" ");
}
