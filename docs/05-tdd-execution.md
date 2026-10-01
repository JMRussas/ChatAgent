# TDD Execution Plan

## Iteration order

1. Router behavior

- Write route tests for direct/deep/clarify
- Implement minimal router logic

2. Orchestrator response contract

- Test immediate response shape and status fields
- Implement fast-response path

3. Async queue + worker

- Test enqueue/dequeue and single-task resolution
- Implement worker loop and deep provider contract

4. Timeline update behavior

- Add tests for provisional then refined message order
- Implement timeline persistence adapter

5. Provider adapter tests

- Add contract tests for Azure and Bedrock adapters
- Ensure deterministic mock mode for local CI

6. Evaluation harness

- Add tests for metric aggregation and pass/fail gates
- Implement report generator

7. Reliability hardening

- Add tests for deep-task retry behavior and dead-letter handling
- Implement retry policy and failed-task capture

8. Adaptive routing and percentile prediction

- Add responsive prompt classification tests and implementation
- Add seeded-prior plus live percentile estimator tests and implementation
- Route moderate complexity prompts with p95-based guardrail policy

9. Operational observability and benchmark artifacts

- Add telemetry persistence and endpoint tests (`/telemetry/latency`, `/routing/policy/tune`)
- Add provider benchmark runner with reproducible JSON/markdown reports
- Validate report generation in CI-style command flow

10. Live benchmark mode

- Add real-run benchmark mode that exercises running API endpoints
- Keep deterministic simulation mode for CI/reproducibility
- Compare live vs simulated metrics in generated artifacts

11. Benchmark regression gates

- Add benchmark comparison tool for baseline vs candidate artifacts
- Add threshold-based pass/fail gates for latency, quality, and dead-letter regressions
- Emit markdown comparison report for release review

12. Routing policy persistence

- Persist adaptive routing policy alongside latency estimator snapshots
- Add explicit policy set endpoint for reproducible experiments
- Add integration coverage for policy mutation and retrieval

13. Release gate automation

- Add one-command release verification pipeline
- Include test, lint, eval report, benchmark run, and benchmark compare
- Use the command for every checkpoint validation before commit

14. Latency estimator memory and data-quality guardrails

- Bound per-bucket sample history with rolling window retention
- Ignore invalid latencies (non-finite or non-positive) during ingest and hydration
- Add unit coverage for trimming and filtering behavior

15. Benchmark reproducibility and compare compatibility

- Add explicit simulation seed control for benchmark generation
- Persist prompt/profile digests and run context in benchmark artifacts
- Fail compare when baseline/candidate contexts are incompatible

16. Strict benchmark parity checks

- Require full profile-set parity between baseline and candidate runs
- Require run-context digests to exist for compare eligibility
- Fail compare early when no overlapping profiles are available

17. Compare-threshold validation hardening

- Normalize and validate compare thresholds before gate evaluation
- Reject non-finite or out-of-range threshold values with explicit errors
- Add unit tests for threshold validation behavior

18. Benchmark input validation hardening

- Validate BENCH_MODE against supported values (simulate/live)
- Validate benchmark prompt file shape and non-empty content
- Reject duplicate prompt ids to preserve deterministic run integrity

19. Benchmark CLI import-safety hardening

- Ensure benchmark runner executes only when invoked as CLI entrypoint
- Prevent side effects during unit-test imports
- Add unit tests for entrypoint guard behavior

20. Telemetry persistence resilience

- Validate persisted telemetry snapshot schema on load/save
- Gracefully ignore malformed or invalid telemetry files
- Use atomic file replacement for snapshot writes

21. Runtime env parsing safeguards

- Normalize and bound server startup numeric env values
- Clamp routing policy threshold and telemetry save interval to safe ranges
- Add unit tests for env parsing edge cases

22. HTTP malformed-body handling

- Return deterministic 400 responses for malformed JSON payloads
- Keep request-validation failures distinct from server failures
- Add integration coverage across representative POST endpoints

23. HTTP request payload schema validation

- Reject null and non-object JSON bodies with deterministic 400 responses
- Validate endpoint-specific payload shapes before service calls
- Add integration coverage for null-body and invalid-shape cases

24. Provider request timeout handling

- Abort Azure and Ollama HTTP requests after a bounded timeout
- Surface clear timeout errors instead of hanging the fast path indefinitely
- Add unit tests that prove the abort signal is wired through

25. Background deep-worker auto-run

- Add optional interval-based deep worker draining in server startup
- Make auto-run behavior env-controlled for deterministic test/benchmark modes
- Document and test env parsing for auto-run controls

26. UI shell and live polling loop

- Serve a static `GET /` control-room page from the existing HTTP server
- Submit prompts from the page and poll conversation events + latency telemetry
- Render provisional-to-refined swaps and live route telemetry in a two-panel layout

## Execution burndown snapshot

As of 2026-09-25

1. Planned phases: 26
2. Completed phases: 26
3. Remaining phases in current plan: 0
4. Completion ratio: 26/26 (100%)

Phase buckets (estimated):

1. Foundation build (1-7)

- Status: complete (7/7)

2. Routing, telemetry, benchmark baseline (8-13)

- Status: complete (6/6)

3. Reliability and reproducibility hardening (14-22)

- Status: complete (9/9)

4. Request validation hardening (23)

- Status: complete (1/1)

5. Provider timeout hardening (24)

- Status: complete (1/1)

6. Deep-worker runtime hardening (25)

- Status: complete (1/1)

7. UI foundation (26)

- Status: complete (1/1)

Schedule signal:

1. Qualitative status: ahead of a typical prototype hardening timeline.
2. Reason: full release gate is already automated and repeatedly passing while hardening phases continue.

Rolling forecast:

1. Current documented plan is fully executed.
2. Additional phases are now incremental hardening extensions (new phases appended as risks/opportunities are identified).

## Daily red-green-refactor checklist

1. Start from failing test
2. Implement smallest passing code
3. Run all tests
4. Refactor for clarity
5. Commit with behavior-focused message
