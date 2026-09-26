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
  195 tests / 38 files, type checking, build and the seeded simulated release gate passed.
- [ADR 0001](../adr/0001-chat-runtime-ownership.md) keeps runtime logic here and
  proposes context-store as a durable backend. The protocol remains a proposal;
  the current API is `/messages` plus snapshot SSE and the cancellation endpoint.

## Next bounded task: Iris integration slice

Spec 02 removes the generation/cancellation prerequisite for the ADR's full slice.
Before implementation, resolve the remaining two decisions from the ADR:

1. Confirm which Iris `OrchestrationClient` is wired at runtime. Trace current
   source and DI registrations rather than assuming the earlier line references
   still apply.
2. Decide whether the context-store persistence adapter is built now or deferred.
   Prefer the existing in-memory store for the first slice unless current evidence
   makes durable storage necessary; explicitly record the choice and restart limits.

Then implement only the ADR's feature-flagged Iris project-tab slice: persistent
per-conversation identity, a ChatRuntime client, protocol v1 compatibility endpoints
and typed events, and the named continuity/reconnect/cancellation/isolation/failure/
late-update/rollback acceptance cases. Current snapshot SSE is not yet protocol v1's
incremental replay contract; an adapter must make that mapping explicit. Preserve
unrelated work in all repositories. Do not claim shared-runtime integration from
this repo's spec 02 pass alone.

01B (internal summaries and source-linked memory) is still a valid independent
workstream, but is not included in this slice. If chosen instead, follow
[the memory extension](01-context-memory.md), design `SourceStore` for future
context-store compatibility, and implement in memory first.

## Outstanding work and limits

- 01B summaries/source lookup and restart persistence remain unimplemented.
- Resource-policy RES-01–08 enforcement, discovery/dispatch/CLI and graceful
  shutdown remain later numbered milestones.
- No Iris/Hekate files were changed as part of spec 02. Cross-repository runtime
  migration, protocol v1 endpoints and durable replay are not implemented here.
- No live inference, model-quality certification or real-browser/mobile gate ran.
  The UI has offline projection/DOM tests; spec 06 still owns real-browser checks.
- Explicit Ollama thinking controls require runtime metadata. Older runtimes without
  `thinking.values` must use `default` or upgrade; the app does not guess support.
- Development processes were not restarted. Restarting resets in-memory timelines,
  cancellation state, duplicate-ID claims and queued work.

Suggested task: "Read NEXT-HANDOFF and ADR 0001. Resolve the two remaining Iris
slice decisions against current source, record the bounded scope, then implement
and verify only that feature-flagged slice. Preserve unrelated work."
