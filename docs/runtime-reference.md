# Runtime reference

Configuration, HTTP contracts and developer commands for ChatAgent. For the current
project overview and measured results, start with the [README](../README.md).
The package and some internal types retain the name ChatRuntime.

## Optional sports briefing HTTP boundary

Compose `new BriefingHttp(coordinator, profile)` and supply it as
`startServer(port, { briefings })` or `createChatServer(service, { briefings })`.
Alternatively, set `SPORTS_BRIEFING_CONFIG_PATH=data/sports/nfl-live-briefing.example.json`
in local configuration and start the server normally. `startServer` loads that file;
explicit injection takes precedence. `createChatServer` remains injection-only.
The file contains a profile, RSS feeds, shared games budget/cache settings and
coordinator limits. It never contains the API key; games use `BALLDONTLIE_API_KEY`.
The default games budget allows five starts per rolling minute with no mandatory
spacing; `minIntervalMs` optionally adds spacing. Excess requests fail fast and a
provider 429 imposes cooldown. RSS does not consume this budget. Cache hits/coalesced
reads do not reserve extra starts. Budgets are shared within one runtime, not across
processes or other applications using the same key.
Invalid configuration fails startup with a safe error. Startup performs no sports
fetches; only explicit start commands do. Missing games credentials leave news usable.

The coordinator receives the server-owned adapter registry and execution limits;
the profile is validated and copied at boundary construction. The default app does
not enable this endpoint or silently load fixtures. Live chat discovers the configured sources through its capability registry. See [the demo plan](18-nba-briefing-demo.md) for source and fixture setup.

After editing the configured file, apply it without restarting:

```bash
curl -X POST http://localhost:3100/briefings/config/reload \
  -H 'Content-Type: application/json' -d '{}'
```

Returns `200 {version, changed}`; invalid files return `400 SPORTS_BRIEFING_RELOAD_FAILED`
and retain the active configuration. Without a reload-capable briefing runtime it
returns `404 BRIEFING_RELOAD_DISABLED`. Reload requests accept no overrides and are
serialized. Identical validated configurations do not replace sources/caches.
New run snapshots include `configVersion`; existing jobs retain their versions,
source instances and deadlines. Identical retries still find their original runs.
Changed configuration replaces caches for new runs, but preserves the shared request
history and provider cooldown. Rate/concurrency/capacity changes apply to new
admissions immediately without cancelling active work or evicting runs. Capacity is
still process-local and retained runs are not automatically removed.

The selected file path and API key are pinned at startup; changing those, `.env`,
or the server port still requires restart. This is an explicit local-prototype
administration endpoint, with the same access boundary as the existing API.
There is no file watcher or UI reload control.

`POST /briefings` accepts exactly one of these JSON command shapes:

```json
{"op":"start","userId":"user-demo","requestId":"briefing-1","request":{"now":"2026-09-30T12:00:00Z","timezone":"America/New_York","team":null}}
```

```json
{"op":"status","userId":"user-demo","runId":"<returned UUID>"}
```

```json
{"op":"cancel","userId":"user-demo","runId":"<returned UUID>","taskId":"<optional returned task UUID>"}
```

Omit `taskId` to cancel the run. Start returns `202` with the run snapshot promptly;
status/cancel return `200`. A duplicate user/request ID with an identical resolved
plan returns the same run; changed inputs return `409 BRIEFING_REQUEST_CONFLICT`.
For retries, reuse the exact request including `now`. Use a new ID for Refresh.
Unknown or other-user runs return `404`; unknown task IDs return `404`. Capacity
returns `429`, a closed coordinator `503`, invalid bodies/checkpoints `400`.
Disabled briefings return `404 BRIEFINGS_DISABLED`. Shutdown rejects admission with
`503 SHUTTING_DOWN`. Client-supplied profile/budget fields are rejected; unexpected
configuration failures produce a safe `503 BRIEFING_UNAVAILABLE` without raw details.

`userId` is a prototype ownership guard, not authenticated identity. Requests supply
an explicit as-of clock for reproducible fixtures; a future live product boundary
must derive its operational clock/checkpoints server-side. This endpoint returns
structured evidence, not model-generated summaries. Results retain source identity,
synthetic/live mode and coverage. Inspect task states; settled does not mean successful.

Runtime shutdown closes briefing admission and signals cancellation in its background
stop hook; direct server close also closes the coordinator. Noncooperative adapters
may outlive logical cancellation, retain their execution slot and cannot publish late
results. No durable storage, resume, automatic refresh, retrieval tool exposure to
chat models or UI integration is implied.

## HTTP API

Every route except the page and pairing needs a credential (see "Local
authentication"). The `curl` examples below omit it for brevity: add
`-H "Authorization: Bearer <token>"`, using the client token, or the operator
token for operator routes. Both are in the installation's `identity.json`.

Malformed JSON payloads on POST endpoints return `400` with error `Invalid JSON body`.
JSON bodies for POST endpoints must be non-null objects; `null`, arrays, and primitive values return `400`.

### Local deployment boundary and request limits

Local operation is the only supported deployment. The listener binds `BIND_HOST`
(default `127.0.0.1`; `::1` and `localhost` are the only other accepted values)
and startup fails for any other address. Every route except the page and
pairing requires the one local installation principal (see "Local
authentication" below). Shared or
nonlocal deployment stays unsupported: that would need separate user identities
and per-user ownership, and `userId` in a JSON body is still only a label.

Every request, including page loads, timeline reads, both event streams and
operator endpoints, is checked before routing and before its body is read:

- `403 HOST_NOT_ALLOWED` unless the `Host` header names `localhost`, `127.0.0.1`
  or `[::1]` (any port). A DNS name rebound to the loopback address therefore
  cannot reach the server from a browser.
- `403 ORIGIN_NOT_ALLOWED` when an `Origin` header is present and is not exactly
  `http://<Host>`. Another site, a page served from a different local port and
  an opaque (`null`) origin are all refused. No CORS headers are sent.
- A repeated `Host` or `Origin` header is refused the same way, for every
  credential. Node keeps only the first copy of some repeated headers, so the
  check reads every received value.

A request that sends no `Origin` (curl, the benchmark and evaluation commands, any
other local process) passes this check, but it still needs a credential. A
reverse proxy that rewrites `Host` or terminates TLS is outside this boundary and
will be refused.

### Local authentication

Every request passes the local boundary and the route policy before any route
handler runs, and every route except the four public ones requires a principal.
Local mode has exactly one principal: the installation. Its identity file
is created on first start in a directory that only the current OS user can read:
`%LOCALAPPDATA%\ChatAgent` on Windows, `$XDG_STATE_HOME/chatagent` elsewhere
(`~/.local/state/chatagent` when `XDG_STATE_HOME` is unset), or
`CHAT_IDENTITY_DIR`. An identity file or directory that is not private, or not
valid, stops startup and is left unchanged. Never delete it to recover: a new
identity orphans everything the old one owned. Restore the permissions and rotate
the credentials instead. Any process running as the same OS user can read the
file, and therefore act as that user; local mode does not defend against that.

Credentials and roles:

| Credential                               | Roles            | Used by                                                                 |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| Browser session cookie (`ca_session`)    | client, operator | The page, after pairing                                                 |
| `Authorization: Bearer <client token>`   | client           | Benchmark and evaluation commands, protocol v1 clients                  |
| `Authorization: Bearer <operator token>` | client, operator | Operator routes such as dead letters, retention, routing policy, reload |

The route table in `src/auth/routePolicy.ts` lists every route. Public routes are
`GET /`, `GET /pair`, `POST /pair` and `GET /auth/session`. Every other route
answers as follows:

- `401 UNAUTHENTICATED` without a valid credential, including for unknown paths,
  so routes cannot be enumerated;
- `403 OPERATOR_REQUIRED` for a client credential on an operator route;
- `404 NOT_FOUND` for an unknown path once authenticated. A path that is not in
  the table never reaches a handler.

Changes made with a browser cookie (any method but GET) must carry an `Origin`
exactly equal to `http://<Host>`, or they get `403 ORIGIN_REQUIRED`. Another
application on the same host but a different port is same-site, so the browser
sends it this host's cookies even with `SameSite=Strict`. Only bearer tokens may
omit `Origin`.

**Pairing a browser.** On start the server prints a one-time code to its own
console:

```text
Pair a browser: open http://127.0.0.1:3100/pair and enter XXXXX-XXXXX (one use, valid for 10 minutes).
```

- The `/pair` form posts the code in a JSON body, never a URL, and must come from
  this exact origin.
- A correct code sets `ca_session`: `HttpOnly`, `SameSite=Strict`, `Path=/`,
  30 days. This HTTP profile does not set `Secure`. Cookies are scoped by host,
  not port, so these flags do not isolate other local applications on the same
  host.
- Five wrong attempts discard the code, and nothing issues a new one
  automatically. Restart the server, or have an operator call
  `POST /pair/reissue` with the operator token. The new code goes to the
  console, never to the response.
- Responses: wrong code `401 PAIRING_FAILED`; no active code
  `409 PAIRING_NOT_ACTIVE`.

The page checks `GET /auth/session` when it loads. It goes to `/pair` only on an
authoritative answer: `401`, or `authenticated: false`. A transient failure does
not force pairing.

**Local commands.** The benchmark, golden-set and live-acceptance commands read
the existing identity; they never create one. They send the client token, and
the operator token only for operator routes. They refuse to send any token
anywhere except `http://localhost`, `http://127.0.0.1` or `http://[::1]`, with no
user information in the URL.

**Protocol v1 scoping.** Legacy client routes cannot reach a conversation that
protocol v1 allocated internally. The conversation id is checked in the path and
in the body of every legacy client POST, before any handler runs, and such ids
answer `404 CONVERSATION_NOT_FOUND`. Operator routes (retention, retirement,
dead-letter replay) work on internal ids by design and remain authorized for the
operator. The operator dead-letter view lists only the task
id, its timestamps, size band and a known failure category. It omits prompts,
context, conversation and message identities, and free error text.

**Ownership is per principal.** Before any handler or store sees it, a valid
`userId` label (as each route already validates it) becomes an owner key scoped
to the authenticated principal: `o1:` + SHA-256 of the principal + `:` + SHA-256
of the principal and label, 90 characters. Protocol v1 derives its owner from
(`accountId`, `projectId`), and its conversation key includes the principal. All
existing ownership checks therefore apply per principal:

- conversation claims (`409 CONVERSATION_OWNER_MISMATCH`);
- evidence and result references;
- games, teams and topics;
- briefing runs;
- document tasks.

The same label under two principals names two different owners. The digests are
collision-resistant; that is a cryptographic expectation, not an absolute
guarantee.

Reads and cancellation carry no owner, so they check the conversation's stored
owner against the caller's principal and answer `404 CONVERSATION_NOT_FOUND`
otherwise. Holding the operator role makes no difference on these client routes.
Operator routes remain installation-wide.

One exception keeps subscribe-before-first-message working: a conversation that
nobody has claimed may be read or streamed while it is empty, and only then. Once
it has events without an owner it is never shown. Once anyone claims it, an open
stream re-checks on every read and ends, before writing, if the claim belongs to
another principal. Cancelling an unclaimed conversation answers `404`.

Behaviour changes in local mode, with its one principal:

- internal owner strings have the new format, including in new document-task
  sidecar rows;
- events without an owner are not readable;
- document-task rows stored earlier under a plain `userId` are kept unchanged, but
  are unreachable through client routes;
- a conversation with such rows cannot be retired. The blocker check sees the
  sidecar's owner mismatch as `DOCUMENT_TASKS_UNKNOWN`, which fails closed.
  Adopting legacy rows is a later, explicit step.

Not provided: a second principal type in production (only tests use two
principals), adoption of existing document-task owners, and shared deployment.

POST bodies are limited to `HTTP_MAX_BODY_BYTES` (default 1048576, at most
16777216; invalid values fail startup). Bytes are counted while reading, so the
limit holds for chunked input with no declared length. A declared
`Content-Length` over the limit is refused before any body byte is read. Either
way the response is `413` with code `REQUEST_BODY_TOO_LARGE` and
`Connection: close`; the server stops reading, nothing is appended or enqueued,
and a `messageId` in the rejected body stays usable. A client that is still
uploading may observe the closed connection instead of the 413. Bytes sent past a
declared `Content-Length` are never treated as body: Node's parser refuses them
as a malformed next request. A body that ends before its declared length settles
the request when the client disconnects or Node's default request timeout fires;
that timeout is not configured here. The limit applies per request; event streams
have their own limits, below.

Concurrent turns are limited to `CHAT_MAX_CONCURRENT_TURNS` (default 8, at most
1000; invalid values fail startup). The count covers both submission paths
(`POST /messages` and protocol v1) across all conversations, since both go
through the same service. A turn occupies its slot from admission
until its response has returned and any inline retrieval it detached has
settled, including through cancellation; with the queue-backed mock runtime the
slot is released when the response returns, because deep work is queued and
bounded separately. The limit is checked synchronously before ownership, history
or a `messageId` is claimed, so a refused submission leaves nothing behind. The
response is `429` with code `TURN_CAPACITY` and `Retry-After: 1`, including on
protocol v1 when the submitted ID already has a terminal event. A refused,
previously unclaimed message may be resent with the same body and `messageId`
once a slot frees. Submissions are
refused, never queued, and the deep worker's own runs do not count. Timeline
reads, event streams, cancellation and operator endpoints are not admitted
through this limit. Event streams and connections have their own limits, below.

### Connection limit

Open TCP connections to the server are limited to `HTTP_MAX_CONNECTIONS` (default
128, at most 4096; decimal digits only, and an empty or invalid explicit value fails
startup). It is Node's own `server.maxConnections`, set before the server listens.
Every open connection counts the same: one that has not finished sending a
request, an idle keep-alive connection after its response, and an event stream.
A further connection is accepted by the operating system and then closed by Node
before any HTTP is read: the client sees a reset or a closed connection, with no
status code, no `Retry-After` and no authentication or Host check. A slot frees
only when its connection actually closes.

The limit is independent of the event stream, turn and body limits: each applies
at its own boundary, and a new event stream may be refused by either the
connection limit or the stream limit. It reserves nothing: a local process holding
connections open can delay every other client, operator requests included, until
those connections close, and there is no fairness between clients. How long an
incomplete or idle connection is kept is left to Node's default server timeouts,
which are not configured here. The limit counts connections only; it does not
bound the requests sent over one connection, memory or work.

The limit applies to one server instance in one process. Only that single-process
loopback deployment is supported: clustering, sharing a listener between
processes or handing sockets to child processes is not. Shutdown is unchanged:
the listener stops accepting, and idle and then all remaining connections are
closed, those that filled the limit included.

### Event stream limits

Open event streams are limited to `HTTP_MAX_EVENT_STREAMS` (default 32, at most 1000) across both stream routes together: `GET /conversations/:id/events/stream`
and `GET /v1/conversations/:id/events/stream`. A stream is admitted after cheap
validation (route match; v1 scope, cursor syntax and `runtimeId`) and before any
timeline read, header, listener or timer. At capacity the response is `429` with
code `STREAM_CAPACITY` and `Retry-After: 1`; nothing was read, and a refused v1
stream allocates no conversation identity. A stream answered with `410` or `409
CURSOR_UNAVAILABLE` after admission releases its slot. The browser page reopens
a refused stream itself with backoff (1 s doubling to 30 s), because Chromium
closes an `EventSource` for good after a non-200 response; at most one reopen is
pending, and only for the stream and conversation that failed.

A slot is held until the response has finished or closed and any timeline read
the stream started has settled. A client that disconnects during a read therefore
keeps its slot until that read returns, so reconnect churn cannot accumulate
pending reads. `retentionStats()` reports held slots as `streams` and the closed
streams still waiting for a read as `settlingStreams`.

Both streams are derived from timeline state, so slow clients get bounded
buffering rather than an event queue. Each stream runs at most one timeline read
at a time. Each frame is one write. When a write reports a full buffer, the frame
was still accepted: the v1 cursor moves past it and the legacy stream records it
as its last snapshot. From then until `drain` the stream neither reads the
timeline, writes frames, nor sends heartbeats, and a frame refused in that state
is not recorded as sent, so it goes out after drain. After drain the next read
sends whatever is current: v1 continues from its cursor without gaps or
duplicates, and the legacy stream sends a new snapshot only if the timeline
changed. A stream that has not drained within `HTTP_STREAM_STALL_TIMEOUT_MS`
(default 30000, 1000 to 600000) is disconnected and its slot freed; clients
reconnect through the existing replay rules. The same deadline applies to a
stream that was ended but has not flushed. Per stream, memory is the current
timeline copy from the read, its serialization, and the buffered frames: at most
the response's high-water mark plus one frame (one v1 event, or one legacy
snapshot bounded by the conversation byte limit). This is a per-stream bound, not
a whole-process measurement. Since 2026-10-06, with the in-memory timeline store, a
v1 stream checks its cursor at open against the last sequence without copying any
events, and each poll copies only events after its cursor within a 256 KiB budget
of serialized event bytes (the size the store records for each stored event). Each
event is admitted before it is added, and the first event of a poll is always
admitted, so one poll copies at most the larger of 256 KiB and that one event; the
rest follow on later polls, without gaps or duplicates. An idle stream copies
nothing. The budget counts serialized bytes, not JavaScript heap.

Since 2026-10-07, with the in-memory store, a legacy stream polls the timeline's
revision (its last sequence) first. While the revision equals that of the last
snapshot the response accepted, the poll still checks the conversation version
and ownership but copies, serializes and sends nothing, and the stream keeps that
sequence instead of a serialized copy of its last snapshot. The first snapshot,
empty or not, is always sent, and the pre-header read is unchanged. A store that
offers `lastSequence` must keep each conversation version append-only. A store
without it, or a snapshot without valid sequences, keeps the previous behaviour:
one full read per poll, compared with the last accepted serialized snapshot.

Limits remain: a single v1 event can be as large as the conversation byte limit;
a store without the optional reads falls back to full copies; and every change to
a legacy stream's timeline, including each delta during generation, still copies,
serializes and re-sends the whole snapshot. The legacy change lowers idle copying
and the retained per-stream cache; it is not a peak-memory bound.

Shutdown (`closeStreams`) clears every stream's timers and listeners at once,
ends idle streams, and destroys streams that are blocked, still flushing or have
not sent headers, so it never waits on a stalled client. Server close alone does
not end streams; the runtime shutdown sequence calls `closeStreams` first. Both
defaults are local-use choices, not measurements.

A v1 stream resumes after the later of the `afterSequence` query parameter and the
`Last-Event-ID` header (2026-10-06). Turn frames carry their sequence as the SSE ID,
so a native `EventSource` that reconnects to its original URL continues after the
last event it received instead of replaying from the URL's cursor, and an explicit
query skip is never undone by an older header. The header must be one decimal safe
integer (0 included); a repeated header, a sign, an exponent, a fraction, internal
whitespace or an unsafe value is `400 INVALID_CURSOR`, refused before stream
admission or any timeline read. Node removes optional whitespace around a header
value before it is checked. Without the header nothing changes. The cursor and
runtime checks apply to the effective cursor: past the high-water mark it is
`409 CURSOR_UNAVAILABLE`, and a stale `runtimeId` in the URL is still
`409 RUNTIME_RESTARTED`. The legacy stream ignores the header.

Body parsing and object validation occur outside operation-specific error handlers,
including `/sports/chat`, so enabled routes preserve the shared HTTP error contract.
Regression coverage checks declared and chunked oversized bodies on enabled optional
routes, including status/code, connection closure and absence of downstream work.
The default-limit integration test accepts valid JSON padded to exactly 1 MiB and
rejects a declared length one byte larger.

`POST /messages` accepts an optional UUID `messageId` (the server allocates one
when absent) and returns the same response fields after the fast phase ends. It also returns:

- `409` with code `DUPLICATE_MESSAGE_ID` for a repeated ID in the same conversation.
- `409` with code `CONVERSATION_OWNER_MISMATCH` if a `userId` other than the one
  that first submitted to a `conversationId` tries to post to it. This is a
  local-prototype guard against accidentally mixing two users' turns into one
  conversation's shared context. It is a label check inside the one authenticated
  installation principal, not per-user authorization.
- `413` with code `CONTEXT_TOO_LARGE` if the message plus configured instructions
  would exceed the conversation context budget (see "Conversation context budget"
  below) even before any history is added. No events are appended and no deep task
  is enqueued when this happens.

1. Submit message

```bash
curl -X POST http://localhost:3100/messages \
	-H "Content-Type: application/json" \
	-d '{"conversationId":"conv1","userId":"u1","text":"Find latest inflation data and cite sources"}'
```

2. Run deep worker once

```bash
curl -X POST http://localhost:3100/workers/deep/run-once
```

3. Get conversation timeline

```bash
curl http://localhost:3100/conversations/conv1/events
```

4. List deep-worker dead-letter records

```bash
curl http://localhost:3100/workers/deep/dead-letters
```

5. Replay a dead-letter task

```bash
curl -X POST http://localhost:3100/workers/deep/dead-letters/<taskId>/replay
```

The list response also reports `capacity`: the configured `DEAD_LETTER_MAX_RECORDS`
/ `DEAD_LETTER_MAX_BYTES` limits and the current records, reserved slots and bytes.
Every queued, running or replayed deep task reserves one slot sized to its serialized
task, so its failure can always be recorded. Records never expire and are never
evicted. When records plus reservations reach either limit, a new deep-routed
message is rejected with `503` / `DEAD_LETTER_CAPACITY` before its user event is
written, so the same `messageId` can be resubmitted later; direct turns continue.
A replayed record keeps its slot until the replayed task settles. Replay still
fails explicitly (`CONVERSATION_EXPIRED`, `DISPATCH_SNAPSHOT_UNAVAILABLE`,
`REPLAY_CONFLICT`) and restores the record when its dependencies are gone.

Dead-letter reservations own the admitted task snapshot. Provider/replay mutations
cannot expand the stored task or change the replay input. Added records and list
results are copied; unreserved record replacements update serialized task-byte
accounting atomically and preserve the old record on capacity rejection. The byte
limit covers serialized tasks, excluding failure metadata and heap overhead.
The worker also records failures during attempt creation after dequeue, including
expired history. Direct queue enqueues bypass reservation; their failure records
remain subject to available dead-letter capacity.

Discard a dead-letter record (explicit operator decision; frees its slot):

```bash
curl -X DELETE http://localhost:3100/workers/deep/dead-letters/<taskId>
```

Discarding removes the only replayable copy of the task. The failure itself stays
in the conversation timeline as the task's terminal error event while that history
is retained.

Conversation identities (operator endpoints: they need the operator token or a
paired browser; see "Local authentication"):

```bash
curl http://localhost:3100/conversations/retention
curl -X DELETE http://localhost:3100/conversations/<conversationId>/identity
```

An expired conversation keeps its ID reserved: history, selected scope, summary
memory and source indexes are gone, but the owner and a tombstone remain so the ID
cannot silently become a new conversation. Nothing recycles these slots
automatically. The listing reports the identity limit, current owners and up to
200 expired identities with their expiry time; `DELETE` retires one of them.

Retirement removes the tombstone, the owner, the protocol-v1 wire mapping, settled
execution records and any tool results or team/game snapshots bound to the
conversation, in that order of dependence: ownership is released last. It returns
`404 CONVERSATION_NOT_FOUND` for an ID the process does not hold and
`409 CONVERSATION_RETIREMENT_BLOCKED` with a `blockers` list otherwise:

| Blocker                                             | Meaning                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `HISTORY_LIVE`                                      | Not expired. Retirement never deletes history.                      |
| `DEAD_LETTERS`                                      | A record or reserved slot refers to it; replay or discard it first. |
| `QUEUED_TASKS`, `ACTIVE_TURNS`                      | Work could still write to it.                                       |
| `DOCUMENT_TASKS`, `DOCUMENT_TASKS_UNKNOWN`          | The sidecar holds tasks for it, or could not be asked.              |
| `QUEUE_UNINSPECTABLE`, `DEAD_LETTERS_UNINSPECTABLE` | A custom queue or store lacks the inspection contract.              |
| `RETIREMENT_UNSUPPORTED`, `PARTICIPANT_UNAVAILABLE` | The timeline store has no retirement contract, or a check failed.   |

`RETIREMENT_REFUSED` means the timeline refused the final deletion; ownership
remains claimed even if dependent cleanup already ran.

A retired ID is unknown to the process. A later request with it starts an
unrelated conversation that any `userId` may claim, and message IDs used in the
old conversation are no longer rejected as duplicates. This is bounded
process-local identity, not durable deduplication. Dead letters are never
discarded on the operator's behalf, and there is no abandon operation for
document tasks, so a conversation with document tasks cannot be retired yet. A
legacy or protocol-v1 stream that followed the retired conversation is closed
rather than continued into the new one. Pending team-directory/game searches and
document-task starts lease the history until their response settles, so they
cannot publish dependent state after retirement. Retirement rechecks an opaque
identity incarnation after awaiting participant blockers; stale answers cannot
retire a reused ID. Custom timeline retirement requires `conversationVersion`
alongside the state and deletion contracts.

6. Read latency telemetry and current routing policy

```bash
curl http://localhost:3100/telemetry/latency
```

Response now also includes `queueDepth` for the current in-memory deep-task queue.

7. Trigger policy auto-tune based on queue depth

```bash
curl -X POST http://localhost:3100/routing/policy/tune \
	-H "Content-Type: application/json" \
	-d '{"queueDepth":10}'
```

8. Read quota envelope accounting (operator endpoint; needs the operator token or a
   paired browser)

```bash
curl http://localhost:3100/routing/quota-envelopes \
	-H "Authorization: Bearer <operator token>"
```

The answer is `source: "local-declared-window-accounting"`: this process's own
accounting against operator-declared windows, not provider quota, and lost on
restart. It reports `asOf`, `unsettledEnvelopeLinks` and, per pool ordered by
digest, its unit, highest declared sequence, availability (remaining and any debt,
or an unavailable reason), retained windows and open reserved, started and unsettled
charges. Pool and window identifiers appear only as digests; scope and credential
references never appear. Reading changes nothing: no ledger change, clock commit,
pruning or settlement. An unusable clock answers `200` with `asOf: null` and every
pool unavailable with `CLOCK_UNAVAILABLE`. Without catalog dispatch the route
answers `404 QUOTA_ENVELOPES_DISABLED`; with no envelope pools, `pools` is empty.
Field details are in `docs/implementation/08-resource-policy.md`.

## TDD flow

Use this loop for each feature:

1. Write or update tests in `tests/`
2. Run `npm run test:tdd`
3. Implement minimal code in `src/`
4. Refactor while tests stay green

## Configuration and secrets

Runtime provider configuration is read from environment variables. The experiment runners also have documented fixed settings; consult their protocols before comparing results.

Local setup:

```bash
cp .env.example .env
# then edit .env with real values
```

`.env` is listed in `.gitignore` and should not be committed. `.env.example` is the checked-in template for local configuration, with placeholder or empty credential values.

Provider keys belong in environment configuration, not source control. Startup
validation checks required configuration and logs a redacted provider summary.
AWS authentication uses the standard SDK credential chain, including environment
credentials or configured profiles/roles. See `src/config/providerConfig.ts` and
the provider adapters for the implemented behavior.

The server binds a loopback address, refuses cross-origin and
non-loopback-`Host` requests, and authenticates every request as the one local
installation principal (see "Local deployment boundary and request limits" and
"Local authentication"). A local process needs the installation's credentials,
which any process running as the same OS user can read. Inside that principal,
conversation ownership by `userId` is a label check, not per-user authorization.
Shared deployment requires separate user identities and per-user ownership, and
is refused at startup.

### Executive overview (Hekate, opt-in)

An operator-only, read-only overview of recorded Hekate plan state for a fixed inventory of
roots (`docs/implementation/18-executive-observability-mvp.md`). It is off unless explicitly
enabled and never discovers roots; a browser cannot supply a root, URL or label.

| Variable                      | Meaning                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEKATE_EXECUTIVE_OVERVIEW`   | `1` enables the overview. Unset or empty leaves it off; any other value fails startup.                                                                              |
| `HEKATE_EXECUTIVE_ROOTS_JSON` | JSON array of 1 to 8 `{ "rootId": lowercase GUID, "label": 1..60 chars, "goal"?: 1..200 chars }`. Unknown keys, duplicate roots and control characters are refused. |
| `HEKATE_PLAN_API_URL`         | Required with enablement; the loopback plan API already used by plan status.                                                                                        |

Invalid enablement fails startup with the stable code `INVALID_EXECUTIVE_ROOTS` and never echoes
the configured value. Goals are operator-written configuration, not verified results.
`GET /development/executive/overview` answers `200` whenever the overview is well-formed, with
per-root `ok`, `invalid` or `unavailable` entries (a code only, never an upstream body, message
or URL); `503` is reserved for the collector failing as a whole. Bounds: 5 s per root, 8 s overall,
2 MiB upstream per root, 100 tasks per root and 1 MiB serialized (trailing tasks are dropped with
an accurate `tasksOmitted`; JSON is never truncated). The page loads empty; only the Refresh
button and expanding a task issue requests, both `GET`. It reports PlanStore acceptance only:
source integration, deployment, worker liveness and budget are not established by it.

#### Checkpoint budget records (optional, read-only)

`HEKATE_CHECKPOINT_RECORDS_JSON` (requires the overview) registers at most 16
`{ "rootId", "nodeId", "recordPath" }` entries with absolute, duplicate-free paths to
`checkpoint-budget/v1` files written by the operator-run `scripts/runCheckpoint.ts`
(`docs/implementation/19-checkpoint-execution.md`). Invalid registration fails startup with
`INVALID_CHECKPOINT_RECORDS` and never echoes the value. Without it the response is unchanged
`executive-overview/v1` (byte-identical, no `attention` field) and `budgetEvidence` is
`not_reported`. With it the response is `executive-overview/v3` (v2 plus `attention`, below; the
page still reads v1 and v2): only registered tasks (accepted ones included) get one bounded lookup of
the record and its `<runId>.gate.json` (regular file, no symlink, 16 KiB, 500 ms, strict JSON, closed
schema) and `budgetEvidence` becomes `reported` or `unavailable` with a typed `reason` (`missing`,
`unreadable`, `too_large`, `invalid`, `unsupported_schema`, `stale_identity`, `timeout`). The
identity fence (`attemptId`, `attemptEpoch`, `contentRevision`) must match the task; `stateRevision`
may advance. A fence mismatch is quarantined and its numbers are not shown. Records are supplied,
unauthenticated runner output with unknown owner liveness; the unit is "distinct assistant message
IDs seen", the 30/60 defaults are a provisional heuristic, provider `num_turns` and cost are
unverified, and lead-supplied gate evidence is current only for the exact artifact. The runner
adds no HTTP route; the UI renders records with `textContent` and issues no extra request.

#### Checkpoint attention and local handoff (optional, advice only)

Design: `docs/implementation/20-checkpoint-recovery-handoff.md`. With a registry the v3 body adds
`attention` (`checkpoint-attention/v1`): at most 32 items, an exact `omitted` count, and
`registeredRecordsUnavailable` (registered entries whose root is unavailable, task is missing or
omitted, or record is missing, invalid or quarantined; a quarantined record's numbers are never
shown). Items come only from a fence-matched, supplied record: `cleanup_unconfirmed`,
`overdue_unreported`, `stopped_tripwire`, `stopped_failed`, `refused_start`, and
`verification_unavailable` (a gate that is current for the task's artifact with outcome
`verifier_unavailable`). Tripwire, failed and refused items are suppressed for accepted or
cancelled tasks; the other kinds are not. Each item carries ids, the fence, `runId`, the closed
stop code, `attribution: "unattributed"`, a closed advice key and `automaticAllowed: false`
with a constant forbidden list; it carries no task name, text, path or free string. A stop item
means a supplied record says so, an overdue item means no end is recorded past the declared bound;
neither establishes liveness, cause or a retry. If the body would exceed the response cap, task
rows are dropped first (items keep `taskListed: false`), then trailing items with `omitted` counted.

The page shows an Attention panel above the roots. **Open detail** opens the same page's root and
task detail (the existing single progress GET, no navigation, no new route) after re-checking that
the item's fence and `runId` still match the task shown; otherwise the row reads "changed,
refresh". An omitted task row has no control.

`npx tsx scripts/handoffCheckpoint.ts --out-dir <absolute dir>` reads the server environment
(`HEKATE_PLAN_API_URL`, `HEKATE_EXECUTIVE_OVERVIEW`, `HEKATE_EXECUTIVE_ROOTS_JSON`,
`HEKATE_CHECKPOINT_RECORDS_JSON`), collects the overview, projects attention, collects a second
time and writes `<handoffId>.handoff.json` (`checkpoint-handoff/v1`, at most 64 KiB) only if both
reads agree on kind, ids, fence, `runId`, stop, record state and gate source and no involved root
was unavailable. Zero items writes nothing. Publication creates a temp file, syncs it and creates
the final name with a no-overwrite hard link, so an existing file is never replaced; a missing
link capability refuses. The out-dir must be an absolute, canonical, existing, non-symlink
directory. Exit codes: 0 written or nothing to hand off, 1 refused (changed, unavailable,
deadline of 20 s, invalid out-dir, oversize), 2 usage, 4 write failed. The file is local storage
only: `delivery: "not_sent"`, `notification`, `wake` and `acknowledgment` are `"none"`, fences are
observed at capture and are not current state, and nothing re-reads it except
`scripts/handoffCheckpoint.ts --show <file>` (strict bounded parse). It adds no daemon, request
beyond the existing loopback GETs, notification or process control.

### Durable checkpoint review ledger

`npx tsx scripts/checkpointQueue.ts --manifest <file> --evaluate` and `--show` implement the
read-only ledger of [doc 21](implementation/21-checkpoint-review-queue.md). The trusted manifest
(`checkpoint-queue-manifest/v1`, at most 32 KiB, closed schema, no duplicate or unknown keys)
names a lowercase-GUID `queueId`, a loopback `planApiUrl`, a canonical existing non-symlink
`ledgerDir` and 1-8 entries (`entryId`, `rootId`, `nodeId`, printable-ASCII `label`, `expected`
`{attemptId|null, attemptEpoch, contentRevision}`, `recordPath` canonical absolute or `null` for a
ready, unclaimed task). It is operator-declared scope, not authenticated authority, and supplies no
command, executable or model. Configuration refusals print a closed code only.

`--evaluate` fetches each distinct root once (loopback GET only) inside one shared 20-second
monotonic deadline, reads each registered record through the existing bounded reader, classifies
every entry by the first matching rule (`unobservable`, `needs_operator`, `accepted`, `blocked`,
`ready_unclaimed`, `gate_recorded`, `review_pending`, `running_recorded`, `claimed_unobserved`,
each with a fixed reason and action key) and publishes `<queueId>.queue.json`
(`checkpoint-queue/v1`, at most 64 KiB, newline-terminated). Outcomes are `all_accepted`,
`review_required`, `operator_required`, `ready_requires_claim`, `blocked`, `running_recorded` and
`unobservable`; an unobservable or claimed-unobserved entry outranks an operator-required one. A
moved fence quarantines the prior record and gate values, only a gate on the exact fence and
artifact is current, and a source artifact is shown only as a hex Git SHA or `withheld`. The
ledger keeps `firstSeenAt` and `stateSince` as display metadata (an unchanged observation
preserves `stateSince`; a changed fence, state or reason resets it), `workerLiveness: "unknown"`,
`taskMutationAllowed: false` and `delivery`, `notification`, `wake`, `acknowledgment` of
not-sent/`none`.

The CLI deadline includes manifest loading. Before writing, the process exclusively creates `<queueId>.lock` holding a random instance token.
An existing lock is `LOCK_BUSY` and is never taken over by PID or age; a crash leaves it for a
separate operator recovery. A malformed, oversized, wrong-schema, symlinked or other-queue prior
ledger is refused and left untouched, and a changed manifest hash needs a new `queueId`. The new
generation is written to an exclusive temp file and synced; the prior bytes and owned lock token are re-read, the deadline
is checked immediately before publication, and the first ledger is created with a no-overwrite hard
link (a replacement uses rename). Replacement is serialized only among writers that respect the
lock; it is not an atomic compare-and-swap against arbitrary external writers, and directory sync
or power-loss safety is not promised. Only this process's temp file and a lock whose token is still
its own are removed; a changed lock is retained and reported (`CLEANUP_INCOMPLETE`). After a deadline
refusal nothing is published and the abandoned work cleans up when it settles.

### Finite checkpoint verification continuation

`npx tsx scripts/continueCheckpoint.ts --manifest <file>` implements
[doc 22](implementation/22-checkpoint-continuation-manager.md) for one already claimed `coding`
checkpoint. The trusted manifest (`checkpoint-continuation-run/v1`, at most 32 KiB, closed schema,
duplicate/unsafe keys and integral decimals in identity fields refused) holds the unchanged
`checkpoint-run/v1` object as `run`, 1-24 declared `files` under `src/`, `scripts/`, `tests/` or
`docs/`, 1-8 `focusedTests`, a pinned absolute `nodeExecutable`, SHA-256 pins for the fixed Prettier,
TypeScript and Vitest entry scripts, and `limits` (`wallMs` at most 1,800,000 and greater than the
worker wall plus `verifierWallMs` plus 30 s; `verifierWallMs` at most 600,000; `verifierOutputBytes`
at most 4 MiB). It has no command, script, argv, environment or model field. A real-valued
`run.providerUsdCap` must be written non-integral or as a plain integer (`2.5` or `2`, not `2.0`).

One process, under one monotonic deadline that starts at CLI entry, runs this sequence and ends
at a stored `review_pending` or `needs_operator`:

1. Preflight (pins, linked worktree at the exact clean base with no staged change, declared paths
   free of symlinks, current `in_progress` claim whose gates hold, no existing run, gate or
   instance/runner lease), then the exclusive `<runId>.continuation.json` and
   `.continuation-<claim-hash>.lease` reservation in `run.recordDir`, all before any worker.
2. `runCheckpoint` once. Anything but a clean zero exit stops with no candidate, finish or check.
3. Bounded NUL-separated Git status/diff paths (renames off). Only declared regular files may be
   modified, added or deleted. One candidate commit is made with fixed identity and message and
   command-local settings (no hooks, fsmonitor or signing); the result is re-verified.
4. One finish-only `POST /api/plan-contract/v1/nodes/<nodeId>/transition` (`to: done`, exact
   attempt/epoch, candidate SHA, the current state revision as CAS, a fixed actor and an operation
   key bound to run and candidate). `finish: attempted` is durable first; a conflict, outage or
   unconfirmed response stops and is never replayed. A bounded GET must show the exact
   `review_pending` artifact before verification.
5. `node <Prettier|TypeScript|Vitest entry>` with fixed arguments in the worktree (`--check` on
   declared existing changed files only; `--project tsconfig.json --noEmit`; `run --maxWorkers=1`
   on the focused tests), `shell: false`, `windowsHide`, an allowlisted environment, shared
   verifier wall/output bounds and output hashed while streamed, then discarded. A launch error,
   timeout or output cap is `unavailable` and keeps later checks unavailable; a nonzero exit is
   `fail`. The checks run in the same awaited process as the worker; no user message is involved.
6. A final task/artifact, candidate HEAD, clean-tree and lease recheck, then the existing
   `checkpoint-gate/v1` for the worker's original run and fence with `failureAttribution:
   unattributed`. Only all-pass yields `review_pending`.

`checkpoint-continuation/v1` (at most 16 KiB, newline-terminated) exposes `phase`
(`reserved`, `running`, `snapshotting`, `verifying`, `review_pending`, `needs_operator`), a typed
`reason`, `sourceRef`, worker stop/exit and unverified counters, `finish`, per-check results with
exit/timeout/byte metadata and output hashes, and fixed `leadAcceptance: pending`,
`semanticReview: not_performed`, `delivery: not_sent`, `wake: none`, `acknowledgment: none`,
`recordTrust: supplied_not_authenticated`, `writerLiveness: unknown`. The gate's evidence
references carry an independent reason, source and fence. `checkRole: mimir_external_checks` names
deterministic external checks only; the gate states `suppliedBy: lead` because that is the existing
schema's only value, not because a lead reviewed anything. Exit codes: 0 only for stored
`review_pending`, 1 stored operator outcome, 2 input or preflight refusal, 4 persistence or cleanup
failure. Zero is never acceptance.

Limits: the lease is cooperative and a crash retains it (recovery is a separate operator step);
a fresh invocation never resumes. In-flight filesystem and process operations can settle after a
deadline and are then not followed by a later phase. A terminal `needs_operator` record is the one
write allowed after the deadline, and still requires the owned lease token. Node and Git entry pins
do not authenticate dependencies, and running repository code is host-owned, not sandboxed. A
child that exits normally is not tree-swept afterwards. Nothing claims, releases, revises,
decides, accepts, integrates, retries, notifies or calls a model, and no semantic review is done.

`--show` reads only the manifest and ledger, checks schema, queue id, manifest hash and entries,
and prints the retained observation (not current state) with no API request, lock or write. Exit
codes: 0 only for `all_accepted`; 1 for any other stored outcome; 2 usage or configuration refusal;
4 ownership, ledger or publication failure. No gate outcome mutates PlanStore or retries a model,
and the tool adds no claim, dispatch, notification, wake, route or UI. CA-ISSUE-004 stays open.

## Provider configuration

The validated inventory lives in [data/model-catalog.json](../data/model-catalog.json).
Inspect it and the active selections at `GET /models`, which now also reports
each binding's real discovery-derived `availability` (`disabled`,
`unsupported-adapter`, `unchecked`, `stale`, `denied`, `unavailable`, `ready`,
in that precedence) instead of a hardcoded value, plus declared
execution/billing/compute facts when a matching connection exists. Discovered
models with no matching catalog entry appear separately under `discovered`,
always disabled -- discovery never auto-curates. See
[model catalog design](../docs/13-model-catalog.md) for metadata and the
task-routing plan. Automatic selection is not enabled yet. The schema also
accounts for CLI subscription access and shared quota pools; CLI execution
adapters are not implemented yet.

Fast and deep layers are independently configurable. This allows mix-and-match across Azure, Bedrock, and Ollama.

Supported provider values:

1. `mock`
2. `azure`
3. `bedrock`
4. `ollama`

Core environment variables:

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
CHAT_FAST_TEMPERATURE=0.2
CHAT_DEEP_TEMPERATURE=0.2
```

Provider-specific settings:

```bash
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_FAST_TIMEOUT_MS=10000
AZURE_OPENAI_DEEP_TIMEOUT_MS=10000

# AWS Bedrock
BEDROCK_REGION=us-east-1
BEDROCK_FAST_TIMEOUT_MS=60000
BEDROCK_DEEP_TIMEOUT_MS=60000

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_FAST_TIMEOUT_MS=20000
OLLAMA_DEEP_TIMEOUT_MS=60000
OLLAMA_FAST_NUM_PREDICT=256
OLLAMA_DEEP_NUM_PREDICT=512
```

Azure, Ollama and Bedrock calls have deadlines covering response headers and streamed bodies.
Azure (default 10 seconds) and Bedrock (default 60 seconds) take a separate deadline for
the fast and deep role. Each value is whole milliseconds from 1 to 600000, written as
plain digits. Only an unset variable uses the default; an empty or malformed value stops
startup with an error that names the setting, even when that provider is not in use.
Hand-built provider configurations are checked against the same range. These are
request deadlines; workflow deadlines are separate and unchanged.
If local Ollama models are large or cold-start slowly on your hardware, increase `OLLAMA_FAST_TIMEOUT_MS` and `OLLAMA_DEEP_TIMEOUT_MS`.
If a model emits long reasoning traces and returns empty final text at low token budgets, increase `OLLAMA_FAST_NUM_PREDICT` and `OLLAMA_DEEP_NUM_PREDICT`.

Ollama requests go to `/api/chat` (not `/api/generate`), sending role-based
`system`/`user`/`assistant` messages so both fast and deep layers see the same
shared conversation snapshot; Azure and Bedrock also switch to role-based
messages (Bedrock's system instruction goes in its separate `system` field).

### Model discovery and inventory (spec 03)

On startup, and every `MODEL_DISCOVERY_INTERVAL_MS`, the server discovers what
each configured connection actually offers: Ollama's installed models via
`GET /api/tags` + `POST /api/show` (verified against the official docs), Azure
deployments via the ARM management plane (the Azure OpenAI resource's own
deployments-list endpoint was retired in 2024; this now requires a _separate_
AAD app-registration credential, distinct from `AZURE_OPENAI_API_KEY`), and
Bedrock foundation models via `@aws-sdk/client-bedrock`'s
`ListFoundationModelsCommand` (the control-plane client, distinct from
`@aws-sdk/client-bedrock-runtime` used for actual inference). Missing cloud
credentials make that connection's discovery simply unavailable; they never
block startup or affect other connections. An observation is fresh for
`MODEL_DISCOVERY_TTL_MS`; a failed refresh retains the last-known observation
without extending its expiry, so a binding correctly becomes `stale`.

```bash
MODEL_DISCOVERY_INTERVAL_MS=300000
MODEL_DISCOVERY_TTL_MS=600000
MODEL_DISCOVERY_TIMEOUT_MS=10000

# Azure ARM (management-plane) credentials, separate from AZURE_OPENAI_API_KEY:
AZURE_ARM_TENANT_ID=
AZURE_ARM_CLIENT_ID=
AZURE_ARM_CLIENT_SECRET=
AZURE_ARM_SUBSCRIPTION_ID=
AZURE_ARM_RESOURCE_GROUP=
AZURE_ARM_ACCOUNT_NAME=
```

Execution location and billing are **declared policy facts, never inferred**
from a base URL or provider name -- a `localhost` Ollama endpoint is not by
itself evidence of `local-device` execution, since Ollama can also proxy its
own hosted cloud models through a local instance. Set them explicitly per
connection if you want them recorded:

```bash
# Scope: local-device | self-hosted-remote | managed-cloud | hybrid | unknown
# Billing (comma-separated): metered-usage, subscription, provisioned-capacity, owned-compute, unknown
OLLAMA_EXECUTION_SCOPE=local-device
OLLAMA_BILLING_COMPONENTS=owned-compute
```

Legacy v1 catalog entries (naming only a `provider`) are migrated in memory to
v2's `connectionId`/`apiKind` shape using a deterministic `default-<provider>`
connection -- the catalog file itself is never rewritten. This is metadata
only (spec 03); admission/selection logic that acts on it is spec 04.

### Streaming and cancellation

Orchestrated calls use Ollama chat NDJSON, Azure chat SSE, and Bedrock
`ConverseStream`. Direct adapter callers without `GenerationControl` retain a
non-streaming transport, with the same typed finish outcomes. Delta events are
coalesced to at most one per 50 ms per attempt (with a final flush); answer buffers
and stream frames are capped at 1 MiB. SSE still sends full timeline snapshots.

`POST /conversations/:id/messages/:messageId/cancel` returns 404 for an unknown
turn, or 200 with existing/cancelled phase states. It aborts running calls and makes
workers skip cancelled queued tasks. Disconnecting SSE does not cancel work.
The browser creates IDs before POST so Stop works while the fast call is pending.

`length` output is shown as incomplete and excluded from accepted context history.
Only transient failures before any answer text are retried (at most twice, each
with a new attempt ID). Partial failures retain their text; cancellation is never
retried or dead-lettered. Public failures use safe codes rather than provider bodies.

```bash
OLLAMA_FAST_THINK=off
OLLAMA_DEEP_THINK=default
```

Values are `off`, `on`, or `default`. Explicit controls require a successful
`/api/version` check and a matching boolean in `/api/show`'s `thinking.values` for
the selected model. Unsupported or unavailable metadata fails startup; use
`default` to leave model behavior unspecified. No model-name heuristic establishes
support. Startup metadata checks do not generate answers. Live behavior and browser
layout remain separate verification gates; see [adapter notes](../docs/implementation/02-evidence.md).

### Conversation context budget

Both the fast and deep layers for a turn receive the same bounded conversation
snapshot: recent completed user/assistant pairs, the current user message, frozen
grounding instructions, and a verified-facts block (actual provider/model pair
and a server timestamp — never a guessed host location). Turns still in progress,
failed, or retrying appear to later turns as an explicit "unresolved request"
note, not as an accepted answer.

```bash
CONTEXT_WINDOW_TOKENS=8192
CONTEXT_MAX_HISTORY_TURNS=12
CONTEXT_SAFETY_TOKENS=256
CHAT_FAST_MAX_OUTPUT_TOKENS=512
CHAT_DEEP_MAX_OUTPUT_TOKENS=2048
```

Startup caps the shared window at the minimum of `CONTEXT_WINDOW_TOKENS` and
any `limits.contextTokens` configured in the model catalog for the selected
fast/deep provider and model bindings. Missing or unlisted limits remain unknown;
unselected models do not constrain the window. Output and safety reserves are
validated against this effective window before providers are constructed.

`CONTEXT_WINDOW_TOKENS` is an application working limit for this prototype, not a
claim about any specific model's real context window; token counts are a
conservative UTF-8-byte-based estimate, not a provider tokenizer. The server
fails to start if the output reserve plus safety tokens would leave no room for
input. `OLLAMA_FAST_NUM_PREDICT` / `OLLAMA_DEEP_NUM_PREDICT` remain authoritative
when explicitly set; otherwise Ollama uses `CHAT_FAST_MAX_OUTPUT_TOKENS` /
`CHAT_DEEP_MAX_OUTPUT_TOKENS`. See [01 — Conversation context](../docs/implementation/01-context.md)
and its [memory extension](../docs/implementation/01-context-memory.md) for the full
design. Internal source-linked memory (01B) is implemented; the visible transcript
is never replaced by a summary.

```bash
CONTEXT_SUMMARY_MODE=extractive  # off / extractive / model
CONTEXT_SUMMARY_TRIGGER_RATIO=0.8
CONTEXT_SUMMARY_MAX_TOKENS=1024
CONTEXT_SUMMARY_TIMEOUT_MS=5000
# Model mode requires explicit opt-in to extra calls on the existing fast binding:
# CONTEXT_SUMMARY_MODEL_BINDING=fast
```

Compression runs in the background over older completed turns; the newest four
pairs stay eligible as exact history. Extractive mode selects verbatim excerpts
with user/assistant attribution and makes no model calls. Model mode uses a
separate bounded internal request and output cap, never the chat queue. Invalid
or timed-out summaries leave bounded history and any still-valid prior memory.

“How do you know”, “check that”, “verify that”, and “what did I say” trigger bounded
source-ID checks for included memory. Original records remain immutable; later
refinements invalidate affected future memory without changing queued snapshots.
Memory is untrusted data, not verified facts. `/telemetry/context` reports counts,
budget estimates and latency without text. All stores remain in memory and reset
on restart. See [01B evidence](../docs/implementation/01b-evidence.md) for acceptance
coverage and the limits of lexical correction/conflict handling and model summaries.

Evaluation reliability thresholds (optional env vars):

```bash
EVAL_MAX_DEAD_LETTER_RATE_DEEP=0.1
EVAL_MAX_AVG_RETRIES_DEEP=1
```

Adaptive routing threshold (optional env var):

```bash
ROUTING_MAX_FAST_P95_MS=1000
TELEMETRY_STORE_PATH=data/latency-telemetry.json
TELEMETRY_SAVE_INTERVAL_MS=5000
DEEP_WORKER_AUTO_RUN=true
DEEP_WORKER_INTERVAL_MS=500
```

Telemetry snapshots are schema-validated on load/save. Invalid or malformed snapshot files are ignored with warnings, and snapshot writes use atomic file replacement.
`ROUTING_MAX_FAST_P95_MS` and `TELEMETRY_SAVE_INTERVAL_MS` are normalized and clamped to safe ranges during startup.
When `DEEP_WORKER_AUTO_RUN=true`, the server drains one deep task per interval tick so provisional replies can refine automatically without manual `/workers/deep/run-once` calls.

UI behavior:

1. `GET /` serves a static control-room page (vanilla HTML/CSS/JS) for desktop and mobile.
2. The page posts to `/messages`, streams timeline updates from `/conversations/:id/events/stream` (SSE), and polls `/telemetry/latency` once per second.
3. Deep-route turns render provisional replies first and then swap in-place to refined replies when background processing completes.
4. Each turn has attached activity with expandable attempt history, model identity,
   separate queue/execution times, and a Stop button. Substantive fast answers remain
   visible when a deep answer arrives as an Update, with each version’s own outcome
   label. Empty failed/incomplete/cancelled phases also retain a visible status. Application acknowledgments can
   be replaced; model depth never implies a correction or verification.
5. SSE snapshots now carry answer deltas and terminal outcomes. The browser rebuilds
   by event sequence/attempt identity on reconnect. Hidden reasoning is never emitted;
   “Reasoning enabled” appears only for an explicitly verified/applied control.
6. When a conversation's history expires, the legacy stream sends a
   `conversation-expired` event before it closes; a page that loads an already
   expired ID learns it from the 410 on the events endpoint. The page then shows a
   notice, keeps the last copy it received as read-only text, disables Send and
   offers "Start a new conversation", which switches to a fresh ID. A full history
   (413) shows the same offer; server conversation capacity (503) is explained in
   the status line because a new ID would not help.

Adaptive routing behavior:

1. Classifies prompt complexity, ambiguity, external-data need, and size band.
2. Seeds provider/model priors for latency percentiles by route and size.
3. Blends priors with live observations as traffic increases.
4. Uses p95 guardrail to escalate moderate requests to deep path when fast-path tail latency is predicted to breach SLO.

## Benchmarking

Run profile benchmark report generation:

```bash
npm run bench:run
```

Set an explicit simulation seed for reproducible benchmark candidates:

```bash
BENCH_SIM_SEED=default-v1
npm run bench:run
```

Run benchmark in live mode against a running local server:

```bash
BENCH_MODE=live
BENCH_BASE_URL=http://localhost:3100
npm run bench:run
```

`BENCH_MODE` must be either `simulate` or `live`; invalid values fail fast.
Benchmark prompt files are validated for non-empty `{ id, text }` records with unique ids.
The benchmark runner executes only when called as a CLI entrypoint, so importing it in tests does not trigger benchmark runs.

Compare candidate benchmark run to baseline with gates:

```bash
npm run bench:compare
```

Compare also enforces benchmark context compatibility (mode, prompt digest, profile digest, and simulation seed when available).
It also requires full profile-set parity (no missing/extra profile names between baseline and candidate).

Optional compare thresholds/env:

```bash
BENCH_BASELINE_PATH=reports/benchmark-summary-baseline.json
BENCH_CANDIDATE_PATH=reports/benchmark-summary.json
BENCH_COMPARE_OUT=reports/benchmark-compare.md
BENCH_MAX_FIRST_P95_REGRESSION_MS=150
BENCH_MAX_FINAL_P95_REGRESSION_MS=300
BENCH_MAX_DEAD_LETTER_REGRESSION=0.05
BENCH_MIN_QUALITY_DELTA=-0.05
```

Threshold values are validated at runtime; invalid values fail compare with explicit configuration errors.

Retention measurements (provider-free; both need `--expose-gc`, which the scripts pass):

```bash
npm run bench:admission-retention
npm run bench:sustained-memory -- --out docs/measurements/sustained-memory-<date>.json
```

`bench:sustained-memory` builds the live-shaped runtime (`CapabilityChat` with
catalog dispatch and the sports registry) and the queue-shaped runtime
(`ChatOrchestrator`, deep worker, dead letters) in one process, drives them over
loopback HTTP past scaled-down limits, and asserts registry sizes after every
round and after shutdown. It exits nonzero when an assertion fails or when
post-warmup heap grows by more than 5% between the first and last third of the
measured rounds. `--measured <n>` lengthens the run and `--heap-only` keeps a long
soak from measuring its own report. The settings, workload, exclusions and raw
samples are in the report; it is not part of `verify:release`.

## Release Verification

Run the full release gate in one command:

```bash
npm run verify:release
```

This runs:

1. tests
2. type-check
3. evaluation report generation
4. benchmark run
5. benchmark compare gates

Artifacts:

1. `reports/benchmark-summary.json`
2. `reports/benchmark-summary.md`
3. `reports/benchmark-compare.md`

## Golden Route Set (end-to-end)

Use the golden set to fully execute the running system against route expectations
and response-shape checks.

1. Start the server (`npm run dev`).
2. Run the golden suite:

```bash
npm run eval:golden
```

Default inputs/outputs:

1. Input cases: `data/golden-prompts.json`
2. JSON report: `reports/golden-eval.json`
3. Markdown report: `reports/golden-eval.md`

Optional env vars:

```bash
GOLDEN_SET_PATH=data/golden-prompts.json
GOLDEN_BASE_URL=http://localhost:3100
GOLDEN_REPORT_JSON_PATH=reports/golden-eval.json
GOLDEN_REPORT_MD_PATH=reports/golden-eval.md
GOLDEN_DEEP_TIMEOUT_MS=120000
GOLDEN_POLL_INTERVAL_MS=400
```

Examples:

1. Fast on Ollama, deep on Bedrock

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
```

2. Fast on Azure, deep on Ollama

```bash
CHAT_FAST_PROVIDER=azure
CHAT_FAST_MODEL=gpt-4o-mini
CHAT_DEEP_PROVIDER=ollama
CHAT_DEEP_MODEL=qwen2.5:14b
```

## Project docs

- Product and scope: `docs/01-product-scope.md`
- Architecture: `docs/02-architecture.md`
- Success metrics: `docs/03-success-criteria.md`
- Evaluation methodology: `docs/04-evaluation-plan.md`
- TDD execution plan: `docs/05-tdd-execution.md`
- Model/provider strategy: `docs/06-model-strategy.md`
- Demo script: `docs/07-demo-script.md`
- Engineering decision log: `docs/08-engineering-decision-log.md`
- Code review (2026-09-25): `docs/09-code-review-2026-09-25.md`
- Class map (open in a browser; eight Mermaid diagrams, loads Mermaid from cdnjs so it needs network access): `docs/10-class-map.html`
- Original UI proposal (partly implemented): `docs/11-ui-plan.md`
- Current roadmap and verification status: `docs/12-development-roadmap.md`
- Executable handoff and milestone acceptance tests: [docs/implementation/README.md](../docs/implementation/README.md)

Effective output limits are resolved once at startup. For an Ollama role, an explicit
`OLLAMA_*_NUM_PREDICT` is used both in its request and in context reservation.
Applicable overrides must be positive integers; invalid or input-exhausting values
fail startup. Azure/Bedrock roles ignore Ollama overrides.

## Capability-planned live chat

Live startup uses `CapabilityChat` on both message APIs. The model sees bounded
conversation history and current registered tool descriptions/schemas. It returns
answer, clarify, unsupported or retrieve. The complete plan is validated before any
of up to three independent read-only calls starts. Unknown tools, invalid arguments
and malformed JSON fail without executing calls. A truncated plan returns
`CAPABILITY_PLAN_TRUNCATED`; increase the configured fast output allowance if needed.
Plans are stored as `capabilityPlan` on answer events, internal JSON deltas are hidden,
and confidence is null. Background tool results appear as refined timeline events
with source evidence and limitations. Cancellation and shutdown signal active reads.

The current registry comes from the briefing profile; no generic search or email tool
is installed. Configuration reload invalidates previously captured tool snapshots.
The planner bypasses heuristic routing and derived summary memory; original recent
turns remain available. Fixed mock-only startup keeps the legacy test/demo behavior.

The manual `POST /sports/chat` endpoint remains available for explicit scope requests:
`{userId, requestId, league, kind, request}`. League must match the profile and kind is
games/news. The request uses the briefing schema with explicit exclusive end `now`
and inclusive `lastSuccessful` timestamps. The model-planning path does not depend
on this endpoint or a sports-specific UI. User IDs remain prototype ownership guards.

## Role catalog

`ROLE_CATALOG_PATH` names an optional role catalog, read once at startup (see
[role configuration](implementation/12-request-to-evidence.md)). The file is read
through one bounded read of at most 1 MiB and decoded as strict UTF-8; a larger,
non-UTF-8, malformed or invalid file fails startup with `ROLE_CATALOG_INVALID`.

After editing that file, apply it without restarting (an operator route: send the
operator token, or use a paired browser session from the page):

```bash
curl -X POST http://localhost:3100/roles/config/reload \
	-H "Authorization: Bearer <operator token>" \
	-H "Content-Type: application/json" -d '{}'
```

- `200 {version, roleIds, sha256}`: the catalog was replaced. `sha256` is the digest
  of the exact bytes read, so you can match it against the file you edited.
- `400 ROLE_CATALOG_RELOAD_FAILED`: the file is unreadable, larger than 1 MiB, not
  UTF-8, malformed or invalid. The active catalog is unchanged, and the reply never
  echoes the file's content or path.
- `404 ROLE_RELOAD_DISABLED`: no role catalog was configured at startup.
- `403 OPERATOR_REQUIRED` for a client-only credential.

The body must be `{}`; any field is rejected with `400`. The route always rereads the
path configured at startup, so changing to a different file still needs a restart.
A reload validates the whole catalog before replacing it, and runs from read to
replace without yielding, so two reloads cannot interleave. Messages already claimed
keep the role snapshot they started with; later messages use the reloaded catalog.
There is no file watcher, automatic reload or UI control.

## Remaining retained-state bounds

The in-memory deep queue limits both task count and serialized task bytes. Defaults
follow `DEAD_LETTER_MAX_RECORDS` and `DEAD_LETTER_MAX_BYTES`; optional
`DEEP_QUEUE_MAX_TASKS` and `DEEP_QUEUE_MAX_BYTES` override them. Overflow rejects
atomically with `DEEP_QUEUE_CAPACITY` (HTTP 503). Initial enqueue failures settle
created attempts and release slots, leases and dispatch references; an already
written user event remains an accepted failed turn. Failed replay enqueue restores
the dead letter. Queue entries own immutable copies. `ChatService.cancelMessage`
removes matching queued entries promptly and releases their dependent resources;
dequeued work keeps its resources until physical settlement. Custom queues without
`removeMessage` retain the previous worker-drain cancellation behavior.

Completed attempt text is cleared only after terminal writes and all workflow/task
consumers settle. Completed dispatch candidates alias their retained replay context
instead of keeping ranking-only copies. Replay still owns `phase.context` and its
candidate metadata; history continues to own answer text.

`TOOL_RESULT_MAX_BYTES` defaults to 16 MiB of aggregate serialized results. The
existing count limit also applies. Oldest results are evicted under either limit;
an individually oversized result throws `RESULT_TOO_LARGE` before evicting live
records. Selection of an evicted handle fails with `RESULT_NOT_FOUND`, so refresh
or detach it. Expiry, retirement and clear all release byte accounting. Timeline
copies remain governed by conversation retention separately.

File telemetry retains one physical write and at most one latest replacement.
Superseded pending `save()` calls share the replacement's completion: successful
resolution means that snapshot or a newer one was persisted. Write failure rejects
that batch's callers without poisoning later writes. Shutdown's final `save()`
replaces pending intermediate snapshots and awaits persistence. The number of
snapshots is bounded; serialized snapshot size still follows estimator/catalog
state, and a stalled disk can still delay shutdown until its timeout.

Discovery listing and retained-observation bounds and completeness rules are in
[the inventory contract](implementation/03-inventory.md). A failed listing never
renews the previous evidence's expiry; absent observations fail closed.
