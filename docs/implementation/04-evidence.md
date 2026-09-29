# 04 — Catalog selection and resource admission evidence

2026-09-29. Spec 04 is implemented with offline acceptance coverage. Catalog mode
is opt-in; fixed mode remains the default. This extends the completed
[classification checkpoint](04a-evidence.md). No live provider, paid call, CLI
execution or real-browser session was used to establish these results.

## Delivered behavior

- Registry instances retain provider configuration by binding ID. Selection filters
  role/task, adapter capabilities, readiness, context/output limits and explicit
  resource policy before ranking retained pairs, compatible evaluations, priority
  and lexical binding ID.
- Context is captured once. Candidate previews reuse captured history/memory/source
  state and do not initiate summaries. The selected pair shares a final budgeted
  context; selections are saved before enqueue. Retry preserves the captured model
  and history, and rechecks observation/resource validity.
- Explicit ordered fallback is limited to one per phase, before emitted text, for
  retryable availability/timeout failures. It rechecks fit, resources and metered
  billing permission. Its new attempt carries actual binding/model/reasons and
  corrected trusted model identity while retaining history/memory.
- The shared ledger reserves a turn's cost/quota atomically, includes retries and
  summaries, bounds waiting, releases unstarted work and retains unsettled usage.
  Compute slots start at execution, so a queued deep task does not consume a slot.
- HTTP returns safe 503 exclusions when selection fails before timeline/queue/model
  work. Explicit image/tool/action payloads are rejected. Per-turn UI and protocol
  metadata retain actual models/bindings. Catalog telemetry separates phase/task/
  size/result and persists alongside the existing adaptive snapshot.

## Acceptance mapping

| Spec requirement | Test file and named case | Result |
|---|---|---|
| 1: Fast coding versus deep coding + fast conversation | `tests/integration/catalogDispatch.test.ts`: `selects fast coding for a short explanation and fast conversation plus deep coding for complex work` | Pass |
| 1: No candidate, no side effects, explicit capability error | Same file: `returns 503 without timeline, queue or provider work and explicitly rejects image/tool payloads` | Pass |
| 2: Classification corpus | `tests/unit/taskClassifier.test.ts`: 52 existing cases; see 04A mapping | Pass |
| 3: Disabled/stale/denied/unknown-limit/unimplemented candidates | `tests/unit/modelSelector.test.ts`: `excludes %s bindings` table; `tests/unit/dispatchConfig.test.ts`: `constructs actual adapters for registered roles and never enables CLI execution` | Pass |
| 4: Newest whole pairs, identical final context | `tests/integration/catalogDispatch.test.ts`: `retains newest whole pairs and sends identical frozen context to both providers` | Pass |
| 4: Capture once without extra summary calls | `tests/unit/contextPreview.test.ts`: `candidate previews share captured state without recapture or per-candidate summary calls` | Pass |
| 5: Deterministic ranking and evidence validity | `tests/unit/modelSelector.test.ts`: `orders quality then latency then priority then lexical binding ID`; `does not use quality without matching task/environment, enough samples and freshness`; `ranks retained complete pairs above evaluation and excludes failed previews` | Pass |
| 6: Frozen retry despite catalog mutation | `tests/integration/catalogDispatch.test.ts`: `keeps model and context frozen across catalog mutation and retry`; `revalidates access before retry without switching credentials or making another call` | Pass |
| 7: New fallback attempt and selection, preserved history | Same file: `records explicit fallback with a new attempt and actual wire/UI labels`; `allows at most one explicit fallback per phase` | Pass |
| 7: No incompatible/paid-disallowed/post-output/auth/context/cancel fallback | Same file: `blocks fallback that cannot fit the already-selected history`; `RES-07: exhausted allowance never causes an unapproved metered fallback`; `never falls back after text emission`; `never falls back on %s` table | Pass |
| 8: Overlapping turns retain own labels | Same file: `labels overlapping coding/conversation turns by their own selected model`; existing browser-serialization regression | Pass (offline projection/serialization, not a real browser run) |
| 9: Fixed-mode compatibility | Existing `tests/eval/golden.test.ts`, `tests/unit/router.test.ts`, `tests/unit/adaptiveRouting.test.ts`, `tests/integration/server.test.ts`, `tests/integration/protocolV1.test.ts` | Pass |
| Attempt telemetry persists without fast/deep mixing | `tests/unit/latencyTelemetryStore.test.ts`: `persists separate fast/deep dispatch attempts and unknown reservation usage` | Pass |
| Invalid JSON cannot enter accepted history | `tests/integration/catalogDispatch.test.ts`: `rejects malformed JSON output rather than accepting it as a completed structured answer` | Pass |
| Failed timeline write releases unused reservations | Same file: `rolls back unstarted pair reservations when timeline persistence fails` | Pass |

Resource fixtures in `tests/unit/resourceAdmission.test.ts` cover RES-01 independent
scope/price constraints, RES-02 known subscription allowance, RES-03/04 separate fixed
cost and unknown/stale versus zero incremental cost, RES-05 atomic pair/shared-pool
reservation, RES-06 retained unsettled spend, and RES-07 bounded waiting. Integration
adds shared summary admission, cancellation of queued versus running work and denial
of an unapproved metered fallback. CLI execution remains unsupported; RES-02's ledger
behavior is tested without claiming a working subscription adapter.

## Executed checks

Windows Node 24.15.0 invoked from WSL:

- Full suite: **391 tests / 57 files passed** (40 tests added after 04A).
- Type checking and TypeScript build: passed.
- `verify:release` with `BENCH_MODE=simulate`, `BENCH_SIM_SEED=default-v1`: passed,
  including fixture evaluation and benchmark comparison.
- `git diff --check`: passed. The benchmark's generated timestamp-only change was
  discarded; historical report/baseline content was preserved.
- Live provider selection, billed usage reconciliation, real-browser/mobile checks:
  **not run**. The latter integrated gates remain in spec 06.

## Limits and next task

See [configuration and runtime boundaries](04-dispatch.md#configuration). Cost
admission uses a declared complete per-invocation USD upper bound, not provider
pricing guesses or an invoice guarantee. Provider adapters currently leave usage
unreported, so consumed calls retain their reservations; the ledger's explicit
reported-consumption reconciliation is tested but not wired to a billing service.
Quota snapshots are configured/observed inputs, not an automatic quota-refresh
service. Changed shared snapshots fail closed. The ledger and dispatch plans are
process-local; neither telemetry reload nor process restart replays reservations.

Fixed mode retains legacy admission and adaptive metrics; catalog telemetry uses
separate attempt records. These tests do not prove live model accuracy or remote
compute release after cancellation. The next numbered task is
[05 — subscription CLI execution](05-cli.md), including its product/account selection
and current-documentation requirements; no CLI execution was added incidentally.
