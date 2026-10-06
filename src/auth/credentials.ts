import type { Credentials } from "./authenticator";

export const SESSION_COOKIE = "ca_session";
const MAX_AUTHORIZATION_LENGTH = 256;
const MAX_COOKIE_HEADER_LENGTH = 8192;

/**
 * Every received value of each header, as Node's `IncomingMessage.headersDistinct`
 * provides. The plain `headers` object cannot be used: Node keeps only the first
 * of a repeated Authorization or Host header, hiding the repetition.
 */
export type DistinctHeaders = Readonly<Record<string, readonly string[] | undefined>>;

/**
 * The credentials a request presented. Anything ambiguous yields no usable
 * credential rather than a guess: a repeated or over-long Authorization header, an
 * over-long Cookie header, or a session cookie that is repeated or malformed.
 */
export function extractCredentials(headers: DistinctHeaders): Credentials {
  const credentials: Credentials = {};
  const authorization = headers.authorization;
  if (authorization !== undefined)
    // Present but unusable still counts as presented, so it cannot fall back to a cookie.
    credentials.authorization =
      authorization.length === 1 && authorization[0].length <= MAX_AUTHORIZATION_LENGTH
        ? authorization[0]
        : "";
  const session = sessionCookie(headers.cookie);
  if (session !== undefined) credentials.sessionToken = session;
  return credentials;
}

function sessionCookie(values: readonly string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  const header = values.join("; ");
  if (header.length > MAX_COOKIE_HEADER_LENGTH) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name !== SESSION_COOKIE) continue;
    // A bare name, an empty value or a second occurrence (for example one set for
    // another path) makes the session cookie ambiguous: none is used.
    const value = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (found !== undefined || !value) return undefined;
    found = value;
  }
  return found;
}

export type OriginCheck = "same-origin" | "missing" | "mismatch";

/**
 * Exact same-origin check for cookie-authenticated or bootstrap requests: exactly
 * one Origin, exactly one Host, and Origin equal to http://<Host>. A missing Origin
 * is reported, not trusted.
 */
export function checkExactOrigin(headers: DistinctHeaders): OriginCheck {
  const origin = headers.origin;
  if (origin === undefined) return "missing";
  const host = headers.host;
  if (origin.length !== 1 || host?.length !== 1 || origin[0] !== `http://${host[0]}`)
    return "mismatch";
  return "same-origin";
}
