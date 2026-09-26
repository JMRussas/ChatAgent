import type { ModelCatalog } from "./modelCatalog";
import type { RuntimeProviderConfig } from "./providerConfig";
import { parseStrictNonNegativeIntEnv, parseStrictPositiveIntEnv } from "./runtimeEnv";

/**
 * Budget knobs for the shared conversation snapshot (spec 01). 8192 is an
 * application working limit chosen for this prototype, not a statement of
 * any particular model's real context window.
 */
export interface ContextBudgetConfig {
  windowTokens: number;
  maxHistoryTurns: number;
  safetyTokens: number;
  fastOutputTokens: number;
  deepOutputTokens: number;
}

export function loadContextBudgetConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  selection?: { config: RuntimeProviderConfig; catalog: ModelCatalog }
): ContextBudgetConfig {
  const applicationWindowTokens = parseStrictPositiveIntEnv(env.CONTEXT_WINDOW_TOKENS, "CONTEXT_WINDOW_TOKENS", 8192);
  // Match the actual fixed bindings, independently of catalog routing preferences.
  // Missing limits remain unknown; they do not increase the application allowance.
  const selectedWindows = selection ? (["fast", "deep"] as const).flatMap(role => {
    const binding = selection.config[role];
    const limit = selection.catalog.models.find(entry =>
      entry.provider === binding.provider && entry.model === binding.model)?.limits.contextTokens;
    return limit === undefined ? [] : [limit];
  }) : [];
  const windowTokens = Math.min(applicationWindowTokens, ...selectedWindows);
  const maxHistoryTurns = parseStrictPositiveIntEnv(env.CONTEXT_MAX_HISTORY_TURNS, "CONTEXT_MAX_HISTORY_TURNS", 12);
  const safetyTokens = parseStrictNonNegativeIntEnv(env.CONTEXT_SAFETY_TOKENS, "CONTEXT_SAFETY_TOKENS", 256);
  const configuredFastOutputTokens = parseStrictPositiveIntEnv(env.CHAT_FAST_MAX_OUTPUT_TOKENS, "CHAT_FAST_MAX_OUTPUT_TOKENS", 512);
  const configuredDeepOutputTokens = parseStrictPositiveIntEnv(env.CHAT_DEEP_MAX_OUTPUT_TOKENS, "CHAT_DEEP_MAX_OUTPUT_TOKENS", 2048);

  // Resolve transport overrides once; the same values feed budgeting and execution.
  const fastOutputTokens = env.CHAT_FAST_PROVIDER === "ollama" && env.OLLAMA_FAST_NUM_PREDICT !== undefined
    ? parseStrictPositiveIntEnv(env.OLLAMA_FAST_NUM_PREDICT, "OLLAMA_FAST_NUM_PREDICT", configuredFastOutputTokens)
    : configuredFastOutputTokens;
  const deepOutputTokens = env.CHAT_DEEP_PROVIDER === "ollama" && env.OLLAMA_DEEP_NUM_PREDICT !== undefined
    ? parseStrictPositiveIntEnv(env.OLLAMA_DEEP_NUM_PREDICT, "OLLAMA_DEEP_NUM_PREDICT", configuredDeepOutputTokens)
    : configuredDeepOutputTokens;

  const outputReserve = Math.max(fastOutputTokens, deepOutputTokens);
  if (outputReserve + safetyTokens >= windowTokens) {
    throw new Error(
      `Context budget misconfigured: effective context window (${windowTokens}; CONTEXT_WINDOW_TOKENS=${applicationWindowTokens}, selected catalog limits=${selectedWindows.join(",") || "unknown"}) leaves no room for input after ` +
        `reserving effective CHAT_*_MAX_OUTPUT_TOKENS (including OLLAMA_*_NUM_PREDICT overrides) (${outputReserve}) ` +
        `plus CONTEXT_SAFETY_TOKENS (${safetyTokens}). Lower output/safety reserves or configure a larger effective model/application window.`
    );
  }

  return { windowTokens, maxHistoryTurns, safetyTokens, fastOutputTokens, deepOutputTokens };
}
