# Development roadmap

Updated: 2026-09-25. This is the current plan; earlier review and design documents
remain as historical context.

## Baseline and scope

The target is a convincing local demonstration of fast replies followed by useful
deep answers, with honest measurements and interchangeable providers. Keep the
current TypeScript/Node server and vanilla browser UI. Provider selection remains
read-only in the UI and changes through environment configuration plus restart.

The stabilization pass includes:

- UUID message/task identities and correlation across user, fast, and deep events.
- Per-turn completion and route display; late fast replies cannot replace refined answers.
- Deep tasks queued before waiting on the fast provider, with a fallback acknowledgment
  if the fast provider fails on a deep-routed request.
- One active deep task per worker, shared by automatic and manual execution.
- Azure/Ollama timeouts covering response-body reads, not just headers.
- Serialized atomic telemetry saves, unique temporary files, recovery after failed
  writes, and handled background save failures.
- Explicit routing-threshold environment settings taking precedence over saved policy.
- Evaluation CLI failures returning nonzero exit status, synthetic measurement labels,
  and corrected golden routing expectations for current-day questions.
- A GitHub Actions workflow for clean install, release checks, and compilation.
- Vitest upgraded to 4.1.11; `npm audit` reports zero known vulnerabilities after
  the upgrade. The upstream [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
  identifies 4.1.11 as a patched release. Node requirements now match the tooling.

## Verification and evidence

Follow-up startup diagnosis: the server on port 3100 was still the process started
at 16:51, before stabilization. A second `npm run dev` printed a premature success
message and then failed with EADDRINUSE. Startup now waits for a successful bind
before logging success or starting timers, and reports an explicit occupied-port
error. After restarting the verified old process, live HTTP probes confirmed the
new HTML and message IDs plus `processingStatus: complete` on direct timeline events.
The startup regression brings coverage to 109 tests across 28 files; tests and
type checking pass. This fixes startup observability, not model hallucinations.

Stabilization verification on Windows / Node 24.15.0: 108 tests across 27 files,
type checking, fixture evaluation, benchmark comparison, and compilation passed.
A clean isolated copy also passed `npm ci` and the full release/build checks with
no `.env` file present. `npm audit` reported zero known vulnerabilities. The hosted
GitHub Actions workflow has not run yet; there is no remote configured.

The original working directory had an active process holding `esbuild.exe`, so
`npm ci` there encountered Windows EPERM. Dependencies were restored with
`npm install`; the clean-install check was completed in an isolated copy without
stopping existing user processes. Stop local dev/watch processes before future
in-place clean installs if the same file lock recurs.

Run `npm ci`, `npm run verify:release`, and `npm run build` from a fresh checkout.
The release command runs tests, type checking, fixture evaluation, deterministic
simulated benchmarks, and baseline comparison. CI sets `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`; use those settings locally when verifying the baseline.
Compilation is a build check; `npm run dev` remains the documented runtime entrypoint.

Regression coverage includes overlapping turns, deep completion before the fast
reply, fast-provider failure, worker concurrency, stalled response bodies, overlapping
telemetry writes, write recovery, golden routing parity, and failed evaluation exit codes.

The saved `reports/golden-eval.*` files are historical live evidence: 3/5 cases passed.
They predate this stabilization and the corrected day-question expectation. They
have not been overwritten with mock results or claimed as a current live pass.
Mocks test plumbing; they do not answer the live golden suite's factual questions.
Benchmark quality values and fixture scores are not evidence of answer correctness.

## Next milestones, in order

### 1. Reliable live demo

- Implemented: per-bubble generation/queue/thinking/retry indicators and terminal
  failure events, correlated by message ID. Deep-provider activity is visible before
  its answer arrives. Model token streaming remains separate future work.
- Add graceful shutdown that stops intake, bounds in-flight work, flushes telemetry,
  closes SSE clients, and handles SIGINT/SIGTERM. The current close callback alone
  does not guarantee a flush when a process is terminated.
- Add an automatic-worker HTTP integration test and a browser smoke test covering
  two overlapping turns, a fast reply, a refined reply, and a terminal failure.
- Align provider instructions for clarify/direct/deep behavior and timestamp handling.
- Run the live golden suite against one explicitly recorded provider/model pair;
  record configuration without credentials, latency, outputs, and failures.

Acceptance: all five current golden cases pass on the chosen live configuration;
two overlapping turns stay correctly paired in the browser; every deep turn ends
in success or a visible failure; normal shutdown saves the latest telemetry.

### 2. Useful answers and trustworthy evaluation

- Pass bounded conversation history to fast and deep providers.
- Add actual retrieval with source provenance for external-data requests; until
  then, do not present deep routing as evidence that facts or citations were verified.
- Replace route-derived quality scores with a documented human or automated rubric.
- Make live benchmark profile labels reflect the server's actual providers; the
  current runner does not switch providers when iterating configured profile labels.
- Expand the golden set with pronoun ambiguity, keyword substring false positives,
  follow-up questions, unsupported factual claims, and citation verification.

Acceptance: factual answers link to retrieved evidence; follow-ups use prior turns;
quality depends on the answer itself; each live report records the providers actually used.

### 3. Latency and routing decisions backed by measurements

The [model catalog](13-model-catalog.md) now provides validated task/capability
metadata and eligibility filtering. Health discovery, per-task model dispatch,
and measured ranking remain follow-up work; the running router still uses its
configured fast/deep pair.

- Separate provisional-generation and deep-generation metric buckets when both use
  the same provider/model; they currently share the `deep` route key in that case.
- Measure queue wait, time to first answer, time to final answer, failure rate, and
  provider duration separately, including retries.
- Consolidate base/adaptive/simulation routing to avoid divergent heuristics.
- Revisit queue-depth tuning: a busy deep queue currently lowers the fast threshold,
  which can send more work into that same queue. Use server-owned queue depth.
- Retain current-profile priors when loading telemetry from an older configuration.

Acceptance: compare single-path and dual-path runs on identical prompts and recorded
hardware/provider settings; demonstrate first-response improvement without hiding
final-latency, quality, cost, or failure regressions.

### 4. Shared deployment, only after the demo is reliable

Add authentication, request-size limits, durable tasks/history, retention limits,
backpressure, Bedrock request deadlines, and operational monitoring before sharing
the service beyond local use. Do not expand the UI framework or add runtime provider
switching unless a demonstrated need justifies the extra state management.

## Working agreement

- Keep `.env` and local telemetry out of Git. Commit `.env.example` changes when
  configuration changes; never include credentials in reports or startup output.
- Make small commits with focused regression tests for behavior changes.
- Keep failing live evidence and fix the cause; update expectations only when the
  intended behavior changes, and explain that change.
- Run the release checks before merging. A simulation pass is a code baseline,
  not a provider performance claim.
- The repository currently has no remote. Commits are local until a destination is
  configured; the included CI workflow will run when hosted on GitHub.
