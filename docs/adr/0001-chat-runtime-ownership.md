# ADR 0001: Shared chat runtime ownership and protocol v1

2026-09-26 companion direction: [ADR 0002](0002-layered-context-and-orchestration.md)
distinguishes chat generation from persistent Hekate objectives, specifies context
policies by layer, and separates execution telemetry from future learning.
It adds a prompt-encoding experiment; it does not claim orchestration migration.
Read the implementation checkpoint at the end of this ADR for superseded proposal details.

Status: Proposed. 2026-09-25. Written per [NEXT-HANDOFF.md](../implementation/NEXT-HANDOFF.md)'s
bounded task. No code migration, deployment, or live verification occurred while
writing this ADR. It supersedes the "trace before deciding" instruction in
[07 — shared chat runtime](../implementation/07-shared-chat-runtime.md); the
tracing is done and cited below.

## Context

Three repositories independently do chat/context/provider work and want to
converge: **ChatAgent/ChatRuntime** (this repo — TypeScript, bounded conversation
context per spec 01A, in-memory only), **Hekate** (Python orchestration + C#
context-store, deployed via NSSM to a persistent Windows host, gods pipeline for
unrelated code-task execution), and **Iris** (WPF desktop client, standalone
Claude-Code-CLI adapter, and an existing but shallow Hekate chat integration).

This section records what two read-only investigations actually found in the
Hekate and Iris repos (agents `a76432683ad9aee00` and `a51f9c977a0137df0`, both
2026-09-25), not what the earlier planning notes assumed. Every claim below has
a file:line citation available in those agent transcripts; only the conclusions
are repeated here.

### Hekate: what's actually live

- `orchestration/backend/routes/chat.py`'s router **is** mounted and live:
  `app.py:46` imports it, `app.py:337` does
  `app.include_router(chat_router, prefix="/api")` with an explicit comment
  "Chat routes — no auth for now." This runs as part of the HekateEngine
  service (port 5200, per `run.py`).
- `chat_agent.py`'s streaming chat calls context-store's
  `POST /api/brain/conversation`, `/resolve`, `/assemble`, and `/turn` (mapped
  in `context-store/Api/Program.cs:432-485` to `InterpreterService`,
  `ContextAssembler`, and `ChatService`). **Critically: the assembled
  context-store output only feeds the system prompt text. The actual message
  array sent to the model is built from client-supplied `messages` only**
  (`chat_agent.py:417-418`). Context-store is not the source of conversational
  turn history for the model call — the caller has to resend it.
- **The gods pipeline (Odin) is not part of the chat path at all.**
  `chat_agent.py` never imports anything under `Odin/`, calls Ollama and
  Anthropic directly, and does not go through `llm-gateway`. Gods is a fully
  separate subsystem for code-task execution (Athena → Hermes → Mimir). The
  only shared touchpoint found is that gods separately calls llm-gateway for
  CLI availability — chat doesn't use llm-gateway at all. `model_router.py`,
  `model_discovery.py`, `provider_quota.py`, and the orchestration-level
  `cli_provider.py` are used exclusively by the legacy/gods-adjacent execution
  path, never imported by `chat_agent.py`.
- `executor.py`/`task_lifecycle.py`/`sentinel/` (CLAUDE.md-marked legacy) are
  confirmed unreachable from chat.
- `ContextAssembler`/`EmbeddingService` are real, wired, and invoked by the
  live `/api/brain/assemble` route — not aspirational, contrary to how the
  original consolidation note framed them ("candidates to evaluate"). They are
  in the request path today.
- Conversation identity is a bare `Guid ConversationId`, with an optional
  `Guid ThreadId` and no separate turn-id type
  (`Program.cs:577-580`). **No project ID, account ID, or auth token appears
  anywhere in the `/api/brain/*` or `/api/chat/stream` routes.** There is no
  isolation boundary today — any caller with network access to port 5200/5102
  can read or write any conversation by guessing/enumerating its GUID.
- Failure handling is good: `context_store_client.py`'s circuit breaker
  (`:67-93`) returns `None` on repeated failure, and `chat_agent.py` degrades
  to an ungrounded chat rather than hanging or crashing.
- Odin's own CLI provider abstraction (`Odin/gods/providers/`) is **actually
  wired** into `hermes_async.py` — CLAUDE.md's "built, not wired" annotation is
  stale. This is unrelated to chat but relevant to spec 05's design.

### Iris: what's actually live

- `ChatSessionManager`'s SSE handler receives `conversation_id` from Hekate and
  **discards it** — confirmed verbatim: a comment says the backend manages
  history per conversation_id, then returns without storing it
  (`ChatSessionManager.cs:1546-1556`).
- The value actually sent as `conversation_id` is `session.ProjectId`
  (`ChatSessionManager.cs:1379-1384`), which is **the same value for every
  task-derived session under one Hekate project**, and **null** for ordinary
  project-tab chat sessions. Two concurrent task sessions in the same project
  send an identical conversation_id to Hekate today — a real collision, not a
  hypothetical one.
- The "reusable SSE parser" (`irischat.hekate/SseEventParser.cs`) does only
  transport framing and is not used by the production chat path;
  `ChatSessionManager` hand-parses SSE lines itself
  (`ChatSessionManager.cs:815-838, 1471-1597`). It does not distinguish
  activity from answer content structurally — that distinction is made ad hoc
  in the hand-rolled switch.
- `IAgentProvider` is a complete, real contract, and `LocalAgentProvider`
  (spawns the `claude` CLI, streams `stream-json`) implements all of it with no
  stubs — a genuine standalone adapter, independent of Hekate.
- `SessionArchiver` **does** destroy the active/reachable history on archive:
  it replaces the session's live message list with `[summary, ...recentKept]`
  and overwrites the JSON store (`SessionArchiver.cs:205-214`,
  `ChatHistoryStore.cs:32-45`). The full transcript survives only in a separate
  markdown archive directory, not reachable through the normal chat-history
  load path — confirming the risk the planning note only speculated about.
- `ContextBuilder.cs` is real and used, but **only** for the local-CLI-agent
  and inter-agent-routing paths, never for the Hekate-streaming path
  (`SendMessageAsync`, `ChatSessionManager.cs:1366-1464`, has no
  `ContextBuilder` reference at all).
- `ChatHistoryStore` persists by Iris's own local `sessionId`, with no
  `conversation_id`/`ProjectId` in the file — local history round-trips on
  restart, but the value sent to Hekate as conversation scope is **not**
  derived from or reconciled with anything persisted. A restart does not
  actually resume a coherent Hekate-side conversation today.
- No user/account/tenant concept exists anywhere in Iris — only
  project/repo-path workspace scoping, using the same `ProjectId` field that's
  conflated with conversation identity above.

### What this changes about the plan

The original notes treated Hekate as "an integration candidate with reusable
context/retrieval assets to evaluate." The evidence supports a narrower claim:
**Hekate's context-store is a real, durable persistence asset (Postgres +
AGE + pgvector, already deployed) worth reusing, but its chat request-handling
logic (`chat_agent.py`) is less correct than what ChatAgent's spec 01A already
does** — it doesn't feed real turn history back to the model from its own
store, and it has no auth/isolation boundary at all. Porting ChatAgent's
context/budget logic into Python to live inside Hekate would mean re-deriving
and re-verifying already-tested behavior in a second language, for a net
correctness regression versus what exists today in ChatAgent.

## Decision

**Host the chat runtime as an independent, standalone-capable service — this
repository (ChatRuntime) — reached over a versioned HTTP/SSE protocol by both
Iris and any Hekate-side chat consumer. Reuse Hekate's context-store as
ChatRuntime's durable persistence backend via a new adapter, rather than
building new storage or porting context logic into Hekate's Python codebase.**

Concretely:

- **Runtime/request-handling owner: ChatRuntime.** All context building,
  budgeting, active-task tracking, provider selection/dispatch, and generation
  lifecycle (specs 01–06) continue to live here, in TypeScript, where they are
  already implemented and tested. Hekate's `chat_agent.py` does not gain new
  responsibilities under this decision; a follow-on migration (out of scope for
  this ADR) would have it stop calling providers directly and instead proxy
  through ChatRuntime, once the vertical slice below has parity evidence.
- **Persistence owner: pluggable, with context-store as the first durable
  backend.** ChatRuntime already separates timeline/context storage behind
  `ConversationTimelineStore`. Add a context-store-backed implementation that
  calls Hekate's `/api/brain/*` endpoints, so ChatRuntime gains durability
  without ChatRuntime or Hekate each building their own database. In-memory
  storage remains the default for standalone/local use.
- **Standalone mode is a hard requirement, not a nice-to-have.** ChatRuntime
  must run fully offline against in-memory/mock providers, exactly as it does
  today, with zero dependency on Hekate. Iris's `LocalAgentProvider` (a real,
  independent CLI adapter) is the proof this matters: Iris already has a
  legitimate no-shared-runtime mode, and the design must not break it.
- **Auth/project isolation: a declared protocol field now, not deferred
  further.** Neither Hekate's chat/context-store APIs nor Iris have any
  auth/tenant concept today (confirmed above — a bare, unauthenticated GUID is
  the entire boundary). Protocol v1 (below) requires `accountId` and
  `projectId` on every request. Today's callers may pass a single fixed value,
  but the field exists so enforcement can be added without a breaking protocol
  change, and so this ADR doesn't quietly ratify the current no-auth state as
  permanent.
- **Credentials boundary: ChatRuntime holds provider credentials, as it does
  today** (Azure/Bedrock/Ollama/CLI). `chat_agent.py` currently holds its own
  Anthropic/Ollama credentials and calls providers directly — that duplicate
  credential surface should be retired once the vertical slice has parity, not
  before.
- **Versioning/migration/rollback:** every request/event carries
  `protocolVersion: "1.0"`; evolve additively. Each client keeps an explicit
  rollback switch to its pre-migration path until parity tests pass (Iris:
  `UseSharedChatRuntime` config flag; existing direct-Hekate path stays intact
  and default-on until the switch flips).
- **Service-failure behavior:** if ChatRuntime is unreachable, Iris falls back
  to `LocalAgentProvider` (standalone CLI) rather than losing the user's
  message, and shows an explicit "shared runtime unavailable" state — never a
  silent drop. If the context-store persistence backend fails, ChatRuntime
  degrades the same way `context_store_client.py`'s circuit breaker already
  does for Hekate: keep the in-memory session usable, mark durability as
  degraded, never crash the turn.

### Alternatives considered

1. **Integrate chat runtime behavior fully into Hekate (Python).** Rejected.
   Would require re-implementing and re-verifying spec 01A's context/budget
   logic in Python, discarding a working, tested implementation, to land inside
   a codebase whose own CLAUDE.md documents an active/legacy path-confusion
   problem. Hekate's existing chat logic is demonstrably less correct
   (client-only history, no auth) than what already exists here.
2. **Keep three independent chat stacks, share only documentation.** Rejected
   per the original consolidation intent — this is the status quo the
   consolidation effort exists to fix, and it's what produced Iris's confirmed
   conversation-identity bug and destructive archiving in the first place.
3. **ChatRuntime owns both logic and storage (no context-store reuse).**
   Rejected for now: Hekate's context-store is the only durable, already-
   deployed persistence asset among the three repos (Postgres + AGE +
   pgvector). Building a second database purely for ChatRuntime before proving
   the vertical slice would be premature; revisit if the context-store adapter
   proves a poor fit during the slice.

## Protocol v1 proposal

Identity fields, in order of scope: `accountId` (new — declared boundary, not
enforced anywhere today), `projectId` (maps to Hekate/Iris `ProjectId`, but
**no longer doubles as conversation identity** — this is the fix for the
confirmed Iris collision bug), `conversationId` (maps to Hekate's
`ConversationId` Guid), `messageId` (client-generated UUID, idempotency key,
matches ChatAgent's existing `messageId`), `taskId` (deep job, matches
ChatAgent's `DeepTask.taskId`), `attemptId` (per spec 02, one per execution
attempt including retries).

```ts
// POST /v1/conversations/{conversationId}/messages
interface SubmitTurnRequest {
  protocolVersion: "1.0";
  accountId: string;
  projectId: string;
  messageId: string;          // client-generated UUID; server rejects a duplicate with 409 IDEMPOTENT_REPLAY
  text: string;
  clientTimestampIso: string;
}

interface SubmitTurnResponse {
  protocolVersion: "1.0";
  conversationId: string;
  messageId: string;
  fastResponse: { provisionalReply: string; routeDecision: "direct" | "deep" | "clarify"; processingStatus: "provisional" | "complete" };
  deepTask?: { taskId: string };
}

// GET /v1/conversations/{conversationId}/events/stream  (SSE, replaces snapshot polling once spec 02 ships)
// Reconnect: client sends ?afterSequence=N; server replays from its persisted event log.
interface TurnEvent {
  protocolVersion: "1.0";
  conversationId: string;
  messageId: string;
  taskId?: string;
  attemptId?: string;
  sequence: number;                                  // strictly increasing per conversation; the reconnect/dedupe key
  type: "delta" | "activity" | "answer" | "terminal";
  phase: "fast" | "deep";
  activity?: "queued" | "running" | "retrying" | "failed" | "cancelled";
  answerRevision?: number;                            // increments each time a *displayed* answer for this messageId is superseded (provisional -> refined)
  text?: string;                                      // delta chunk, or full answer text for "answer"/"terminal"
  finishReason?: "stop" | "length" | "cancelled" | "error";
  model?: { bindingId: string; provider: string; model: string; revision?: string };
  usage?: Record<string, number> | null;              // null means "not reported", never assume zero cost
  createdAtIso: string;
}
```

### Example fixture: one Iris fast/deep turn

The outer object is a fixture envelope: `conversationId` supplies the URL path,
`request` and `response` are HTTP bodies, and each `events` element is an SSE
JSON payload. Envelope keys are not sent as wire fields. The answer text is
synthetic test data, not a factual or retrieval claim.

```json
{
  "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
  "request": {
    "protocolVersion": "1.0",
    "accountId": "acct-1",
    "projectId": "iris-proj-42",
    "messageId": "b2c10000-0000-4000-8000-000000000001",
    "text": "Find latest inflation data and cite sources",
    "clientTimestampIso": "2026-09-25T18:20:00.000Z"
  },
  "response": {
    "protocolVersion": "1.0",
    "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
    "messageId": "b2c10000-0000-4000-8000-000000000001",
    "fastResponse": {
      "provisionalReply": "Your request is queued for deeper analysis.",
      "routeDecision": "deep",
      "processingStatus": "provisional"
    },
    "deepTask": {
      "taskId": "99100000-0000-4000-8000-000000000001"
    }
  },
  "events": [
    {
      "type": "activity",
      "sequence": 1,
      "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
      "messageId": "b2c10000-0000-4000-8000-000000000001",
      "taskId": "99100000-0000-4000-8000-000000000001",
      "phase": "deep",
      "activity": "queued",
      "createdAtIso": "2026-09-25T18:20:00.050Z",
      "protocolVersion": "1.0"
    },
    {
      "type": "activity",
      "sequence": 2,
      "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
      "messageId": "b2c10000-0000-4000-8000-000000000001",
      "taskId": "99100000-0000-4000-8000-000000000001",
      "attemptId": "a-1",
      "phase": "deep",
      "activity": "running",
      "createdAtIso": "2026-09-25T18:20:00.400Z",
      "protocolVersion": "1.0"
    },
    {
      "type": "delta",
      "sequence": 3,
      "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
      "messageId": "b2c10000-0000-4000-8000-000000000001",
      "taskId": "99100000-0000-4000-8000-000000000001",
      "attemptId": "a-1",
      "phase": "deep",
      "text": "Inflation is ",
      "createdAtIso": "2026-09-25T18:20:01.100Z",
      "protocolVersion": "1.0"
    },
    {
      "type": "terminal",
      "sequence": 4,
      "conversationId": "8f14e45f-ea3b-4a83-9d70-0d46edccaa01",
      "messageId": "b2c10000-0000-4000-8000-000000000001",
      "taskId": "99100000-0000-4000-8000-000000000001",
      "attemptId": "a-1",
      "phase": "deep",
      "finishReason": "stop",
      "answerRevision": 1,
      "text": "Inflation is 3.1% per the latest report.",
      "model": {
        "bindingId": "ollama:qwen2.5:14b",
        "provider": "ollama",
        "model": "qwen2.5:14b"
      },
      "usage": null,
      "createdAtIso": "2026-09-25T18:20:03.200Z",
      "protocolVersion": "1.0"
    }
  ]
}
```

The fixture is checked against the interfaces above by
`tests/unit/protocolFixture.test.ts`; protocol v1 endpoints remain planned.

### Field mapping (today's systems → protocol v1)

| Today | System | Protocol v1 field | Note |
|---|---|---|---|
| `ConversationId` (Guid) | Hekate context-store | `conversationId` | Direct mapping. |
| `ThreadId` (Guid, optional) | Hekate context-store | *(not mapped yet)* | No equivalent concept in ChatAgent today; open question below. |
| `session.ProjectId` sent as conversation scope | Iris `ChatSessionManager` | `projectId` (isolation only) + a real `conversationId` | **Fixes the confirmed collision bug** — Iris must generate and persist a real per-conversation UUID instead of reusing `ProjectId`. |
| `messageId` | ChatAgent | `messageId` | Direct mapping, already correct. |
| `taskId` | ChatAgent | `taskId` | Direct mapping. |
| *(none)* | Hekate, Iris | `accountId` | New — declared boundary; see auth note above. |
| SSE `conversation_id` event (discarded) | Iris | *(removed)* | Superseded — the request itself carries `conversationId`; no separate SSE identity event needed. |
| Hand-rolled SSE switch | Iris `ChatSessionManager` | `TurnEvent.type`/`.activity` | Iris should consume the generic parser (`irischat.hekate/SseEventParser.cs`) for framing and this typed event for semantics, retiring its duplicate hand-rolled switch. |

## Reconciliation with 01B and specs 02–06

**Reused as-is:**
- ChatAgent's `contextBuilder`/`ContextManager` (budget, active-task tracking,
  grounding) becomes the canonical context logic behind protocol v1 — no
  Python port.
- Iris's `IAgentProvider`/`LocalAgentProvider` is a real, working standalone
  CLI adapter — a strong reference/candidate for spec 05's `CliAdapter`
  contract (same shape: inspect readiness, execute, stream events), though it
  is C# and spec 05's adapter is TypeScript, so this is a design reference, not
  shared code.
- Odin's CLI provider registry pattern (`Odin/gods/providers/`, actually wired
  despite the stale CLAUDE.md note) validates the registry-based adapter
  approach spec 05 already proposes.

**Adaptations needed before 01B can use context-store as its source store:**
- Hekate's `/api/brain/assemble` returns a digest for the system prompt, not an
  ordered raw-turn list. 01B's source store needs to retrieve exact prior
  messages by ID for `resolveSources()` — this requires either a new
  context-store endpoint (list turns by conversationId, ordered) or building
  01B's `SourceStore` as a ChatRuntime-side cache seeded from `/api/brain/turn`
  writes, so ChatRuntime remains the source of truth for provenance rather than
  re-deriving it from Hekate's digest output.
- Iris's `SessionArchiver` destructively replaces active history down to a
  summary. Under this ADR, ChatRuntime becomes the authoritative history
  keeper for Hekate-routed conversations; Iris's local `SessionArchiver`/
  `ChatHistoryStore` remain in use only for the standalone/local-CLI path
  (`LocalAgentProvider`), where Iris is the only party and its own retention
  rules apply.
- The declared `accountId`/`projectId` fields need real values from somewhere;
  today nothing in Hekate or Iris issues them. The vertical slice below can use
  a single fixed placeholder value without blocking on building real auth.

**Sequencing:** 01A is preserved unchanged. 01B (summarization/source lookup)
should design its `SourceStore` interface with the context-store adapter above
in mind, but does not need to wait for the vertical slice below to land — the
interface can be added now, with in-memory as its only implementation until
the context-store adapter exists. Spec 02 (streaming/cancellation) must land
before implementing the vertical slice. Its mid-answer reconnect and queued/running
cancellation acceptance tests require that lifecycle support. Existing snapshot SSE
is not a substitute; no pre-02 compatibility milestone is defined here.

## Next vertical slice

Route **one Iris project-tab chat session** (not task-derived, to sidestep the
`ProjectId` collision entirely for the first slice) through ChatRuntime instead
of directly through Hekate's `/api/chat/stream`, behind a feature flag.

1. Iris generates a real per-conversation UUID on session creation and persists
   it in `ChatHistoryStore`'s JSON file (fixing the confirmed identity gap).
2. Add `IChatRuntimeClient` in Iris (parallel to `OrchestrationClient`), posting
   to ChatRuntime's `POST /v1/conversations/:conversationId/messages`.
   Refactor `ChatSessionManager`'s SSE handling to consume
   `irischat.hekate/SseEventParser.cs` for framing (finally using the
   "reusable" parser) plus the new typed `TurnEvent` semantics, retiring the
   hand-rolled switch for this path.
3. `UseSharedChatRuntime` config flag in `iris/config.json`; off by default,
   existing direct-Hekate path unchanged when off.
4. ChatRuntime's existing mock/Ollama provider pair answers fast+deep; no new
   provider work required for the slice itself.

**Acceptance tests** (offline, fixture-based, per 07's required fixture list):

- Two-turn continuity: second Iris message's context includes the first
  exchange, verified against ChatRuntime's `contextBuilder` output.
- Reconnect without duplicate text: kill and reopen the SSE connection
  mid-answer; reassembled text matches a non-interrupted run exactly once.
- Cancellation: cancel a queued/running deep task; no retry, no resurrected
  text.
- Concurrent isolation: two conversations opened in the same Iris project
  (proving the `ProjectId`-collision bug is actually fixed, not just
  documented).
- Partial failure: fast provider fails, deep still completes and is shown.
- Late deep update: deep answer arrives after the fast reply is already
  displayed; UI shows the refined answer, not a duplicate bubble.
- Rollback: flag off leaves Iris's existing direct-Hekate path passing its
  current tests unchanged.

## Open / unresolved decisions

- Whether Hekate's `ThreadId` concept should be adopted into protocol v1 (no
  ChatAgent equivalent exists today) — deferred until a concrete use case
  needs it.
- Real `accountId` issuance/verification — no auth exists anywhere today across
  all three repos; this ADR only reserves the field.
- Whether the context-store persistence adapter is built in this repo (a thin
  HTTP client) or whether context-store gains a new "list turns" endpoint
  first — depends on confirming the exact shape needed by 01B's `SourceStore`,
  not yet designed against a real backend.
- Whether `IrisChat.Hekate.OrchestrationClient` (a second, near-duplicate class
  found alongside `iris/Clients/OrchestrationClient.cs`) is the one actually
  live at runtime — the investigating agent could not confirm which copy
  `ClientFactory` wires up; needs to be resolved before implementing step 2 of
  the vertical slice above.
- Whether `context-store/Program.cs` (a second, root-level entry point distinct
  from `Api/Program.cs`) is dead code or an alternate deployment — unresolved;
  does not block this ADR since `Api/Program.cs` is confirmed to be the one
  actually serving port 5102.

## Evidence

Full cited findings are in the transcripts of investigation agents
`a76432683ad9aee00` (Hekate) and `a51f9c977a0137df0` (Iris), run 2026-09-25
against the working trees at `D:\Git\Hekate` and `D:\Git\Iris`. No files in
either repo were modified during the investigation. This ADR itself required
no ChatRuntime code changes; `npm run verify:release` was not re-run because
nothing in `src/` changed.

## 2026-09-25 implementation checkpoint

The bounded Iris project-tab slice is implemented. See
[implementation evidence](../implementation/07-iris-slice-evidence.md) for the
confirmed active client trace, in-memory persistence decision, concrete wire
refinements, cancellation and failure behavior, and acceptance evidence. That
checkpoint supersedes proposal wording above where they differ. In particular,
there is no automatic CLI fallback after ambiguous submission, and duplicate
requests use the existing `DUPLICATE_MESSAGE_ID` code. Durable storage/recovery,
authentication and real desktop/live-provider validation remain outstanding.
