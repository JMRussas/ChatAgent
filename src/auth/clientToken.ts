import type { Role } from "./authenticator";
import { defaultIdentityDir, loadIdentity } from "./localIdentity";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class UnsafeDestinationError extends Error {
  readonly code = "UNSAFE_CREDENTIAL_DESTINATION";
}

/**
 * The installation's tokens only ever go to this machine's own server: plain HTTP to
 * a loopback host, with no user information in the URL. Checked before the identity
 * is read, so a remote URL from configuration never sees a credential.
 */
export function assertLocalDestination(baseUrl: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UnsafeDestinationError(`"${baseUrl}" is not a valid URL.`);
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    url.username ||
    url.password
  )
    throw new UnsafeDestinationError(
      "Local credentials are only sent to http://localhost, http://127.0.0.1 or http://[::1] without user information in the URL."
    );
}

/**
 * Authorization header for a local client of a running server (benchmarks,
 * evaluations). It loads the existing identity through the privacy checks and never
 * creates one. Callers ask for the least privilege they need: "client" unless they
 * call operator routes.
 */
export async function clientAuthHeaders(
  baseUrl: string,
  role: Role = "client",
  dir = defaultIdentityDir()
) {
  assertLocalDestination(baseUrl);
  const identity = await loadIdentity(dir);
  return {
    authorization: `Bearer ${role === "operator" ? identity.operatorToken : identity.clientToken}`
  };
}
