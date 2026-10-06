import { parseStrictPositiveIntEnv } from "./runtimeEnv";

export const DEFAULT_MAX_BODY_BYTES = 1048576;
const MAX_BODY_BYTES_CEILING = 16777216;
// A manual local-use choice, not a measurement: room for several browser tabs,
// their event streams and local protocol clients at once.
export const DEFAULT_MAX_CONNECTIONS = 128;
const MAX_CONNECTIONS_CEILING = 4096;
const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "::1", "localhost"];
const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export interface HttpBoundaryConfig {
  host: string;
  maxBodyBytes: number;
  /** Open TCP connections to this server; Node closes a further one before HTTP. */
  maxConnections: number;
}

/**
 * The only supported deployment is local: one server process listening on a
 * loopback address. A nonlocal bind is refused rather than warned about, because
 * the authentication, Host and Origin checks are designed for one local machine
 * (docs/implementation/14-local-authentication.md), not for a shared network.
 */
export function loadHttpBoundaryConfig(env: NodeJS.ProcessEnv = process.env): HttpBoundaryConfig {
  const host = env.BIND_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_BIND_HOSTS.includes(host))
    throw new Error(
      `BIND_HOST must be one of ${LOOPBACK_BIND_HOSTS.join(", ")}; got "${host}". Nonlocal deployment is not supported: authentication and the Host and Origin checks are designed for one local machine.`
    );
  const maxBodyBytes = parseStrictPositiveIntEnv(
    env.HTTP_MAX_BODY_BYTES,
    "HTTP_MAX_BODY_BYTES",
    DEFAULT_MAX_BODY_BYTES
  );
  if (maxBodyBytes > MAX_BODY_BYTES_CEILING)
    throw new Error(
      `HTTP_MAX_BODY_BYTES must be at most ${MAX_BODY_BYTES_CEILING}; got "${env.HTTP_MAX_BODY_BYTES}".`
    );
  const raw = env.HTTP_MAX_CONNECTIONS;
  // Decimal digits only; only an unset value takes the default.
  if (raw !== undefined && !/^[0-9]+$/.test(raw))
    throw new Error(
      `HTTP_MAX_CONNECTIONS must be an integer from 1 to ${MAX_CONNECTIONS_CEILING}; got "${raw}".`
    );
  const maxConnections = assertMaxConnections(
    raw === undefined ? DEFAULT_MAX_CONNECTIONS : Number(raw),
    "HTTP_MAX_CONNECTIONS"
  );
  return { host, maxBodyBytes, maxConnections };
}

/**
 * Validates a connection limit, from the environment or passed directly to
 * createChatServer: a whole number from 1 to the ceiling, nothing else.
 */
export function assertMaxConnections(value: unknown, name = "maxConnections"): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CONNECTIONS_CEILING
  )
    throw new Error(
      `${name} must be an integer from 1 to ${MAX_CONNECTIONS_CEILING}; got ${JSON.stringify(String(value))}.`
    );
  return value;
}

export type BoundaryRejection = "HOST_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED";

/**
 * Local-mode request policy. The Host check stops a rebound DNS name from
 * reaching the loopback listener; the Origin check stops another site (or
 * another local web app) open in the same browser from driving it. Clients
 * that send no Origin are local processes, which local mode trusts.
 *
 * Pass every received value (Node's `headersDistinct`): Node keeps only the first
 * of a repeated Host header, so a repeated Host or Origin is refused here.
 */
export function checkLocalRequest(headers: {
  host?: string | readonly string[];
  origin?: string | readonly string[];
}): BoundaryRejection | undefined {
  const one = (value: string | readonly string[] | undefined) =>
    typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
  const host = one(headers.host)?.toLowerCase();
  if (!host || !LOOPBACK_HOST_HEADER.test(host)) return "HOST_NOT_ALLOWED";
  if (headers.origin === undefined) return undefined;
  const origin = one(headers.origin);
  if (origin === undefined || origin.toLowerCase() !== `http://${host}`)
    return "ORIGIN_NOT_ALLOWED";
  return undefined;
}
