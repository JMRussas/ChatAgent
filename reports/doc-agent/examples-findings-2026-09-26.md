# Canonical examples: local Gemma4 comparison

The optional three-example prompt produced one additional structural pass across
six new questions, at 39.3% more reported input tokens. This small run does not
justify enabling the examples by default. It identifies a useful retrieval success
and several failures that demonstrations alone did not resolve.

## Design and evidence

Twelve sequential agent runs used the same `gemma4:26b` model, base prompt,
tool schemas, eight-document snapshot, generation options and execution limits.
Only the optional fictional examples block differed. Six new questions and review
criteria were fixed before inference; pair order alternated. Each condition ran
once per question, with temperature zero and the same seed. No prompt revision or
selective rerun followed these results. This is exploratory evidence from one model.

- [Protocol](../../experiments/doc-agent/EXAMPLES-EVALUATION.md)
- [Frozen cases, model digest, options and code hashes](examples-v1-2026-09-26/metadata.json)
- [Source snapshot](examples-v1-2026-09-26/sources.json)
- [Derived metrics](examples-v1-2026-09-26/summary.json)

The summarizer additionally verified identical initial tool schemas across all
runs, consistent system prompts within each variant, snapshot checksum, resource
bounds and resolution of accepted citations to actual retrieved ranges.

## Resource and structural results

| Metric across six questions | Baseline | Three examples |
| --- | ---: | ---: |
| Structurally valid completion | 5/6 | 6/6 |
| All case structural checks, including expected status | 4/6 | 5/6 |
| Model calls | 24 | 24 |
| Tool calls | 11 | 12 |
| Reported input tokens, summed over every call | 40,099 | 55,867 |
| Reported output tokens | 1,524 | 1,364 |
| Rejected drafts requiring final synthesis | 6 | 6 |
| Tool argument errors | 0 | 0 |
| Total elapsed seconds | 31.61 | 18.06 |

The token increase is 15,768 input tokens. Total input plus output increased from
41,623 to 57,231 (37.5%). These are provider-reported token counts, including
repeated context; they are not a dollar-cost calculation. Baseline's first case
included 13.82 seconds of model loading. Do not interpret the aggregate elapsed
time difference as an examples speedup; cache and load effects were not controlled.

## Manual review against the fixed criteria

| Case | Baseline | Examples |
| --- | --- | --- |
| Default summary mode | Missed answer present in source | Same failure |
| SSE disconnection/cancellation | Supported answer | Supported answer |
| Source lookup scope | Supported but incomplete | Supported but incomplete |
| Shutdown scope | Rejected: no accepted citation | Supported answer with retrieved citation |
| Measured cooling water | Declined invented value; imprecise absence scope | Same limitation |
| Measured p99 latency | Declined invented value; unsupported broad absence statement | Same limitation |

**Default summary mode:** both searched and read memory-evidence lines 50–88.
The actual default is documented earlier, at line 43. Both stopped with
insufficient_evidence and claimed the document did not identify the default.
The retrieved passage was inadequate, despite the needed fact existing in the
allowlisted source. This is a concrete context-selection failure, not evidence
that the corpus lacks an answer.

**Source lookup:** both cited lines 100–105 and correctly described direct ID
checking rather than semantic search. Neither explained the internal interface
and existing ownership check documented at lines 21–25. Structural success did
not establish full coverage of the review criterion.

**Shutdown:** baseline attempted to answer from search snippets without reading.
Its final result was rejected because no citation had been issued. With examples,
the model read lines 60–69 and correctly distinguished summary-job shutdown from
full worker/provider draining. The example variant improved this particular trace;
a single paired observation cannot establish a reliable causal improvement rate.

**Unknown measurements:** neither variant invented a number. Both only searched;
neither read a source. Water answers framed absence as an inability to find data,
but still referred broadly to provided documentation. Latency answers additionally
claimed available documents lack the requested metrics, beyond what their bounded
searches establish. The example of carefully scoped uncertainty did not reliably
transfer to these questions.

All twelve runs searched first, even the four runs with a source explicitly named
in the question. All twelve rejected a draft and used constrained final synthesis.
No fictional example citation was accepted. No invalid tool argument or repeated
identical tool call occurred. Most importantly, examples did not reduce aggregate
model calls or solve evidence coverage and output formatting here.

## Decision and next step

Keep examples optional and preserve this comparison unchanged. Continue to expose
only search_docs and read_doc for the documentation worker. Additional tools would
not directly address the observed missed passage in an already identified source.

Before a broader examples claim, use additional untouched questions and repeated
runs across models. A separate targeted retrieval experiment should evaluate
whether section-aware reading helps the agent locate configuration facts and
avoid treating a partial read as evidence of absence. Keep that change separate
from an examples-only comparison. LangGraph remains the next framework-learning
step; it should preserve these limits and known failures, not be presented as an
automatic solution to retrieval quality.

Seventeen offline tests pass, including example-evidence isolation and equality
of schemas, question context and limits between prompt variants. Production
TypeScript code and application dependencies were not changed.
