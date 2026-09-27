# Task / Guidelines / Response Framework experiment

Held-out content correctness is the primary endpoint. Scoring was frozen before execution. One deterministic pass; differences are descriptive, not statistically established. Flat/TGR/JSON/XML contain identical semantic strings. Legacy differs in instruction wording and placement.

## heldout results

| Model | Variant | Content correct | Exact pass | Mean input tokens | Median wall s |
|---|---|---:|---:|---:|---:|
| qwen3:8b | legacy | 6/12 | 6/12 | 166.6 | 0.33 |
| qwen3:8b | flat | 5/12 | 5/12 | 244.4 | 0.34 |
| qwen3:8b | tgr | 7/12 | 7/12 | 254.4 | 0.34 |
| qwen3:8b | json | 4/12 | 4/12 | 263.4 | 0.34 |
| qwen3:8b | xml | 5/12 | 5/12 | 306.1 | 0.34 |
| qwen3.5:latest | legacy | 7/12 | 7/12 | 163.6 | 0.45 |
| qwen3.5:latest | flat | 7/12 | 7/12 | 247.4 | 0.38 |
| qwen3.5:latest | tgr | 6/12 | 6/12 | 261.4 | 0.39 |
| qwen3.5:latest | json | 4/12 | 4/12 | 259.4 | 0.38 |
| qwen3.5:latest | xml | 4/12 | 4/12 | 302.1 | 0.39 |
| gemma4:26b | legacy | 10/12 | 0/12 | 163.5 | 0.46 |
| gemma4:26b | flat | 9/12 | 9/12 | 249.9 | 0.38 |
| gemma4:26b | tgr | 9/12 | 9/12 | 262.9 | 0.39 |
| gemma4:26b | json | 10/12 | 10/12 | 265.9 | 0.39 |
| gemma4:26b | xml | 11/12 | 11/12 | 308.9 | 0.39 |
| qwen3-coder:latest | legacy | 7/12 | 6/12 | 158.6 | 0.36 |
| qwen3-coder:latest | flat | 8/12 | 8/12 | 236.4 | 0.36 |
| qwen3-coder:latest | tgr | 9/12 | 9/12 | 246.4 | 0.37 |
| qwen3-coder:latest | json | 8/12 | 8/12 | 255.4 | 0.36 |
| qwen3-coder:latest | xml | 7/12 | 7/12 | 298.1 | 0.38 |
| qwen2.5-coder:14b | legacy | 6/12 | 0/12 | 158.6 | 0.43 |
| qwen2.5-coder:14b | flat | 9/12 | 0/12 | 236.4 | 0.43 |
| qwen2.5-coder:14b | tgr | 9/12 | 0/12 | 246.4 | 0.43 |
| qwen2.5-coder:14b | json | 6/12 | 4/12 | 255.4 | 0.43 |
| qwen2.5-coder:14b | xml | 8/12 | 8/12 | 298.1 | 0.41 |

| Variant | Aggregate content | Equal-model accuracy | Exact pass | Mean input tokens |
|---|---:|---:|---:|---:|
| legacy | 36/60 | 60.0% | 19/60 | 162.2 |
| flat | 38/60 | 63.3% | 29/60 | 242.9 |
| tgr | 40/60 | 66.7% | 31/60 | 254.3 |
| json | 32/60 | 53.3% | 30/60 | 259.9 |
| xml | 35/60 | 58.3% | 35/60 | 302.6 |
## calibration results

| Model | Variant | Content correct | Exact pass | Mean input tokens | Median wall s |
|---|---|---:|---:|---:|---:|
| qwen3:8b | legacy | 10/12 | 9/12 | 148.2 | 0.33 |
| qwen3:8b | flat | 7/12 | 7/12 | 223.5 | 0.34 |
| qwen3:8b | tgr | 7/12 | 7/12 | 233.5 | 0.33 |
| qwen3:8b | json | 8/12 | 8/12 | 242.5 | 0.33 |
| qwen3:8b | xml | 8/12 | 8/12 | 284.8 | 0.34 |
| qwen3.5:latest | legacy | 10/12 | 6/12 | 145.2 | 0.44 |
| qwen3.5:latest | flat | 10/12 | 10/12 | 226.5 | 0.38 |
| qwen3.5:latest | tgr | 9/12 | 9/12 | 240.5 | 0.38 |
| qwen3.5:latest | json | 10/12 | 10/12 | 238.5 | 0.37 |
| qwen3.5:latest | xml | 10/12 | 10/12 | 280.8 | 0.38 |
| gemma4:26b | legacy | 10/12 | 0/12 | 145.2 | 0.45 |
| gemma4:26b | flat | 12/12 | 12/12 | 227.7 | 0.38 |
| gemma4:26b | tgr | 12/12 | 12/12 | 240.7 | 0.38 |
| gemma4:26b | json | 12/12 | 12/12 | 243.7 | 0.39 |
| gemma4:26b | xml | 11/12 | 11/12 | 286.7 | 0.39 |
| qwen3-coder:latest | legacy | 10/12 | 10/12 | 140.2 | 0.35 |
| qwen3-coder:latest | flat | 12/12 | 12/12 | 215.5 | 0.36 |
| qwen3-coder:latest | tgr | 12/12 | 12/12 | 225.5 | 0.36 |
| qwen3-coder:latest | json | 12/12 | 12/12 | 234.5 | 0.35 |
| qwen3-coder:latest | xml | 12/12 | 12/12 | 276.8 | 0.35 |
| qwen2.5-coder:14b | legacy | 9/12 | 0/12 | 140.2 | 0.42 |
| qwen2.5-coder:14b | flat | 11/12 | 0/12 | 215.5 | 0.42 |
| qwen2.5-coder:14b | tgr | 11/12 | 0/12 | 225.5 | 0.42 |
| qwen2.5-coder:14b | json | 10/12 | 7/12 | 234.5 | 0.41 |
| qwen2.5-coder:14b | xml | 10/12 | 10/12 | 276.8 | 0.40 |

| Variant | Aggregate content | Equal-model accuracy | Exact pass | Mean input tokens |
|---|---:|---:|---:|---:|
| legacy | 49/60 | 81.7% | 25/60 | 143.8 |
| flat | 52/60 | 86.7% | 41/60 | 221.7 |
| tgr | 51/60 | 85.0% | 40/60 | 233.1 |
| json | 52/60 | 86.7% | 49/60 | 238.7 |
| xml | 51/60 | 85.0% | 51/60 | 281.2 |
## all results

| Model | Variant | Content correct | Exact pass | Mean input tokens | Median wall s |
|---|---|---:|---:|---:|---:|
| qwen3:8b | legacy | 16/24 | 15/24 | 157.4 | 0.33 |
| qwen3:8b | flat | 12/24 | 12/24 | 234.0 | 0.34 |
| qwen3:8b | tgr | 14/24 | 14/24 | 244.0 | 0.34 |
| qwen3:8b | json | 12/24 | 12/24 | 253.0 | 0.34 |
| qwen3:8b | xml | 13/24 | 13/24 | 295.5 | 0.34 |
| qwen3.5:latest | legacy | 17/24 | 13/24 | 154.4 | 0.44 |
| qwen3.5:latest | flat | 17/24 | 17/24 | 237.0 | 0.38 |
| qwen3.5:latest | tgr | 15/24 | 15/24 | 251.0 | 0.38 |
| qwen3.5:latest | json | 14/24 | 14/24 | 249.0 | 0.38 |
| qwen3.5:latest | xml | 14/24 | 14/24 | 291.5 | 0.38 |
| gemma4:26b | legacy | 20/24 | 0/24 | 154.4 | 0.46 |
| gemma4:26b | flat | 21/24 | 21/24 | 238.8 | 0.38 |
| gemma4:26b | tgr | 21/24 | 21/24 | 251.8 | 0.39 |
| gemma4:26b | json | 22/24 | 22/24 | 254.8 | 0.39 |
| gemma4:26b | xml | 22/24 | 22/24 | 297.8 | 0.39 |
| qwen3-coder:latest | legacy | 17/24 | 16/24 | 149.4 | 0.36 |
| qwen3-coder:latest | flat | 20/24 | 20/24 | 226.0 | 0.36 |
| qwen3-coder:latest | tgr | 21/24 | 21/24 | 236.0 | 0.36 |
| qwen3-coder:latest | json | 20/24 | 20/24 | 245.0 | 0.35 |
| qwen3-coder:latest | xml | 19/24 | 19/24 | 287.5 | 0.36 |
| qwen2.5-coder:14b | legacy | 15/24 | 0/24 | 149.4 | 0.42 |
| qwen2.5-coder:14b | flat | 20/24 | 0/24 | 226.0 | 0.42 |
| qwen2.5-coder:14b | tgr | 20/24 | 0/24 | 236.0 | 0.42 |
| qwen2.5-coder:14b | json | 16/24 | 11/24 | 245.0 | 0.41 |
| qwen2.5-coder:14b | xml | 18/24 | 18/24 | 287.5 | 0.40 |

| Variant | Aggregate content | Equal-model accuracy | Exact pass | Mean input tokens |
|---|---:|---:|---:|---:|
| legacy | 85/120 | 70.8% | 44/120 | 153.0 |
| flat | 90/120 | 75.0% | 70/120 | 232.3 |
| tgr | 91/120 | 75.8% | 71/120 | 243.7 |
| json | 84/120 | 70.0% | 79/120 | 249.3 |
| xml | 86/120 | 71.7% | 86/120 | 291.9 |

## Paired changes against identical-content flat control

| Split | Model | Variant | Wins | Losses | Ties |
|---|---|---|---:|---:|---:|
| heldout | qwen3:8b | tgr | 2 | 0 | 10 |
| heldout | qwen3:8b | json | 0 | 1 | 11 |
| heldout | qwen3:8b | xml | 1 | 1 | 10 |
| heldout | qwen3.5:latest | tgr | 0 | 1 | 11 |
| heldout | qwen3.5:latest | json | 0 | 3 | 9 |
| heldout | qwen3.5:latest | xml | 0 | 3 | 9 |
| heldout | gemma4:26b | tgr | 1 | 1 | 10 |
| heldout | gemma4:26b | json | 2 | 1 | 9 |
| heldout | gemma4:26b | xml | 2 | 0 | 10 |
| heldout | qwen3-coder:latest | tgr | 1 | 0 | 11 |
| heldout | qwen3-coder:latest | json | 1 | 1 | 10 |
| heldout | qwen3-coder:latest | xml | 1 | 2 | 9 |
| heldout | qwen2.5-coder:14b | tgr | 0 | 0 | 12 |
| heldout | qwen2.5-coder:14b | json | 0 | 3 | 9 |
| heldout | qwen2.5-coder:14b | xml | 0 | 1 | 11 |
| calibration | qwen3:8b | tgr | 1 | 1 | 10 |
| calibration | qwen3:8b | json | 2 | 1 | 9 |
| calibration | qwen3:8b | xml | 2 | 1 | 9 |
| calibration | qwen3.5:latest | tgr | 1 | 2 | 9 |
| calibration | qwen3.5:latest | json | 0 | 0 | 12 |
| calibration | qwen3.5:latest | xml | 0 | 0 | 12 |
| calibration | gemma4:26b | tgr | 0 | 0 | 12 |
| calibration | gemma4:26b | json | 0 | 0 | 12 |
| calibration | gemma4:26b | xml | 0 | 1 | 11 |
| calibration | qwen3-coder:latest | tgr | 0 | 0 | 12 |
| calibration | qwen3-coder:latest | json | 0 | 0 | 12 |
| calibration | qwen3-coder:latest | xml | 0 | 0 | 12 |
| calibration | qwen2.5-coder:14b | tgr | 0 | 0 | 12 |
| calibration | qwen2.5-coder:14b | json | 0 | 1 | 11 |
| calibration | qwen2.5-coder:14b | xml | 0 | 1 | 11 |
| all | qwen3:8b | tgr | 3 | 1 | 20 |
| all | qwen3:8b | json | 2 | 2 | 20 |
| all | qwen3:8b | xml | 3 | 2 | 19 |
| all | qwen3.5:latest | tgr | 1 | 3 | 20 |
| all | qwen3.5:latest | json | 0 | 3 | 21 |
| all | qwen3.5:latest | xml | 0 | 3 | 21 |
| all | gemma4:26b | tgr | 1 | 1 | 22 |
| all | gemma4:26b | json | 2 | 1 | 21 |
| all | gemma4:26b | xml | 2 | 1 | 21 |
| all | qwen3-coder:latest | tgr | 1 | 0 | 23 |
| all | qwen3-coder:latest | json | 1 | 1 | 22 |
| all | qwen3-coder:latest | xml | 1 | 2 | 21 |
| all | qwen2.5-coder:14b | tgr | 0 | 0 | 24 |
| all | qwen2.5-coder:14b | json | 0 | 4 | 20 |
| all | qwen2.5-coder:14b | xml | 0 | 2 | 22 |

## Content failures

- heldout / qwen3:8b / h-unknown-all / legacy: expected `[]`, observed `"{\"answer\": [\"B\"]}"`.
- heldout / qwen3:8b / h-unknown-all / flat: expected `[]`, observed `"{\"answer\": [\"A\"]}"`.
- heldout / qwen3:8b / h-unknown-all / tgr: expected `[]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3:8b / h-unknown-all / json: expected `[]`, observed `"{\"answer\": [\"A\"]}"`.
- heldout / qwen3:8b / h-unknown-all / xml: expected `[]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- calibration / qwen3:8b / exception / flat: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\", \"C\"]}"`.
- calibration / qwen3:8b / schedule / json: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3:8b / schedule / xml: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3:8b / schedule / legacy: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3:8b / schedule / flat: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3:8b / schedule / tgr: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- heldout / qwen3:8b / h-disclosure-exception / flat: expected `["A", "B"]`, observed `"{\"answer\": [\"A\", \"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-disclosure-exception / tgr: expected `["A", "B"]`, observed `"{\"answer\": [\"A\", \"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-disclosure-exception / json: expected `["A", "B"]`, observed `"{\"answer\": [\"A\", \"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-disclosure-exception / xml: expected `["A", "B"]`, observed `"{\"answer\": [\"A\", \"B\", \"D\"]}"`.
- calibration / qwen3:8b / retry-partial / flat: expected `["A"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- calibration / qwen3:8b / retry-partial / tgr: expected `["A"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- calibration / qwen3:8b / retry-partial / json: expected `["A"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- calibration / qwen3:8b / retry-partial / xml: expected `["A"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3:8b / h-two-witnesses / json: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\", \"R4\"]}"`.
- heldout / qwen3:8b / h-two-witnesses / flat: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- heldout / qwen3:8b / h-multiple-locks / legacy: expected `["A", "D"]`, observed `"{\"answer\": [\"Candidate D\"]}"`.
- heldout / qwen3:8b / h-multiple-locks / flat: expected `["A", "D"]`, observed `"{\"answer\": [\"D\"]}"`.
- heldout / qwen3:8b / h-multiple-locks / tgr: expected `["A", "D"]`, observed `"{\"answer\": [\"D\"]}"`.
- heldout / qwen3:8b / h-multiple-locks / json: expected `["A", "D"]`, observed `"{\"answer\": [\"D\"]}"`.
- heldout / qwen3:8b / h-multiple-locks / xml: expected `["A", "D"]`, observed `"{\"answer\": [\"D\"]}"`.
- heldout / qwen3:8b / h-joint-dependency / flat: expected `["D", "F"]`, observed `"{\"answer\": [\"A\", \"F\", \"G\"]}"`.
- heldout / qwen3:8b / h-joint-dependency / json: expected `["D", "F"]`, observed `"{\"answer\": [\"A\", \"F\", \"G\"]}"`.
- heldout / qwen3:8b / h-joint-dependency / xml: expected `["D", "F"]`, observed `"{\"answer\": [\"A\", \"F\", \"G\"]}"`.
- heldout / qwen3:8b / h-joint-dependency / legacy: expected `["D", "F"]`, observed `"{\"answer\": [\"A\", \"F\", \"G\"]}"`.
- calibration / qwen3:8b / dependency / json: expected `["B", "D"]`, observed `"{\"answer\": [\"D\"]}"`.
- heldout / qwen3:8b / h-select-lexicographic / xml: expected `["B"]`, observed `"{\"answer\": [\"B\", \"C\"]}"`.
- calibration / qwen3:8b / no-evidence / flat: expected `[]`, observed `"{\"answer\": [\"R2\"]}"`.
- calibration / qwen3:8b / no-evidence / tgr: expected `[]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- calibration / qwen3:8b / no-evidence / json: expected `[]`, observed `"{\"answer\": [\"R2\"]}"`.
- calibration / qwen3:8b / no-evidence / xml: expected `[]`, observed `"{\"answer\": [\"R2\"]}"`.
- heldout / qwen3:8b / h-revision-scope / flat: expected `["D"]`, observed `"{\"answer\": [\"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-revision-scope / tgr: expected `["D"]`, observed `"{\"answer\": [\"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-revision-scope / json: expected `["D"]`, observed `"{\"answer\": [\"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-revision-scope / xml: expected `["D"]`, observed `"{\"answer\": [\"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-revision-scope / legacy: expected `["D"]`, observed `"{\"answer\": [\"B\", \"D\"]}"`.
- heldout / qwen3:8b / h-retry-bounds / legacy: expected `["B"]`, observed `"{\"answer\": [\"B\", \"C\"]}"`.
- heldout / qwen3:8b / h-task-local-revision / json: expected `["B", "D"]`, observed `"{\"answer\": [\"A\", \"B\", \"D\"]}"`.
- calibration / qwen3:8b / scope / legacy: expected `["A", "C"]`, observed `"{\"answer\": [\"A\"]}"`.
- calibration / qwen3:8b / precedence / tgr: expected `["C"]`, observed `"{\"answer\": [\"B\", \"C\"]}"`.
- calibration / qwen3:8b / precedence / xml: expected `["C"]`, observed `"{\"answer\": [\"B\", \"C\"]}"`.
- heldout / qwen3:8b / h-mandatory-budget / tgr: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\", \"C\", \"D\"]}"`.
- heldout / qwen3:8b / h-mandatory-budget / json: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\", \"C\"]}"`.
- heldout / qwen3:8b / h-mandatory-budget / xml: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\", \"C\", \"D\"]}"`.
- heldout / qwen3:8b / h-mandatory-budget / legacy: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3:8b / h-mandatory-budget / flat: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- calibration / qwen3:8b / unknown / flat: expected `["A"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3:8b / unknown / tgr: expected `["A"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`.
- calibration / qwen3.5:latest / exception / tgr: expected `["A", "C"]`, observed `"{\"answer\":[\"C\"]}"`.
- calibration / qwen3.5:latest / locks / legacy: expected `["C", "E"]`, observed `"{\n  \"answer\": [\n    \"B\",\n    \"C\",\n    \"E\"\n  ]\n}"`.
- heldout / qwen3.5:latest / h-disclosure-exception / tgr: expected `["A", "B"]`, observed `"{\"answer\": [\"B\"]}"`.
- heldout / qwen3.5:latest / h-disclosure-exception / json: expected `["A", "B"]`, observed `"{\"answer\":[\"B\"]}"`.
- heldout / qwen3.5:latest / h-disclosure-exception / xml: expected `["A", "B"]`, observed `"{\"answer\":[\"B\"]}"`.
- heldout / qwen3.5:latest / h-disclosure-exception / legacy: expected `["A", "B"]`, observed `"{\n  \"answer\": [\n    \"B\"\n  ]\n}"`.
- heldout / qwen3.5:latest / h-two-witnesses / xml: expected `["R2"]`, observed `"{\"answer\":[\"R1\",\"R2\"]}"`.
- heldout / qwen3.5:latest / h-two-witnesses / legacy: expected `["R2"]`, observed `"{\n  \"answer\": [\n    \"R1\",\n    \"R2\"\n  ]\n}"`.
- heldout / qwen3.5:latest / h-two-witnesses / flat: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- heldout / qwen3.5:latest / h-two-witnesses / tgr: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- heldout / qwen3.5:latest / h-two-witnesses / json: expected `["R2"]`, observed `"{\"answer\":[\"R1\",\"R2\"]}"`.
- heldout / qwen3.5:latest / h-source-authority / flat: expected `["T3"]`, observed `"{\"answer\":[\"T2\",\"T3\"]}"`.
- heldout / qwen3.5:latest / h-source-authority / tgr: expected `["T3"]`, observed `"{\"answer\":[\"T2\",\"T3\"]}"`.
- heldout / qwen3.5:latest / h-source-authority / json: expected `["T3"]`, observed `"{\"answer\":[\"T2\",\"T3\"]}"`.
- heldout / qwen3.5:latest / h-source-authority / xml: expected `["T3"]`, observed `"{\"answer\":[\"T2\",\"T3\"]}"`.
- heldout / qwen3.5:latest / h-joint-dependency / tgr: expected `["D", "F"]`, observed `"{\"answer\":[\"A\",\"F\"]}"`.
- heldout / qwen3.5:latest / h-joint-dependency / json: expected `["D", "F"]`, observed `"{\"answer\":[\"A\",\"F\"]}"`.
- heldout / qwen3.5:latest / h-joint-dependency / xml: expected `["D", "F"]`, observed `"{\"answer\":[\"A\",\"F\"]}"`.
- heldout / qwen3.5:latest / h-joint-dependency / legacy: expected `["D", "F"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"D\",\n    \"F\"\n  ]\n}"`.
- heldout / qwen3.5:latest / h-joint-dependency / flat: expected `["D", "F"]`, observed `"{\"answer\":[\"A\",\"F\"]}"`.
- calibration / qwen3.5:latest / dependency / xml: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"D\"]}"`.
- calibration / qwen3.5:latest / dependency / legacy: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"D\"\n  ]\n}"`.
- calibration / qwen3.5:latest / dependency / flat: expected `["B", "D"]`, observed `"{\"answer\":[\"D\"]}"`.
- calibration / qwen3.5:latest / dependency / tgr: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"D\"]}"`.
- calibration / qwen3.5:latest / dependency / json: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"D\"]}"`.
- heldout / qwen3.5:latest / h-select-lexicographic / json: expected `["B"]`, observed `"{\"answer\":[\"A\"]}"`.
- heldout / qwen3.5:latest / h-select-lexicographic / xml: expected `["B"]`, observed `"{\"answer\":[\"A\"]}"`.
- heldout / qwen3.5:latest / h-revision-scope / json: expected `["D"]`, observed `"{\"answer\":[\"B\",\"D\"]}"`.
- heldout / qwen3.5:latest / h-revision-scope / xml: expected `["D"]`, observed `"{\"answer\":[\"B\",\"D\"]}"`.
- heldout / qwen3.5:latest / h-task-local-revision / xml: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"B\"]}"`.
- heldout / qwen3.5:latest / h-task-local-revision / legacy: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"Model A\",\n    \"Model B\",\n    \"Model D\"\n  ]\n}"`.
- heldout / qwen3.5:latest / h-task-local-revision / flat: expected `["B", "D"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3.5:latest / h-task-local-revision / tgr: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"B\"]}"`.
- heldout / qwen3.5:latest / h-task-local-revision / json: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"B\"]}"`.
- calibration / qwen3.5:latest / scope / flat: expected `["A", "C"]`, observed `"{\"answer\":[\"C\"]}"`.
- calibration / qwen3.5:latest / scope / json: expected `["A", "C"]`, observed `"{\"answer\":[\"C\"]}"`.
- calibration / qwen3.5:latest / scope / xml: expected `["A", "C"]`, observed `"{\"answer\":[\"A\"]}"`.
- calibration / qwen3.5:latest / precedence / tgr: expected `["C"]`, observed `"{\"answer\": []}"`.
- heldout / qwen3.5:latest / h-mandatory-budget / json: expected `["A", "C"]`, observed `"{\"answer\":[]}"`.
- heldout / qwen3.5:latest / h-mandatory-budget / xml: expected `["A", "C"]`, observed `"{\"answer\":[]}"`.
- heldout / qwen3.5:latest / h-mandatory-budget / legacy: expected `["A", "C"]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3.5:latest / h-mandatory-budget / flat: expected `["A", "C"]`, observed `"{\"answer\": []}"`.
- heldout / qwen3.5:latest / h-mandatory-budget / tgr: expected `["A", "C"]`, observed `"{\"answer\":[]}"`.
- heldout / gemma4:26b / h-explicit-offsets / flat: expected `["A", "D"]`, observed `"{\"answer\":[\"A\"]}"`.
- heldout / gemma4:26b / h-explicit-offsets / legacy: expected `["A", "D"]`, observed `"```json\n{\n \"answer\": [\"Job A\"]\n}\n```"`.
- heldout / gemma4:26b / h-joint-dependency / tgr: expected `["D", "F"]`, observed `"{\"answer\":[\"A\",\"D\",\"F\"]}"`.
- calibration / gemma4:26b / dependency / legacy: expected `["B", "D"]`, observed `"```json\n{\n \"answer\": [\"D\"]\n}\n```"`.
- heldout / gemma4:26b / h-retry-bounds / json: expected `["B"]`, observed `"{\"answer\":[\"B\",\"C\"]}"`.
- heldout / gemma4:26b / h-task-local-revision / flat: expected `["B", "D"]`, observed `"{\"answer\":[\"A\",\"B\",\"C\",\"D\"]}"`.
- heldout / gemma4:26b / h-task-local-revision / tgr: expected `["B", "D"]`, observed `"{\"answer\":[\"B\",\"C\",\"D\"]}"`.
- calibration / gemma4:26b / scope / xml: expected `["A", "C"]`, observed `"{\"answer\":[\"A\"]}"`.
- calibration / gemma4:26b / scope / legacy: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\n    \"A\"\n  ]\n}\n```"`.
- heldout / gemma4:26b / h-mandatory-budget / xml: expected `["A", "C"]`, observed `"{\"answer\":[\"B\",\"C\",\"D\"]}"`.
- heldout / gemma4:26b / h-mandatory-budget / legacy: expected `["A", "C"]`, observed `"```json\n{\n \"answer\": [\"B\", \"C\", \"D\"]\n}\n```"`.
- heldout / gemma4:26b / h-mandatory-budget / flat: expected `["A", "C"]`, observed `"{\"answer\":[\"B\",\"C\",\"D\"]}"`.
- heldout / gemma4:26b / h-mandatory-budget / tgr: expected `["A", "C"]`, observed `"{\"answer\":[\"B\",\"C\",\"D\"]}"`.
- heldout / gemma4:26b / h-mandatory-budget / json: expected `["A", "C"]`, observed `"{\"answer\":[\"B\",\"C\",\"D\"]}"`.
- heldout / qwen3-coder:latest / h-unknown-all / json: expected `[]`, observed `"{\"answer\": [\"A\", \"B\"]}"`.
- heldout / qwen3-coder:latest / h-explicit-offsets / xml: expected `["A", "D"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"B\",\n    \"D\"\n  ]\n}"`.
- heldout / qwen3-coder:latest / h-explicit-offsets / legacy: expected `["A", "D"]`, observed `"{\n  \"answer\": [\"A\", \"B\", \"D\"]\n}"`.
- heldout / qwen3-coder:latest / h-two-witnesses / flat: expected `["R2"]`, observed `"{\n  \"answer\": [\"A\", \"B\"]\n}"`.
- heldout / qwen3-coder:latest / h-two-witnesses / tgr: expected `["R2"]`, observed `"{\n  \"answer\": [\"A\", \"B\"]\n}"`.
- heldout / qwen3-coder:latest / h-two-witnesses / json: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- heldout / qwen3-coder:latest / h-two-witnesses / xml: expected `["R2"]`, observed `"{\"answer\": [\"R1\", \"R2\"]}"`.
- heldout / qwen3-coder:latest / h-two-witnesses / legacy: expected `["R2"]`, observed `"{\n  \"answer\": [\"R1\", \"R2\"]\n}"`.
- heldout / qwen3-coder:latest / h-multiple-locks / flat: expected `["A", "D"]`, observed `"{\n  \"answer\": [\"D\"]\n}"`.
- heldout / qwen3-coder:latest / h-joint-dependency / xml: expected `["D", "F"]`, observed `"{\n  \"answer\": [\"A\", \"D\", \"F\"]\n}"`.
- heldout / qwen3-coder:latest / h-joint-dependency / legacy: expected `["D", "F"]`, observed `"{\n  \"answer\": [\"A\", \"D\", \"F\"]\n}"`.
- heldout / qwen3-coder:latest / h-joint-dependency / flat: expected `["D", "F"]`, observed `"{\n  \"answer\": [\"A\", \"F\"]\n}"`.
- heldout / qwen3-coder:latest / h-joint-dependency / tgr: expected `["D", "F"]`, observed `"{\n  \"answer\": [\"A\", \"D\", \"F\"]\n}"`.
- heldout / qwen3-coder:latest / h-joint-dependency / json: expected `["D", "F"]`, observed `"{\n  \"answer\": [\"A\", \"F\"]\n}"`.
- calibration / qwen3-coder:latest / dependency / legacy: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"A\", \"D\"]\n}"`.
- heldout / qwen3-coder:latest / h-select-lexicographic / xml: expected `["B"]`, observed `"[\"B\"]"`.
- heldout / qwen3-coder:latest / h-task-local-revision / legacy: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"A\", \"B\", \"D\"]\n}"`.
- calibration / qwen3-coder:latest / scope / legacy: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"C\"]\n}"`.
- heldout / qwen3-coder:latest / h-mandatory-budget / legacy: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\", \"B\", \"C\"]\n}"`.
- heldout / qwen3-coder:latest / h-mandatory-budget / flat: expected `["A", "C"]`, observed `"{\n  \"answer\": []\n}"`.
- heldout / qwen3-coder:latest / h-mandatory-budget / tgr: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\", \"B\"]\n}"`.
- heldout / qwen3-coder:latest / h-mandatory-budget / json: expected `["A", "C"]`, observed `"{\"answer\":[\"A\",\"B\",\"C\"]}"`.
- heldout / qwen3-coder:latest / h-mandatory-budget / xml: expected `["A", "C"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"B\"\n  ]\n}"`.
- heldout / qwen2.5-coder:14b / h-unknown-all / legacy: expected `[]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-unknown-all / json: expected `[]`, observed `"```json\n{\n  \"answer\": [\"A\", \"B\", \"C\", \"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-disclosure-exception / legacy: expected `["A", "B"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"B\", \"D\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / retry-partial / legacy: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / retry-partial / json: expected `["A"]`, observed `"{\n  \"answer\": [\"A\", \"C\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-two-witnesses / tgr: expected `["R2"]`, observed `"```json\n{\n  \"answer\": [\"R1\", \"R2\", \"R4\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-two-witnesses / json: expected `["R2"]`, observed `"```json\n{\n  \"answer\": [\"R1\", \"R2\", \"R4\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-two-witnesses / xml: expected `["R2"]`, observed `"{\n  \"answer\": [\"R1\", \"R2\", \"R4\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-two-witnesses / flat: expected `["R2"]`, observed `"```json\n{\n  \"answer\": [\"R1\", \"R2\", \"R4\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-multiple-locks / xml: expected `["A", "D"]`, observed `"{\n  \"answer\": [\"D\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-multiple-locks / legacy: expected `["A", "D"]`, observed `"```json\n{\n  \"answer\": [\"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-multiple-locks / flat: expected `["A", "D"]`, observed `"```json\n{\n  \"answer\": [\"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-multiple-locks / tgr: expected `["A", "D"]`, observed `"```json\n{\n  \"answer\": [\"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-multiple-locks / json: expected `["A", "D"]`, observed `"```json\n{\n  \"answer\": [\"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-joint-dependency / legacy: expected `["D", "F"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"F\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / dependency / xml: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"A\", \"B\", \"D\"]\n}"`.
- calibration / qwen2.5-coder:14b / dependency / legacy: expected `["B", "D"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-retry-bounds / json: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\", \"C\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-retry-bounds / xml: expected `["B"]`, observed `"{\n  \"answer\": [\"B\", \"C\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-retry-bounds / legacy: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\", \"C\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-task-local-revision / json: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"B\", \"C\", \"D\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-mandatory-budget / flat: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"B\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-mandatory-budget / tgr: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"B\"]\n}\n```"`.
- heldout / qwen2.5-coder:14b / h-mandatory-budget / json: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\", \"B\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-mandatory-budget / xml: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\", \"B\"]\n}"`.
- heldout / qwen2.5-coder:14b / h-mandatory-budget / legacy: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"B\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / unknown / tgr: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / unknown / json: expected `["A"]`, observed `"{\n  \"answer\": [\"A\", \"D\"]\n}"`.
- calibration / qwen2.5-coder:14b / unknown / xml: expected `["A"]`, observed `"{\n  \"answer\": [\"A\", \"D\"]\n}"`.
- calibration / qwen2.5-coder:14b / unknown / legacy: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`.
- calibration / qwen2.5-coder:14b / unknown / flat: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`.
