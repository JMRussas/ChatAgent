# Results and evidence

This page distinguishes live-model experiments from software verification.
Numbers describe the recorded September 2026 checkpoints, not continuous service
performance. Each report retains its original scope; test totals from different
checkpoints should not be added together.

## Live model experiments

| Experiment       | Setup and result                                                                                                                                                                                                   | Interpretation                                                                                                      | Evidence                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt contract  | 600 scored calls; five model digests × 24 cases × five input formats. Held-out headings 40/60; identical flat text 38/60; headings used ~4.7% more input tokens.                                                   | Small descriptive difference. Model-specific behavior varied; no universal format winner established.               | [Findings](../reports/prompt-contract/findings-2026-09-26.md), [frozen protocol](../reports/prompt-contract/run-2026-09-26/preregistration.json), [raw records](../reports/prompt-contract/run-2026-09-26/records.jsonl)                                                                 |
| Observable plans | Eight Gemma4 runs; four questions with and without preliminary plans. Both conditions passed 4/4 structural checks. Manual review still found citation and uncertainty errors.                                     | Valid output and plan compliance are not proof of supported answers. Keep planning optional.                        | [Findings and paired traces](../reports/doc-agent/plan-findings-2026-09-28.md)                                                                                                                                                                                                           |
| Shared inference | Same local Gemma4 model for foreground and background. Six overlap samples per policy: 477 ms concurrent, 479 ms FIFO, 569 ms priority median first-answer latency. 18/18 noncancelled background tasks completed. | The tested priority policy did not justify changing runtime scheduling. Small workload, not an SLA or p95 estimate. | [Findings](../reports/doc-agent/contention-findings-2026-09-28.md), [protocol](../reports/doc-agent/contention-v2-2026-09-28/protocol.md), [raw data](../reports/doc-agent/contention-v2-2026-09-28/results.json), [summary](../reports/doc-agent/contention-v2-2026-09-28/summary.json) |

The prompt-contract experiment tested short, supplied-context tasks across
`qwen3:8b`, `qwen3.5:latest`, `gemma4:26b`, `qwen3-coder:latest` and
`qwen2.5-coder:14b`. Exact model digests and settings are in its
[metadata](../reports/prompt-contract/run-2026-09-26/metadata.json). Mutable tags are
not reproducible model identities by themselves.

The contention test used `gemma4:26b`, 25.8B Q4_K_M, Ollama 0.34.4 and a reported
32,768-token loaded context with full model residency in VRAM. It measured the
first nonempty answer chunk at an experiment gateway, not time to browser render.
Application admission wait is not Ollama's internal queue wait. The report preserves
an earlier, less-controlled run and explains why the protocol changed.

## Software and integration verification

| Check                                      | Recorded evidence                                                                                                                                                         | Boundary                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TypeScript suite                           | [258 tests passed](../reports/doc-agent/contention-v2-2026-09-28/release-check.txt), plus type checking and release checks                                                | Deterministic software behavior, not live answer quality                                                          |
| Python documentation agent/lifecycle suite | [61 tests passed](../reports/doc-agent/contention-v2-2026-09-28/python-check.txt)                                                                                         | Separate from the prompt-format experiment test suites; not currently run by GitHub CI                            |
| Fault injection                            | [Five reproduced lifecycle gaps fixed](../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md), including late completion and cancellation cleanup                       | Includes an actual killed worker and simulated persistence failure; not every disk/power-loss scenario            |
| Browser integration                        | [Headless Chrome flow](../reports/doc-agent/browser-contention-findings-2026-09-27.md): task start, cancellation, sourced completion, foreground Send and scope switching | Foreground mocked during the browser phase; background used real Ollama. Live contention was measured separately. |
| Simulated regression gate                  | [Seeded comparison passed](../reports/doc-agent/contention-v2-2026-09-28/release-compare.md)                                                                              | Simulated latency and synthetic quality values are regression fixtures, not model performance claims              |

The [GitHub workflow](../.github/workflows/verify.yml) runs Node tests, type checking,
fixture evaluation, a seeded simulated benchmark comparison and build. A green CI
run does not imply that local Ollama or Python evaluations ran there.

## Reproduce the software checks

Node checks (no live provider required):

```bash
npm ci
npm test
npm run lint
npm run build
```

For the full simulated release gate, set `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1` before `npm run verify:release`. Environment-variable
syntax differs by shell. The command writes report files; keep generated changes
separate from the dated historical evidence.

Python agent checks use isolated `uv` with managed Python 3.13.13. Install the
interpreter once with `uv python install 3.13.13` if needed. From the repo root:

```bash
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads --with-requirements experiments/doc-agent/requirements-durable.txt python -m unittest discover -s experiments/doc-agent -p "test_*.py"
```

Use `uv.exe` in WSL with the Windows installation. See the
[uv-managed sidecar environment](../experiments/doc-agent/README.md#runtime-sidecar-environment)
when a persistent interpreter is needed; keep that environment untracked.
Live runs additionally require a supported
installed Ollama model and sufficient memory. They make model calls; they are not
part of the default Node test command.

Experiment-specific instructions:

- [Prompt-contract experiment](../experiments/prompt-contract/README.md)
- [Documentation agent](../experiments/doc-agent/README.md)
- [Observable plans](../experiments/doc-agent/PLAN-EVALUATION.md)
- [Contention protocol](../experiments/doc-agent/CONTENTION-EVALUATION.md) and [run command](../reports/doc-agent/contention-findings-2026-09-28.md#reproduce)

Use fresh output/task directories for new live runs. Do not overwrite historical
results or bypass checkpoint identity checks to reuse old task databases.
