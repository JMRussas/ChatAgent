# Spec 05A — offline CLI evidence

2026-09-29: offline runner/adapter contract implemented. **05B is pending**: the
user has not selected a CLI and account profile. No real CLI, subscription, login,
paid provider or live benchmark was invoked. Production CLI entries continue to
report not implemented. This is an offline milestone, not completion of spec 05.

## Implemented

- `src/providers/cli/adapter.ts`: request/events, readiness contract and explicit
  code-owned adapter registrations.
- `runner.ts`: shell-free spawn, stdin context, working-root validation, incremental
  UTF-8 parsing through an adapter-owned parser, combined stdout/stderr cap,
  mandatory final answer and safe typed failures. Diagnostics are discarded.
- Per-run timeout, cancellation and process-tree terminator. Windows uses
  `taskkill /PID <owned pid> /T /F`; POSIX uses a detached process group.
- Positive integer environment limits; concurrency keyed by quota pool (otherwise
  adapter/profile) across adapters belonging to the same runner.
- Fresh auth/automation/quota inspection before invocation; bounded, cancellable
  documented-reset wait followed by reinspection. Unknown quota is not unlimited.
- Provider registry composition hook for explicitly registered adapters; fast/deep
  wrappers and safe queued lifecycle activity. No production adapters are registered.
- Quota exhaustion is not retryable. Only the dispatcher's explicitly configured
  approved fallback can switch bindings; metered transitions retain the existing
  billing permission and admission checks.

## Checks

`tests/integration/cliRunner.test.ts`: 18 tests cover hostile stdin, byte-chunk parsing,
diagnostic exclusion, distinct failure codes, pool contention, readiness denial,
quota wait/cancellation, child/grandchild cleanup, working-directory confinement,
explicit registry wiring and queued activity. Fixture executable is Node-only and
lives under `tests/fixtures/cli`; production configuration cannot select it.

`tests/integration/catalogDispatch.test.ts`: two additional cases verify permitted
and forbidden metered fallbacks following a non-retryable quota failure. Existing
cancellation/no-retry and fallback regression tests remain green.

Windows Node **24.15.0**: **411 tests / 58 files**, type checking, build and seeded
simulated `verify:release` pass. Release gate uses `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`; baseline quality/cost/latency conclusions remain
simulation-only. Timestamp-only generated report churn is not committed.

## Limits and next work

- The JSONL fixture is our test protocol, not an assumed real CLI protocol.
  Product code must implement its own documented parser, readiness probe and
  request encoding, including output-budget enforcement and profile selection.
- `answerOnly` is a trusted adapter-code assertion. A real adapter must establish
  that the product disables tools/edits before setting it true. Catalog metadata
  cannot establish that property. No sandbox for arbitrary agent execution is claimed.
- Readiness probes must obey their AbortSignal and avoid interactive authentication.
  Authentication instructions belong outside the application; no session output is
  retained. Billing/entitlement evidence still belongs to resource admission.
- The tested Windows tree has a live parent until cancellation/timeout. A selected
  product that detaches/reparents helpers or exits before its children needs a
  stronger product/platform containment strategy and additional cleanup tests before
  live support. The POSIX branch has not been exercised in this Windows test run.
- Pool limits are process-local. Compose supported adapters with one shared runner;
  this is not a distributed quota scheduler.
- 05B must wire discovery/startup to the selected real adapter and perform the
  documented live answer/cancellation checks. Product/profile selection is the
  current dependency; it is not inferred from installed executables.

Evaluation mode remains in spec 06. The [grader learning guide](../15-evaluation-graders.md)
and [evaluation plan](../04-evaluation-plan.md) now describe code/model grading,
versioned judge evidence and human calibration; no judge service was added here.
