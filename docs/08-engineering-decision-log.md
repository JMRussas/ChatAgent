# Engineering Decision Log

Purpose: keep a durable record of issues, design flaws, test flaws, and approach changes.

How to use this log:

1. Add one entry per issue or decision.
2. Capture root cause and chosen change.
3. Record objective validation evidence (tests, metrics, reports).
4. Link files touched so future reviews can trace reasoning.

---

## 2026-09-25 - Golden Prompt Set for End-to-End Route Verification

Status: Closed

Issue:

- Existing tests validated API routes and rendering contracts, but there was no
  deterministic end-to-end suite that executed the full system against
  expected route behaviors for representative prompts.

Decision:

- Add a golden evaluation harness that runs prompt cases through the live
  server, validates expected route/phase behavior (`fast-only` vs
  `deep-required`), and produces machine-readable plus markdown reports.

Changes made:

1. Added schema-backed golden case definitions and report rendering.
2. Added a live runner that submits prompts, polls conversation events, and
   triggers deep worker ticks for deterministic deep-path completion.
3. Added initial golden dataset with direct, clarify, and deep-route cases.
4. Added unit tests for schema/report behavior and npm script wiring.

Files changed:

- `src/eval/golden.ts` (new)
- `src/eval/runGoldenSet.ts` (new)
- `data/golden-prompts.json` (new)
- `tests/eval/golden.test.ts` (new)
- `package.json`
- `README.md`

Validation evidence:

1. Unit tests pass for golden schema and report generation.
2. Full release gate passes after integration.

---

## 2026-09-25 - UI Shell and Live Polling

Status: Closed

Issue:

- The prototype lacked any visible UI for demonstrating the fast-to-refined swap; reviewers had to infer behavior from curl output.

Decision:

- Serve a first-cut static control-room page from `GET /` using vanilla HTML/CSS/JS.
- Keep API contracts unchanged and poll existing endpoints (`/messages`, `/conversations/:id/events`, `/telemetry/latency`) at a lightweight interval.

Changes made:

1. Added static page renderer module and `GET /` route.
2. Added client-side polling and rendering logic for provisional-to-refined transition.
3. Exposed `queueDepth` in telemetry payload so the side panel can show queue pressure.
4. Added integration coverage for `GET /` plus telemetry queue depth presence.

Files changed:

- `src/ui/homePage.ts` (new)
- `src/server.ts`
- `src/app/chatService.ts`
- `tests/integration/server.test.ts`
- `README.md`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Integration tests include route coverage for `GET /`.
2. Full release verification command passes after the change.

---

## 2026-09-25 - Background Deep-Worker Auto-Run

Status: Closed

Issue:

- The deep path depended on manual `/workers/deep/run-once` calls, which blocked UI viability for automatic provisional-to-refined transitions.

Decision:

- Add an interval-based deep-worker loop in server startup with environment controls to keep deterministic behavior available for tests and benchmark runs.

Changes made:

1. Added deep-worker auto-run config resolution from environment.
2. Added optional interval loop that executes one deep worker tick per interval and logs non-fatal loop errors.
3. Added env template and README documentation for auto-run controls.
4. Added unit coverage for boolean env parsing used by auto-run toggles.

Files changed:

- `src/server.ts`
- `src/config/runtimeEnv.ts`
- `tests/unit/runtimeEnv.test.ts`
- `.env.example`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Full release verification command passes.
2. Runtime env unit tests cover auto-run boolean parsing behavior.

---

## 2026-09-25 - UI Plan Documented

Status: Open (proposed, not yet built)

Issue:

- No UI exists; the prototype is API-only. A discussion of what a UI should look like happened in conversation only and was not recorded anywhere in the project.

Decision:

- Record the recommendation as a standalone plan doc so it survives past the conversation: two-panel layout (chat thread + live routing readout), per-route visual treatment, the open provider-comparison design question, the hard dependency on a background deep-worker loop, and a recommended build order.

Changes made:

1. Added `docs/11-ui-plan.md`.
2. Linked it from the README project-docs list.

Files changed:

- `docs/11-ui-plan.md` (new)
- `README.md`

Validation evidence:

1. None — this is a proposal, not a code change. Building against it is future work.

---

## 2026-09-25 - Class Map Saved to Repo

Status: Closed

Issue:

- A UML-style class map was built and published as a Claude Artifact (a page hosted on claude.ai), which is not part of the git working tree. Publishing an Artifact never writes to disk in the project, so it was not actually saved as project history.

Decision:

- Save the diagram as a standalone, self-contained HTML file inside `docs/` so it is versioned with everything else and opens directly in a browser with no server or build step.

Changes made:

1. Added `docs/10-class-map.html` — inline SVG class diagram covering the composition root (`server.ts`), the application layer, the six port interfaces and their adapters, and the domain DTOs.
2. Linked it from the README project-docs list.

Files changed:

- `docs/10-class-map.html` (new)
- `README.md`

Validation evidence:

1. File opens correctly as a standalone HTML document (full doctype/head/body, no Artifact-runtime dependencies).

---

## 2026-09-25 - Deferred: vitest/vite Dev-Dependency Vulnerabilities

Status: Open (deferred, not actioned)

Issue:

- `npm audit` reports 5 vulnerabilities (3 moderate, 1 high, 1 critical) in the `vitest` -> `vite` -> `esbuild`/`vite-node` dev-dependency chain:
  1. `@vitest/mocker` (moderate) - path traversal / arbitrary file read via redirect mock.
  2. `esbuild` (moderate) - dev server allows any website to send requests and read the response.
  3. `vite` (high) - path traversal in optimized deps `.map` handling; `launch-editor` NTLMv2 hash disclosure via UNC path handling on Windows; `server.fs.deny` bypass on Windows alternate paths.
  4. `vite-node` (moderate) - depends on vulnerable `vite`.
  5. `vitest` (critical) - depends on vulnerable `@vitest/mocker`/`vite`/`vite-node`; arbitrary file read/execute when the Vitest UI server is listening.
- Confirmed pre-existing: not introduced by the `dotenv` addition in the same session (verified via `npm audit --json` before/after).
- All affected packages are devDependencies (`vitest` and its transitive `vite` chain). They ship in `node_modules` for local dev/test only and are not part of the running server (`src/index.ts` has no dependency on them).
- `npm audit fix --force` resolves this by installing `vitest@5.0.2`, which is a breaking major-version change to the test runner and would need its own verification pass (config compatibility, `vitest.config.ts`, `vitest/globals` types in `tsconfig.json`) before landing.

Decision:

- Defer the upgrade rather than force it in unreviewed. Revisit as its own change: upgrade `vitest`/`vite`, re-run the full suite and lint, and confirm `vitest.config.ts` and the `vitest/globals` type reference in `tsconfig.json` still work under the new major version.

Files likely touched when this is picked up:

- `package.json`, `package-lock.json`
- `vitest.config.ts`
- `tsconfig.json` (`types: ["node", "vitest/globals"]`)

Validation evidence:

1. `npm audit` output captured above at time of deferral.
2. No code changes made for this entry; tracking only.

---

## 2026-09-25 - Secure Environment Variable Configuration

Status: Closed

Issue:

- No `.env` support existed; environment variables (including the AZURE_OPENAI_API_KEY secret) had to be exported manually with no documented, gitignored local-config path.
- A non-mock provider with a missing model name silently fell back to a placeholder (`unset-model`) instead of failing at startup.
- Azure/Bedrock "settings are missing" errors did not name which variable was absent.

Decision:

- Add dotenv-based local config loading, with `.env` gitignored and a secret-free `.env.example` template checked in.
- Keep the rule that a real environment variable always wins over `.env`, so CI/production secret injection is authoritative.
- Fail fast with a specific, secret-free error when a required provider variable is missing, instead of silently proceeding.
- Add a redacted startup log line (`describeProviderConfig`) that names active providers/models without ever including credentials.
- Document the security model (secret handling, AWS credential chain for Bedrock, no built-in auth) in the README.

Changes made:

1. Added `src/config/loadEnv.ts`, a dotenv bootstrap imported first by every CLI entrypoint (`src/index.ts`, `src/bench/runBenchmark.ts`, `src/bench/compareBenchmarks.ts`, `src/eval/generateReport.ts`).
2. Added `.env.example` (checked in, placeholders only) and gitignored `.env`, `.env.local`, `.env.*.local`.
3. `loadRuntimeProviderConfigFromEnv` now throws a clear, variable-named error instead of defaulting to `unset-model` when a non-mock provider has no model configured.
4. `buildFastProvider`/`buildDeepProvider` error messages now name the exact missing environment variables for Azure and Bedrock.
5. Added `describeProviderConfig`, a secret-free provider/model summary, and logged it on server startup.
6. Added `## Configuration and secrets` section to README covering local setup, the AWS credential-chain rule for Bedrock, fail-fast behavior, and the lack of built-in auth.
7. Added `tests/unit/providerConfig.test.ts` covering the fail-fast path and asserting the redacted summary never contains a supplied API key value.

Files changed:

- `src/config/loadEnv.ts` (new)
- `.env.example` (new)
- `.gitignore`
- `src/index.ts`, `src/bench/runBenchmark.ts`, `src/bench/compareBenchmarks.ts`, `src/eval/generateReport.ts`
- `src/config/providerConfig.ts`
- `src/providers/providerFactory.ts`
- `src/server.ts`
- `README.md`
- `tests/unit/providerConfig.test.ts` (new)

Validation evidence:

1. Full suite (79 tests across 22 files) and type check pass.
2. Manually confirmed `CHAT_FAST_PROVIDER=azure` with no `CHAT_FAST_MODEL` fails startup with a variable-named error and no stack-trace leakage of any secret.
3. Manually confirmed default (mock) config still starts and logs a redacted summary containing no credential.
4. New unit test asserts a supplied `AZURE_OPENAI_API_KEY` value never appears in `describeProviderConfig` output.

---

## 2026-09-25 - Full Codebase Review

Status: Open

Issue:

- No consolidated review of the codebase existed before the baseline commit.

Decision:

- Record a full read-through review with reproduced bugs, design gaps, and a recommended fix order in a standalone document.

Changes made:

1. Added `docs/09-code-review-2026-09-25.md` with 11 bugs (4 reproduced), 10 design gaps, test observations, and a prioritized work order.

Files changed:

- `docs/09-code-review-2026-09-25.md`

Validation evidence:

1. Test suite (72 tests) and type check were green at time of review.
2. Findings B1, B2, and B4 were reproduced with runnable snippets recorded in the review document.

---

## 2026-09-25 - Provider Request Timeout Handling

Status: Closed

Issue:

- Azure and Ollama provider adapters issued fetch requests with no timeout, so a hung upstream could block fast-path responses indefinitely.

Decision:

- Add bounded request timeouts to provider adapters using `AbortController`.
- Surface deterministic timeout errors so the caller can fail fast instead of waiting forever.

Changes made:

1. Added a shared timeout helper for provider HTTP calls.
2. Applied timeout handling to Azure OpenAI and Ollama adapters.
3. Added unit tests to verify abort-signal wiring and timeout error behavior.

Files changed:

- `src/providers/azureProviders.ts`
- `src/providers/ollamaProviders.ts`
- `tests/unit/azureProviders.test.ts`
- `tests/unit/ollamaProviders.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Unit tests verify timeout wiring and failure behavior.
2. Full release verification command passes.

---

## 2026-09-25 - HTTP Request Payload Schema Validation

Status: Closed

Issue:

- The server rejected malformed JSON, but valid JSON values like `null` still reached property access and could fail with a 500.
- Endpoint bodies were not schema-validated before service calls.

Decision:

- Require JSON request bodies for POST endpoints to be non-null objects.
- Validate endpoint-specific shapes with `zod` before invoking service logic.

Changes made:

1. Added object-body guard to reject `null`, arrays, and primitive JSON values.
2. Added `zod` schemas for `/messages`, `/routing/policy/tune`, and `/routing/policy/set` payloads.
3. Added integration coverage for null-body and invalid-shape cases.

Files changed:

- `src/server.ts`
- `tests/integration/server.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Integration tests cover null and invalid request bodies.
2. Full release verification command passes after the change.

---

## 2026-09-25 - Execution Burndown Tracking in TDD Plan

Status: Closed

Issue:

- Plan progress status was visible through commit history but not summarized directly in the execution plan document.

Decision:

- Add an explicit execution burndown snapshot section to the TDD plan with phase counts, completion ratio, bucket status, and rolling forecast.

Changes made:

1. Added completion metrics (planned/completed/remaining) to plan doc.
2. Added phase-bucket breakdown for scope visibility.
3. Added qualitative schedule signal and rolling forecast notes.

Files changed:

- `docs/05-tdd-execution.md`

Validation evidence:

1. Plan now contains explicit progress snapshot for schedule reporting.

---

## 2026-09-25 - HTTP Malformed JSON Handling

Status: Closed

Issue:

- JSON parse errors on request bodies were surfaced as generic 500 server errors.

Decision:

- Treat malformed request JSON as client input errors and return HTTP 400 with a stable message.

Changes made:

1. Added request-scoped HTTP error type for explicit status mapping.
2. Wrapped JSON parse in try/catch and raised `Invalid JSON body` on parse failure.
3. Mapped request errors to 400 in server handler catch block.
4. Added integration tests for malformed payloads on `POST /messages` and `POST /routing/policy/set`.

Files changed:

- `src/server.ts`
- `tests/integration/server.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Integration tests verify malformed JSON returns 400.
2. Full release verification command passes.

---

## 2026-09-25 - Runtime Environment Parsing Safeguards

Status: Closed

Issue:

- Server startup parsed numeric env values using raw `Number(...)`, allowing `NaN` or unsafe bounds to leak into routing and timer behavior.

Decision:

- Centralize numeric env parsing in a dedicated utility with fallback, clamping, and integer normalization.

Changes made:

1. Added `runtimeEnv` parsing helpers for finite, bounded, and positive-int values.
2. Applied bounded parsing for `ROUTING_MAX_FAST_P95_MS` in server startup.
3. Applied bounded positive-int parsing for `TELEMETRY_SAVE_INTERVAL_MS`.
4. Added unit tests for invalid, boundary, and rounding scenarios.

Files changed:

- `src/config/runtimeEnv.ts`
- `src/server.ts`
- `tests/unit/runtimeEnv.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Runtime env parsing unit tests pass.
2. Full release verification command passes.

---

## 2026-09-25 - Telemetry Store Resilience (Validation + Atomic Writes)

Status: Closed

Issue:

- Server startup could fail if telemetry snapshot JSON was malformed or structurally invalid.
- Snapshot writes were direct-to-target, which increased risk of truncated/corrupted files on interrupted writes.

Decision:

- Validate telemetry snapshots with schema checks at load/save boundaries.
- Gracefully ignore malformed/invalid snapshot files with warning logs.
- Persist snapshots through temp-file write then atomic rename.

Changes made:

1. Added `zod` schemas for telemetry snapshot structure.
2. Added `validateRoutingTelemetrySnapshot` helper.
3. Updated `load()` to return `undefined` for malformed/invalid files instead of throwing.
4. Updated `save()` to validate snapshot and use atomic temp-file replacement.
5. Added unit tests for malformed JSON and invalid schema fallback.

Files changed:

- `src/telemetry/latencyTelemetryStore.ts`
- `tests/unit/latencyTelemetryStore.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Telemetry store tests pass for malformed/invalid snapshot handling.
2. Full release verification command passes.

---

## 2026-09-25 - Benchmark Runner Import Side-Effect Fix

Status: Closed

Issue:

- Importing the benchmark runner module in unit tests executed the CLI flow due unconditional `main()` call.

Decision:

- Gate benchmark runner execution behind explicit CLI-entrypoint detection.

Changes made:

1. Added `shouldRunBenchmarkCli` helper using module URL equality with process entrypoint path.
2. Wrapped `main()` invocation in entrypoint guard.
3. Added unit tests to verify guard behavior.

Files changed:

- `src/bench/runBenchmark.ts`
- `tests/unit/runBenchmark.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Unit tests pass with no benchmark run side-effects from imports.
2. Full release verification command passes.

---

## 2026-09-25 - Benchmark Input Validation (Mode + Prompt Schema)

Status: Closed

Issue:

- Benchmark execution accepted arbitrary `BENCH_MODE` values and could silently run simulate mode on typos.
- Prompt-file parsing had no structural validation and allowed malformed or duplicate prompt ids.

Decision:

- Add strict benchmark mode normalization with fail-fast errors.
- Validate prompt payload structure and enforce unique prompt ids.

Changes made:

1. Added `normalizeBenchmarkMode` and `validateBenchmarkPrompts` helpers.
2. Added `zod`-backed prompt schema validation (`id`/`text`, non-empty list).
3. Added duplicate-id detection for benchmark prompts.
4. Added unit tests for valid/invalid mode and prompt payload cases.

Files changed:

- `src/bench/runBenchmark.ts`
- `tests/unit/runBenchmark.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. New unit tests pass for mode and prompt validation.
2. Full release verification command passes.

---

## 2026-09-25 - Compare Threshold Validation and Normalization

Status: Closed

Issue:

- Compare thresholds were parsed directly from environment variables and could become `NaN` or out-of-range values, weakening gate behavior.

Decision:

- Add explicit threshold normalization and validation before compare evaluation.
- Fail fast with actionable errors when threshold configuration is invalid.

Changes made:

1. Added `normalizeThresholds` in compare core.
2. Enforced finite-number checks for all thresholds.
3. Enforced valid ranges for dead-letter and quality thresholds.
4. Applied normalization in compare CLI before evaluation.
5. Added unit tests for valid and invalid threshold scenarios.

Files changed:

- `src/bench/compareCore.ts`
- `src/bench/compareBenchmarks.ts`
- `tests/unit/compareCore.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Compare unit tests pass with new threshold validation coverage.
2. Full release verification command passes.

---

## 2026-09-25 - Strict Benchmark Parity and Context Completeness Checks

Status: Closed

Issue:

- Compare logic could compute deltas on profile intersection only, which allowed partial comparisons to pass.
- Compatibility checks validated context only when fields existed, allowing missing metadata to bypass strict verification.

Decision:

- Enforce full profile-set parity for baseline and candidate benchmark summaries.
- Require run-context digest fields for compare eligibility.
- Fail compare when simulate mode lacks simulation seed metadata.

Changes made:

1. Added profile-set mismatch compatibility issue with explicit missing/extra lists.
2. Added required-field checks for prompt and profile digests.
3. Added simulate-mode requirement for `simulationSeed`.
4. Added defensive fail when zero overlapping profiles exist.
5. Added unit tests for profile mismatch and missing context-field failures.

Files changed:

- `src/bench/compareCore.ts`
- `tests/unit/compareCore.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Compare unit tests pass for new parity and completeness gates.
2. Full release verification command passes.

---

## 2026-09-25 - Benchmark Reproducibility Context and Compatibility Gates

Status: Closed

Issue:

- Benchmark compare used only summary deltas and could silently compare incompatible runs (different mode, prompt set, profile set, or simulation seed).
- Simulated benchmark runs were deterministic but had no explicit externally controlled seed documented in artifacts.

Decision:

- Add explicit simulation seed control and persist run-context metadata in benchmark output.
- Require benchmark compare to fail when baseline and candidate contexts are incompatible.

Changes made:

1. Added `BENCH_SIM_SEED` support to benchmark simulation path.
2. Persisted run context in benchmark JSON:
- simulation seed (simulate mode)
- prompt set digest
- profile set digest
3. Added compare compatibility checks and report section.
4. Added tests for seed determinism/variability and compatibility failures.

Files changed:

- `src/bench/benchmarkCore.ts`
- `src/bench/runBenchmark.ts`
- `src/bench/compareCore.ts`
- `src/bench/compareBenchmarks.ts`
- `tests/unit/benchmarkCore.test.ts`
- `tests/unit/compareCore.test.ts`
- `README.md`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Unit tests pass for seed repeatability and compatibility gate behavior.
2. Full release verification command passes.

---

## 2026-09-25 - Latency Estimator Guardrails (Bounded Window + Invalid Sample Filtering)

Status: Closed

Issue:

- Latency samples were retained indefinitely per bucket, causing unbounded memory growth over long-running sessions.
- Snapshot hydration accepted invalid latency values, allowing bad telemetry to pollute percentile estimates.

Decision:

- Enforce a bounded rolling history per bucket in the in-memory estimator.
- Reject invalid latency samples (non-finite or non-positive) both at ingest time and hydrate time.

Changes made:

1. Added estimator options with `maxSamplesPerBucket` (default: 1000).
2. Implemented rolling window retention by trimming oldest values on append.
3. Filtered invalid values in `recordLatency` and `hydrate`.
4. Added unit tests for window trimming, invalid ingest filtering, and hydrate sanitization.

Files changed:

- `src/telemetry/latencyEstimator.ts`
- `tests/unit/latencyEstimator.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Latency estimator unit tests cover bounded retention and invalid sample filtering.
2. Full release verification command passes after changes.

---

## 2026-09-25 - Evaluation Gate Was Route-Mismatched

Status: Closed

Issue:

- Evaluation failed because citation threshold was applied globally across all routes.

Observed behavior:

- `eval:report` returned FAIL even when deep-route answers were cited.

Root cause:

- Citation gate used an all-record citation rate instead of a deep-route-only citation rate.

Decision:

- Keep latency and score as global metrics.
- Apply citation gate only to deep-route records.
- Publish both all-route and deep-route citation metrics for transparency.

Changes made:

1. Added route-aware metrics fields:
- `citationRateAll`
- `deepCitationRate`

2. Updated report gate:
- Replaced `citation_rate` gate with `deep_citation_rate`.

3. Updated tests and success criteria wording.

Files changed:

- `src/eval/metrics.ts`
- `src/eval/report.ts`
- `tests/eval/evaluationHarness.test.ts`
- `docs/03-success-criteria.md`

Validation evidence:

1. Unit tests pass for live benchmark flow.
2. Full suite and lint pass after integration.

---

## 2026-09-25 - Benchmark Regression Comparison and Gates

Status: Closed

Issue:

- Benchmark artifacts existed, but there was no automated way to detect regressions between baseline and candidate runs.

Decision:

- Add a compare command that computes deltas per profile and enforces configurable regression thresholds.
- Emit markdown report and non-zero exit code on gate failure for CI/release workflows.

Changes made:

1. Added compare core for delta computation and gate evaluation.
2. Added compare CLI command with configurable thresholds via env vars.
3. Added baseline artifact and compare report output.
4. Added tests for compare core.

Files changed:

- `src/bench/compareCore.ts`
- `src/bench/compareBenchmarks.ts`
- `tests/unit/compareCore.test.ts`
- `reports/benchmark-summary-baseline.json`
- `package.json`
- `README.md`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Compare core tests pass.
2. `npm run bench:compare` generates `reports/benchmark-compare.md`.
3. Full test suite and lint pass.

---

## 2026-09-25 - Persisted Routing Policy and Explicit Policy Endpoint

Status: Closed

Issue:

- Latency telemetry snapshots persisted, but adaptive policy threshold did not.
- Reproducibility across restarts and benchmark runs required stable policy restoration.

Decision:

- Persist both estimator and routing policy in a unified telemetry snapshot.
- Add explicit policy mutation endpoint for deterministic experiment setup.

Changes made:

1. Extended telemetry snapshot shape to include policy values.
2. Added adaptive routing state snapshot/hydration methods.
3. Updated server bootstrap to load/save full routing state.
4. Added endpoint:
- `POST /routing/policy/set`
5. Added/updated tests for snapshot shape and policy endpoint behavior.

Files changed:

- `src/telemetry/latencyTelemetryStore.ts`
- `src/routing/adaptiveRouting.ts`
- `src/app/chatService.ts`
- `src/server.ts`
- `tests/unit/latencyTelemetryStore.test.ts`
- `tests/integration/server.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Full test suite passes.
2. Type-check passes.
3. Integration verifies policy tuning plus explicit set endpoint behavior.

---

## 2026-09-25 - Release Gate Automation Command

Status: Closed

Issue:

- Validation required multiple manual commands each checkpoint, increasing the chance of missed steps.

Decision:

- Add a single release verification command that executes all required checks in order.

Changes made:

1. Added `npm run verify:release` script:
- tests
- lint/type-check
- eval report generation
- benchmark run
- benchmark compare gates
2. Documented release verification flow in README.
3. Added a plan phase to standardize usage.

Files changed:

- `package.json`
- `README.md`
- `docs/05-tdd-execution.md`

Validation evidence:

1. `npm run verify:release` completes successfully.

1. `npm test` passed (all tests green).
2. `npm run lint` passed.
3. `npm run eval:report` result changed to PASS on sample set.

---

## 2026-09-25 - Provider Abstraction Requirement Expanded (Azure + Bedrock + Ollama)

Status: Closed

Issue:

- Needed runtime mix-and-match across providers for fast and deep paths without changing orchestration code.

Root cause:

- Initial prototype used mock providers directly and lacked runtime provider selection/factory indirection.

Decision:

- Introduce provider factory and environment-driven configuration.
- Keep app layer dependent on provider interfaces only.

Changes made:

1. Added provider config loader and schema.
2. Added factory for fast/deep provider composition.
3. Added Azure, Bedrock, and Ollama adapters.
4. Added provider contract tests.

Files changed:

- `src/config/providerConfig.ts`
- `src/providers/providerFactory.ts`
- `src/providers/azureProviders.ts`
- `src/providers/bedrockProviders.ts`
- `src/providers/ollamaProviders.ts`
- `tests/unit/providerFactory.test.ts`
- `tests/unit/azureProviders.test.ts`
- `tests/unit/bedrockProviders.test.ts`
- `tests/unit/ollamaProviders.test.ts`

Validation evidence:

1. Provider tests pass.
2. Integration tests pass with mock path.
3. Runtime configuration documented in README.

---

## 2026-09-25 - Deep Worker Reliability Gaps (Retry + Dead Letter)

Status: Closed

Issue:

- A transient deep-provider failure dropped immediate progress with no retry.
- Repeated failures had no durable failed-task capture path.

Root cause:

- Worker previously executed one attempt only and returned/failed directly.

Decision:

- Add bounded retry behavior for deep tasks.
- Move exhausted tasks to dead-letter storage for investigation/replay.

Changes made:

1. Added `DeadLetterStore` abstraction and in-memory implementation.
2. Added retry tracking per task id in deep worker.
3. Re-enqueue task for retry until max retry threshold.
4. Persist exhausted failures to dead-letter store.

Files changed:

- `src/app/deadLetterStore.ts`
- `src/app/orchestrator.ts`
- `tests/unit/deepWorkerReliability.test.ts`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Added tests for retry-then-success path.
2. Added tests for dead-letter path after max retries.
3. Full suite passes (`npm test`).
4. Type check passes (`npm run lint`).

---

## 2026-09-25 - Operational Visibility for Dead Letters and Replay

Status: Closed

Issue:

- Reliability controls existed, but operators could not inspect or replay failed deep tasks through API.

Decision:

- Add dead-letter listing endpoint and task replay endpoint.
- Extend eval outputs with reliability metrics to measure retry/dead-letter outcomes.

Changes made:

1. Added dead-letter store remove capability for replay workflows.
2. Added API endpoints:
- `GET /workers/deep/dead-letters`
- `POST /workers/deep/dead-letters/:taskId/replay`
3. Added integration test for list + replay behavior.
4. Added reliability metrics and gates in eval report:
- `avgRetriesDeep`
- `deadLetterRateDeep`

Files changed:

- `src/app/deadLetterStore.ts`
- `src/app/chatService.ts`
- `src/server.ts`
- `tests/integration/server.test.ts`
- `src/eval/metrics.ts`
- `src/eval/report.ts`
- `src/eval/generateReport.ts`
- `tests/eval/evaluationHarness.test.ts`
- `tests/eval/report.test.ts`
- `README.md`

Validation evidence:

1. Integration test covers dead-letter API list and replay path.
2. Eval tests validate reliability summary and report gating.
3. Full test suite and lint pass.

---

## 2026-09-25 - Adaptive Routing with Seeded Percentile Priors

Status: Closed

Issue:

- Static routing logic did not account for model/provider-specific tail latency behavior.
- Needed a responsive classification phase and route policy informed by predicted p95.

Decision:

- Add a lightweight classifier for complexity, ambiguity, external-data need, and size band.
- Seed latency priors by provider/model/route/size and blend with live telemetry over time.
- Apply p95 guardrail policy to escalate moderate prompts when fast-path predicted tail latency exceeds target.

Changes made:

1. Added classification module.
2. Added in-memory percentile estimator with confidence tiers.
3. Added adaptive routing coordinator with p95-aware policy.
4. Wired adaptive routing and latency recording into orchestrator and deep worker.
5. Seeded runtime priors in server bootstrap from provider/model profile.

Files changed:

- `src/routing/classifier.ts`
- `src/telemetry/latencyEstimator.ts`
- `src/routing/adaptiveRouting.ts`
- `src/app/orchestrator.ts`
- `src/server.ts`
- `src/domain/types.ts`
- `tests/unit/classifier.test.ts`
- `tests/unit/latencyEstimator.test.ts`
- `tests/unit/adaptiveRouting.test.ts`
- `docs/05-tdd-execution.md`
- `README.md`

Validation evidence:

1. New unit tests cover classifier behavior, estimator blending/confidence, and adaptive route decisions.
2. Existing test suite remains green.
3. Lint/type-check remains green.

Follow-up adjustment:

- Found false-positive clarify routing for normal sentences containing "this".
- Tightened ambiguity heuristic to prioritize short/underspecified prompts and exact ambiguity phrases.
- Regression validated by adaptive routing tests and full suite pass.

---

## 2026-09-25 - Telemetry Durability and Benchmark Artifacts

Status: Closed

Issue:

- Adaptive routing learned in memory only; insights reset on restart.
- Needed objective side-by-side provider comparison artifacts for demo/interview use.

Decision:

- Persist estimator snapshots to disk and expose telemetry/policy endpoints.
- Add deterministic benchmark runner for Azure/Bedrock/Ollama profile comparison.

Changes made:

1. Added telemetry snapshot file store and estimator snapshot/hydration support.
2. Added endpoints:
- `GET /telemetry/latency`
- `POST /routing/policy/tune`
3. Added tests for telemetry store and endpoint behavior.
4. Added benchmark runner and reports:
- `npm run bench:run`
- `reports/benchmark-summary.json`
- `reports/benchmark-summary.md`

Files changed:

- `src/telemetry/latencyEstimator.ts`
- `src/telemetry/latencyTelemetryStore.ts`
- `src/server.ts`
- `src/app/chatService.ts`
- `tests/unit/latencyTelemetryStore.test.ts`
- `tests/integration/server.test.ts`
- `src/bench/benchmarkCore.ts`
- `src/bench/runBenchmark.ts`
- `tests/unit/benchmarkCore.test.ts`
- `data/benchmark-prompts.json`
- `README.md`
- `docs/05-tdd-execution.md`

Validation evidence:

1. Unit and integration tests pass for telemetry and routing-policy endpoints.
2. Benchmark unit tests pass.
3. Lint/type-check passes.
4. Benchmark command generates report artifacts.

---

## 2026-09-25 - Added Live Benchmark Mode

Status: Closed

Issue:

- Deterministic benchmark mode is reproducible but does not capture end-to-end runtime behavior.

Decision:

- Add benchmark `live` mode that hits running API endpoints for real route and latency measurement.
- Keep simulation mode as default for CI stability.

Changes made:

1. Added `runLiveBenchmark` module using `/messages`, `/workers/deep/run-once`, and timeline/dead-letter reads.
2. Extended benchmark runner to support `BENCH_MODE=live` and `BENCH_BASE_URL`.
3. Added unit tests for live runner via mocked fetch.

Files changed:

- `src/bench/liveBenchmark.ts`
- `src/bench/runBenchmark.ts`
- `tests/unit/liveBenchmark.test.ts`
- `docs/05-tdd-execution.md`
- `README.md`

Validation evidence:

1. Unit tests pass for live benchmark flow.
2. Full suite and lint pass after integration.

## 2026-09-25 - Shared chat runtime consolidation checkpoint

Status: Planned; repository identity updated to ChatRuntime.

Source inspection found overlapping chat, context, provider and CLI capabilities
in Hekate and Iris, including an existing Iris-to-Hekate streaming integration.
Use a versioned service protocol with application-specific UIs. Hekate is an
integration candidate; runtime ownership requires an ADR after tracing active
gateway/gods paths because some orchestration code is marked legacy.

The detailed handoff is [07 Shared chat runtime](implementation/07-shared-chat-runtime.md).
Root CHAT-CONSOLIDATION.md notes and CLAUDE.md links were added in Hekate and Iris.
Preserve completed context milestone 01A (f889b9a); reconcile 01B and overlapping
provider/CLI plans before implementation. No cross-repository runtime migration,
service deployment, or live verification is claimed.

Earlier design decisions remain linked from the implementation handoff: internal
summaries with retained source provenance (fbaf5e0), and per-turn activity
sub-bubbles with preserved answer versions (40ad2a5). These are planned behavior,
not evidence that summaries or the full activity extension are implemented.

Rename the repository/package to ChatRuntime to describe its intended reusable
role. Keep the local folder and historical documentation names for continuity.
Create a private GitHub remote under the authenticated JMRussas account and push
the committed checkpoint; record the actual push outcome separately.

Validation: type checking and build passed. The default parallel test run failed
with an unexpected Vitest worker exit; `npm test -- --maxWorkers=1` passed all
140 tests across 31 files. No runtime code changed in this documentation/name
checkpoint. The worker failure has not been diagnosed.

## 2026-09-25 - Review invariants and independent resource budgets

Status: Specified; implementation and regression tests remain open.

Review of f889b9a reproduced four boundary gaps despite 140 passing tests:
effective Ollama output overrides were not reserved, rendered pending-task
wrappers were not counted, shared prompts lost route instructions, and historical
failure overrode replay state. See implementation/01a-review-followup.md for
CTX-01–04 and mandatory requirement-to-test traceability.

The user's observation that Ollama can use cloud inference prompted an explicit
separation of transport, execution location, billing, quota and compute. Official
Ollama cloud documentation confirms localhost can proxy cloud inference. Resource
policy implementation/08-resource-policy.md adds RES-01–08 across inventory,
dispatch, CLI and verification. Unknown costs are not zero; subscriptions consume
allowance; local compute consumes capacity; fixed costs are separate from marginal
charges. Shared reservations include fast/deep/retry/summary work. Cancellation
without usage evidence does not prove no charge. These are future requirements,
not implemented spending controls or guarantees about existing fixed routing.

Validation: documentation diff checks only; no runtime code or tests changed.
