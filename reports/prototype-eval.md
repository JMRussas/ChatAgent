# Prototype Evaluation Report

This report summarizes input records. The default data/eval-records.json is a fixture, not a live provider evaluation.

Overall: PASS

## Summary
- avgLatencyMs: 762.50
- avgScore: 4.25
- citationRateAll: 0.500
- deepCitationRate: 1.000
- deepRouteRate: 0.500
- avgRetriesDeep: 0.500
- deadLetterRateDeep: 0.000

## Gates
- avg_latency: PASS (actual=762.500, expected=1000.000)
- avg_score: PASS (actual=4.250, expected=4.000)
- deep_citation_rate: PASS (actual=1.000, expected=0.900)
- dead_letter_rate_deep: PASS (actual=0.000, expected=0.100)
- avg_retries_deep: PASS (actual=0.500, expected=1.000)
