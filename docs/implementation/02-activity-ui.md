# 02 UI extension — Activity sub-bubbles and answer updates

Status: implemented with spec 02, 2026-09-25; see [acceptance evidence](02-evidence.md).
Real-browser/mobile verification remains assigned to spec 06.
This extension does not change spec 01, its v2 interfaces, memory policy or acceptance
criteria. The current context implementation can continue without rework.

## Turn layout

One user turn owns its answer, a compact attached activity sub-bubble, and any
subsequent substantive update. Key all views by messageId; activities also carry
phase and attemptId. Never attach progress to the latest visible bubble by position.

- Show one current activity by default, with expandable completed step history.
- Keep activity smaller and visually muted, distinct from generated answer text.
- Before text exists, show an assistant placeholder with its activity sub-bubble.
- Display actual model identity when known: “Working on a deeper answer · <model>”.
- Allowed states: Queued, Working, Generating, Retrying, Complete, Incomplete,
  Cancelled, Failed. Map server events to these states; do not invent steps.
- “Running tests”, “Checking sources” and similar labels require corresponding
  tool-execution events. Deep routing by itself does not mean verification occurred.
- “Reasoning enabled” is an optional badge only when adapter metadata confirms
  an explicitly supported/applied setting. Do not label every deep call “Thinking”.
- Show elapsed time using server attempt start/end timestamps. Queued time is
  separate from active execution time. Do not fabricate percent-complete or ETAs.
- On success, collapse activity to a small completed indicator with expandable
  history. Failure, cancellation and incomplete output stay visible without a spinner.
- Keep elapsed-time ticking local to the activity node; do not rebuild the answer
  DOM every second or announce every timer tick to screen readers.
- Use accessible status text, keyboard-operable disclosure/Stop controls and
  reduced-motion support. Reconnecting is a transport indicator, not a model failure.

## Preserve substantive answers

Add optional answerKind `acknowledgment`/`substantive` to answer events. Missing
means substantive. Only application-owned placeholders/fallback acknowledgments
are automatically marked acknowledgment; do not guess from string length. Treat
free-form fast model output conservatively as substantive.

An acknowledgment may be replaced by a deep draft/final answer. If the fast reply
contains substantive text, keep it and render the deep draft in an attached Update
sub-bubble. Completion freezes that version; never silently rewrite the earlier
advice. Late fast deltas cannot modify the deep draft or completed update.

Use “Update” by default. “Correction” requires explicit correction metadata with a
short explanation of the changed claim and supporting evidence references. Do not
infer truth from model depth, elapsed time or model self-confidence. Automatic
contradiction detection/verification is not required by this UI milestone.

Answer versions remain in the transcript. This display rule does not change spec
01's accepted-history selection: the latest completed refined answer remains the
selected assistant answer; retaining earlier versions for audit is separate.
No status text, step history or hidden reasoning enters conversation memory.

## Acceptance additions to spec 02

1. Two concurrent turns display independent attached activities, model names and timers.
2. With no answer yet, activity appears in that turn's assistant placeholder.
3. Substantive fast reply survives a deep update; an app acknowledgment can be replaced.
4. Retry history expands without duplicating answer text; terminal failures stay visible.
5. Successful activity collapses; old answer/update versions remain inspectable.
6. Actual adapter metadata controls reasoning badge; no fabricated verification labels.
7. SSE reconnect reconstructs activity/history without restarting timers or duplicating steps.
8. Timer updates preserve answer DOM/focus; reduced-motion and keyboard behavior work.

Add unit view-model tests now during 02 implementation; spec 06's real-browser
suite must exercise this layout, including mobile and failure states.

## Other design defaults queued after current context work

These record follow-up direction, not new requirements for Claude's current 01 task:

- New messages create new immutable task snapshots. Keep explicit cancellation via
  the Stop/API contract; natural-language cancel/supersede resolution needs a separate
  tested change. Never silently retarget a running task; ambiguous references ask.
- The application owns memory. CLI integrations start fresh per task unless an
  adapter can prove isolation/reset of its private sessions (spec 05).
- Coding remains answer-only until workspace/action permissions are implemented.
- Durable memory will use a separate SQLite persistence milestone: save source
  events, task outcomes and summary references consistently; propagate deletion;
  mark interrupted tasks after restart instead of blindly replaying actions.
  Spec 01 remains explicitly in-memory for now.
- Turn-level resource accounting must include retries/fallbacks; summary work is
  attributed to the conversation. A separate budget-enforcement task will define
  limits before automatic multi-model/CLI dispatch. No implicit paid fallback.
- Tests and sources provide verification evidence. A deeper answer alone does not.
