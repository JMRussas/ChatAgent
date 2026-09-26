# Next handoff after spec 02

2026-09-25. Read this before starting another implementation milestone.

## Completed checkpoint

- 01A bounded snapshots and CTX-01–04 regressions remain implemented. Review fix
  `e568256` also enforces selected catalog context windows and validates the ADR's
  protocol example against its interfaces.
- [Spec 02](02-generation.md) and [activity UI](02-activity-ui.md) are implemented:
  answer streaming, per-attempt lifecycle, cancellation, bounded retries/buffers,
  explicit thinking verification, activity history/timers and preserved answers.
  [02 evidence](02-evidence.md) maps acceptance cases to executed tests and records
  adapter documentation and offline/live verification boundaries. Validation:
  203 tests / 38 files, type checking, build and the seeded simulated release gate passed
  after review fixes for visible partial-answer outcomes and frozen terminal UI state.
- [ADR 0001](../adr/0001-chat-runtime-ownership.md) keeps runtime logic here and
  defers durable context-store persistence. The opt-in Iris project-tab integration
  and protocol v1 endpoints are implemented. See [slice evidence](07-iris-slice-evidence.md)
  for scope, protocol refinements, tests, enable/rollback instructions and restart limits.

## Next bounded task: desktop validation, then 01B

The Iris slice is implemented with `useSharedChatRuntime=false` by default.
Perform a real WPF smoke check against a running runtime: two turns, fast/deep
rendering, cancellation, reconnect and flag-off rollback. Offline tests and the
cross-process C#/Node smoke check passed; no real desktop/live-model check is claimed.
Do not restart an existing runtime without accounting for its in-memory state.

After desktop validation, the next implementation workstream is 01B. Durable
context-store integration remains deferred; Iris UUID/history persistence does
not restore ChatRuntime context after restart.

01B (internal summaries and source-linked memory) is still a valid independent
workstream, but is not included in this slice. If chosen instead, follow
[the memory extension](01-context-memory.md), design `SourceStore` for future
context-store compatibility, and implement in memory first.

## Outstanding work and limits

- 01B summaries/source lookup and restart persistence remain unimplemented.
- Resource-policy RES-01–08 enforcement, discovery/dispatch/CLI and graceful
  shutdown remain later numbered milestones.
- Iris now has an opt-in runtime adapter; Hekate is unchanged. Durable replay
  and runtime-context recovery remain unimplemented.
- No live inference, model-quality certification or real-browser/mobile gate ran.
  The UI has offline projection/DOM tests; spec 06 still owns real-browser checks.
- Explicit Ollama thinking controls require runtime metadata. Older runtimes without
  `thinking.values` must use `default` or upgrade; the app does not guess support.
- Development processes were not restarted. Restarting resets in-memory timelines,
  cancellation state, duplicate-ID claims and queued work.

Suggested task: "Read NEXT-HANDOFF and the Iris slice evidence. Validate the
feature-flagged path in WPF, preserve existing development state, then implement
01B against the retained source/context contracts. Keep durable persistence deferred."
