# 06 — Lifecycle and honest end-to-end verification

Status: planned. Integrates 01–04, and 05 when enabled. Code gates are offline;
live answer-quality gates require separately identified provider configuration.

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
must match; missing/incompatible quality evidence fails quality comparison clearly.
Preserve existing baseline artifacts as historical rather than silently regenerating
them to suit new metrics. Add a new versioned baseline after explaining methodology.

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

## Live evidence and completion

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
