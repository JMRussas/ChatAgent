import { parseStrictPositiveIntEnv } from "./runtimeEnv";

export const DEFAULT_MAX_BODY_BYTES = 1048576;
const MAX_BODY_BYTES_CEILING = 16777216;
const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "::1", "localhost"];
const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export interface HttpBoundaryConfig {
  host: string;
  maxBodyBytes: number;
}

/**
 * The only supported deployment is local: the listener binds a loopback
 * address. A nonlocal bind is refused rather than warned about, because the
 * server has no authentication and identities are self-asserted in JSON.
 */
export function loadHttpBoundaryConfig(env: NodeJS.ProcessEnv = process.env): HttpBoundaryConfig {
  const host = env.BIND_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_BIND_HOSTS.includes(host))
    throw new Error(
      `BIND_HOST must be one of ${LOOPBACK_BIND_HOSTS.join(", ")}; got "${host}". Nonlocal deployment is not supported: this server has no authentication.`
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
  return { host, maxBodyBytes };
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
