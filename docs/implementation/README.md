# Implementation handoff

## Current direction — 2026-09-30

Follow [the latest handoff](NEXT-HANDOFF.md) and the
[NBA briefing demo](../18-nba-briefing-demo.md). Sports is now the selected concrete
workflow for remaining multitask evaluation, superseding older sports-deferral
instructions below. Spec 06 remains open. The offline briefing planner is the first
slice; source fixtures and bounded coordination are next. Earlier entries are dated
evidence, not current task ordering.


## 2026-09-30: Chromium browser acceptance

Added dev-only Playwright, `npm run test:browser`, per-test ephemeral mock runtimes,
and CI Chromium installation/browser execution. Eight real-browser cases cover
direct streaming, deep queue/model/progress, overlapping turns and late chunks,
auth/quota/general failures, length truncation, keyboard cancellation, mobile width,
reduced motion, and real SSE disconnect/reconnect without duplicate text.

Browser evidence found and fixed missing spinner DOM: active reply summaries now
render the existing styled spinner, hide it on termination, and retain accessible
text and reduced-motion behavior. See [06 browser evidence](06-verification.md#browser-acceptance-evidence-2026-09-30)
for setup and limits. This is Chromium automation, not a full accessibility audit,
other-browser certification or live model quality evidence.

Validation: **8 Chromium browser tests pass; 513 unit/integration tests / 66 files,
typecheck, build and seeded simulated release gate pass**. The first release run,
concurrent with browser tests, had an unexpected Vitest worker exit; a separate full
rerun passed. No assertion was weakened. No live model calls or account changes.
Recording remains off locally; historical benchmark output is preserved.

Next: **live-quality acceptance** with explicitly configured provider(s), versioned
exact-answer annotations, repeated single/dual comparisons, remaining live/concurrent
measurement checks, and clean-copy installation verification. Do not claim spec 06
complete or begin the sports demo before those remaining gates are accounted for.

## 2026-09-30: HTTP observation / recorder linkage

The live benchmark CLI now emits `chatagent-live-benchmark-v2` with raw conversation
IDs and a recorder run ID only when the same healthy recording brackets the batch.
`eval:recordings link-live <report> <run> <dataset> <annotations>` verifies hashed
turn/call correlation, full dataset coverage, model/binding identities, retries,
terminal outcomes and exact answer hashes before attaching grades and actual
configuration/code identity. HTTP observations and recorder useful-answer timing
remain separately labelled. Missing/failed grades cannot pass quality; mismatched
artifacts fail explicitly. Historical v1 reports cannot be retroactively linked.

[Setup and boundaries](06b-recording.md#linking-http-observations-to-recorder-evidence)
explain dedicated recorder sessions and clean shutdown before linking. Cross-run
comparisons still use original recorder artifacts and the existing compatibility
and experiment gate; a linked report does not bypass it.

Validation: **513 tests / 66 files**, typecheck, build and seeded simulated release
gate pass. Sixteen unit/CLI cases cover identity/schema/mismatch/grade/status rules;
a real loopback HTTP test covers direct/deep mock execution, bracketed run identity,
shutdown persistence and linked exact-answer grades. No live provider calls.

Next: **browser acceptance** (streaming, overlap, cancel/error, reconnect and
accessibility), then explicitly configured live-quality acceptance and remaining
live/concurrent measurement limits. Spec 06 remains in progress; sports follows it.
Recording remains off locally.

## 2026-09-30: matched mock HTTP runtime overhead

The overhead command now accepts `http` after the capture mode. It measures a
fresh loopback runtime through real HTTP submission, context preparation, fixed mock
providers, automatic deep retries, timeline polling and shutdown/persistence. Pairs
must preserve normalized provider requests, routes, retries, model-labelled answers
and terminal outcomes. No local/live provider configuration is selected.

[HTTP method and raw evidence](06b-recording.md#matched-http-runtime-overhead) preserve
20 pairs per capture mode with warmups and alternating order. Median total batch
deltas were -36.86 ms metadata and -14.45 ms answers in the isolated rerun; shutdown
deltas were positive (3.41 / 2.84 ms). Negative workload deltas reflect scheduling
and measurement variability and are not evidence that recording makes inference
faster. An earlier answer run overlapping a test invocation is retained explicitly
as exploratory. All measurements are synthetic; no live capacity was consumed.

Validation: **496 tests / 65 files**, typecheck, build and seeded simulated release
gate pass. Added HTTP parity/persistence cases for both capture modes and failure
cleanup after server startup. The original recorder-component reports remain intact.

Also clarified the selected `experiments/doc-agent/LANGGRAPH.md` paragraph: the
plain graph command defaults to no persistence, while the current graph supports
the SQLite durable wrapper's checkpoint/resume hooks. Confirmed pauses survive
restart; uncertain mid-execution crashes are still refused. No Python runtime
behavior changed and the experimental track remains parked.

Next: live-observation/recorder report linkage, then browser and live-quality
acceptance. EVAL-06 still has live/concurrent deadline and supported usage-accounting
limits; spec 06 is not complete. Recording remains off locally.

## 2026-09-30: measured recorder-component overhead

Added `npm run eval:overhead -- <new-report.json> metadata|answers`: a matched,
alternating-order synthetic timeline replay using production recorder persistence.
It retains raw pairs, source/config/workload identities, output parity hashes,
write counts, and separate setup/feed/final-flush timings. Invalid recording/writer
failure rejects; owned temporary artifacts are removed. It invokes no providers
and does not change the application's recording settings.

[Method and raw reports](06b-recording.md#matched-recorder-overhead-eval-06-component)
record twenty pairs per capture mode after warmups. Each batch has twenty turns /
250 events; median total on-minus-off overhead was **60.08 ms metadata** and
**64.00 ms answers**, dominated by final persistence (56.07 / 60.18 ms). Feed deltas
were 2.40 / 2.51 ms. These are local burst-replay component measurements, not live
per-message latency, quality, or provider-cost evidence. Both conditions had identical
normalized timeline output. EVAL-06 is not claimed complete end to end.

Validation: **493 tests / 65 files**, typecheck, build and seeded simulated release
gate pass. Four new cases cover both capture modes, real writes/parity/cleanup,
failed storage and bounded parameters/source identity. Historical simulation reports
remain unchanged; two new raw overhead reports preserve the measured dirty source
identity. No live inference ran.

Next: extend matched overhead to end-to-end runtime/HTTP execution and finish live
observation-to-recorder linkage; browser and live-quality acceptance remain afterward.
Sports remains queued after spec 06. Recording is still off locally.

## 2026-09-30: comparison execution-identity review fixes

Fixed both findings in `b84f7e5`. Comparison eligibility now requires consistent,
nonempty provider/model identity for each call, an identified terminal for every
attempt and every required phase, and matching identity on the final scored answer.
A fast model can no longer stand in for unknown deep execution. The `execution-v2`
digest retains per-phase attempt order, retry/outcome information, and final-answer
attribution. Swapping failed and successful models, or adding same-model retries,
changes the digest; run-local IDs and cross-phase scheduling do not.

Old set-based execution digests are intentionally incompatible. Regenerate expected
identities from pilot artifacts and preregister a new manifest before new runs; do
not rewrite historical evidence. Comparison setup documents this transition.

Validation: **489 tests / 64 files**, typecheck, build and seeded simulated release
gate pass. Nine new regression cases cover missing fast/deep identity, missing or
conflicting scored-call metadata, reversed fallback attribution, repeated retries,
and equivalent runs with different call IDs/interleaving. No live provider calls.
Next remains matched recorder on/off overhead measurement (EVAL-06).

## 2026-09-30: 06C recorder comparison and grading gate

`eval:recordings compare` now checks full dataset coverage/content/order, isolated
turns, code/configuration/model identity, live/synthetic mode, known run condition,
capture policy and grading method before producing a quality comparison. It reuses
exact-answer annotation validation; missing evidence blocks comparison, while rated
failures remain valid evidence and fail candidate quality. Versioned experiment
manifests pin both configuration/execution identities and permit only exact declared
configuration differences. Timestamp checks require declarations before execution;
trusted local files are not cryptographically attested preregistration.

See [comparison usage and limitations](06b-recording.md#comparing-recorded-runs-06c).
The standalone HTTP observation report remains ineligible without recorder evidence;
no automatic report join or aggregate latency/repetition comparison is implemented.
Cost and recorder overhead remain unknown. Historical simulation reports are intact.

Validation: **480 tests / 64 files**, typecheck, build and seeded simulated release
gate pass. Thirteen comparison cases cover compatible runs, exact experiment paths,
late/stale manifests, mismatched identities, partial datasets, missing/failed ratings,
and CLI success/nonzero outcomes. No live calls or model grading ran.

Next: **06C matched recorder on/off overhead measurements (EVAL-06)**, then remaining
live report integration, browser and live-quality acceptance. Spec 06 is still in
progress; sports follows it. Recording remains off locally.

## 2026-09-30: live benchmark review fixes

Fixed both findings in the review of `0a04daa`. Timeline polling now runs alongside
submission, so first-answer observation can precede completion of the fast response.
The user timeline event supplies route identity before the HTTP response arrives.
Provider HTTP failures retain status and a bounded code (not raw error bodies), and
the runner collects correlated terminal/model/attempt evidence instead of reporting
all failures as transport errors with zero retries. Failed submissions without
terminal evidence receive bounded cleanup; observation failures abort and await the
outstanding submission. Timings still include polling/transport delay.

Regression evidence includes early streaming before submission completion, HTTP 502
with retries, admission rejection without terminal events, concurrent-observation
cleanup, and a real local HTTP server returning a provider failure after retries.
Validation: 467 tests / 63 files, typecheck, build and seeded simulated release gate
pass. All providers in HTTP integration tests are mocked; no live inference ran.
Next remains 06C configuration/annotation compatibility and matched overhead.

## 2026-09-30: 06C live measurement foundation implemented

The live benchmark now submits each prompt once against the actual server, waits
for message-correlated fast/deep terminal events under a 120-second default deadline,
and polls every 100 ms. It uses automatic workers; polling never triggers retries.
Attempt IDs determine retry counts. Reports retain observed model/binding/revision
metadata, terminal outcomes, exact final-answer hashes and client observation times.
A stalled submission is bounded too. Deadline/transport failures request bounded
cancellation; unconfirmed cleanup stops the batch and leaves unrun prompts explicit.

Live observations use `chatagent-live-benchmark-v1`, with separate default output
`reports/live-benchmark-v1.json` and `.md`. Per-turn evidence distinguishes mock,
live, mixed and unknown providers. No route-derived quality score or hypothetical
profile names remain in live execution. Quality, usage, cost, configuration digest,
provider/queue duration and annotated useful-answer time remain unavailable; these
reports are explicitly not comparison eligible. Existing simulation artifacts and
methodology remain historical and unchanged. The comparison CLI rejects the new
observation format until compatibility and grading support are implemented.

Validation: **462 tests / 62 files**, typecheck, build and seeded simulated release
gate pass. Ten live-runner unit cases cover correlation, retries, failure/truncation,
acknowledgments, stalled requests, deadlines and cancellation. The existing runtime
HTTP test also runs the benchmark against actual automatic workers with mock models.
No live provider calls, model grading or performance claims were made.

Next: finish **06C configuration/dataset compatibility and experiment manifests**,
connect exact-answer grading, then matched recorder overhead. Browser and live-quality
acceptance remain afterward; the sports demo follows spec 06. Recording remains off
locally. This milestone does not complete 06C or spec 06.

## 2026-09-30: 06B passive recorder and annotation contracts implemented

[Recorder setup and evidence](06b-recording.md) documents opt-in metadata/answer
capture, versioned run artifacts, exact-answer grading and retention commands.
Timeline observation adds no inference calls and does not control routing or
retries. Unknown cost/usage/quality and unmeasured overhead remain unknown.
Shutdown flushes recording; write/incomplete/timeout failures are explicit and do
not change inference answers. Default capture is metadata-only and remains off
unless `EVAL_RECORDING=true` is configured with a versioned dataset.

Named tests cover deterministic recording on/off with a deferred retry, overlapping
turns and cancellation, exact-answer annotation/hash integrity, secret-bearing
fixtures, size/retention limits, failed writes, final flush and CLI nonzero status.
The server integration test checks automatic deep work and persisted recording at
shutdown. **453 tests / 62 files**, typecheck, build and seeded simulated release
gate pass. No live inference or model grading was run for this change.

Next: **06C honest benchmark measurements and experiment compatibility**, including
matched recorder-overhead runs (EVAL-06), then browser and live-quality acceptance.
The existing live benchmark still has its historical measurement limitations;
these recorder tests do not establish answer quality or performance improvement.
Spec 06 as a whole remains in progress.


## 2026-09-30: spec 06A runtime lifecycle complete

`startServer` now returns the bound server/address and an idempotent `shutdown()`.
Only index.ts installs process signal handlers. Shutdown stops admission/background
work, cancels and awaits summary jobs, gives active calls the configured grace,
cancels remaining/late-created attempts, releases pending reservations, drains the
process-local queue, closes SSE, awaits serialized final telemetry, and closes HTTP.
Persistence failures and the overall shutdown deadline reject explicitly; the CLI
sets a failure exit status. This is not durable queue recovery or a guarantee that
remote compute has stopped.

Tests cover an active SSE client, deferred provider and persistence, graceful
completion, queued cancellation, late context-preparation races, write failure,
timeout, idempotence, and an automatic-worker HTTP flow on an ephemeral port with
no process signal listeners. **439 tests / 61 files**, typecheck, build and the
seeded simulated release gate pass. No live model call was needed for this change.

Next: **06B passive evaluation recorder and artifact/annotation contracts**,
followed by honest live benchmark comparisons and browser acceptance. Spec 06 as a
whole remains in progress; EVAL-01–06, browser gates, and live quality comparisons
are not claimed complete by these lifecycle tests.


## 2026-09-30: Claude live acceptance complete

Claude 2.1.285 through the local Hekate bridge passed catalog selection and a live
answer (`BRIDGE_OK`). Separate cancellation and timeout checks each observed three
processes in the invocation tree and verified zero survivors. This establishes
local cleanup, not proof that remote inference stopped or incurred zero charges.
The runtime supports answer-only/final-only output; tool execution and interleaved
thinking comparisons remain separate evaluation work.

Local configuration now uses catalog routing and the approved 80% headroom policy.
Only Claude has resource-policy evidence in this local profile. Subscription and
potential metered usage are declared; incremental cost stays unknown, with explicit
`allow-unpriced`, no monetary ceiling, and no fallback. The user reports separate
account funding protections. No account settings were changed.

`quotaAdmission: "adapter-preflight"` requires a code-owned binding capability.
Claude checks usage immediately before every invocation under the shared CLI
concurrency gate; percentages are never converted to invented request/token counts.
Configured resource evidence expires after one day and must be reviewed/renewed;
usage evidence expires after 30 seconds. Local discovery runs every 20 seconds.
Missing/stale evidence blocks dispatch.

Live checks are explicit commands, excluded from offline tests:
`npm run cli:claude:accept -- answer`, `-- cancel`, and `-- timeout`.
The latter two verify Windows process-tree cleanup. Each command can use live
subscription capacity. They require the configured local dispatch policy.

Next: **spec 06 lifecycle/verification and evaluation mode**, then the sports demo.


## 2026-09-29: Claude reuse and review

User selected Claude through a local bridge to Hekate's existing unified CLI
provider. [Review findings and setup](05-claude-review.md) describe reuse, fixes
and pending live acceptance. Existing Max authentication is confirmed; generation
is still blocked on unknown quota under the current policy. Product selection
is resolved. Spec 05B is not yet complete.

## 2026-09-29: spec 05A offline CLI milestone

Offline runner, explicit adapter registration, provider wrappers, quota waits and
dispatcher-owned fallback are implemented. [05 evidence](05-evidence.md) records
**411 tests / 58 files**, type checking, build and seeded simulated release gate.
Production CLI support remains not implemented until **05B**, which needs the
user's CLI product/account profile and documented live checks. No live/billed call
was made. The [grader guide](../15-evaluation-graders.md) explains code/model
evaluation methods; grader metadata/calibration is incorporated into the evaluation
plan. Spec 06 evaluation mode remains queued, then the sports demonstration.

## 2026-09-29: spec 04 dispatch implemented

Catalog-mode selection, captured-context previews, provider registry, resource
admission, frozen retries, explicit bounded fallback and per-turn model labels are
implemented. Fixed mode remains the default. [04 evidence](04-evidence.md) maps
acceptance and resource fixtures: **391 tests / 57 files**, type checking, build and
seeded simulated release gate pass. No live/billed provider or real-browser run was
performed. Cost bounds are declared, usage remains unsettled when unreported, and
reservations are process-local; see the evidence for limits.

**Next bounded task: [spec 06 — verification](06-verification.md)** and evaluation
mode. Keep the sports demo after the runtime sequence. Do not reactivate the
parked documentation-agent experiments as the default next task.

## 2026-09-29: spec 03 (inventory) implemented

Real discovery for Ollama/Azure/Bedrock, catalog v1->v2 migration, and the
RES-01/03/04/08 resource-policy metadata fixtures are done. See
[03 evidence](03-evidence.md) for the acceptance mapping and
[NEXT-HANDOFF](NEXT-HANDOFF.md) for the matching entry and next task (spec 04).

## 2026-09-29: canonical direction confirmed — resume the numbered runtime spec

The numbered spec sequence below (01–06) is the confirmed active plan; the
experimental doc-agent/learning track referenced further down is parked, not
the active priority. Entries below this one predate that decision and are
preserved as history, not current sequencing.

## 2026-09-28: shared inference decision

[Controlled contention findings](../../reports/doc-agent/contention-findings-2026-09-28.md)
now separate application admission wait, first answer text and completion across
Node/Ollama and Python/LangGraph. With equal foreground bursts and a FIFO control,
overlap medians were 477 ms concurrent, 479 ms FIFO and 569 ms foreground-priority.
All 18 documentation tasks completed; cancellation/recovery checks passed.
**Keep normal runtime scheduling unchanged.** The gateway and policies are optional
experiments, not a production scheduler. This supersedes the older instruction to
measure first-token/admission timing next; it does not establish an SLA or a general
scheduling result. See the report for the preserved exploratory run and limitations.

Next: held-out multi-part documentation evaluation for requirement coverage,
citation support and scoped uncertainty, before selecting completed-task evidence
for on-demand conversation context. Keep planning optional. Revisit scheduling if
longer calls or sustained/multi-worker load misses the documented latency target.

Latest learning experiment: [observable plans versus actual execution](../../reports/doc-agent/plan-findings-2026-09-28.md)
compares eight local runs under shared budgets. Both conditions pass 4/4 structural
checks, but manual review finds citation and uncertainty gaps; planning remains
optional and outside production. Next: held-out requirement/evidence review and
plan readability before considering runtime integration.

Earlier validation: [browser and shared Ollama findings](../../reports/doc-agent/browser-contention-findings-2026-09-27.md)
records a fixed development-browser rendering bug, 248 passing TypeScript tests,
and a small same-model contention probe (295 ms baseline median; 888 ms during
background work). That timing follow-up is now recorded in the 2026-09-28 findings above.

Current integration: [conversation documentation tasks](11-conversation-tasks.md)
adds an optional background action, scoped status/results, cancellation and bounded
admission through a local Python sidecar. Earlier notes describing all Python work
as disconnected from chat are superseded for this opt-in path. Shared GPU priority,
automatic context insertion and scheduled triggers remain future work.

## 2026-09-27: explicit LangGraph learning slice

The [LangGraph workflow](../../experiments/doc-agent/LANGGRAPH.md) is implemented as an optional
engine, with the original loop retained for comparison. 29 offline tests pass,
including contract parity, invocation isolation and cancellation propagation.
This supersedes earlier text proposing graph translation as future work. The next
learning step is designing durable state and pause/resume; neither is implemented
by this invocation-local graph. Production runtime integration remains separate.

2026-09-27: use the [model-specific reference guide](../14-model-reference-guide.md) before
changing model integration or designing local evaluations. Start with official
guidance and published benchmarks, then test the application-specific gaps.

Current learning slice: [10 documentation retrieval agent](10-doc-retrieval-agent.md)
uses the existing sibling course patterns for LangChain/Ollama and bounded
read-only tools. Hekate integration and production provider migration are not
prerequisites. Read the latest section of NEXT-HANDOFF before older sequencing.

Latest prompt work: [spec 09](09-prompt-contract.md) and
[experiment 2](../../experiments/prompt-contract/README.md) define and evaluate
Task / Guidelines / Response Framework. This experimental branch does not mark
the queued numbered runtime milestones as complete.

2026-09-26 priority update: [ADR 0002](../adr/0002-layered-context-and-orchestration.md)
records the latest orchestration/context/telemetry direction. The immediate
experiment is [paired local prompt encoding](../../experiments/prompt-encoding/README.md).
Use [NEXT-HANDOFF](NEXT-HANDOFF.md) for current sequencing; the numbered specs
below remain the queued runtime roadmap, not evidence of implementation.

Specification baseline: `7f03beb` (2026-09-25). These documents describe planned
changes, not existing APIs. Read the current source before editing; do not restore
the baseline over newer work. The spec 02 checkpoint and acceptance results are recorded in [02 evidence](02-evidence.md).
No live quality pass is claimed. Start with [NEXT-HANDOFF](NEXT-HANDOFF.md).

**Context plan revision 2:** read [01's memory extension](01-context-memory.md)
before resuming context work. It supersedes the original “no summaries” and
“drop all pending turns” requirements. Summarization belongs to the context manager,
not the visible chat. Preserve useful work already implemented; see the extension's
safe continuation instructions. No source implementation was changed by this revision.

## Execution order

**Review corrections:** [01A boundary invariants](01a-review-followup.md) records
four corrected regressions against f889b9a and their passing named tests. [Execution and resource policy](08-resource-policy.md)
extends 03–06: transport, execution location, billing, quota and compute are
independent. Ollama and CLI bindings carry no implicit locality or price.

**Cross-repository reuse checkpoint (2026-09-25):** read
[07 Shared chat runtime](07-shared-chat-runtime.md) before starting overlapping
01B/provider/CLI work. 01A is committed at `f889b9a`; preserve it. Audit existing
Hekate and Iris assets and record runtime ownership before migration. This
checkpoint adds a design prerequisite; it does not claim integration is complete.

UI follow-up: [02 activity sub-bubbles](02-activity-ui.md) specifies attached progress,
observable labels and preserved answer versions. Context revision 2 is unchanged;
an agent already implementing 01 should finish that scope, then read this extension
when starting 02. Do not add UI/persistence work to the current context task.

| Spec | Dependency | Deliverable |
|---|---|---|
| [01 Context](01-context.md) + [memory extension](01-context-memory.md) | Existing baseline | 01A snapshots/pending state; 01B internal summaries/source records |
| [02 Generation](02-generation.md) + [activity UI](02-activity-ui.md) | 01A; preserve v2 context fields | Streaming, cancellation, activity sub-bubbles and answer updates |
| [03 Inventory](03-inventory.md) | Existing catalog; integrate after 02 | Connections and fresh provider observations |
| [04 Dispatch](04-dispatch.md) | 01–03 | Deterministic task-based model selection |
| [05 CLI](05-cli.md) | 02–04; product/account selection for live adapter | Subscription execution via a registered adapter |
| [06 Verification](06-verification.md) | 01–04; include 05 when enabled | Shutdown, honest benchmarks, browser and live gates |

The ownership ADR, 01A/01B and spec 02 are implemented. See [01B evidence](01b-evidence.md).
Current user direction: work only in ChatAgent; leave Iris/Hekate follow-up for work in those repos.
Follow NEXT-HANDOFF.md for the next bounded task. Implement one reconciled numbered spec at a time. Do not implement later
milestones as incidental refactoring. Each spec has a scope boundary and named
acceptance cases; completion requires the cases, not merely new types or metadata.
03's interfaces can be designed independently, but this handoff does not require
parallel agents. Production deployment and retrieval are separate future scopes.

## Common contracts and rules

- `messageId` identifies a user turn, `taskId` a queued deep job. Retries retain both;
  each execution attempt receives a separate `attemptId`. Never correlate by text
  or timestamps. Preserve existing HTTP fields during incremental migration.
- Keep UI timeline events separate from provider conversation messages. Activities,
  partial deltas and diagnostic metadata are never assistant conversation content.
- ContextManager owns context preparation, summary lifecycle and source lookup;
  orchestrator captures the prepared context and owns selection. Adapters translate requests and emit
  results; workers execute frozen tasks; the UI displays persisted facts.
- No provider credentials, login tokens, hidden reasoning text, full environment
  dumps, or arbitrary shell command strings in public events/catalog endpoints.
- Use mock/deferred providers for deterministic tests. Network, cloud provisioning,
  subscriptions and billed inference are not requirements of an offline test pass.
- Update `.env.example`, README and the roadmap when behavior/configuration changes.
  Preserve historical reports. Mark checks as run, failed, or not run with a reason.
- Provider-specific protocol facts must be verified against installed versions and
  current official documentation during implementation. Record the source/date in
  adapter notes. Do not guess CLI switches, regional availability or model limits.

## Verification and commits

Every milestone handoff must map acceptance IDs/requirements to test file and test
name, with executed result or explicit outstanding status. Include cross-component
boundary/transition cases, not only isolated request-shape checks. A passing suite
does not by itself establish acceptance coverage.

For each code milestone: run its focused tests, then `npm test`, `npm run lint`,
`npm run build`. Before declaring the integrated handoff complete, run
`npm run verify:release` with `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`. On PowerShell set these with `$env:NAME = 'value'`;
shell `NAME=value command` syntax is not portable to this workspace.

Read existing Git status first and preserve unrelated work. Commit each coherent
milestone with implementation, tests and documentation together. Do not overwrite
benchmark baselines merely to make gates pass. Investigate and explain legitimate
changes before versioning a replacement baseline. No remote is configured.

The development server does not watch source changes. Verify its process/port
before restarting; report that in-memory conversations will reset. Do not kill
unrelated Node/Ollama processes. Keep local secrets out of commits.

## Reusable task prompt

> Read docs/implementation/README.md and the next numbered spec. Check its
> prerequisites against the actual code. Implement only that spec, including its
> failure cases and acceptance tests. Preserve unrelated changes. Run the required
> checks, update the roadmap with evidence and remaining limitations, and commit
> the completed milestone. If an external prerequisite is missing, complete the
> independent offline work and report the exact blocked live acceptance case;
> do not substitute a mock result for live verification.
