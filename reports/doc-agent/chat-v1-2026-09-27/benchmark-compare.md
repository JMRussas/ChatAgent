# Benchmark Comparison Report

Overall: PASS

## Deltas (candidate - baseline)
| Profile | First p95 delta (ms) | Final p95 delta (ms) | Quality delta | Avg retries delta | Dead-letter delta |
|---|---:|---:|---:|---:|---:|
| azure-balanced | 0 | 0 | 0.000 | 0.000 | 0.000 |
| bedrock-balanced | 0 | 0 | 0.000 | 0.000 | 0.000 |
| ollama-local | 0 | 0 | 0.000 | 0.000 | 0.000 |

## Gates
| Profile | Gate | Status | Actual | Expected |
|---|---|---|---:|---:|
| azure-balanced | first_response_p95_regression_ms | PASS | 0.000 | 150.000 |
| azure-balanced | final_latency_p95_regression_ms | PASS | 0.000 | 300.000 |
| azure-balanced | dead_letter_rate_regression | PASS | 0.000 | 0.050 |
| azure-balanced | quality_delta | PASS | 0.000 | -0.050 |
| bedrock-balanced | first_response_p95_regression_ms | PASS | 0.000 | 150.000 |
| bedrock-balanced | final_latency_p95_regression_ms | PASS | 0.000 | 300.000 |
| bedrock-balanced | dead_letter_rate_regression | PASS | 0.000 | 0.050 |
| bedrock-balanced | quality_delta | PASS | 0.000 | -0.050 |
| ollama-local | first_response_p95_regression_ms | PASS | 0.000 | 150.000 |
| ollama-local | final_latency_p95_regression_ms | PASS | 0.000 | 300.000 |
| ollama-local | dead_letter_rate_regression | PASS | 0.000 | 0.050 |
| ollama-local | quality_delta | PASS | 0.000 | -0.050 |
