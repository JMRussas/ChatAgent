# 14 — Local authentication core

Date: 2026-10-06. Status: **activated** for local mode: the source enforces it for
every newly started server, and no running service was restarted. Every request
passes the local boundary and the route policy before routing, protected routes
require the one installation principal, the page pairs
through `/pair`, and local commands send least-privilege bearer tokens. The
operator contract is in the runtime reference, under "Local authentication".
This is roadmap step 2 work toward authenticated ownership; it does not complete
step 2 and claims no cross-user ownership.

## Model

Local mode has exactly one trusted principal: the installation. The user approved
a local-first design whose principal seam can later be backed by a shared login
provider. Distinct humans on one host are not separated: any process running as
the same OS user can read the identity file and act as that user.

- `src/auth/localIdentity.ts` stores `{version, principalId, sessionKey,
clientToken, operatorToken, epoch}` in a dedicated directory. The default is
  `%LOCALAPPDATA%/ChatAgent` on Windows or `$XDG_STATE_HOME/chatagent` elsewhere
  (`~/.local/state/chatagent` when `XDG_STATE_HOME` is unset);
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

## Activation primitives

The server uses these on every request.

- `src/auth/pairing.ts`, `PairingController`:
  - One active code at a time: ten characters from a 32-symbol alphabet without
    I, L, O and U (50 bits), shown as `XXXXX-XXXXX`.
  - Single use, valid for ten minutes. The code is compared exactly, in constant
    time, against its displayed form.
  - Five wrong attempts discard it, and nothing re-issues automatically. Issuing
    is explicit and replaces any earlier code.
  - Expiry is computed from an injected clock, so no timer is kept. `clear()`
    forgets the code at shutdown.
- `src/auth/credentials.ts`:
  - Both helpers take Node's `headersDistinct`, never the plain `headers` object,
    because Node keeps only the first of a repeated `Authorization` or `Host`
    header and the repetition would otherwise be invisible.
  - `extractCredentials(headers)` reads one `Authorization` header and exactly one
    `ca_session` cookie. An over-long or repeated `Authorization` header yields an
    unusable credential, which prevents falling back to the cookie. Repeated
    `Cookie` headers are combined first. An over-long `Cookie` header, or a session
    cookie that is repeated, bare (no `=`) or empty, yields no session.
  - `checkExactOrigin(headers)` reports `same-origin` only when there is exactly
    one `Origin`, exactly one `Host`, and the Origin equals `http://<Host>`. A
    missing Origin is reported, not trusted.
- `src/auth/routePolicy.ts`:
  - `ROUTES` lists every route with an anchored pattern, so a parameter matches
    exactly one path segment. Literal routes win over parameterized ones.
  - `classifyRoute` returns the matching rule, or nothing (default deny).
  - `decideAccess` answers `401 UNAUTHENTICATED` to any unauthenticated request
    for a non-public or unknown route, so routes cannot be enumerated. An
    authenticated request for an unknown route gets `404`, and a client token on
    an operator route gets `403 OPERATOR_REQUIRED`.

### Route inventory (source, commit 2cecb5b)

There were 34 handlers at commit 2cecb5b. Activation added 4 routes: the pairing
page, pairing, operator re-issue and `GET /auth/session`. The document sidecar
restart slice added 2 operator routes, and orphan-task recovery 2 more. That makes
42 routes, of which 4 are public, 21 client and 17 operator. Each handler is a
`method === X && <path matcher>` branch in `src/server.ts`, or the v1 regular
expression in `src/app/protocolV1.ts`.

| Access   | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public   | `GET /`, `GET /pair`, `POST /pair`, `GET /auth/session`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Client   | `POST /briefings` (start, status and cancel), `POST /document-tasks`, `POST /sports/games`, `GET /sports/team-directories`, `POST /conversation-context/detach`, `POST /conversation-context`, `POST /sports/conversations`, `POST /sports/teams`, `POST /sports/results`, `POST /sports/chat`, `POST /messages`, `POST /conversations/:c/messages/:m/cancel`, `GET /telemetry/latency`, `GET /run-controls`, `GET /run-controls/thinking`, `GET /models`, `GET /conversations/:c/events`, `GET /conversations/:c/events/stream`, `POST /v1/conversations/:c/messages`, `GET /v1/conversations/:c/events/stream`, `POST /v1/conversations/:c/messages/:m/cancel` |
| Operator | `POST /pair/reissue`, `GET /telemetry/evaluation`, `POST /briefings/config/reload`, `GET /workers/document-tasks/status`, `POST /workers/document-tasks/restart`, `POST /workers/document-tasks/inspect`, `POST /workers/document-tasks/abandon`, `POST /workers/deep/run-once`, `GET /workers/deep/dead-letters`, `DELETE /workers/deep/dead-letters/:t`, `POST /workers/deep/dead-letters/:t/replay`, `GET /telemetry/dispatch`, `GET /telemetry/context`, `POST /routing/policy/tune`, `POST /routing/policy/set`, `GET /conversations/retention`, `DELETE /conversations/:c/identity`                                                                        |

Three of today's handlers match more loosely than this table, using `startsWith`
and `endsWith` checks:

- the legacy events route;
- the legacy event-stream route;
- dead-letter replay.

Before activation, `/conversations/a/b/events` reached the events handler with
conversation `a`. The server now consults the table first, so such paths return
404 and no handler runs.

The table is the runtime gate: a request whose path is not in it never reaches a
handler. A handler added later without a table entry is therefore unreachable,
which fails closed. The tests cannot discover such a handler by themselves: the
coverage probe sends a request to every table entry with the operator token and
requires it to reach a handler, so it catches a table entry whose handler is
missing, but not the reverse.

## Per-principal ownership

`scopedOwnerKey(principalId, labels)` produces the stored owner: `o1:` + SHA-256
of `JSON.stringify(["chatagent-principal", principalId])` + `:` + SHA-256 of the
canonical `[principalId, ...labels]`, 90 characters. JSON encoding comes first
because raw UTF-8 hashing maps distinct unpaired surrogates to the same bytes.
`ownerBelongsToPrincipal` checks the strict format and compares the principal
part in constant time. No map stores principals separately.

The server derives the owner in one place, before dispatch, as follows:

- for each legacy client POST, from `userId`, validated first against that
  route's own contract. `/messages` requires a non-empty string; `/briefings`
  and `/sports/chat` trim, then require 1–200 characters; the other routes
  require 1–200 characters. An invalid label is left for the route to reject as
  before;
- for v1, from (`accountId`, `projectId`), after the scope schema has validated
  them.

The owner fits the document-task sidecar's 200-character `scope()` limit.

## Activation notes

- Legacy client routes cannot reach a conversation that protocol v1 allocated
  internally. The id is checked in the path and in the body of every legacy client
  POST, before dispatch. Operator retention, retirement and dead-letter replay
  work on internal ids by design and remain authorized.

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
