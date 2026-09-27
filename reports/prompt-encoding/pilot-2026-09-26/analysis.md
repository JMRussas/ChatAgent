# Exploratory content scoring

Added after observing pilot output; raw exact grades remain unchanged. Accept JSON fences and a single entity prefix (e.g. "Model B" → "B"). No extra identifiers, duplicates, invalid JSON or arbitrary explanatory prose are accepted. This is a post-hoc descriptive analysis, not a preregistered metric.

| Model | Encoding | Content correct | Exact pass | Strict JSON shape | Mean input tokens |
|---|---|---:|---:|---:|---:|
| qwen3:8b | prose | 10/12 | 10/12 | 12/12 | 148.2 |
| qwen3:8b | concise | 8/12 | 8/12 | 12/12 | 133.8 |
| qwen3:8b | json | 6/12 | 6/12 | 12/12 | 136.2 |
| qwen3:8b | xml | 8/12 | 8/12 | 12/12 | 145.7 |
| qwen3.5:latest | prose | 10/12 | 6/12 | 12/12 | 145.2 |
| qwen3.5:latest | concise | 10/12 | 10/12 | 12/12 | 130.0 |
| qwen3.5:latest | json | 7/12 | 7/12 | 12/12 | 132.2 |
| qwen3.5:latest | xml | 7/12 | 7/12 | 12/12 | 141.7 |
| gemma4:26b | prose | 10/12 | 0/12 | 0/12 | 145.2 |
| gemma4:26b | concise | 10/12 | 0/12 | 0/12 | 132.8 |
| gemma4:26b | json | 10/12 | 0/12 | 0/12 | 134.9 |
| gemma4:26b | xml | 11/12 | 0/12 | 0/12 | 145.8 |
| qwen3-coder:latest | prose | 10/12 | 10/12 | 12/12 | 140.2 |
| qwen3-coder:latest | concise | 7/12 | 7/12 | 12/12 | 125.8 |
| qwen3-coder:latest | json | 7/12 | 7/12 | 12/12 | 128.2 |
| qwen3-coder:latest | xml | 8/12 | 8/12 | 12/12 | 137.7 |
| qwen2.5-coder:14b | prose | 9/12 | 0/12 | 0/12 | 140.2 |
| qwen2.5-coder:14b | concise | 8/12 | 0/12 | 0/12 | 125.8 |
| qwen2.5-coder:14b | json | 9/12 | 1/12 | 1/12 | 128.2 |
| qwen2.5-coder:14b | xml | 9/12 | 0/12 | 0/12 | 137.7 |

## Paired content changes versus prose

| Model | Encoding | Wins | Losses | Ties |
|---|---|---:|---:|---:|
| qwen3:8b | concise | 1 | 3 | 8 |
| qwen3:8b | json | 1 | 5 | 6 |
| qwen3:8b | xml | 1 | 3 | 8 |
| qwen3.5:latest | concise | 1 | 1 | 10 |
| qwen3.5:latest | json | 0 | 3 | 9 |
| qwen3.5:latest | xml | 0 | 3 | 9 |
| gemma4:26b | concise | 1 | 1 | 10 |
| gemma4:26b | json | 1 | 1 | 10 |
| gemma4:26b | xml | 1 | 0 | 11 |
| qwen3-coder:latest | concise | 0 | 3 | 9 |
| qwen3-coder:latest | json | 0 | 3 | 9 |
| qwen3-coder:latest | xml | 0 | 2 | 10 |
| qwen2.5-coder:14b | concise | 2 | 3 | 7 |
| qwen2.5-coder:14b | json | 3 | 3 | 6 |
| qwen2.5-coder:14b | xml | 2 | 2 | 8 |
