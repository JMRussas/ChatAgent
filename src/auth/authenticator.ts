import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { localIdentitySchema, type LocalIdentity } from "./localIdentity";

export type Role = "client" | "operator";

/** Who is acting, as established by the server. Request bodies never supply it. */
export interface Principal {
  principalId: string;
  roles: ReadonlySet<Role>;
  via: "session" | "bearer";
}

/** The credentials a request presented; decoupled from the HTTP request type. */
export interface Credentials {
  authorization?: string;
  sessionToken?: string;
}

/** Pluggable: a later shared deployment resolves principals from its own provider. */
export interface Authenticator {
  resolve(credentials: Credentials): Principal | undefined;
}

export const SESSION_MAX_AGE_SECONDS = 30 * 86400;
const CLOCK_SKEW_SECONDS = 60;
const MAX_SESSION_TOKEN_LENGTH = 512;

const base64url = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));

const sessionPayloadSchema = z
  .object({
    v: z.literal(1),
    sid: base64url(16),
    pid: z.string().min(1).max(200),
    ep: z.number().int().min(0),
    iat: z.number().int().min(0),
    exp: z.number().int().min(0)
  })
  .strict();

/**
 * A validated, frozen copy: a caller that later changes its object cannot swap the
 * key, principal or epoch behind the authenticator.
 */
function snapshot(identity: LocalIdentity): LocalIdentity {
  return Object.freeze(localIdentitySchema.parse(structuredClone(identity)));
}

/** Constant-time comparison; unequal lengths compare a same-length dummy first. */
function sameSecret(presented: string, expected: string) {
  const a = Buffer.from(presented),
    b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// A fresh set per resolution: a caller mutating one cannot change another's roles.
const client = (): ReadonlySet<Role> => new Set<Role>(["client"]);
const owner = (): ReadonlySet<Role> => new Set<Role>(["client", "operator"]);

/**
 * The single installation principal. Bearer client tokens grant client access only;
 * the operator token and a paired browser session (the installation owner) grant
 * both roles. State is only the current identity; there is no session map.
 */
export class LocalAuthenticator implements Authenticator {
  private identity: LocalIdentity;

  constructor(
    identity: LocalIdentity,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.identity = snapshot(identity);
  }

  /** Atomically replaces the authenticators, for example after rotation. */
  useIdentity(identity: LocalIdentity) {
    const next = snapshot(identity);
    if (next.principalId !== this.identity.principalId) throw new Error("LOCAL_PRINCIPAL_CHANGED");
    this.identity = next;
  }

  get principalId() {
    return this.identity.principalId;
  }

  resolve(credentials: Credentials): Principal | undefined {
    const identity = this.identity;
    if (credentials.authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(credentials.authorization);
      if (!match) return undefined;
      // Both comparisons always run, so timing does not reveal which token matched.
      const isOperator = sameSecret(match[1], identity.operatorToken);
      const isClient = sameSecret(match[1], identity.clientToken);
      if (isOperator) return { principalId: identity.principalId, roles: owner(), via: "bearer" };
      if (isClient) return { principalId: identity.principalId, roles: client(), via: "bearer" };
      return undefined;
    }
    if (credentials.sessionToken !== undefined)
      return this.verifySession(identity, credentials.sessionToken);
    return undefined;
  }

  /** Issues a signed session for a browser that completed pairing. */
  issueSession(): string {
    const iat = this.now();
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        sid: randomBytes(16).toString("base64url"),
        pid: this.identity.principalId,
        ep: this.identity.epoch,
        iat,
        exp: iat + SESSION_MAX_AGE_SECONDS
      })
    );
    return `${payload.toString("base64url")}.${this.mac(this.identity, payload)}`;
  }

  private mac(identity: LocalIdentity, payload: Buffer) {
    return createHmac("sha256", Buffer.from(identity.sessionKey, "base64url"))
      .update(payload)
      .digest("base64url");
  }

  private verifySession(identity: LocalIdentity, token: string): Principal | undefined {
    if (token.length > MAX_SESSION_TOKEN_LENGTH) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return undefined;
    const payload = Buffer.from(parts[0], "base64url");
    // Only the canonical encoding is accepted, so one payload has one token form.
    if (payload.toString("base64url") !== parts[0]) return undefined;
    // The signature is checked before the payload is parsed.
    if (!sameSecret(parts[1], this.mac(identity, payload))) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf8"));
    } catch {
      return undefined;
    }
    const parsed = sessionPayloadSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const { pid, ep, iat, exp } = parsed.data;
    const now = this.now();
    if (
      pid !== identity.principalId ||
      ep !== identity.epoch ||
      iat > now + CLOCK_SKEW_SECONDS ||
      exp <= iat ||
      exp <= now ||
      exp - iat > SESSION_MAX_AGE_SECONDS
    )
      return undefined;
    return { principalId: identity.principalId, roles: owner(), via: "session" };
  }
}

/**
 * Canonical owner key: the verified principal plus a namespace of labels (userId,
 * accountId, projectId). JSON array encoding keeps it unambiguous for any label.
 */
export function ownerKey(principalId: string, namespace: readonly string[]) {
  return JSON.stringify([principalId, ...namespace]);
}
