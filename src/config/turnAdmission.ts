import { parseStrictPositiveIntEnv } from "./runtimeEnv";

export const DEFAULT_MAX_CONCURRENT_TURNS = 8;
const MAX_CONCURRENT_TURNS_CEILING = 1000;

export interface TurnAdmissionConfig {
  /** Turns the runtime will run at once; a further submission is refused, never queued. */
  maxConcurrentTurns: number;
}

/**
 * Admission limit on concurrent turns (inventory finding 1). Before it, in-flight
 * requests, live turns, inline retrieval and reservations were limited only by
 * request arrival and per-call timeouts.
 */
export function loadTurnAdmissionConfig(env: NodeJS.ProcessEnv = process.env): TurnAdmissionConfig {
  const maxConcurrentTurns = parseStrictPositiveIntEnv(
    env.CHAT_MAX_CONCURRENT_TURNS,
    "CHAT_MAX_CONCURRENT_TURNS",
    DEFAULT_MAX_CONCURRENT_TURNS
  );
  if (maxConcurrentTurns > MAX_CONCURRENT_TURNS_CEILING)
    throw new Error(
      `CHAT_MAX_CONCURRENT_TURNS must be at most ${MAX_CONCURRENT_TURNS_CEILING}; got "${env.CHAT_MAX_CONCURRENT_TURNS}".`
    );
  return { maxConcurrentTurns };
}

/** Validates an explicit limit the same way the environment value is validated. */
export function assertConcurrentTurnLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CONCURRENT_TURNS_CEILING)
    throw new Error(
      `maxConcurrentTurns must be an integer from 1 to ${MAX_CONCURRENT_TURNS_CEILING}; got ${String(value)}.`
    );
  return value;
}
