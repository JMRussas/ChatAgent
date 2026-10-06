import { randomBytes, randomUUID } from "node:crypto";
import { LocalAuthenticator, type Role } from "./authenticator";
import type { LocalIdentity } from "./localIdentity";

/**
 * An in-memory identity for servers a benchmark or evaluation builds inside its own
 * process. Nothing is written to disk and nothing outlives the process; the server
 * still enforces authentication, and the caller sends the matching bearer token.
 */
export function createEphemeralAuth() {
  const secret = () => randomBytes(32).toString("base64url");
  const identity: LocalIdentity = {
    version: 1,
    principalId: `local:${randomUUID()}`,
    sessionKey: secret(),
    clientToken: secret(),
    operatorToken: secret(),
    epoch: 0
  };
  let current = identity;
  const auth = new LocalAuthenticator(identity);
  return {
    auth,
    /** New authenticators for the same principal; earlier sessions and tokens stop working. */
    rotate: () => {
      current = {
        ...current,
        sessionKey: secret(),
        clientToken: secret(),
        operatorToken: secret(),
        epoch: current.epoch + 1
      };
      auth.useIdentity(current);
    },
    /** Authorization header for the least privilege a caller needs. */
    headers: (role: Role = "client") => ({
      authorization: `Bearer ${role === "operator" ? current.operatorToken : current.clientToken}`
    }),
    issueSession: () => auth.issueSession()
  };
}
