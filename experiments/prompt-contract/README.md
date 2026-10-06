# Task / Guidelines / Response Framework: experiment 2

Status: experiment contract and scoring defined before live inference. Production
runtime/provider behavior is unchanged. Python standard library only.

## Question and controls

Does organizing a prompt into **Task, Guidelines, Response Framework** improve
performance when its semantic content is held constant? The response framework
specifies the deliverable, not hidden reasoning steps. Context is a separately
referenced input; it is not a fourth instruction responsibility.

`contract.py` defines validated frozen dataclasses (`PromptPackage`,
`ContextSource`) with an explicit contract version. The package contains a task,
ordered guidelines, ordered response requirements, and versioned context sources.
Expected answers never enter the package or model request. Telemetry versions
are excluded from model-visible fields unless they are source identity/revision.

Five paired conditions:

| Variant | Presentation                                                                            | Interpretation                                        |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| legacy  | First pilot's system instruction plus full prose and question                           | Continuity baseline; different instructions/placement |
| flat    | New contract's literal text values, no section headings                                 | Identical-content control                             |
| tgr     | Same text/order as flat, with Task, Guidelines, Response Framework and Context headings | Primary comparison: section organization              |
| json    | Same full-word values in a nested typed object                                          | Serialization comparison                              |
| xml     | Same full-word values in explicit nested elements                                       | Serialization comparison                              |

There is no semantic compression or shortened logical notation in this experiment.
The same source prose is retained verbatim in every condition. JSON and XML differ
in delimiters/field structure; logical strings are identical. Flat and TGR use
identical source labels and ordering, differing only in headings. New variants
share one system message. Comparisons with legacy include clearer output guidance,
source labels, changed instruction placement, and system wording, so improvements
against legacy cannot be attributed solely to headings.

## Dataset and primary endpoint

Twenty-four synthetic cases: the first pilot's twelve cases are **calibration**;
twelve newly authored cases are **heldout**. Heldout means their model outcomes
were unseen at the protocol freeze; they are related synthetic tasks authored by
us, not an external independent benchmark. New cases cover combined constraints,
time offsets, context budgets, independent evidence, lock relationships, objective
scope, tie-breaking, unknowns, bounded retries and source authority.

Primary endpoint: held-out presentation-normalized content correctness; paired
TGR versus flat on the same model/case. Secondary: JSON/XML versus flat, strict
output compliance, calibration/combined results, tokens and latency. Report all
five models and an equal-model aggregate; retain case-level wins/losses/ties.

One pass per model/case/variant = **600 scored requests**, plus five excluded
warmups. No significance or stable ranking claim is planned. Temperature 0,
seed 20260927, context 4096, output cap 384. Thinking=false is sent only when
advertised by installed metadata; otherwise record the server default. Sampling
defaults otherwise remain model-specific. This tests non-thinking behavior with
a bounded final-answer task, not optimal model tuning.

## Frozen scoring rules

`scoring.py` version `contract-score/1`:

- Require `done=true` and `done_reason=stop`; transport errors, missing terminal
  state and truncations fail, and remain in the denominator.
- Parse one JSON object with exactly one `answer` array of strings. Reject duplicate
  JSON keys, extra fields, invalid JSON and arbitrary explanatory prose.
- For primary content scoring, accept an enclosing JSON/untagged code fence and
  strip one exact prefix: Model, Task, Document, Result, Attempt, Change, Claim,
  Job, Source or Test followed by a space and a bare identifier (capital letter
  optionally followed by digits). No case folding or fuzzy interpretation.
- Compare identifier multisets; ordering is irrelevant but duplicate/missing/extra
  IDs fail. Empty arrays are valid only for empty expected sets.
- Exact pass additionally requires no fence and literal bare identifiers.
  Strict format compliance is recorded independently of answer correctness.

This normalization is fixed **before** experiment 2, unlike the first pilot's
exploratory rescore. No LLM judge or forced provider JSON output mode is used.
All conditions request JSON output; possible input/output-format affinity remains
an explicit limitation. A later study can cross output formats independently.

## Execution and artifacts

From the repository root, use `uv` with managed Python 3.13.13. These commands
need only the standard library. Install the interpreter once with
`uv python install 3.13.13` if needed; use `uv.exe` in WSL with the Windows
installation. Choose a fresh output directory; preserve dated evidence.

```bash
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python experiments/prompt-contract/generate_cases.py
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python -m unittest discover -s experiments/prompt-contract -p 'test_*.py'
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python experiments/prompt-contract/run.py --out reports/prompt-contract/new-run
```

The default is direct API access, including Windows Python launched by `uv.exe`.
Add `--windows-host` only with Linux `uv`/Python inside WSL when Ollama is on
Windows localhost: that transport uses Linux `wslpath` and the mounted Windows
PowerShell executable, so it does not work with Windows Python. The first pilot's transport is reused
without changing its renderer, scorer or results. No downloads, server restarts,
provider configuration edits or cloud calls. The default models are the same
five installed general/coding bindings; duplicate digests are rejected.

Before the first warmup, `preregistration.json` freezes cases/answers, endpoints,
controls and implementation hashes. `rendered-inputs.jsonl` retains all exact
packages and messages. `metadata.json` records model digests, server metadata,
warmups, completion status and the preregistration hash. Each result includes
source IDs/revisions/content hashes, package/renderer/scorer versions, exact
request and final output, grade, token counts and timings. Internal thinking text
is removed. Source content is recoverable from frozen packages.

The run refuses a nonempty output directory; it does not silently resume or
retry failures. Reports are regenerated after every case, and remain partial
until metadata records a complete matrix. Regenerate reports with:

```bash
python3 experiments/prompt-contract/report.py reports/prompt-contract/run-2026-09-26
```

Models run sequentially, case order is seeded, and condition order rotates.
Timing includes the WSL bridge; cache state, fixed model order, hardware contention
and model defaults are uncontrolled. Token counts include system/template overhead
and differ by tokenizer. Primary analysis is paired within model. No software
agent, retrieval, concurrent workflow or production task is executed by these cases.

Learning notes stay outside source control in `D:\Git\ChatAgent-learning`.
