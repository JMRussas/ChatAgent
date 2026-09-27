# Canonical examples comparison

This experiment changes only the optional examples block in the system prompt.
`examples.py` contains three fictional demonstrations: direct reading when the
source is identified, reconciling proposal and implementation, and reporting an
evidence gap without asserting universal absence. Example evidence IDs are not
accepted by the host. Both variants retain the same base prompt, tools, schemas,
source snapshot, model options, final-output constraint and resource limits.

`comparison_cases.py` fixes six new questions and manual review criteria before
inference. Four concern documented implementation; two request unavailable measured
values. These are distinct from the original four smoke cases and from the fictional
examples. Pair order alternates baseline/examples and examples/baseline to reduce
systematic ordering effects. One run per question per variant is a small exploratory
comparison, not a statistically reliable estimate. The first request may load the
model, and prompt caching or machine load can affect latency.

Run from the repository using the existing Windows course environment:

```powershell
& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe experiments/doc-agent/run.py `
  --compare-examples --model gemma4:26b --out reports/doc-agent/new-examples-comparison
```

Each case records full local telemetry. Evaluate completion, source-reference
checks, manual factual support and absence wording separately. Count all model
calls and reported input/output tokens, including rejected drafts and final
synthesis. These input tokens include repeated context across calls; they measure
reported prompt processing, not unique text or billable cost. Review tool choice,
argument errors, repeated calls and stopping behavior. Do not change examples
based on these answers and then label a rerun held-out evidence.

The default CLI remains the baseline. Passing `--compare-examples` evaluates both
variants; the Python `run_agent(..., with_examples=True)` option selects examples.
No production runtime or explicit LangGraph integration is included.
