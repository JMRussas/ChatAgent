import { parseStrictPositiveIntEnv } from "./runtimeEnv";

// Manual local-use choices, not measurements: enough for a few browser tabs and
// protocol clients, and a stall window longer than an ordinary slow network pause.
export const DEFAULT_MAX_EVENT_STREAMS = 32;
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 30_000;
const MAX_EVENT_STREAMS_CEILING = 1000;
const MIN_STALL_TIMEOUT_MS = 1000;
const MAX_STALL_TIMEOUT_MS = 600_000;

export interface StreamAdmissionConfig {
  /** Open event streams across the legacy and protocol v1 routes; a further one is refused. */
  maxEventStreams: number;
  /** How long a stream may stay unable to accept writes before its connection is closed. */
  streamStallTimeoutMs: number;
}

/** Limits on event streams (inventory finding 4). */
export function loadStreamAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env
): StreamAdmissionConfig {
  const maxEventStreams = parseStrictPositiveIntEnv(
    env.HTTP_MAX_EVENT_STREAMS,
    "HTTP_MAX_EVENT_STREAMS",
    DEFAULT_MAX_EVENT_STREAMS
  );
  if (maxEventStreams > MAX_EVENT_STREAMS_CEILING)
    throw new Error(
      `HTTP_MAX_EVENT_STREAMS must be at most ${MAX_EVENT_STREAMS_CEILING}; got "${env.HTTP_MAX_EVENT_STREAMS}".`
    );
  const streamStallTimeoutMs = parseStrictPositiveIntEnv(
    env.HTTP_STREAM_STALL_TIMEOUT_MS,
    "HTTP_STREAM_STALL_TIMEOUT_MS",
    DEFAULT_STREAM_STALL_TIMEOUT_MS
  );
  if (streamStallTimeoutMs < MIN_STALL_TIMEOUT_MS || streamStallTimeoutMs > MAX_STALL_TIMEOUT_MS)
    throw new Error(
      `HTTP_STREAM_STALL_TIMEOUT_MS must be from ${MIN_STALL_TIMEOUT_MS} to ${MAX_STALL_TIMEOUT_MS}; got "${env.HTTP_STREAM_STALL_TIMEOUT_MS}".`
    );
  return { maxEventStreams, streamStallTimeoutMs };
}

/** Validates explicit limits the same way the environment values are validated. */
export function assertStreamAdmission(value: StreamAdmissionConfig): StreamAdmissionConfig {
  const { maxEventStreams, streamStallTimeoutMs } = value;
  if (
    !Number.isInteger(maxEventStreams) ||
    maxEventStreams <= 0 ||
    maxEventStreams > MAX_EVENT_STREAMS_CEILING
  )
    throw new Error(
      `maxEventStreams must be an integer from 1 to ${MAX_EVENT_STREAMS_CEILING}; got ${String(maxEventStreams)}.`
    );
  if (
    !Number.isInteger(streamStallTimeoutMs) ||
    streamStallTimeoutMs < MIN_STALL_TIMEOUT_MS ||
    streamStallTimeoutMs > MAX_STALL_TIMEOUT_MS
  )
    throw new Error(
      `streamStallTimeoutMs must be an integer from ${MIN_STALL_TIMEOUT_MS} to ${MAX_STALL_TIMEOUT_MS}; got ${String(streamStallTimeoutMs)}.`
    );
  return { maxEventStreams, streamStallTimeoutMs };
}
