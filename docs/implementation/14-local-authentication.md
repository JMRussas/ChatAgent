# 14 — Local authentication core

Date: 2026-10-06. Status: core implemented, **not activated**. No HTTP route, page,
client or sidecar uses it yet, and the running server's local boundary is unchanged.
This is roadmap step 2 work toward authenticated ownership; it does not complete
step 2 and claims no cross-user ownership.

## Model

Local mode has exactly one trusted principal: the installation. The user approved
a local-first design whose principal seam can later be backed by a shared login
provider. Distinct humans on one host are not separated: any process running as
the same OS user can read the identity file and act as that user.

- `src/auth/localIdentity.ts` stores `{version, principalId, sessionKey,
clientToken, operatorToken, epoch}` in a dedicated directory. The default is
  `%LOCALAPPDATA%/ChatAgent` on Windows or `$XDG_STATE_HOME/chatagent` elsewhere;
  `CHAT_IDENTITY_DIR` overrides it. The principal id is created once and never
  changes; rotation replaces the authenticators and increments `epoch`.
- `src/auth/authenticator.ts` defines `Authenticator.resolve(credentials)`, which
  returns a `Principal {principalId, roles, via}` or nothing.
  - The client bearer token grants `client`.
  - The operator token and a paired browser session (the installation owner)
    grant `client` and `operator`.
  - Each resolution returns its own role set.
- `ownerKey(principalId, namespace)` is the canonical owner key: a JSON array, so
  labels such as userId, accountId and projectId cannot collide by concatenation.
  It is not wired into ownership yet.

## File privacy

Secrets are written only into a directory that is already private, and only after
the file itself is private. Privacy is proven by reading the permissions back,
never assumed from a requested mode.

- **Windows.** The ACL is read by SID through .NET (Access and Owner sections
  only), never by parsing localized `icacls` names. It passes only when all of
  these hold:
  - the owner is the current user;
  - inheritance is off and no rule is inherited;
  - every Allow rule names the current user, SYSTEM (`S-1-5-18`) or
    Administrators (`S-1-5-32-544`);
  - the current user has full control.

  Protecting an entry removes inherited and explicit rules before granting that
  allowlist.

- **POSIX.** Owned by the current uid, with no group or other bits.
- **Both.** Links and junctions, wrong entry kinds and paths that resolve
  elsewhere are refused.
- **Failing closed.** An existing directory or file that is not private, or an
  identity file that does not match the strict format, stops startup with the
  path named. It is never repaired or regenerated, because widened permissions
  may already have exposed it.
- **First creation.** The directory is protected under a temporary name and
  renamed into place. The file is published by hard link, which fails if another
  initializer won, so concurrent first starts agree on one identity.

## Sessions

A session token is `base64url(payload).base64url(HMAC-SHA256(sessionKey, payload))`:

- The signature is checked in constant time before the payload is parsed.
- Only the canonical encoding is accepted.
- The payload is strict: `{v:1, sid, pid, ep, iat, exp}`.
- It is rejected when `pid` or `ep` differs from the current identity, when it is
  expired, when `iat` is more than 60 s in the future, or when it is valid for
  more than 30 days.
- There is no session map. The only state is the current identity.

## Rotation

`rotateIdentity` replaces the authenticators and keeps the principal id, so
ownership is unaffected.

- Rotations are serialized by an exclusive lock file. A lock left by a crash is
  reported, never broken automatically.
- Rotation refuses to pass the largest safe epoch, leaving the file unchanged.
- A running server is not affected until it is given the new identity
  (`LocalAuthenticator.useIdentity`, intended for a later operator endpoint) or
  restarted. Rotation alone does not revoke sessions in a running server.

## For the HTTP activation slice (not implemented)

- Cookies are scoped by host, not port: `HttpOnly` and `SameSite` do not isolate
  other local applications on the same host.
- Cookie-authenticated mutations need exact `Origin` validation. The current
  boundary accepts requests with no `Origin` for local tools, and that trust must
  stay limited to bearer tokens.
- Pairing codes travel in a request body, never a URL. Failed attempts do not
  automatically issue a new code; re-issue is an owner-controlled action.
- Dead-letter and other operator views omit prompts and conversation identity by
  default.
- Existing durable document-task owners are preserved unchanged; adopting them is
  a later, explicit step.
- The development agent-bridge credentials are never read by ChatAgent code.
