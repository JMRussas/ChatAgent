# Next handoff after the runtime-ownership ADR

2026-09-25. Read this before starting another numbered implementation milestone.

## Completed checkpoint

CTX-01–04 are fixed (see [01A review follow-up](01a-review-followup.md)).
[ADR 0001](../adr/0001-chat-runtime-ownership.md) traces Hekate's/Iris's actual
active chat paths with file:line evidence, decides ChatRuntime hosts chat
request-handling logic while reusing Hekate's context-store as a persistence
backend, proposes protocol v1 schemas/fixtures, and defines one next vertical
slice (an Iris project-tab session routed through ChatRuntime) with named
acceptance tests. All three repos' consolidation notes now point to it. No
cross-repository migration, deployment, or live verification occurred.

Validation: 152 tests / 32 files, type checking, build, fixture evaluation and
seeded simulated benchmark comparison all pass (unchanged by this checkpoint —
no `src/` code changed). Local directory remains ChatAgent; GitHub repo/package
is ChatRuntime.

## Next bounded task: choose between 01B and the vertical slice

Two independent, un-started pieces of work are now both unblocked. Pick one
explicitly rather than starting both:

**Option A — 01B (internal summarization and source-linked memory).** Design
`SourceStore`'s interface per ADR 0001's reconciliation section with the future
context-store adapter in mind, but implement it in-memory first — it does not
need to wait for the vertical slice. Follow
[01's memory extension](01-context-memory.md) directly; its acceptance tests are
unaffected by the ADR.

**Option B — the vertical slice from ADR 0001.** This is cross-repository (Iris
+ ChatRuntime) and has two unresolved prerequisites called out in the ADR's
"Open / unresolved decisions" that must be settled first: (1) confirm which of
the two near-duplicate `OrchestrationClient` classes in Iris is actually live at
runtime, and (2) decide whether ChatRuntime's context-store persistence adapter
is built now or deferred — the slice itself does not strictly require it (it
can ship using ChatRuntime's existing in-memory store), but building it in the
wrong order risks throwaway work. This slice also depends on spec 02
(streaming/cancellation) for true SSE deltas; it can run in a non-streaming
compatibility mode against ChatRuntime's existing snapshot SSE endpoint until
spec 02 ships, but say so explicitly rather than claiming full parity early.

Either choice is a legitimate next step; do not silently start a third,
unplanned direction. If neither is picked, spec 02 (generation streaming and
cancellation) remains the default next numbered milestone per
[implementation/README.md](README.md)'s execution order.

## Outstanding implementation, not part of the fixes

- 01B summaries/source lookup and restart persistence remain unimplemented.
- 02 streaming/cancellation/activity extensions remain planned. During integration,
  include typed terminal context-overflow handling instead of blindly retrying an
  unchanged provider request; existing generic deep retries do not meet that rule.
- RES-01–08 describe future resource admission/accounting, not enforced spending
  controls. Ollama/CLI names are not execution-location or billing evidence.
- The vertical slice and any Hekate/Iris code changes remain unimplemented; ADR
  0001 is a design deliverable only.
- No live provider tests, model-quality certification, cloud provisioning or CLI
  subscription activation occurred in this checkpoint.

Suggested task prompt: "Read docs/implementation/NEXT-HANDOFF.md and ADR 0001.
Choose option A (01B) or option B (the vertical slice) explicitly, state which
and why, then implement only that option's acceptance tests. Preserve unrelated
work in any repo touched."
