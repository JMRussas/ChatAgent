# Iris protocol v1 slice — 2026-09-25

Iris companion commit: `6735478` (`feat: add opt-in ChatRuntime project chat with replay and cancellation`).

Implemented as an opt-in, text-only project-tab integration. Runtime logic stays
in ChatRuntime; durable context-store integration is deferred. Hekate is unchanged.

## Source trace and decisions

`Iris.MainWindow` constructs `Iris.Clients.ClientFactory` and
`Iris.Services.ChatSessionManager`. The factory resolves the app-local
`Iris.Clients.OrchestrationClient`, not the similarly named shared-library client.
The manager uses `IrisChat.Core.Services.ChatHistoryStore`, not its legacy
app-local duplicate. Ordinary `ChatInput.SubmitAsync` previously launched
`StartCliSessionAsync`; the feature flag now selects the shared path there too.
Explicit commands, mentions, externally claimed sessions, Lily and task sessions
retain their existing routing.

Persistence is **in memory for this slice**. Iris persists a UUID per local
session in atomic JSON files under `chat-history/conversation-identities/`.
Message JSON remains backward compatible; retention and transcript clearing do
not change conversation identity. The scope is declared account + project +
conversation, mapped to a private runtime timeline. This separates accidental
scope collisions; it is not authentication or a multi-tenant security boundary.
The default account is the explicit `iris-local` placeholder.

Restarting ChatRuntime loses context, events, duplicate claims, cancellation
state and queued work. Iris history/UUIDs survive but are **not rehydrated into
runtime context**. Reconnect carries `runtimeId` and fails explicitly after a
restart; no durable replay claim is made. An application restart also does not
resume an outstanding turn. Durable recovery remains future work.

## Implemented protocol

- `POST /v1/conversations/{UUID}/messages`: ADR request fields; response includes
  `runtimeId`, flattened fast route/status and optional deep task ID. Status also
  supports `incomplete`, `cancelled`, and `failed`. An accepted generation failure
  returns 200 with failed status so the terminal/partial text can be consumed;
  validation and budget rejections remain errors. Duplicate ID: 409
  `DUPLICATE_MESSAGE_ID` (the existing lifecycle code, superseding the proposed
  `IDEMPOTENT_REPLAY` spelling).
- `GET /v1/conversations/{UUID}/events/stream`: required `accountId` and `projectId`
  query fields, optional `afterSequence` (default 0) and reconnect `runtimeId`. A
  `Last-Event-ID` header, when present, is also a cursor; the later one applies
  (see the runtime reference).
  `ready` supplies the process identity; individual `turn` frames have SSE IDs
  and the same sequence in JSON. Only records after the cursor are emitted.
  User records are omitted, so sequence gaps are valid. Invalid/ahead cursors
  fail instead of hanging silently. Legacy snapshot SSE remains supported.
- `POST /v1/conversations/{UUID}/messages/{UUID}/cancel`: same scope query fields;
  cancellation uses the existing shared fast/deep lifecycle.
- `provisional`/`refined` project to `answer`; revisions use timeline sequence.
  Model bindings are fixed `fast`/`deep`, usage is unavailable (`null`).
  `retrying`, `answerKind`, and expanded processing status are additive fields.

The Iris client submits once, reconnects reads up to three times, deduplicates
by sequence and cancels server work on cancellation or interrupted transport.
Cancellation retries a short acceptance race; if transport is unavailable, the
UI reports a local stop/requested cancellation rather than asserting server stop.
No automatic local-agent retry follows an ambiguous submission failure.
This deliberately supersedes the ADR's proposed automatic unavailable-runtime
fallback; disabling the flag restores the existing route without risking a
second execution of an accepted turn.

Fast and deep results share one retained turn bubble with separate answer/update
text and outcome labels. Terminal attempts freeze; newer answer snapshots replace
streamed deltas. The app acknowledgment exception cannot overwrite useful text.
Only one shared turn runs per Iris session at a time. `/cancel` stops it.
Attachments are explicitly rejected by this text-only path rather than dropped.

## Validation

- ChatRuntime protocol HTTP tests: two-turn context; duplicate submissions;
  project/conversation isolation; delta before POST completion; cursor replay;
  restart/ahead/invalid cursor rejection; partial fast failure; queued and running
  deep cancellation; suppression of late output and retries.
- Existing lifecycle/context tests retain budget, frozen-context and cancellation
  coverage. 01B summaries/source lookup are outside this slice.
- Shared `protocol-v1-turn.json` fixture is identical in both repos and consumed
  by TypeScript projection and C# rendering tests.
- Iris tests cover reconnect without resubmission, duplicate event suppression,
  cancellation acceptance race, failed POST wakeup, terminal freeze, answer
  replacement, persistent/concurrent identity creation, feature selection,
  manager two-turn continuity and one bubble per turn.
- Selected Iris suite: 108 passed; core history store: 17 passed.
- Separate ephemeral C# executable against a temporary Node HTTP/SSE server:
  two-turn context and running cancellation passed. Used deterministic providers,
  no secrets or live model calls. Temporary server stopped afterward.
- Final ChatRuntime gate: 209 tests / 39 files, type checking, evaluation and
  seeded simulated benchmark comparison passed. Build passed. Existing
  development processes were not restarted.

Real WPF interaction and live provider certification remain unexecuted. This is
an offline-verified opt-in slice, not production auth, persistence or rollout.

## Enable and roll back

In Iris `config.json`, set `useSharedChatRuntime` to true and set
`chatRuntimeUrl` to the running ChatRuntime URL (default `http://localhost:3100`).
Restart Iris to reload configuration. Ordinary unmentioned project-tab text uses
the runtime; `/cancel` requests cancellation. Keep the runtime process alive for
multi-turn context. Set the flag false and restart Iris to restore prior routing.
The committed default is false.

## Review follow-up

Review fixed a duplicate-submission cleanup bug: a rejected duplicate must never
cancel the original accepted turn. A regression test verifies zero cancellation
requests after a 409 submission rejection. Interrupted views now freeze active
phases with a truthful local outcome instead of retaining a running label, while
completed early answers survive. Reconnect also validates the ready-frame runtime
identity. The selected Iris suite passed again after these fixes (108 tests).
