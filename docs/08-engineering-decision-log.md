# Engineering Decision Log

Purpose: keep a durable record of issues, design flaws, test flaws, and approach changes.

How to use this log:

1. Add one entry per issue or decision.
2. Capture root cause and chosen change.
3. Record objective validation evidence (tests, metrics, reports).
4. Link files touched so future reviews can trace reasoning.

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
