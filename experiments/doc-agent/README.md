# Documentation retrieval agent: LangChain + local Ollama

Latest: [shared inference protocol](CONTENTION-EVALUATION.md) and
[controlled findings](../../reports/doc-agent/contention-findings-2026-09-28.md).
The real foreground provider and Python sidecar can use an experiment-only
loopback gateway for timing and admission comparisons. Normal runtime scheduling
is unchanged. See the findings for commands, limitations and source-pin migration.
The original standalone loop remains available; the optional conversation-task
bridge now connects the durable graph to chat (older standalone-only notes below
are historical).

Latest lifecycle review: [edge-case findings](../../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) records
five reproduced fixes and 67 passing offline tests, including a killed worker,
late provider completion, cancellation races and failed persistence. Historical
live-run hashes predate these fixes; old durable tasks still require migration.

## 2026-09-27: independent task lifecycle

The [local task manager](TASKS.md) adds task IDs, status/list,
resume, and persisted cancellation around per-task checkpoints. Managed tasks
exclude paused time from their execution budget; the standalone durable CLI
retains its wall-clock policy. This supersedes earlier task-management next-step
notes. Conversation integration, admission control and scheduled triggers remain
future work; uncertain in-flight tasks are still refused.

## 2026-09-27: durable single-task checkpoint

[SQLite pause/resume](DURABILITY.md) now supports process restarts from confirmed
retrieval pauses, preserving sources, evidence and budgets. 33 offline tests and
a four-process local Gemma4 run passed. This supersedes earlier descriptions of
persistence as entirely future work; the ordinary graph engine remains optional
and nonpersistent. Arbitrary in-flight crash replay is refused. The next increment
is task lifecycle/scheduling around this unit, with explicit long-pause policy.

A standalone learning slice. The agent answers repository questions by deciding
when to search and read documentation. It is not wired into ChatRuntime's server,
conversation history or fast/deep generation lifecycle.

## What this teaches

- `ChatOllama` adapts a local model into LangChain's chat-model interface.
- `@tool` and Pydantic schemas describe callable operations to the model.
- `bind_tools` allows native tool requests; it does not execute them.
- Our small host loop executes permitted tools, appends `ToolMessage` results,
  and invokes the model again. The model chooses retrieval; code enforces limits.
- A Markdown Task / Guidelines / Tool guidance / Response Framework prompt
  separates responsibilities and keeps evidence in tool messages.

The explicit loop is intentional for learning. We use LangChain model, tool and
message abstractions directly, not `create_agent`. The reference loop remains available.
An optional explicit LangGraph implementation is now available; see [the graph walkthrough](LANGGRAPH.md).

## Run

Use Python 3.12+ and a dedicated environment with `requirements.txt`, or the
already-installed course environment. No sibling module is imported or modified.
No `.env` is loaded and hosted LangSmith tracing is disabled for this process.
The default model is `gemma4:26b`, validated in the final development smoke run.

```powershell
# From D:\Git\ChatAgent; reuses the existing course environment unchanged.
& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe experiments/doc-agent/run.py `
  --model gemma4:26b `
  --question "Does restarting the implemented Iris slice preserve queued work?" `
  --out reports/doc-agent/my-question

# Four-case live smoke evaluation:
& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe experiments/doc-agent/run.py `
  --model gemma4:26b --eval --out reports/doc-agent/new-eval

# Offline deterministic checks; no Ollama calls:
& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe -m unittest discover `
  -s experiments/doc-agent -p "test_*.py"
```

For an independent setup, use `python -m venv .venv` and install
`experiments/doc-agent/requirements.txt` with that environment's pip. The run
accepts local loopback HTTP Ollama only. It verifies the model is installed,
advertises tools, and reports at least 32768 context capacity. It does not download
models or change the application's configured providers. Thinking is disabled
only if the installed metadata advertises support. No paid/cloud fallback exists.
Output directories must be new and empty.

## Corpus and retrieval

`retrieval.py` declares eight source IDs and paths. Only these Markdown documents
are loaded; no arbitrary path or shell tool is exposed. Resolved paths must stay
inside the repo and individual source files are capped at 128 KiB. Loading makes
an immutable per-run snapshot, recording content hashes. This is a scoped learning
corpus, not a full repository search engine.

The initial prompt has only an index of titles, IDs, paths and line counts.
`search_docs` performs simple keyword overlap search, returning up to three sources
with at most two short line hints each. `read_doc` returns up to 40 numbered lines
and 3000 content bytes per call. `next_line` supports progressive reading.
Search is lexical and can match generic words; absence of a match does not prove
absence across the repository. There are no embeddings or vector database.

## Host-enforced limits

- At most six model calls, eight tool calls, 10,000 cumulative retrieval-result
  bytes, 28,000 serialized input bytes, and 180 seconds per question.
- Each model call has a 60-second timeout; the provider output cap is 1024 tokens.
- The final available model call is reserved for tool-free synthesis. Exhausting
  tool calls also closes retrieval for the next invocation.
- The 32k served context includes an output reserve; the UTF-8-byte input bound is
  deliberately conservative and not an exact provider tokenizer. Tool schemas
  and protocol metadata count toward the host bound.
- Unknown tools, repeated identical requests, over-budget tool batches, invalid
  output and truncation have explicit terminal outcomes. Failed arguments consume
  the tool budget and return the schema constraints for correction.
- Malformed drafts remain recorded. At most one schema-constrained final synthesis
  can follow a rejected draft, inside the same six-call budget. During final
  synthesis the provider schema restricts citations to issued evidence IDs. This
  is visible in telemetry, not a silent rewrite or network retry. An initial
  answer without retrieval gets one explicit retrieval reminder. A timeout cancels our await;
  server-side resource release is not independently certified.

## Evidence and telemetry

The final JSON contains status, answer, citations and missing_evidence. An answered
result needs a citation. The model cites only evidence IDs such as `E1` issued by `read_doc`. The host
resolves each ID to the actual retrieved line range, path and pinned source revision.
The model never has to invent or reproduce line numbers. Unknown and duplicate
evidence IDs are rejected. Search snippets alone cannot support accepted citations. An insufficient_evidence result must describe the missing
information. Duplicate JSON keys and extra fields are rejected.

This validates **citation availability and source identity**, not whether the
answer logically follows from the quote. Factual correctness is reviewed separately;
a valid reference does not turn an agent's claim into a verified fact.

Each run writes:

- `sources.json`: recoverable snapshots of the eight allowlisted docs.
- `metadata.json`: dependency versions, model digest/capabilities, options, cases,
  code hashes and completion status.
- One case record: rendered messages and tool schemas, native tool requests,
  retrieved passages, final output, reference validation, finish metadata, available
  token counts, durations and host limits. Internal reasoning is not retained.

Records stay local. They include documentation excerpts and the entered question;
use suitable storage if later applying this to private material. Telemetry records
observations; no automatic learning or policy promotion is implemented.

## Reuse and source references

The approach builds on `../LangChain/lca-lc-foundations/course_model.py` (Ollama
model setup/context configuration) and its `notebooks/module-1/JR.py` invocation
example. We use explicit `ChatOllama` here to keep local-only configuration and
tracing behavior visible. The sibling `lca-langgraph-essentials` examples are a
reference for the later graph step, not a runtime dependency.

Official documentation checked 2026-09-26:
[ChatOllama and native tools](https://docs.langchain.com/oss/python/integrations/chat/ollama),
[LangChain agents](https://docs.langchain.com/oss/python/langchain/agents),
[Anthropic context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

The separate learning journal is in `D:\Git\ChatAgent-learning`.

## Live evidence

See [development findings](../../reports/doc-agent/findings-2026-09-26.md).
The final Gemma4 v4 run completed all four structural smoke cases. This includes
three sourced answers and one explicit insufficient-evidence result. Earlier
failed iterations are retained. This is development validation, not a model
ranking or held-out accuracy benchmark. The missing-cost answer still used
broader absence wording than its bounded retrieval justifies; that limitation is
recorded rather than scored as proof that all documents were searched.

## Optional canonical examples

The [comparison protocol](EXAMPLES-EVALUATION.md) describes the three-example
variant and `--compare-examples` command. The [12-run findings](../../reports/doc-agent/examples-findings-2026-09-26.md)
show one additional structural pass at 39.3% more input tokens. Examples remain
optional; the ordinary CLI retains the baseline. Seventeen offline tests pass.

Before extending model coverage or prompting experiments, follow the
[model-specific reference guide](../../docs/14-model-reference-guide.md).

## Observable planning experiment

[Protocol](PLAN-EVALUATION.md) and [eight-run findings](../../reports/doc-agent/plan-findings-2026-09-28.md) compare a brief proposed plan with host-recorded tool actions under shared budgets. This is opt-in and does not change the chat worker.
