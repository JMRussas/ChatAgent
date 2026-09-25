# 01A review follow-up: boundary invariants

2026-09-25. CTX-01–04 implemented and verified in the review-correction checkpoint.
The cases below remain regression requirements. 01B, streaming and resource-policy
enforcement are separate work and are not claimed complete.

## Invariants and required regressions

| ID | Invariant | Cross-component acceptance case |
|---|---|---|
| CTX-01 | One resolved per-role output limit feeds startup validation, context reservation and the adapter request. | Configure Ollama deep override 8192 with application window 8192: reject startup because output plus safety leaves no input. With a larger window, inspect the actual mocked request and assert its cap equals the reserve used by context preparation. Repeat with a fast override, no override, and Azure/Bedrock caps. |
| CTX-02 | Estimate the exact rendered system, role and task content sent by adapters, plus the specified message/request overhead. | Pending task plus nearly full completed history: count the rendered provider payload independently using the documented UTF-8 estimator; it must fit the allowance and agree with reported cost. Include delimiters, separators, non-ASCII text, no-task case, and both roles. Evict whole expendable records before rejecting mandatory content. |
| CTX-03 | Shared history does not erase the selected route's instructions. | Through orchestrator and mocked transport, direct instructs a direct answer without promising queued work; clarify instructs one concise clarifying question; deep acknowledges actually queued analysis without claiming completion. Fast/deep history remains identical. Test all three live adapter request mappings and inspect instructions, not generated model text. |
| CTX-04 | Pending status reflects the latest applicable lifecycle transition in captured event order. | Drive a task through failure, dead-letter replay, queued/running/retrying and completion; a new turn at each stage sees that stage. An old failure cannot override a later running event. Replay must append queued state when re-enqueued. Completion removes the unresolved record and supplies the accepted answer. Earlier snapshots remain unchanged. |

Resolve limits before constructing providers/context manager; do not independently
parse the same override in each component. Budget against shared pure rendering
helpers, and independently count final payloads in regression tests so a duplicated
accounting mistake cannot validate itself. Monetary budgets are separate: see
[resource policy](08-resource-policy.md).

Task transitions follow append sequence, not user timestamps. Successful replay
retains message/task identity; spec 02 adds attempt identity. Choose the latest
eligible refined answer when multiple completion events exist. Failure/cancellation
does not spontaneously become queued without an explicit replay transition.

## Evidence and completion

Review reproduced CTX-01 with reserve 2048 versus an actual cap of 8192. CTX-02
reported 463 estimated units for a rendered cost of 614 against allowance 499.
CTX-03 produced identical requests for all routes; CTX-04 yielded failed after a
later thinking event. Existing 140 tests passed with one worker and missed these
cases. These are offline observations, not live provider quality results.

All four IDs map to `tests/unit/contextReview.test.ts`:

| ID | Test names / evidence |
|---|---|
| CTX-01 | `rejects %s Ollama override consuming the window`; `reserves the same effective caps sent through %s`; `uses defaults without overrides and rejects malformed applicable overrides` |
| CTX-02 | `counts rendered wrappers, UTF-8 and both roles (tasks=%s)` |
| CTX-03 | `preserves selected route in %s requests and shared history` |
| CTX-04 | `follows failed, replay queued, running, retrying and complete without mutating snapshots` (also asserts latest refined answer wins) |

All passed. Full default parallel suite: 152 tests across 32 files. Type checking,
build and verify:release passed with BENCH_MODE=simulate, BENCH_SIM_SEED=default-v1.
No live provider quality check was run. An earlier intermittent worker crash did
not recur in this run; no claim that its root cause was fixed.
