# Provider Benchmark Summary

Quality scores are synthetic route-based placeholders, including in live mode; they do not measure answer correctness. Simulation timings are generated, not provider measurements.

| Profile | First p50 (ms) | First p95 (ms) | Final p95 (ms) | Avg Quality | Deep Route Rate | Avg Retries (deep) | Dead Letter Rate (deep) |
|---|---:|---:|---:|---:|---:|---:|---:|
| azure-balanced | 630 | 791 | 3516 | 4.32 | 0.50 | 0.00 | 0.00 |
| bedrock-balanced | 673 | 810 | 3656 | 4.31 | 0.50 | 0.00 | 0.00 |
| ollama-local | 814 | 983 | 4283 | 4.32 | 0.50 | 0.00 | 0.00 |

Mode: simulate
