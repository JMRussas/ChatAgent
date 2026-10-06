# 02 — Thinking controls, answer streaming and cancellation

Status: implemented with offline acceptance evidence in [02 evidence](02-evidence.md).
Live provider validation remains outstanding. Depends on 01A (context revision 2). Preserve the memory/task fields
even if 01B is outstanding. Offline completion uses fake HTTP/event streams.

Read [the activity UI extension](02-activity-ui.md) for per-turn sub-bubble layout,
answer versioning and acceptance cases. It changes later UI work, not context spec 01.

## Outcome and boundaries

Show answer text as it arrives inside its own bubble, with truthful activity states.
Cancellation and truncation are terminal outcomes. Do not expose hidden reasoning
text, add model routing, or change the external POST response shape in this phase.
`POST /messages` still resolves after the fast reply; SSE provides earlier updates.

## Interfaces and owners

Extend provider calls with optional `GenerationControl`:

```ts
interface GenerationControl {
  signal: AbortSignal;
  attemptId: string;
  onDelta: (text: string) => Promise<void>;
}
type FinishReason = "stop" | "length" | "cancelled";
interface GenerationResult { text: string; finishReason: FinishReason }
```

Fast providers return GenerationResult instead of string; deep results gain
finishReason. Update mocks/callers together. Adapter awaits onDelta to bound buffering.
Orchestrator/worker own AbortControllers; adapters must propagate abort to the
actual request/stream. Normalize transport failures into typed errors with
`retryable` and a safe public code. Protocol/auth/context errors are not retryable.
Retry transient failures at most the existing two retries, only before answer text
was emitted. Never concatenate two attempts' text as one answer.

Timeline adds `type: "delta"`, messageId, attemptId, phase (`fast`/`deep`) and text;
every event receives an increasing per-conversation sequence from timelineStore.
Reuse the stable eventId/sequence already introduced by context revision 2; do not
introduce a second event ordering system. Deltas are not eligible memory sources.
Terminal events carry phase, attemptId and finishReason. Existing provisional and
refined events remain authoritative full texts. The UI derives separate fast/deep
drafts; replace app-owned acknowledgments with deep text, but retain substantive
fast answers and display deep text as an attached Update per the UI extension. Late fast
deltas must never replace a deep draft/final answer. A length finish displays
“Incomplete — output limit reached”; it is not complete history for spec 01.

Keep the existing full-snapshot SSE transport initially: cap/coalesce delta writes
to at most one event per 50 ms per attempt, flush pending text before terminal
events, cap each attempted answer buffer at 1 MiB, and reconstruct from sequence
numbers rather than blindly appending on reconnect. Do not stream the whole hidden
reasoning field. Incremental SSE transport is a separate optimization.

## Thinking, configuration and cancellation

- Add `OLLAMA_FAST_THINK=off` and `OLLAMA_DEEP_THINK=default` with enum
  off/on/default. Use model metadata and installed runtime checks before setting
  explicit controls. Unsupported explicit settings fail with a configuration error;
  do not silently pretend they were applied. Pass Ollama `think` at its documented
  request location. Do not assume a coding model has a thinking toggle.
- Reuse spec 01 output limits; do not increase them automatically on error.
  Other providers keep default thinking behavior until their adapters explicitly
  implement and verify controls. Label deep activity “Working on a deeper answer”;
  show “Reasoning enabled” only when the setting is verified by the adapter.
- Streaming implementations: Ollama chat NDJSON, Azure streaming response frames,
  Bedrock supported streaming operation. Decode split UTF-8/codepoints and partial
  frames; reject malformed/oversized streams with a terminal failure.
- Add optional client-generated UUID `messageId` to POST /messages (server allocates
  one when absent). Atomically reject duplicate IDs in a conversation with 409.
  The UI allocates before submission, enabling a Stop button before POST resolves.
- Add `POST /conversations/:id/messages/:messageId/cancel`. Return 404 unknown,
  200 with existing state if already terminal, 200 cancelled otherwise. Cancellation
  aborts fast/deep attempts, marks queued tasks cancelled so workers skip them,
  emits one terminal cancellation per active phase, and suppresses late chunks.
  Do not retry/dead-letter cancellation. Cancellation before request registration
  returns 404; UI retries once after observing the user event, not indefinitely.
- Cancellation during preparation (2026-10-06). A legacy turn registers a
  preparation controller from its history check until it ends, so a cancel reaches
  it while it captures context or waits for quota in catalog admission,
  before any attempt exists. If its user-event append has not begun, the turn ends
  with no history, attempt, queue entry or provider call, and its reservations
  are released. The cancel answers 200 `{messageId, phases: {}, preparation:
"cancelled"}`, and the message request answers 409 `{code: "CANCELLED"}`, as
  any `GenerationError` `CANCELLED` now does (capability turns included, and v1
  submissions through the same mapping). The message ID never entered history and
  may be sent again. If cancellation arrives during the user-event append, the
  append completes and the turn's attempts are created and immediately cancelled,
  so history records the cancellation;
  nothing is queued and no provider starts. Shutdown cancels every preparing turn
  and refuses turns that enter the orchestrator afterwards. Capability turns pass
  their attempt signal, combined with the workflow deadline in evidence and review
  modes, so a quota wait ends as `CANCELLED` or `WORKFLOW_DEADLINE`.
  `CatalogDispatch.prepare` never reports an abort as `NO_ELIGIBLE_MODEL` and
  does not try further candidates after one. Until it returns a plan it owns every
  reservation and registered phase, and releases them on any failure; started
  consumption is never refunded.
- Browser navigation/SSE disconnect does not cancel model work. A failed SSE
  connection displays “Live updates reconnecting” in affected active bubbles;
  reconnect replaces drafts from the authoritative snapshot.

## Acceptance and files

Update provider adapters/interfaces, domain types, orchestrator, queue control,
timelineStore, server and homePage. Add streaming parser and generation lifecycle tests.

1. Split NDJSON/SSE/UTF-8 chunks reconstruct the exact answer once after reconnect.
2. Partial answer appears before terminal event; late fast text cannot overwrite
   the deep update, and substantive earlier answers remain visible.
3. Both empty and nonempty length finishes are incomplete, with no normal success tag.
4. Cancel queued/running/completed turns; no retry, no late UI resurrection.
5. Timeout after headers aborts body; malformed stream stops spinner and reports failure.
6. Retry before output uses new attemptId; failure after output preserves incomplete
   text and does not restart generation automatically.
7. Unsupported thinking control is explicit; no reasoning text enters events/history.
8. Mock streaming provider plus HTTP/SSE test observes a delta before completion.

Run common checks; live provider stream tests are opt-in and record runtime version.
