import { parseStrictPositiveIntEnv } from "./runtimeEnv";

export interface DiscoveryConfig {
  intervalMs: number;
  ttlMs: number;
  timeoutMs: number;
  maxConcurrentRequests: number;
}

export function loadDiscoveryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  return {
    intervalMs: parseStrictPositiveIntEnv(
      env.MODEL_DISCOVERY_INTERVAL_MS,
      "MODEL_DISCOVERY_INTERVAL_MS",
      300_000
    ),
    ttlMs: parseStrictPositiveIntEnv(env.MODEL_DISCOVERY_TTL_MS, "MODEL_DISCOVERY_TTL_MS", 600_000),
    timeoutMs: parseStrictPositiveIntEnv(
      env.MODEL_DISCOVERY_TIMEOUT_MS,
      "MODEL_DISCOVERY_TIMEOUT_MS",
      10_000
    ),
    maxConcurrentRequests: 4
  };
}
