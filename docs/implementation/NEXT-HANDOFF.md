# Next ChatAgent handoff after 01B

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


## 2026-09-30: review findings fixed

All three findings from the review of `4e0bea1` are addressed:

- Inventory respects the earlier of the adapter expiry and configured TTL. Adapters
  without their own limit omit expiry; malformed explicit expiry stays stale.
- Live cleanup inspection has a five-second timeout, bounded output, and guaranteed
  invocation-tree termination in `finally`, including inspection/parse failures.
- Cancellation/timeout acceptance uses the selected binding's model and production
  CLI wrapper, preserving its profile, quota pool, exhaustion policy and output
  budget. The acceptance harness now also goes through InventoryStore.

Validation: **432 TypeScript tests across 60 files**, typecheck, build and seeded
simulated release gate pass. New offline regressions cover expiry caps, inspection
failure/timeout, and a non-Sonnet binding with different quota settings. Live
cancellation and timeout were rerun; each observed three processes and zero
survivors. No account settings changed. Next remains spec 06 verification and
evaluation mode.


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


## 2026-09-29: account setting correction and optional headroom admission

User explicitly refuses to disable account-wide extra usage; respect that.
Removed the account-flag admission requirement. No documented per-invocation
included-only switch was found in installed help or current official references.
Strict mode reports `CLI_INCLUDED_ONLY_UNSUPPORTED`. Optional
`HEKATE_CLAUDE_USAGE_POLICY=headroom` permits fresh reported shared/model usage
below 80%, with no zero-overage guarantee. User accepted the remaining risk, citing existing account funding protections.
Local `.env` now enables `headroom`. Those protections are user-reported, not
independently verified. Do not ask the user to disable account extra usage again. No model call was made.
Next: reconcile resource-policy evidence, then live answer and cancellation
acceptance. The risk choice is resolved. See [review](05-claude-review.md).

## 2026-09-29: reasoning evaluation and tool-use learning design

User approved adding Claude interleaved-thinking conditions to the evaluation
plan. Compare only controls verified for the actual model/transport; the present
answer-only bridge cannot exercise inter-tool reasoning. User also asked about
LoRA for tool use: [design note](../16-tool-use-lora.md) proposes a trainable local
model experiment after evaluation mode and the sports baseline. No training or
inference run was started. Existing Claude admission/live acceptance work remains
the next runtime dependency; this note does not approve paid overage.

## 2026-09-29: usage reader verified after upgrade

Claude **2.1.285** is installed. Account usage retrieval succeeded through the
undocumented OAuth usage endpoint; the bridge inspection command now reports
safe, timestamped windows and the extra-usage flag. See the
[review follow-up](05-claude-review.md). Shared windows were 0%/3% used at inspection;
model-specific fields were null and extra usage enabled. These are observations,
not persistent allowance grants. Strict generation admission and live acceptance
remain unresolved; no paid or model invocation occurred. Do not repeat the claim
that no account usage can be obtained. Reconcile scoped windows with admission next.

## 2026-09-29: Claude bridge review

Claude and a local bridge to Hekate's unified provider are selected. Bridge and
registry/discovery wiring are implemented; existing OS-profile authentication
passes inspection. [Review](05-claude-review.md) records shared-layer defects,
mitigations and pending quota policy. Do not claim a live answer/cancellation
pass or completion of 05B. A user question about bounded attempts with unknown
quota is pending; the current implementation retains strict blocking.

## 2026-09-29: spec 05A offline milestone

The offline CLI runner and provider registration contract are implemented and
validated: **411 tests / 58 files**, type checking, build, simulated release gate.
See [05 evidence](05-evidence.md) for acceptance mapping and platform limits.
**Next: 05B**, pending the user's CLI product/profile selection; no real product
was selected or invoked implicitly. Production CLI entries still report not
implemented. Evaluation-mode grader design is updated in
[the plan](../04-evaluation-plan.md#grader-design-planned), with a
[learning guide](../15-evaluation-graders.md). Spec 06 and the sports demo follow.

## 2026-09-29: spec 04 dispatch implemented

Catalog-mode selection, captured-context previews, provider registry, resource
admission, frozen retries, explicit bounded fallback and per-turn model labels are
implemented. Fixed mode remains the default. [04 evidence](04-evidence.md) maps
acceptance and resource fixtures: **391 tests / 57 files**, type checking, build and
seeded simulated release gate pass. No live/billed provider or real-browser run was
performed. Cost bounds are declared, usage remains unsettled when unreported, and
reservations are process-local; see the evidence for limits.

**Next bounded task: [spec 05 — CLI execution](05-cli.md)**, starting with its
product/account selection and documented adapter contract. Keep spec 06 evaluation
mode queued and the sports demo after the runtime sequence. Do not reactivate the
parked documentation-agent experiments as the default next task.

## 2026-09-29: spec 04 classification checkpoint

The first step required before dispatch wiring is implemented: deterministic task
classification and a 52-case test suite covering precedence, code/stack traces,
whole-word matching, JSON output requirements and clarification. See
[04A evidence](04a-evidence.md). All 351 tests / 52 files, type checking, build and
the seeded simulated release gate passed. No live-provider checks ran.

Spec 04 remains in progress: model selection, registry, shared-context previews,
resource admission/reservations, fallback, and per-binding telemetry still need
implementation and acceptance coverage. Existing runtime routing is unchanged.
The next implementation step is catalog selection and resource admission, followed
by orchestrator/worker integration. Do not mark spec 04 complete or start 05 yet.

## 2026-09-29: evaluation mode added to the plan

[Evaluation mode and orchestration comparisons](../04-evaluation-plan.md#evaluation-mode-planned-2026-09-29)
now cover passive metadata, correlated traces, quality/cost/latency evidence,
structured decision checkpoints, redaction/retention and recorder overhead.
[Spec 06](06-verification.md#evaluation-mode) owns implementation and EVAL-01–06
acceptance. Recording and orchestration are independent settings; private reasoning
is excluded. Compare sequential, batched and delegated execution when supported,
without reactivating the parked experimental track. This is planning only.
**Spec 04 dispatch remains the next bounded task.** After the runtime sequence
through spec 06 is verified, the [sports-agent demonstration](../12-development-roadmap.md#next-domain-project-temporally-grounded-sports-agent)
is the next domain project, starting with one league and timestamped evidence.

## 2026-09-29: spec 03 (inventory) implemented

[03 evidence](03-evidence.md) records the full acceptance mapping. Real discovery
adapters for Ollama (`/api/tags` + `/api/show`), Azure (ARM management plane,
separate credentials from `AZURE_OPENAI_API_KEY`), and Bedrock
(`@aws-sdk/client-bedrock`'s `ListFoundationModelsCommand`) are implemented and
wired into `GET /models`, which now computes real per-binding readiness instead
of a hardcoded value. Catalog v1 -> v2 migration, connections, and the
RES-01/03/04/08 resource-policy metadata fixtures named as spec 03's scope are
done. 299 tests / 51 files pass; `verify:release` passes. Live cloud discovery
was not run (no Azure ARM or AWS credentials configured here) -- recorded as
not run, not simulated as passing.

**Next bounded task: [spec 04 — dispatch](04-dispatch.md)**, which consumes this
inventory (readiness, resourceFacts) for deterministic task-based model
selection. Do not implement CLI execution (05) incidentally.

## 2026-09-29: canonical direction confirmed — resume the numbered runtime spec

Explicit user decision: the numbered runtime spec (01–06, `docs/implementation/README.md`)
is the canonical plan going forward, not the doc-agent/learning experimental track.
The experimental work below (documentation agent, LangGraph, task lifecycle,
shared-inference scheduling, prompt-contract/prompt-encoding research) is **parked,
not abandoned** — it remains a real, evidenced body of work and its reports stay
as historical record — but it is not the active priority. Do not continue it
as the default next step without a new explicit decision to do so.

**Next bounded task: [spec 03 — inventory](03-inventory.md)**, integrating the
applicable RES-01/03/04/08 fixtures from [08 resource policy](08-resource-policy.md).
This was already named "next" on 2026-09-26 below but was superseded in practice
by the experimental track before being started; it is now confirmed, not merely
carried over by default. Preserve 01A/01B/02 and the protocol v1 surface; do not
re-litigate their acceptance criteria as part of this task.

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

Latest lifecycle review: [edge-case findings](../../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) records
five reproduced fixes and 67 passing offline tests, including a killed worker,
late provider completion, cancellation races and failed persistence. Historical
live-run hashes predate these fixes; old durable tasks still require migration.

Latest evidence: [task-manager validation](../../reports/doc-agent/manager-findings-2026-09-27.md)
records 56 passing offline tests and preserved live success/failure outcomes.

## 2026-09-27: independent task lifecycle

The [local task manager](../../experiments/doc-agent/TASKS.md) adds task IDs, status/list,
resume, and persisted cancellation around per-task checkpoints. Managed tasks
exclude paused time from their execution budget; the standalone durable CLI
retains its wall-clock policy. This supersedes earlier task-management next-step
notes. Conversation integration, admission control and scheduled triggers remain
future work; uncertain in-flight tasks are still refused.

Review checkpoint: [pre-commit review](../../reports/doc-agent/review-2026-09-27.md)
records 50 passing offline tests and two durable-resume validation fixes. Historical
live manifests predate these fixes; their hashes and results are preserved.

## 2026-09-27: durable single-task checkpoint

[SQLite pause/resume](../../experiments/doc-agent/DURABILITY.md) now supports process restarts from confirmed
retrieval pauses, preserving sources, evidence and budgets. 33 offline tests and
a four-process local Gemma4 run passed. This supersedes earlier descriptions of
persistence as entirely future work; the ordinary graph engine remains optional
and nonpersistent. Arbitrary in-flight crash replay is refused. The next increment
is task lifecycle/scheduling around this unit, with explicit long-pause policy.

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

## Current learning milestone: documentation agent

[Spec 10](10-doc-retrieval-agent.md) and the [standalone LangChain/Ollama slice](../../experiments/doc-agent/README.md)
supersede the earlier suggestion to begin with a production provider adapter or
Hekate audit. Learning and completing this project are primary; sibling projects
are references. The agent retrieves documentation on demand with native tools,
bounded host execution and local telemetry. Production TypeScript integration
remains separate. The next learning exercise is expressing this working loop in
LangGraph while preserving the same evidence and resource contracts.

## 2026-09-26 planning update

Latest authorized increment: [Task / Guidelines / Response Framework](09-prompt-contract.md)
and [experiment 2](../../experiments/prompt-contract/README.md). A typed immutable
package and deterministic renderers are implemented outside the application.
Evaluate identical-content controls and new held-out cases before runtime
integration. Scoring is fixed before inference. The next application increment,
after reviewing results, is a TypeScript contract and one LangChain-backed
provider adapter with existing behavior preserved; it is not part of this run.

**Experiment 2 complete:** [600 live calls and findings](../../reports/prompt-contract/findings-2026-09-26.md).
On the new held-out cases TGR scored 40/60, flat identical-content text 38/60,
legacy prose 36/60, JSON 32/60 and XML 35/60. TGR versus flat had four paired wins,
two losses and 54 ties; calibration favored flat by one answer. Keep the package
boundary and configurable rendering, without claiming a universal accuracy gain.
Nine new experiment tests and seven existing pilot tests passed. No production
provider or LangChain integration occurred. Review the report before starting
the separately bounded TypeScript/provider integration.

Prior work: the [prompt-encoding pilot](../../experiments/prompt-encoding/README.md)
and design reconciliation in [ADR 0002](../adr/0002-layered-context-and-orchestration.md)
are complete as experimental/documentation artifacts. Preserve those reports.
Both prompt experiments are independent of the runtime; neither implements a
production translation layer. Layer-specific context policy and a bounded
LangChain integration remain separate follow-up work. The spec 03 inventory scope below remains
queued; it is not the task selected by this latest discussion. Hekate reuse needs
a separately scoped source investigation; do not modify sibling repos here.

Current user direction: **keep work in ChatAgent**. Leave Iris/Hekate changes and
integration validation for sessions working on those repositories. Existing
cross-repository commits are historical context, not authorization to expand scope.

## Prompt-encoding pilot checkpoint (2026-09-26)

The [live pilot findings](../../reports/prompt-encoding/findings-2026-09-26.md)
record 240 scored calls across five installed local models and four formats.
The content score was 81.7% prose, 71.7% concise, 65.0% JSON and 71.7% XML;
this uses an explicitly post-hoc presentation normalization. Exact output-contract
scores, per-model results, token counts and raw records are retained separately.
No universal encoding winner is claimed. Seven experiment tests passed. No
production renderer or framework dependency was added.

## Completed

- 01A bounded context, pending-task awareness, immutable fast/deep snapshots,
  effective model context limits, and CTX-01–04 regression fixes.
- 01B background internal summaries, immutable source identities and bounded
  source checks. Default extractive mode makes no model calls. Optional model mode
  requires explicit fast-binding selection and separate request budgets. See
  [01B evidence](01b-evidence.md) for acceptance coverage and implementation limits.
- Spec 02 streaming/cancellation and preserved fast/deep answers; see
  [02 evidence](02-evidence.md).
- ChatAgent protocol v1 endpoints are present. Prior Iris integration evidence is
  retained in [the slice checkpoint](07-iris-slice-evidence.md); do not continue
  that repo's work as part of the next ChatAgent milestone.

## Next bounded implementation: spec 03 inventory

Read [03 inventory](03-inventory.md) and the applicable metadata requirements in
[08 resource policy](08-resource-policy.md). Implement connections, catalog v2
migration, fresh provider observations and the named RES-01/03/04/08 fixtures in
ChatAgent. Preserve unknown locality, billing, access and health states rather
than inferring them from provider names. Do not implement dispatch/CLI incidentally
or download models, activate subscriptions, or perform billed probes.

## Limits and deferred work

- Runtime timelines, sources, summaries, queues and duplicate claims are in memory;
  restart persistence and durable replay remain deferred.
- Model summary output is structurally validated, not semantically certified.
  Source checks are bounded ID lookup, not semantic retrieval or tool execution.
- Correction/directive detection is conservative lexical handling, not universal
  contradiction or intent detection. Summaries never become verified facts.
- Summary jobs cancel and settle on server shutdown. Full worker/provider draining
  and the broader spec 06 lifecycle remain separate work.
- No live provider, real browser/mobile or desktop quality gate ran for 01B.
- Existing development processes were not restarted. Restart loses runtime state.

Suggested task: "Implement only ChatAgent spec 03 inventory and its resource
metadata fixtures. Preserve completed context/generation work and keep other
repositories out of scope."

## Canonical examples comparison — 2026-09-26

Twelve local Gemma4 runs compared the same tools and schemas with and without
three fictional examples. Structural checks improved from 4/6 to 5/6, while
reported input tokens rose 39.3%; evidence coverage and absence wording remain
limited. Keep examples optional. See the [results](../../reports/doc-agent/examples-findings-2026-09-26.md).
The next framework-learning step remains LangGraph; a separate retrieval-quality
experiment should address missed sections before expanding the tool set.

LangGraph live evidence: [four-case report](../../reports/doc-agent/langgraph-findings-2026-09-27.md).
All structural checks passed. Keep the known uncertainty-wording limitation visible.
