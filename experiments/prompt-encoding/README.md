# Local prompt-encoding pilot

This standalone experiment tests compact representation, not ChatRuntime routing
or a deployed translation layer. It makes real local Ollama calls and grades
actual answers. It does not reuse the existing benchmark's synthetic quality
scores, change release baselines, download models, or access cloud providers.

## Design

Twelve synthetic closed-world cases cover negation, dependencies, source scope,
revision freshness, evidence coverage, scheduling, exceptions, uncertainty,
numeric selection and concurrency. Each case has a hand-authored full-prose
version and a compact fact/rule representation with the same intended meaning.
`cases.json` contains expected identifier sets; these are never sent to models.

Four input conditions:

1. Full prose (baseline).
2. Concise labeled text.
3. Compact JSON.
4. Compact XML.

Concise, JSON and XML share identical field values. This comparison isolates
serialization more closely. Full prose versus compact conditions changes both
wording and representation; it does **not** isolate punctuation alone. Logical
notation in compact conditions may make reasoning easier independently of length.
Case equivalence was manually inspected, not mechanically proven.

Every condition uses the same system instruction and requests a JSON answer.
No Ollama structured-output schema/JSON constraint is supplied. This means the
results include instruction/format compliance, and JSON inputs may benefit from
matching the output format. A future experiment should cross input and output
formats or use a second common answer format.

The pilot uses one repetition, temperature 0, seed 20260926, 4096 context tokens
and 384 maximum generated tokens. Explicit thinking=false is sent only when
installed `/api/show` metadata lists boolean false as supported; otherwise the
server default applies and is recorded. Model-specific other sampling defaults
remain recorded in metadata. This is not a test of optimal per-model tuning or
thinking-mode quality. No hidden thinking text is retained in the reports.

Models execute sequentially with an excluded warmup. Case order is seeded and
format order rotates across cases/models. Models are deduplicated by digest.
The selected matrix contains installed general-purpose/coding models; embedding,
translation and moderation models are excluded as different task classes.
Model order is fixed, hardware/cache state is uncontrolled, and all four formats
for a case share prefix information. Timing is descriptive, not a cold-cache
throughput comparison. Wall time includes a PowerShell bridge on WSL; recorded
Ollama timing separates loading, prompt evaluation and generation.

## Reproduce

Use `uv` with managed Python 3.13.13 from the repository root. This experiment
uses only the standard library; no doc-agent dependencies are needed. Install the
interpreter once with `uv python install 3.13.13` if needed; use `uv.exe` in WSL
with the Windows installation.

```bash
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python experiments/prompt-encoding/generate_cases.py
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python -m unittest discover -s experiments/prompt-encoding -p 'test_*.py'
uv run --no-project --isolated --no-env-file --python 3.13.13 --no-python-downloads python experiments/prompt-encoding/run.py --out reports/prompt-encoding/new-run
```

The default direct mode works with Windows Python launched by `uv.exe`.
Add `--windows-host` only with Linux `uv`/Python inside WSL when Ollama listens
only on Windows localhost. This transport uses Linux `wslpath`, temporary files
and the mounted Windows PowerShell executable; it does not work with Windows
Python and does not reconfigure Ollama's network binding.
`--base-url`, `--models`, `--repeats` and
`--case-limit` support explicit follow-up runs. Existing record files are never
overwritten. Runs are not automatically resumed; choose a fresh output directory.
The runner never changes the application's provider configuration.

## Grading and telemetry

Exact pass requires a finished, non-truncated response containing exactly one
JSON key `answer` with the correct string identifier multiset. Order is ignored;
duplicates, extra keys, missing/extra IDs, invalid JSON, HTTP errors and truncated
responses fail. Semantic pass additionally accepts a JSON code fence; no general
natural-language answer extraction or LLM judge is used. Transport failures and
format failures remain visible rather than silently retried or removed.

`metadata.json` records model digests, full inventory, server version, model
metadata, controls, cases and warmups. `records.jsonl` records each exact request,
final response (excluding thinking), answer key, grade, finish reason, timestamps,
reported token counts and duration fields. Summaries update after each attempt;
only a run reaching the planned matrix is a complete comparison.

`summary.json` and `summary.md` show per-model/format results, failure details and
an equal-model macro-average. Token counts are actual Ollama-reported counts;
word/character length is not substituted for token usage. Cross-model token
averages mix tokenizers and are descriptive. Compare token reductions primarily
within each model. Unknown metrics are not assigned zero.

The cases are small, synthetic and unblinded to the author. They cannot establish
performance on long context, real coding, retrieval, concurrent orchestration or
agent specialization. Twelve cases with one repetition are a screening baseline,
not evidence of statistical superiority. Near-perfect scores signal the need
for harder held-out cases; they do not prove lossless semantic compression.

## Results

See [2026-09-26 live pilot](../../reports/prompt-encoding/pilot-2026-09-26/summary.md)
and its adjacent raw records and metadata. Interpretation is recorded in
[findings](../../reports/prompt-encoding/findings-2026-09-26.md).

Official API references checked 2026-09-26:
[chat](https://docs.ollama.com/api/chat),
[model inventory](https://docs.ollama.com/api/tags).

The separate education journal lives outside the repository in
`D:\Git\ChatAgent-learning`.

## Exploratory presentation-normalized analysis

After observing the pilot's responses, `analyze.py` was added to distinguish
content selection from presentation errors. It accepts a JSON fence and strips
one exact entity prefix (`Model B` → `B`, likewise Task, Document, Result,
Attempt, Change and Claim). No case folding, arbitrary prose extraction,
extra fields or duplicate identifiers are accepted. The same rule is applied to
all models and formats. This is explicitly **post-hoc** and does not alter the
original exact grades. Read both metrics rather than treating formatting failures
as proof of reasoning failure.

```bash
python3 experiments/prompt-encoding/analyze.py reports/prompt-encoding/pilot-2026-09-26
```
