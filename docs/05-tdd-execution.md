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

## Daily red-green-refactor checklist

1. Start from failing test
2. Implement smallest passing code
3. Run all tests
4. Refactor for clarity
5. Commit with behavior-focused message
