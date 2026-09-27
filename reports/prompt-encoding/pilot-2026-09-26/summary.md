# Live prompt-encoding pilot

Descriptive results, not a statistical ranking. See the experiment README for controls and limitations.

| Model | Encoding | Exact pass | Semantic pass | Errors | Mean input tokens | Mean output tokens | Median wall s |
|---|---|---:|---:|---:|---:|---:|---:|
| qwen3:8b | prose | 10/12 | 10/12 | 0 | 148.2 | 8.5 | 0.61 |
| qwen3:8b | concise | 8/12 | 8/12 | 0 | 133.8 | 8.0 | 0.60 |
| qwen3:8b | json | 6/12 | 6/12 | 0 | 136.2 | 8.7 | 0.66 |
| qwen3:8b | xml | 8/12 | 8/12 | 0 | 145.7 | 8.0 | 0.58 |
| qwen3.5:latest | concise | 10/12 | 10/12 | 0 | 130.0 | 18.2 | 0.61 |
| qwen3.5:latest | json | 7/12 | 7/12 | 0 | 132.2 | 14.9 | 0.61 |
| qwen3.5:latest | xml | 7/12 | 7/12 | 0 | 141.7 | 15.5 | 0.57 |
| qwen3.5:latest | prose | 6/12 | 6/12 | 0 | 145.2 | 18.5 | 0.66 |
| gemma4:26b | json | 0/12 | 10/12 | 0 | 134.9 | 11.9 | 0.91 |
| gemma4:26b | xml | 0/12 | 11/12 | 0 | 145.8 | 14.5 | 1.05 |
| gemma4:26b | prose | 0/12 | 4/12 | 0 | 145.2 | 20.8 | 1.13 |
| gemma4:26b | concise | 0/12 | 10/12 | 0 | 132.8 | 21.8 | 1.01 |
| qwen3-coder:latest | xml | 8/12 | 8/12 | 0 | 137.7 | 10.9 | 0.52 |
| qwen3-coder:latest | prose | 10/12 | 10/12 | 0 | 140.2 | 10.7 | 0.52 |
| qwen3-coder:latest | concise | 7/12 | 7/12 | 0 | 125.8 | 11.4 | 0.51 |
| qwen3-coder:latest | json | 7/12 | 7/12 | 0 | 128.2 | 10.9 | 0.52 |
| qwen2.5-coder:14b | prose | 0/12 | 9/12 | 0 | 140.2 | 15.4 | 0.66 |
| qwen2.5-coder:14b | concise | 0/12 | 8/12 | 0 | 125.8 | 15.0 | 0.65 |
| qwen2.5-coder:14b | json | 1/12 | 9/12 | 0 | 128.2 | 14.5 | 0.64 |
| qwen2.5-coder:14b | xml | 0/12 | 9/12 | 0 | 137.7 | 15.0 | 0.65 |

## Equal-model aggregate

| Encoding | Exact pass | Mean model accuracy | Mean input tokens |
|---|---:|---:|---:|
| prose | 26/60 | 43.3% | 143.8 |
| concise | 25/60 | 41.7% | 129.6 |
| json | 21/60 | 35.0% | 131.9 |
| xml | 23/60 | 38.3% | 141.7 |

## Failures

- qwen3:8b / unknown / json: expected `["A"]`, observed `"{\"answer\": [\"A\", \"D\"]}"`; finish=stop
- qwen3:8b / locks / concise: expected `["C", "E"]`, observed `"{\"answer\": [\"C\"]}"`; finish=stop
- qwen3:8b / locks / json: expected `["C", "E"]`, observed `"{\"answer\": [\"B\", \"C\"]}"`; finish=stop
- qwen3:8b / locks / xml: expected `["C", "E"]`, observed `"{\"answer\": [\"C\"]}"`; finish=stop
- qwen3:8b / schedule / json: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / schedule / xml: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / schedule / prose: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / schedule / concise: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / revision / xml: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / revision / json: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / scope / prose: expected `["A", "C"]`, observed `"{\"answer\": [\"A\"]}"`; finish=stop
- qwen3:8b / precedence / concise: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / precedence / json: expected `["C"]`, observed `"{\"answer\": [\"A\", \"C\"]}"`; finish=stop
- qwen3:8b / dependency / xml: expected `["B", "D"]`, observed `"{\"answer\": [\"D\"]}"`; finish=stop
- qwen3:8b / dependency / concise: expected `["B", "D"]`, observed `"{\"answer\": [\"D\"]}"`; finish=stop
- qwen3:8b / dependency / json: expected `["B", "D"]`, observed `"{\"answer\": [\"D\"]}"`; finish=stop
- qwen3.5:latest / budget / prose: expected `["B"]`, observed `"{\"answer\": [\"Model B\"]}"`; finish=stop
- qwen3.5:latest / unknown / prose: expected `["A"]`, observed `"{\n  \"answer\": [\n    \"Model A\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / exception / json: expected `["A", "C"]`, observed `"{\"answer\":[\"A\"]}"`; finish=stop
- qwen3.5:latest / exception / xml: expected `["A", "C"]`, observed `"{\"answer\":[\"A\"]}"`; finish=stop
- qwen3.5:latest / locks / json: expected `["C", "E"]`, observed `"{\n  \"answer\": [\n    \"C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / locks / xml: expected `["C", "E"]`, observed `"{\n  \"answer\": [\n    \"B\",\n    \"C\",\n    \"E\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / locks / prose: expected `["C", "E"]`, observed `"{\n  \"answer\": [\n    \"B\",\n    \"C\",\n    \"E\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / revision / xml: expected `["C"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / scope / json: expected `["A", "C"]`, observed `"{\"answer\":[\"C\"]}"`; finish=stop
- qwen3.5:latest / precedence / json: expected `["C"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / precedence / xml: expected `["C"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / precedence / prose: expected `["C"]`, observed `"{\n  \"answer\": [\n    \"Model C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / precedence / concise: expected `["C"]`, observed `"{\n  \"answer\": [\n    \"A\",\n    \"C\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / retry-partial / prose: expected `["A"]`, observed `"{\n  \"answer\": [\n    \"Attempt A\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / dependency / prose: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"D\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / dependency / concise: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"D\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / dependency / json: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"D\"\n  ]\n}"`; finish=stop
- qwen3.5:latest / dependency / xml: expected `["B", "D"]`, observed `"{\n  \"answer\": [\n    \"D\"\n  ]\n}"`; finish=stop
- gemma4:26b / budget / json: expected `["B"]`, observed `"```json\n{\"answer\":[\"B\"]}\n```"`; finish=stop
- gemma4:26b / budget / xml: expected `["B"]`, observed `"```json\n{\"answer\": [\"B\"]}\n```"`; finish=stop
- gemma4:26b / budget / prose: expected `["B"]`, observed `"```json\n{\n \"answer\": [\"Model B\"]\n}\n```"`; finish=stop
- gemma4:26b / budget / concise: expected `["B"]`, observed `"```json\n{\n \"answer\": [\"B\"]\n}\n```"`; finish=stop
- gemma4:26b / evidence / xml: expected `["R3"]`, observed `"```json\n{\"answer\": [\"R3\"]}\n```"`; finish=stop
- gemma4:26b / evidence / prose: expected `["R3"]`, observed `"```json\n{\n \"answer\": [\n  \"R3\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / evidence / concise: expected `["R3"]`, observed `"```json\n{\n \"answer\": [\n  \"R3\",\n  \"R4\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / evidence / json: expected `["R3"]`, observed `"```json\n{\"answer\":[\"R3,R4\"]}\n```"`; finish=stop
- gemma4:26b / no-evidence / prose: expected `[]`, observed `"```json\n{\n \"answer\": []\n}\n```"`; finish=stop
- gemma4:26b / no-evidence / concise: expected `[]`, observed `"```json\n{\n \"answer\": []\n}\n```"`; finish=stop
- gemma4:26b / no-evidence / json: expected `[]`, observed `"```json\n{\"answer\":[]}\n```"`; finish=stop
- gemma4:26b / no-evidence / xml: expected `[]`, observed `"```json\n{\"answer\": []}\n```"`; finish=stop
- gemma4:26b / unknown / concise: expected `["A"]`, observed `"```json\n{\n \"answer\": [\n  \"A\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / unknown / json: expected `["A"]`, observed `"```json\n{\"answer\":[\"A\"]}\n```"`; finish=stop
- gemma4:26b / unknown / xml: expected `["A"]`, observed `"```json\n{\"answer\": [\"A\"]}\n```"`; finish=stop
- gemma4:26b / unknown / prose: expected `["A"]`, observed `"```json\n{\n \"answer\": [\n  \"Model A\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / exception / json: expected `["A", "C"]`, observed `"```json\n{\"answer\":[\"A\",\"C\"]}\n```"`; finish=stop
- gemma4:26b / exception / xml: expected `["A", "C"]`, observed `"```json\n{\n \"answer\": [\n  \"A\",\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / exception / prose: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\n    \"A\",\n    \"C\"\n  ]\n}\n```"`; finish=stop
- gemma4:26b / exception / concise: expected `["A", "C"]`, observed `"```json\n{\n \"answer\": [\n  \"A\",\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / locks / xml: expected `["C", "E"]`, observed `"```json\n{\"answer\": [\"C\", \"E\"]}\n```"`; finish=stop
- gemma4:26b / locks / prose: expected `["C", "E"]`, observed `"```json\n{\n \"answer\": [\"C\", \"E\"]\n}\n```"`; finish=stop
- gemma4:26b / locks / concise: expected `["C", "E"]`, observed `"```json\n{\n \"answer\": [\n  \"C\",\n  \"E\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / locks / json: expected `["C", "E"]`, observed `"```json\n{\"answer\": [\"C\", \"E\"]}\n```"`; finish=stop
- gemma4:26b / schedule / prose: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"Task C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / schedule / concise: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / schedule / json: expected `["C"]`, observed `"```json\n{\"answer\":[\"C\"]}\n```"`; finish=stop
- gemma4:26b / schedule / xml: expected `["C"]`, observed `"```json\n{\"answer\":[\"C\"]}\n```"`; finish=stop
- gemma4:26b / revision / concise: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / revision / json: expected `["C"]`, observed `"```json\n{\"answer\":[\"C\"]}\n```"`; finish=stop
- gemma4:26b / revision / xml: expected `["C"]`, observed `"```json\n{\"answer\": [\"C\"]}\n```"`; finish=stop
- gemma4:26b / revision / prose: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"Result C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / scope / json: expected `["A", "C"]`, observed `"```json\n{\"answer\":[\"A\",\"C\"]}\n```"`; finish=stop
- gemma4:26b / scope / xml: expected `["A", "C"]`, observed `"```json\n{\n \"answer\": [\n  \"A\",\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / scope / prose: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\n    \"A\"\n  ]\n}\n```"`; finish=stop
- gemma4:26b / scope / concise: expected `["A", "C"]`, observed `"```json\n{\n \"answer\": [\n  \"A\",\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / precedence / xml: expected `["C"]`, observed `"```json\n{\"answer\": [\"C\"]}\n```"`; finish=stop
- gemma4:26b / precedence / prose: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"Model C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / precedence / concise: expected `["C"]`, observed `"```json\n{\n \"answer\": [\n  \"C\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / precedence / json: expected `["C"]`, observed `"```json\n{\"answer\":[\"C\"]}\n```"`; finish=stop
- gemma4:26b / retry-partial / prose: expected `["A"]`, observed `"```json\n{\n \"answer\": [\n  \"Attempt A\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / retry-partial / concise: expected `["A"]`, observed `"```json\n{\n \"answer\": [\n  \"A\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / retry-partial / json: expected `["A"]`, observed `"```json\n{\"answer\":[\"A\"]}\n```"`; finish=stop
- gemma4:26b / retry-partial / xml: expected `["A"]`, observed `"```json\n{\"answer\": [\"A\"]}\n```"`; finish=stop
- gemma4:26b / dependency / concise: expected `["B", "D"]`, observed `"```json\n{\n \"answer\": [\n  \"D\"\n ]\n}\n```"`; finish=stop
- gemma4:26b / dependency / json: expected `["B", "D"]`, observed `"```json\n{\"answer\":[\"D\"]}\n```"`; finish=stop
- gemma4:26b / dependency / xml: expected `["B", "D"]`, observed `"```json\n{\"answer\": [\"D\"]}\n```"`; finish=stop
- gemma4:26b / dependency / prose: expected `["B", "D"]`, observed `"```json\n{\n \"answer\": [\"D\"]\n}\n```"`; finish=stop
- qwen3-coder:latest / no-evidence / concise: expected `[]`, observed `"{\n  \"answer\": [\"R2\"]\n}"`; finish=stop
- qwen3-coder:latest / no-evidence / json: expected `[]`, observed `"{\n  \"answer\": [\"R2\"]\n}"`; finish=stop
- qwen3-coder:latest / locks / concise: expected `["C", "E"]`, observed `"{\n  \"answer\": [\"B\", \"C\", \"E\"]\n}"`; finish=stop
- qwen3-coder:latest / locks / json: expected `["C", "E"]`, observed `"{\n  \"answer\": [\"B\", \"C\", \"E\"]\n}"`; finish=stop
- qwen3-coder:latest / locks / xml: expected `["C", "E"]`, observed `"{\n  \"answer\": [\"B\", \"C\", \"E\"]\n}"`; finish=stop
- qwen3-coder:latest / scope / xml: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\"]\n}"`; finish=stop
- qwen3-coder:latest / scope / prose: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"C\"]\n}"`; finish=stop
- qwen3-coder:latest / scope / concise: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\"]\n}"`; finish=stop
- qwen3-coder:latest / scope / json: expected `["A", "C"]`, observed `"{\n  \"answer\": [\"A\"]\n}"`; finish=stop
- qwen3-coder:latest / precedence / concise: expected `["C"]`, observed `"{\n  \"answer\": [\"A\", \"B\", \"C\"]\n}"`; finish=stop
- qwen3-coder:latest / precedence / json: expected `["C"]`, observed `"{\n  \"answer\": [\"A\", \"C\"]\n}"`; finish=stop
- qwen3-coder:latest / precedence / xml: expected `["C"]`, observed `"{\n  \"answer\": [\"A\", \"C\"]\n}"`; finish=stop
- qwen3-coder:latest / dependency / json: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"D\"]\n}"`; finish=stop
- qwen3-coder:latest / dependency / xml: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"D\"]\n}"`; finish=stop
- qwen3-coder:latest / dependency / prose: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"A\", \"D\"]\n}"`; finish=stop
- qwen3-coder:latest / dependency / concise: expected `["B", "D"]`, observed `"{\n  \"answer\": [\"D\"]\n}"`; finish=stop
- qwen2.5-coder:14b / budget / prose: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / budget / concise: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / budget / json: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / budget / xml: expected `["B"]`, observed `"```json\n{\n  \"answer\": [\"B\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / evidence / concise: expected `["R3"]`, observed `"```json\n{\n  \"answer\": [\"R3\", \"R4\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / evidence / json: expected `["R3"]`, observed `"```json\n{\n  \"answer\": [\"R3\", \"R4\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / evidence / xml: expected `["R3"]`, observed `"```json\n{\n  \"answer\": [\"R3\", \"R4\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / evidence / prose: expected `["R3"]`, observed `"```json\n{\n  \"answer\": [\"R3\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / no-evidence / json: expected `[]`, observed `"```json\n{\"answer\":[]}\n```"`; finish=stop
- qwen2.5-coder:14b / no-evidence / xml: expected `[]`, observed `"```json\n{\n  \"answer\": []\n}\n```"`; finish=stop
- qwen2.5-coder:14b / no-evidence / prose: expected `[]`, observed `"```json\n{\n  \"answer\": []\n}\n```"`; finish=stop
- qwen2.5-coder:14b / no-evidence / concise: expected `[]`, observed `"```json\n{\n  \"answer\": []\n}\n```"`; finish=stop
- qwen2.5-coder:14b / unknown / xml: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / unknown / prose: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / unknown / concise: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / unknown / json: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / exception / prose: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / exception / concise: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / exception / json: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / exception / xml: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / locks / concise: expected `["C", "E"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"E\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / locks / json: expected `["C", "E"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"E\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / locks / xml: expected `["C", "E"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"E\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / locks / prose: expected `["C", "E"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"E\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / schedule / json: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / schedule / xml: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / schedule / prose: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / schedule / concise: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / revision / xml: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / revision / prose: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / revision / concise: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / revision / json: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / scope / prose: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / scope / concise: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"D\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / scope / json: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"C\", \"D\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / scope / xml: expected `["A", "C"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / precedence / concise: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / precedence / json: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / precedence / xml: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / precedence / prose: expected `["C"]`, observed `"```json\n{\n  \"answer\": [\"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / retry-partial / json: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / retry-partial / xml: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / retry-partial / prose: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"C\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / retry-partial / concise: expected `["A"]`, observed `"```json\n{\n  \"answer\": [\"A\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / dependency / xml: expected `["B", "D"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / dependency / prose: expected `["B", "D"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`; finish=stop
- qwen2.5-coder:14b / dependency / concise: expected `["B", "D"]`, observed `"```json\n{\n  \"answer\": [\"A\", \"D\"]\n}\n```"`; finish=stop
