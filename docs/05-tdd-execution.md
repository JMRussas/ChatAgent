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

## Daily red-green-refactor checklist

1. Start from failing test
2. Implement smallest passing code
3. Run all tests
4. Refactor for clarity
5. Commit with behavior-focused message
