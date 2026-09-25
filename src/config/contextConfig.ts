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

export function loadContextBudgetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ContextBudgetConfig {
  const windowTokens = parseStrictPositiveIntEnv(env.CONTEXT_WINDOW_TOKENS, "CONTEXT_WINDOW_TOKENS", 8192);
  const maxHistoryTurns = parseStrictPositiveIntEnv(env.CONTEXT_MAX_HISTORY_TURNS, "CONTEXT_MAX_HISTORY_TURNS", 12);
  const safetyTokens = parseStrictNonNegativeIntEnv(env.CONTEXT_SAFETY_TOKENS, "CONTEXT_SAFETY_TOKENS", 256);
  const fastOutputTokens = parseStrictPositiveIntEnv(env.CHAT_FAST_MAX_OUTPUT_TOKENS, "CHAT_FAST_MAX_OUTPUT_TOKENS", 512);
  const deepOutputTokens = parseStrictPositiveIntEnv(env.CHAT_DEEP_MAX_OUTPUT_TOKENS, "CHAT_DEEP_MAX_OUTPUT_TOKENS", 2048);

  const outputReserve = Math.max(fastOutputTokens, deepOutputTokens);
  if (outputReserve + safetyTokens >= windowTokens) {
    throw new Error(
      `Context budget misconfigured: CONTEXT_WINDOW_TOKENS (${windowTokens}) leaves no room for input after ` +
        `reserving the larger of CHAT_FAST_MAX_OUTPUT_TOKENS/CHAT_DEEP_MAX_OUTPUT_TOKENS (${outputReserve}) ` +
        `plus CONTEXT_SAFETY_TOKENS (${safetyTokens}). Increase CONTEXT_WINDOW_TOKENS or lower the others.`
    );
  }

  return { windowTokens, maxHistoryTurns, safetyTokens, fastOutputTokens, deepOutputTokens };
}
