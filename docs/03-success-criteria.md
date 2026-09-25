# Success Criteria

## Prototype definition of done

1. Functional
- Fast response returned for 100% of prompts
- Deep route triggers async refined response when needed
- Clarification prompts generated for underspecified queries

2. Performance
- Fast-path p95 latency <= 1000 ms
- Deep result p95 latency <= 7000 ms (prototype target)

3. Quality
- Human or model-based eval average >= 4.0/5 on relevance
- For deep routes only, citation presence >= 90% (evaluate on deep-route subset)
- Hallucination rate on benchmark set <= 10%

4. Reliability
- Async task completion rate >= 98% on test runs
- No message loss in queue simulation tests

5. Portfolio readiness
- Architecture diagram and rationale documented
- Cross-provider switch shown in demo (Azure and Bedrock)
- Eval report included with metrics and tradeoff discussion
