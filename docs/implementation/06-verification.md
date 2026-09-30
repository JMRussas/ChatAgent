# 06 — Lifecycle and honest end-to-end verification

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

Compare identical prompts against one streaming model and the dual-path setup.
Use at least 30 prompts with at least 10 deep-eligible cases, three repetitions,
identical history snapshots, recorded warm/cold condition and versioned annotations.
Report latency distributions and failure/quality counts; do not promise improvement
before measuring it. A valid finding that dual-path does not help is acceptable.

Run `npm ci` in a clean copy, common release/build checks and browser checks. Report
code-gate results separately from live results. If cloud/CLI credentials or browser
binaries are unavailable, enumerate the unrun checks; do not mark the whole milestone
complete. Authentication, durable storage, retrieval and production rollout remain
separate work after this handoff.
