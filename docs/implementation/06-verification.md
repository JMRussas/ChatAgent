# 06 — Lifecycle and honest end-to-end verification

## Active testing plan — 2026-10-10

This section governs the testing review and cleanup. It supersedes earlier test
sequencing in this document; dated evidence below remains historical. This is a
plan, not a claim that the suite has already been reorganized. Current work and
delivery status belong in the [roadmap](../12-development-roadmap.md).

### Objective and review findings

The product goal is to make AI-assisted and agentic work digestible, observable
and easy for a human to monitor and direct. Successful execution is necessary;
the person must also understand what is happening without reconstructing it from
logs, internal identifiers or a conversation with the developer.

Tests should catch failures that affect task completion, correctness, privacy or
recovery, with the cheapest reliable check for each behavior. The central workflow
is simple: read the next eligible task, supply its inputs and context to the
chosen API, tool, model, agent or human, check and record the result, then continue.
Manual execution of those same steps is the baseline for judging whether
automation reduces work.

For a representative task, the normal view should answer:

- What are we trying to accomplish, what is running, and what comes next?
- What has changed or finished, and where is the actual result?
- Is work progressing, waiting for me, blocked, failed, or of unknown status?
- What decision or action is needed from me, and how do I stop or redirect work?

Show a concise activity summary and relevant results first, with detailed evidence
available when needed. Status must distinguish observed facts from model claims;
do not imply useful progress just because a process is alive. Identifiers and
diagnostic records support inspection but should not be prerequisites for routine
monitoring. Use existing components to present this information before adding
infrastructure.

Browser/workflow tests should check those observable states and available actions.
A short human walkthrough must also check comprehensibility: can the person locate
the current task, explain its status, find its result and act on a blocker without
developer narration or opening raw logs? Record confusion and navigation effort;
DOM assertions alone cannot establish usability. Run this walkthrough early on
the existing workflow. Completing the whole test reclassification is not a
prerequisite for demonstrating useful work.

The inventory at `90b694b` is 227 Vitest files: 161 under `unit`, 61 under `integration`,
four under `eval`, and one under `acceptance`. Nine Playwright spec files run
separately. `npm test` includes all four Vitest directories. Directory names do not
yet reliably describe dependencies: some unit files create Git repositories or
spawn processes; the acceptance file uses mock providers; evaluation tests include
report/schema checks rather than model-quality judgments.

The last recorded local full run passed 3,502 tests with one skip in 288.13 seconds
on Node 24.21.0. That is a baseline for that machine and run, not a speed target or
proof of product usefulness. The review inspected configuration, representative
UI, workflow, fixture and evaluation tests, and prior run evidence. It has not
classified every assertion or established a suite-wide flake rate.

Claude Fable independently reviewed the inventory and representative assertions.
Its first cleanup action removed mapped source-spelling, maintained-source hash
and duplicate formatter assertions, retaining exercised browser behavior and
public bounds. The mock prototype now lives in
`tests/unit/prototypeConversation.test.ts` as component coverage: a controlled
completion proves provisional persistence before admitted deep work and refinement
of the same message afterward. Mock citation fields are only shape checks, and
the one-second host-speed assertion is removed. Making the existing
fast/integration categories executable is implemented for the current directory
partition. `test:fast` selects unit/component files; it is an initial lane and
still includes known process, Git and loopback cases awaiting reclassification.
`test:integration` selects integration, deterministic eval and future acceptance
files. The measured migration inventory covered all 228 files without overlap;
the original `npm test` selection remains unchanged. Preserve
immutable executable, verifier and evidence integrity pins. These changes support
product delivery; they do not delay the workspace walkthrough.

For the factual work digest, verify state projection, current versus historical
revision, allocation versus running, step approval versus task verification,
read-error versus decision, and agreement across direct tools, chat and MCP.
Browser checks exercise count partitioning, pending prompts and actual response
forms, timestamps and mobile visibility. This projection has no model dependency,
so live model calls do not add evidence for this change.

Fable assesses UI clarity from fresh real-data screenshots against its rubric,
with no implementation report supplied as grading evidence. It records visible
support or unknowns for each criterion. That review is separate from deterministic
correctness checks and is not a CI gate. The reviewed revision, model findings and
user acceptance remain distinct records; a design review never implies acceptance.

Confirmed problems:

- A harmless production variable rename breaks the plan-status source-string
  assertion. Its existing request test already checks the URL, GET method and
  number of calls. The failed rename experiment is retained under external run
  `overview-auto-refresh-20261010/ca025-live/original-oracle-counterexample.json`.
- Other UI assertions depend on internal function names, source formatting and
  concatenation syntax. Some have equivalent behavioral browser coverage already.
- Permanent tests contain frozen source hashes from individual delivery tasks.
  These can reject comment changes without finding a behavioral defect.
- Some tests pay for full Git fixtures while mocking the coordinator they exercise.
  Others repeat the repository-wide formatter check inside behavior suites.
- Mock workflow results, report formatting and synthetic benchmark results can
  pass without demonstrating useful live model output. Keep those claims separate.

### Test types and what each earns us

| Type                     | What to test and why                                                                                                                                                                  | Dependencies and normal use                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                     | Selection rules, validation, state transitions, bounds, redaction and prompt/context construction. Pin decisions and observable outputs so defects are easy to locate.                | In-memory inputs and controlled clock; no real Git, network or child process. Run during ordinary edits.                                                                                                                         |
| Component                | Execute the actual UI script or service with a controlled transport/provider. Check requests, rendered state, cancellation and late results across collaborating functions.           | Fake external edges, real component logic. Fast development feedback; do not replace the component under test with a mock.                                                                                                       |
| Integration/contract     | Verify HTTP/auth, persistence, provider protocol parsing, CLI arguments/exits, Git delivery and process cleanup across real boundaries. Catch assumptions that isolated tests cannot. | Local server, temporary store/worktree or controlled child as needed. Run affected suites locally and all required offline suites in CI.                                                                                         |
| Browser                  | Verify important user journeys: start/view/stop work, scope changes, stale/error states, keyboard actions and inert rendering of hostile text. Catch real DOM/event/wiring failures.  | Real Chromium and application server; controlled backend responses are allowed and identified. Run affected specs for UI changes and the full browser gate in CI.                                                                |
| Workflow acceptance      | Exercise next-task selection through prompt delivery, completion checking, saved result and progression. Establish that the assembled loop works.                                     | Real workflow components with a deterministic model substitute for CI. A separate small live run checks actual provider wiring and useful artifacts.                                                                             |
| Model-quality evaluation | Judge actual task completion, groundedness, instruction following and necessary human correction. Detect regressions that “request succeeded” cannot detect.                          | A small representative set of tasks, expected outcomes/rubric defined before running, retained outputs and actual model/settings. Run when prompts/models/context/tool behavior change and before claiming quality improvements. |
| Performance/reliability  | Measure latency, memory, throughput, cancellation latency and resource cleanup where those are product requirements.                                                                  | A declared workload and environment, repeated measurements and explicit real/synthetic labels. Run affected checks after relevant changes; keep ordinary correctness tests independent of host speed.                            |

Static checks remain a separate gate: pinned formatting, TypeScript and contract
documentation validation. They are useful once per change, but do not need a copy
inside every feature's tests. Security, privacy and concurrency are risks tested
at the appropriate levels above, not additional duplicate suites for every layer.

Property-based or table-driven cases are useful when inputs have meaningful
partitions: valid/invalid identifiers, bound minus one/at bound/plus one, missing
fields, or different event orders. Use existing table-driven facilities first.
Do not add a new testing framework or enumerate combinations without a distinct
failure to catch.

### Minimum acceptance for the plan loop

Use the existing queue/continuation implementation. Testing this loop does not
require another scheduler, agent hierarchy or evidence service. Consolidate around
these behaviors, mapping existing cases before adding anything:

| Scenario                                      | Required observation                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two eligible tasks                            | The first eligible task starts once; the model receives that task's instructions/context; its checked result is recorded against that task. The second starts only after the first meets the existing completion/acceptance policy. |
| Nothing ready                                 | No model invocation; an understandable idle or blocked result. Completed or ineligible tasks are not selected again.                                                                                                                |
| Model failure, invalid result or failed check | The failure is retained; the task is not reported as successfully accepted and the loop does not silently advance or retry indefinitely.                                                                                            |
| User stop or deadline                         | Active work follows the documented cancellation policy; no next task starts; status identifies what finished and what remains uncertain.                                                                                            |
| Stale result, restart or uncertain completion | A result cannot complete another task/attempt. Resumption follows the supported contract; uncertain work is reported rather than blindly executed twice. Do not imply exactly-once effects or crash recovery where unsupported.     |

`tests/integration/checkpointQueueService.test.ts` already covers ordered starts,
acceptance waiting, unavailable API, stop, deadline and some resume/refusal cases.
Inspect prompt delivery and result persistence in the continuation coverage before
adding a consolidated acceptance case. Keep representative real boundary tests;
exercise the detailed state combinations in faster tests.

After cleanup, run a short plan with a real model on useful, independently
checkable tasks. Record completed outcomes, failures, necessary interventions and
elapsed/operator time, with unknown usage or cost left unknown. A model's “done”
message is not the acceptance criterion. Use the same task instructions and
checking standard as manual execution; compare comparable runs before claiming
automation saves effort. One successful run establishes a smoke check only.

### Concrete keep, simplify and remove decisions

| Priority and current location                                                                                                                                                                                                                  | Decision                                                                                                                                                                                                    | What remains or must replace it                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First: `tests/unit/planStatusPanel.test.ts`, static fetch count and literal `value` URL assertion                                                                                                                                              | Remove those two redundant assertions. Rename the enclosing test to match what it still checks. Do not add a replacement fixture framework.                                                                 | Existing “issues one same-origin GET…” case checks actual request URL, method, body and count. Existing invalid-input, overlap and scope cases remain.                    |
| Next: `tests/unit/attemptProgressUi.test.ts`, `run`, `readButton`, `req.root` and emitted `var` assertions                                                                                                                                     | Remove implementation-spelling checks after mapping behavioral coverage. Retain declared public limit assertions; check enforcement through behavior.                                                       | `tests/browser/attemptProgress.spec.ts` already checks no load-time requests, selected-task GET, six-read limit, timeouts and cancellation. Fill only a demonstrated gap. |
| Next: `tests/unit/homePage.test.ts`, literal event-handler/410 source probes; `tests/unit/documentTaskPanel.test.ts`, exact assignment text                                                                                                    | Replace or remove source-spelling assertions. Keep useful markup/script-parse checks.                                                                                                                       | Map expiry cases in `tests/browser/chat.spec.ts` and document-task browser coverage; any missing behavior gets a direct request/render assertion.                         |
| Next: `tests/unit/attemptProgressTask.test.ts`, frozen prefix/suffix hashes                                                                                                                                                                    | Remove this delivery-scope assertion from evergreen regression testing, preserving its original evidence in history.                                                                                        | Keep public activity, privacy and limit behavior checks. Integrity checks for actual immutable artifacts/executables remain valid and are not targeted by this removal.   |
| Next: embedded `prettier.format` checks in plan-status, home-page, attempt-progress and runbook tests                                                                                                                                          | Remove duplicate formatting checks; split mixed tests so useful behavioral assertions remain.                                                                                                               | Repository `npm run lint` already runs pinned `format:check`. Preserve formatter-runtime integration tests, which test product behavior.                                  |
| Review separately: `tests/unit/conversationOperationsRunbook.test.ts`, frozen verifier and document hashes                                                                                                                                     | Separate historical evidence integrity from tests of maintained helpers/docs. Determine whether each target is an immutable archived artifact or a maintained source before moving its check.               | Preserve historical bytes and useful projection semantics. A source change should not require casually rewriting an “approved” hash to make tests pass.                   |
| Fixture cost: `tests/integration/operatorHandoffControlled.test.ts`                                                                                                                                                                            | The controlled handoff cases retain their real Git fixtures after moving to integration. Simplifying mocked classification/registry cases to a valid manifest and temporary directory remains future work.  | Keep real coordinator/Git tests in integration coverage, including ownership, source mismatch and cleanup. Do not share mutable worktrees across cases.                   |
| Classification: `tests/integration/checkpointRun.test.ts`, `tests/integration/browserSerialization.test.ts`, `tests/integration/dispatchHost.test.ts`, `tests/integration/cliRunner.test.ts`; remaining `evidenceComparison.test.ts` CLI cases | These now run in integration, preserving their actual process checks. Remaining unit boundaries still need classification; the initial fast command is not a strict in-memory lane.                         | Preserve actual OS/process behavior coverage and measure cost. Expensive does not mean valueless.                                                                         |
| Claim correction: `tests/acceptance/prototypeSuccess.test.ts`                                                                                                                                                                                  | Classify its mock-provider checks as component tests. Replace the one-second mock wall-clock assertion with deterministic completion/order behavior unless a measured performance requirement justifies it. | Citation presence on mock output proves neither current-data retrieval nor answer correctness. Useful acceptance requires the workflow and quality checks above.          |

Do not delete all fixed expected values. An exact API path, method, schema field,
known answer, privacy exclusion or contractual bound is often precisely what must
be asserted. Internal variable names and equivalent ways to construct the same
request are different. Likewise, different layers can legitimately check the same
risk when they expose different failures, such as policy denial and actual HTTP
authorization enforcement.

Static forbidden-source scans are limited guardrails, not proof of security. Keep
them only for an explicit maintained coding constraint; prefer hostile-input,
unauthorized-request and data-exposure behavior tests for product guarantees.

### Execution policy and implementation order

1. **Remove confirmed low-value checks.** Start with the two plan-status assertions,
   then the mapped UI/source-hash/duplicate-formatting cases above in small changes.
   Record the surviving behavioral coverage in each change. For the plan-status
   cleanup, a harmless rename/equivalent URL must pass, while a wrong endpoint,
   method or duplicate request must still fail. These are bounded review experiments,
   not a permanent source-rewriting test framework. Reuse retained evidence where
   it applies; do not replay a matrix merely to increase test counts.
2. **Make categories executable.** Classify files by actual dependencies; split
   mixed files only where useful. Add `test:fast` for unit/component checks and
   `test:integration` for boundary checks; keep `test:browser` separate and retain
   `npm test` as the complete offline Vitest suite. These two commands are now
   available for the initial directory partition; remaining boundaries and the
   full fast-lane measurement are outstanding. Confirm the selections have no
   overlap and together include every retained Vitest file. Preserve cited test
   paths/tags and run `docs:check` when files move.
3. **Reduce fixture cost at the measured hotspots.** Simplify mocked handoff tests
   first, then inspect dispatch/continuation costs. Use controlled time/deferred
   promises for logical scheduling, and real clocks/processes for OS lifecycle
   checks. Set worker concurrency from measured host behavior. Record one baseline
   and comparable after-change timings; investigate failures before changing
   timeouts or enabling retries.
4. **Close actual workflow gaps and perform a live usefulness check.** Map existing
   tests to the five loop scenarios above. Add only missing coverage, then run the
   small useful live plan. Preserve failed outputs; inspect the delivered artifact
   independently of the model's self-report. A failed test design gets corrected;
   a real product failure gets fixed.

During an edit, run the affected behavior tests and the appropriate nearby boundary
or browser tests. At handoff, run required formatting/lint and documentation checks
where applicable. During this migration, keep current full Linux/Windows and
browser CI requirements; faster local feedback must not silently omit release
coverage. Documentation-only planning changes need formatting/lint, not a replay of
the entire runtime suite. Changes to runtime behavior need the applicable code gates.

After classification, aim for an affected-test loop below 30 seconds and the full
fast lane below 60 seconds on the recorded development machine. These are initial
engineering targets to assess after measurement, not per-test correctness assertions
or reasons to skip coverage. Required offline checks remain the merge gate; live
quality runs are separately reported when affected, and performance runs use the
declared relevant workload. An unavailable required dependency must fail its gate;
optional/platform skips must be visible and justified.

Each changed test should answer: what real failure does this catch, why does it
belong at this layer, and does an existing cheaper test already catch that failure?
Expectations must come from the contract or known outcome rather than copying the
production algorithm. Use a targeted negative control when a test's ability to
detect its claimed defect is uncertain. Avoid whole-suite mutation campaigns for
routine edits, blanket coverage-percentage targets, count-based success criteria,
or a new mandatory metadata system for every test.

The cleanup is complete when the named brittle checks are resolved, execution
lanes match their dependencies without dropped coverage, the core workflow has
mapped behavioral acceptance, and timings plus a live task outcome are reported
honestly. The live walkthrough must also report whether the workflow was easy to
understand and monitor, including any need for developer explanation. Fewer tests
is acceptable; reliable signal, useful task completion and reduced human effort
are the measures of success.

## Active application — NBA briefing demo

The user selected [NBA briefings](../18-nba-briefing-demo.md) as the next concrete
workflow. Apply remaining overlap, cancellation and coordination checks there.
This supersedes deferring all sports work until this document's gates finish;
quality review and fair repeated comparisons remain open. The initial planner
provides no live-source or concurrency acceptance evidence.

Status: in progress. 06A runtime shutdown and automatic-worker HTTP acceptance
implemented (439 tests / 61 files, typecheck, build, simulated release gate pass).
06B passive recorder/artifact and annotation contracts are implemented; see
[06B setup/evidence](06b-recording.md). Live benchmark deadline/correlation and honest observation reports are implemented
(462 tests / 62 files; see latest handoff). Recorder comparison/annotation gates and experiment compatibility are implemented
(see 06B comparison usage). HTTP observation/recorder linkage is implemented
(513 tests / 66 files, typecheck/build/simulated release pass). Remaining:
live/concurrent overhead acceptance (synthetic recorder-component and mock HTTP
measurements are available in 06B evidence) and live quality comparisons remain.
Chromium browser acceptance is implemented and passes eight cases; see evidence below. Integrates 01–04, and 05 when enabled. Code gates are offline;
live answer-quality gates require separately identified provider configuration.

## Clean-copy installation evidence — 2026-09-30

A fresh local clone of `afc1733` passed installation and all common code/browser
gates on Windows x64 with Node 24.15.0 and npm 11.12.1. No ignored configuration or
credentials were copied; the child environment contained allowlisted OS variables
and explicit seeded-simulation settings. npm used fresh cache storage and empty
user/global configurations. Playwright downloaded Chromium into a fresh directory.

Commands: `npm ci`, `npm run verify:release`, `npm run build`,
`node node_modules/playwright/cli.js install chromium`, `npm run test:browser`.
Results: **535 tests / 68 files**, typecheck, evaluation report, seeded benchmark
comparison, build and **eight browser tests** passed. Lockfile hashes match before
and after. [Machine-readable evidence](../../reports/clean-copy-verification-2026-09-30.json)
records revision, versions, timings, exit codes, hashes and limits. Only generated
benchmark time and mounted-filesystem mode bits changed in the disposable checkout.

This closes the Windows clean-copy check, not Ubuntu CI, Python validation, live
quality acceptance or the repeated streaming comparison. No provider calls were
needed. Full spec 06 remains in progress.

## Shutdown and ownership

Refactor server composition to expose `startServer` returning a RuntimeHandle with
server, actual bound address and idempotent `shutdown(): Promise<void>`. index.ts
owns SIGINT/SIGTERM registration, calls shutdown once and sets a failure exit code
if cleanup fails. Tests call the handle directly and do not install global signals.

Shutdown order: reject new messages with 503 SHUTTING_DOWN; cancel/await internal
summary jobs and prevent further memory publication; stop worker/discovery/
save timers; allow running work `SHUTDOWN_GRACE_MS=5000`; then cancel remaining
requests/CLI processes; mark pending tasks cancelled; close SSE responses and idle
connections; await the serialized final telemetry save; close HTTP server. Overall
deadline `SHUTDOWN_TIMEOUT_MS=10000` must exceed grace; validate configuration.
Report persistence failure explicitly without hanging. In-memory queues are not
durable and must not be described as surviving a restart.

## Measurement changes

[Resource policy](08-resource-policy.md) governs execution/billing/compute metadata
and cost measurement. Implement RES-08 reporting and verify RES-05/06 accounting;
estimated, reserved, reported, fixed/amortized and unknown costs remain distinct.

Change `src/bench/liveBenchmark.ts` to use deadlines and message-correlated terminal
events, not four tight polls or manual-worker call counts. Poll every 100 ms (or
subscribe to SSE) until a terminal event or configurable 120-second deadline.
Automatic worker is the primary scenario; manual mode is a separate deterministic
test. Count retries from attempt events, never from polling iterations.

Record per turn: actual model bindings/revisions, route/task, mode, fixture digest,
configuration digest without secrets, request start, first answer-token time,
first useful answer time when annotated, final time, queue duration, provider
duration per attempt, cancellation/failure/truncation, usage if available, measured
or unknown cost, and quality rubric outcome. An acknowledgment is not automatically
a useful answer. Unknown quality/cost/usage remains null, not zero or a fixed score.

Replace `qualityFromRoute` in live evaluation. Use a versioned external annotation
file keyed by prompt ID plus response hash (to avoid grading a changed answer with
an old score). Rubric fields: correctness pass/fail/unrated, relevance pass/fail/unrated,
unsupportedClaims yes/no/unrated, and optional firstUsefulEventSequence. Automated
fixture assertions may supply explicit scores only when they truly check correctness.
No annotation means unrated; quality gates cannot pass with missing required ratings.
Citation presence alone is not evidence of source support.

Live runner reads actual selection/runtime metadata; do not loop through hypothetical
profile names against an unchanged server. One run represents one actual configuration.
Simulation stays available with explicit synthetic labels and separate schema/version.
Update compareCore so modes, dataset versions, config identity and quality methods
must match by default. Controlled comparisons use a versioned experiment manifest
that declares allowed configuration differences before execution (for example,
single/dual path or orchestration strategy). Validate all remaining fields and
retain each configuration's distinct digest; do not bypass compatibility checks.
Missing/incompatible quality evidence fails quality comparison clearly.
Preserve existing baseline artifacts as historical rather than silently regenerating
them to suit new metrics. Add a new versioned baseline after explaining methodology.

## Evaluation mode

Implement the passive recorder and artifact contract in the
[evaluation plan](../04-evaluation-plan.md#evaluation-mode-planned-2026-09-29).
Reuse existing turn/task/attempt correlation and serialized telemetry persistence;
add run and parent-child call identities where needed. Recording is independent of
orchestration selection. Record supported paths; sub-agent execution is not a
prerequisite. The strategy comparison follows when its conditions are available.

The [Claude reasoning comparison](../04-evaluation-plan.md#claude-reasoning-conditions)
records actual model/transport support and declared thinking/effort differences.
Answer-only runs cannot establish inter-tool reasoning effects. The optional
[tool-use LoRA design](../16-tool-use-lora.md) follows the sports tool baseline;
it does not add a training requirement to this spec.

Named acceptance cases:

- **EVAL-01 — Passive recording:** a deterministic deferred-provider scenario with
  recording on/off produces identical provider requests, tool actions, selection,
  retry decisions and terminal answers, excluding recorder metadata/timestamps.
  Use controlled time for this invariant; assess real timing/deadline effects in
  EVAL-06 rather than requiring identical live timing.
- **EVAL-02 — Trace integrity:** overlapping turns, retries and cancellation preserve
  run/turn/task/attempt and parent-child identities. Distinguish parallel durations
  from elapsed time; unavailable usage and cost remain null.
- **EVAL-03 — Reproducibility and scoring:** retain actual configuration, dataset,
  prompt/code identity, response hashes and versioned annotations. Reject incompatible
  comparisons except differences declared in the experiment manifest before execution.
  Verify access to the exact scored answer or mark its review evidence unavailable;
  distinguish redacted artifact hashes from scored answer hashes. Missing required
  ratings cannot pass quality gates.
- **EVAL-04 — Capture boundaries:** redact secret-bearing fixtures before persistence,
  default to metadata-only capture and exclude private reasoning. Verify configured
  retention/size limits and explicit dropped-event counts.
- **EVAL-05 — Recorder lifecycle:** completion, cancellation, shutdown and write
  failure yield flushed artifacts or explicit incomplete/failed recording status.
  Recorder failure does not change answers or trigger inference retries; the
  evaluation command reports invalid evidence with a nonzero exit status.
- **EVAL-06 — Measurement validity:** reports separate live/synthetic evidence,
  failures and unrun conditions, aggregate executed child usage without double
  counting, and include measured recorder overhead from matched on/off runs.

Map these cases to named tests/evidence at implementation. Recorder fixture tests
cannot establish live orchestration quality or performance improvements.

## Browser and HTTP acceptance

Add Playwright as a dev-only browser test dependency when implementing this spec,
with `test:browser` script and CI browser installation. Use a dedicated test server
with deferred mock providers on an ephemeral port; never depend on port 3100 or .env.

- Direct stream: correct bubble displays draft + spinner, then Complete without spinner.
- Deep stream: queue → Thinking with selected model → answer → Refined.
- Two overlapping turns: late fast/deep chunks never affect the other turn.
- Failure, cancellation, length finish and auth/quota errors terminate progress honestly.
- SSE reconnect reconstructs text without duplicate tokens; connection status clears.
- Keyboard submit/cancel work, activity has accessible status text, reduced-motion
  preference suppresses spinner animation, and mobile bubbles remain readable.
- Automatic worker HTTP test completes a queued job without run-once requests.
- Shutdown tests use deferred provider, active SSE client and pending telemetry save;
  assert deadline, no leaked handles, final persistence, and idempotence.

## Browser acceptance evidence (2026-09-30)

`npm run test:browser` runs eight Playwright Chromium cases against a new loopback
server on an ephemeral port for each test. `tests/browser/fixture.ts` supplies
controlled mock providers and an automatic deep worker; tests release real provider
awaits to exercise the production service, timeline and HTTP/SSE handler. No `.env`,
port 3100, Hekate or live provider is required. Teardown uses RuntimeHandle.shutdown.
Playwright is dev-only; CI installs Chromium with system dependencies and runs this
gate after the existing release/build checks. Local browser setup is
`npx playwright install chromium`. Browser traces are retained on failure in the
ignored `test-results/` directory. The fixture pattern follows
[Playwright's fixture documentation](https://playwright.dev/docs/test-fixtures).

Coverage:

- Direct draft text, active aria-busy/spinner, final answer and cleared progress.
- Deep queued state, selected model, overlapping second turn, late chunk isolation
  and final fast/deep answers from automatic processing.
- Provider auth/quota/general failure and length truncation stop progress honestly.
- Keyboard activation of Send/Stop, cancellation, polite activity announcements,
  reduced-motion spinner behavior and no horizontal overflow at 390px width.
- Real SSE connection closure/reconnect restores accumulated text without duplication
  and clears the reconnect message before final completion.

The browser tests exposed a real omission: `.activity-spinner` had CSS but no DOM
node. Active reply summaries now render an aria-hidden spinner alongside their text,
hide it at termination, and honor reduced motion. The tests assert visible state;
they do not replace a full assistive-technology audit or certify other browsers.
Firefox/WebKit and real mobile hardware were not run. Mock answer strings do not
establish factual accuracy or live-provider performance.

## Live evidence and completion

### Grounding and follow-up evidence (2026-09-30)

The [scenario suite](../../data/grounding-followup-scenarios.json) now exercises
five two-turn conversations through the real HTTP runtime and local Claude bridge.
See [execution and linking](06b-recording.md#grounding-and-follow-up-scenarios) and
the [dated evidence](../../reports/grounding-followup-review-2026-09-30.json).
The initial failed batch exposed and led to a fix for discovery refresh timing.
The retained rerun completes 10/10 turns; assistant review of final answers grades
10/10 groundedness and 8/10 task completion. Two deliberately unanswerable turns
remain task failures, so overall quality is not marked passed. This exercises
supplied evidence and conversation history, not real retrieval or a complete
acceptance matrix for spec 01. Independent calibration and repeated single/dual
measurements remain unrun.

### Claude debugging follow-up (2026-09-30)

Subsequent [v2 quality review](../../reports/claude-quality-linked-2026-09-30.json)
of the same final answers reports **3 pass, 1 fail, 1 unavailable**, independently
of the 5/5 runtime/structural result. Inflation fails task completion; domain factual
verification is incomplete. See [grading contract](06b-recording.md#separate-execution-grounding-and-task-completion-grading-v2).

The [dated debugging report](../../reports/claude-debug-2026-09-30.json) retains
failed/intermediate runs and a final **5/5 structural pass**. Capacity is serialized
with the existing bounded-wait policy (30 seconds, one slot). Usage inspection is
shared and cached within its original 30-second validity, with safe HTTP 429
diagnostics and backoff. Selection exclusions now survive in optional
`selectionExclusions` on live v2 records; older v2 files remain readable. Startup
readiness snapshots are also saved by `eval:live-accept`.

The CLI bridge now preserves earlier public answer blocks and stops its child on
the first streamed output limit, returning `length` instead of accepting a tail-only
continuation as complete. An intermediate run that reported 5/5 before this fix is
not the final evidence. With honest truncation, one run scored 4/5; a budget-derived
brevity hint then produced 5/5 without increasing token budgets or golden limits.
Length hints remain advisory. Original failure reports are unchanged.

This establishes runtime behavior for these five calls, not factual quality or
retrieval. The latest-data answer states its lack of tools; a current-data sports
demo still needs actual retrieval. Versioned exact-answer grading and repeated
single/dual evaluation remain open. See the handoff for the detailed diagnosis.

### Live Claude golden baseline (2026-09-30)

`npm run eval:live-accept -- reports/evaluations/<new-run-directory>` is an explicit
live, capacity-consuming command, separate from offline release verification. It
requires catalog routing and the configured `claude-hekate-default` binding. It
starts an isolated ephemeral runtime, enables answer recording for that process,
disables context summaries and doc tasks, uses the automatic deep worker, and runs
the original five goldens with 120-second observation deadlines. It saves the
dataset, HTTP observations, recorder artifact and structural results. An existing
output directory is refused. Structural success alone leaves quality unrated;
review retained exact answers with versioned annotations before claiming quality.

The [first dated review](../../reports/live-golden-claude-2026-09-30.json) records
**3/5 structural passes; acceptance failed**. Actual attempts used the Hekate Claude
CLI binding, model alias `sonnet`, CLI revision `2.1.285 (Claude Code)`; resolved
model revision, token usage and cost are unknown. The first three cases passed
assistant review of their exact answers (not independently calibrated human review).

- Arithmetic, clarification and verified server-date answers completed in roughly
  3.3–3.8 seconds, within the original limits.
- Latest-data deep execution failed `COMPUTE_CAPACITY_EXHAUSTED`: the configured
  single compute slot and fail-on-contention policy reject overlapping deep work.
  Its fast answer starts mid-sentence and is not a complete useful response.
- The complex comparison was rejected with HTTP 503 `NO_ELIGIBLE_MODEL` before
  turn registration. Selection exclusions were not retained by this observation
  report, so the specific cause remains unconfirmed.

The four recorded turns do not satisfy five-case coverage. Missing final answers
cannot pass grading, and this is not a successful linked or comparative evaluation.
Raw answers remain in the ignored local run directory with retention expiry
`2026-10-07T15:02:32.971Z`; committed hashes and findings alone cannot reproduce an
exact-answer review after those artifacts expire. No retrieval was available, no
streaming first-token measurement was made, and warm/cold condition is unknown.
Account settings and persistent resource policy were not changed.

Next investigate the latter failures, and test an explicitly recorded bounded-wait
profile if paired execution should share one slot. Keep this failed baseline and
write a new run; do not relax original golden assertions.

Run the five current golden cases on an explicitly chosen authorized live pair,
then add follow-up/grounding cases from spec 01. Record provider/model/revision and
safe environment details. Keep existing failing golden reports as historical files;
write new timestamped reports. Failure is evidence to fix, not permission to weaken
assertions. Do not claim unsupported factual accuracy or retrieval.

The next comparison is session-based: layer 1 maintains interaction while deep
work proceeds. Follow the [multitask session design](../17-multitask-evaluation.md)
and implement its deterministic overlapping-action runner before selecting live
models. The six seed sessions contain 30 user messages and at least 12 deep-eligible
tasks; freeze exact fixtures before live execution. Run three repetitions per
supported condition with matching initial history and user-arrival schedules,
recorded warm/cold conditions and separate coordination/deep-work grades. Include
a background-capable single-agent baseline before claiming layered specialization
helps. Single-answer streaming latency is secondary. Existing sequential scenario
linking does not establish session comparison support. Multiple active deep workers
and automatic task revision are capability gaps, not assumed runtime features.
Report failures, unsupported cases and tradeoffs without assuming improvement.

Run `npm ci` in a clean copy, common release/build checks and browser checks. Report
code-gate results separately from live results. If cloud/CLI credentials or browser
binaries are unavailable, enumerate the unrun checks; do not mark the whole milestone
complete. Authentication, durable storage, retrieval and production rollout remain
separate work after this handoff.
