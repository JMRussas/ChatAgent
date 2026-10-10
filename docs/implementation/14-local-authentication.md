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

- Rotations are serialized by exclusive lock creation. A lock left by a crash is
  reported, never broken automatically. Windows lock-open `EPERM` is retried with
  six finite waits (25, 50, 100, 200, 400, 800 ms); successful exclusive creation
  is the only grant of ownership. `EEXIST` remains immediate refusal. Exhausted
  `EPERM` gives `LocalIdentityError` retaining native cause; the caller does not
  own or remove the lock or change identity bytes. Other native codes/platforms
  retain their existing behavior. Real delete-pending handle tests prove recovery
  after release, bounded refusal while held, and refusal if another owner wins
  the name. This establishes the mechanism, not the original field holder.
  Regression: `tests/integration/localIdentityLockContention.test.ts` and
  `tests/unit/localIdentityRecurrence.test.ts`.
- Rotation refuses to pass the largest safe epoch, leaving the file unchanged.
- The new file replaces the old one by rename while the lock is held. On Windows a
  rename onto a file another process holds open fails with `EPERM` until it is
  released (shown with a deliberate holder process; which process held the file in
  the failed full-suite runs is not established). That error alone is retried with
  the same files after waits of 25, 50, 100, 200, 400 and 800 ms: seven attempts and
  1575 ms of waiting, though the renames themselves can add to the elapsed time.
  On Windows, an `EPERM` also invokes the fixed, bounded POSIX-semantics replacement
  helper and checks both files after its exit. Confirmed replacement succeeds;
  unchanged files continue the existing retry; an uncertain outcome preserves the
  temp file and lock for inspection. Known unchanged failure leaves the old identity
  and cleans up this call's temp/lock. Other errors/platforms and exhausted retry
  preserve the native refusal. The old identity is never removed to recreate it.
  Regressions: `localIdentityHelper.test.ts` and the unchanged 19-case
  `tests/integration/localIdentityPosixReplace.test.ts` oracle.
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

### Route inventory

The current route policy contains 65 routes: 4 public, 21 client and 40 operator.
The independent inventory in `tests/unit/authPrimitives.test.ts` verifies every
route's required role and complete coverage without freezing the route count.
Each handler is a
`method === X && <path matcher>` branch in `src/server.ts`, or the v1 regular
expression in `src/app/protocolV1.ts`.

| Access   | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public   | `GET /`, `GET /pair`, `POST /pair`, `GET /auth/session`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Client   | `POST /briefings` (start, status and cancel), `POST /document-tasks`, `POST /sports/games`, `GET /sports/team-directories`, `POST /conversation-context/detach`, `POST /conversation-context`, `POST /sports/conversations`, `POST /sports/teams`, `POST /sports/results`, `POST /sports/chat`, `POST /messages`, `POST /conversations/:c/messages/:m/cancel`, `GET /telemetry/latency`, `GET /run-controls`, `GET /run-controls/thinking`, `GET /models`, `GET /conversations/:c/events`, `GET /conversations/:c/events/stream`, `POST /v1/conversations/:c/messages`, `GET /v1/conversations/:c/events/stream`, `POST /v1/conversations/:c/messages/:m/cancel`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Operator | `POST /pair/reissue`, `GET /telemetry/evaluation`, `POST /briefings/config/reload`, `POST /roles/config/reload`, `GET /workflows/tools`, `POST /workflows/tools/:name`, `POST /mcp`, `GET /mcp`, `DELETE /mcp`, `GET /workers/document-tasks/status`, `POST /workers/document-tasks/restart`, `GET /workers/document-tasks/recovery-candidates`, `POST /workers/document-tasks/inspect`, `POST /workers/document-tasks/abandon`, `POST /workers/deep/run-once`, `GET /workers/deep/dead-letters`, `DELETE /workers/deep/dead-letters/:t`, `POST /workers/deep/dead-letters/:t/replay`, `GET /telemetry/dispatch`, `GET /telemetry/context`, `POST /routing/policy/tune`, `POST /routing/policy/set`, `POST /routing/quota-envelopes/declare`, `GET /routing/quota-envelopes`, `GET /conversations/retention`, `GET /development/plans/:root/status`, `GET /development/executive/overview`, `GET /development/plans/:root/nodes/:node/progress`, `GET /development/plans/:root/dispatch`, `POST /development/plans/:root/dispatch/launch`, `POST /development/plans/:root/dispatch/stop`, `DELETE /conversations/:c/identity` |

`GET /development/plans/:root/status` reads a global Hekate plan through `HEKATE_PLAN_API_URL`, not any
principal's conversation, so it needs the operator role: no credential is `401`, a
client credential is `403 OPERATOR_REQUIRED`, and neither reaches Hekate. The
Host/Origin boundary applies as for every route. Without a configured URL it answers
`404 PLAN_STATUS_DISABLED`. See `13-hekate-plan-node-integration.md`.

`GET /development/executive/overview` is a further operator route: a fixed, read-only
overview of the startup-configured plan roots (`18-executive-observability-mvp.md`). Guest and
expired sessions are `401`, a client credential is `403 OPERATOR_REQUIRED`, and neither reaches
the plan API. It accepts no query, `POST`/`DELETE` and sibling paths are default-deny `404`, and
without `HEKATE_EXECUTIVE_OVERVIEW=1` it answers `404 EXECUTIVE_OVERVIEW_DISABLED`. The strict
route inventory in `tests/unit/authPrimitives.test.ts` lists it.

Workspace routes also require the operator role: `GET /workspace/tools`,
`POST /workspace/tools/:name`, and `/workspace/conversations/:c/` with `GET events`,
`GET events/stream`, `POST messages`, `POST messages/:m/cancel`, `POST context`,
or `POST context/detach`. Discovery, title/project/archive changes and reopening
are scoped to the authenticated principal. Reopening uses the stored conversation
owner; caller-supplied user labels cannot change that identity. The bridge supports
saved legacy and v1 conversations while the legacy client API continues to refuse
v1 internal IDs. `X-Workspace-Conversation-Id` on a tool call is validated against
the same owner before invoking an operation. It supplies navigation context,
not authority. Retiring a conversation clears its metadata and plan associations
through the existing coordinated retirement path.

The workflow tools and MCP routes require operator credentials for discovery and
execution. Direct UI operations use `POST /workflows/tools/:name`; MCP clients use
the stateless `POST /mcp` endpoint. Authenticated `GET /mcp` and `DELETE /mcp` reach
an explicit `405` response; authentication is checked before that response. Browser
session mutations require the exact application origin, and neither protocol accepts
caller-supplied roles as authority. Both adapters invoke the same application tools.

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
