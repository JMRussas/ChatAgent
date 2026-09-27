# 10 — Standalone documentation retrieval agent

## 2026-09-27: durable single-task checkpoint

[SQLite pause/resume](../../experiments/doc-agent/DURABILITY.md) now supports process restarts from confirmed
retrieval pauses, preserving sources, evidence and budgets. 33 offline tests and
a four-process local Gemma4 run passed. This supersedes earlier descriptions of
persistence as entirely future work; the ordinary graph engine remains optional
and nonpersistent. Arbitrary in-flight crash replay is refused. The next increment
is task lifecycle/scheduling around this unit, with explicit long-pause policy.

## 2026-09-27: explicit LangGraph learning slice

The [LangGraph workflow](../../experiments/doc-agent/LANGGRAPH.md) is implemented as an optional
engine, with the original loop retained for comparison. 29 offline tests pass,
including contract parity, invocation isolation and cancellation propagation.
This supersedes earlier text proposing graph translation as future work. The next
learning step is designing durable state and pause/resume; neither is implemented
by this invocation-local graph. Production runtime integration remains separate.

Status: standalone Python learning slice implemented. It uses LangChain's
ChatOllama, native message classes and structured tools. It does not change the
TypeScript application or add an explicit LangGraph workflow.

## Learning-first scope

The user's primary goal is learning and completing this assistant project.
Hekate is an optional reference, not an integration prerequisite. Existing
sibling LangChain/Ollama examples provide concrete patterns to build on:

- `LangChain/lca-lc-foundations/course_model.py`: model setup and context controls.
- `LangChain/lca-lc-foundations/notebooks/module-1/JR.py`: minimal local invocation.
- `lca-langgraph-essentials`: graph routing, parallelism, memory and interrupts.

The slice reuses the installed course environment without importing or modifying
its helpers. Explicit local-only configuration avoids inherited cloud defaults
and hosted tracing. A pinned requirements file supports independent setup.

## Behavior and boundaries

The agent begins with a small document index. It chooses `search_docs` and
`read_doc` calls to retrieve evidence from eight allowlisted Markdown documents.
The host loads a versioned snapshot, bounds reads and search results, and enforces
call, byte and time limits. No shell, arbitrary file access or write tool exists.

Markdown sections implement Task, Guidelines, Tool guidance, Response Framework
and Context. The model decides which evidence it needs; tool schemas and host
code enforce what it can request. Search uses lexical overlap, not embeddings.

Read results issue evidence IDs. The model cites IDs; the host resolves them
to actual retrieved line ranges and source hashes. Reference validation does not
prove that an answer follows from its sources. Local telemetry preserves model
requests, native tool calls, results, final outputs, usage, timings and validation.
No automatic learning or scoring of context correctness is implemented.

The explicit model/tool loop makes the mechanism visible before translating it
to LangGraph. This is an executable agent using LangChain primitives; it does not
use the higher-level `create_agent` harness or claim production orchestration.

## Validation and evidence

See the [runnable slice](../../experiments/doc-agent/README.md). Offline tests
cover allowlist scope, source snapshots, search/read behavior, budgets, evidence
IDs, invalid tools, repeated calls, deadlines, truncation and citation rejection.
Live smoke cases cover restart behavior, background summaries, model dispatch,
and an unsupported request for measured electricity cost.

Initial runs are retained even when they fail. They exposed schema-bound visibility,
retrieval overuse, guessed citation locations and output formatting problems.
These are development smoke checks, not a held-out model benchmark; fixes made
after observing failures must not be presented as an unbiased accuracy comparison.

Final validation: 15 offline tests pass. Gemma4 completed all four structural
smoke checks; manual review supports the three positive answers, with overly broad
absence wording in the unknown case. See the [development findings](../../reports/doc-agent/findings-2026-09-26.md),
including retained failures and the successful default CLI check.

## Next learning step

Once the slice's limitations are understood, represent the same steps explicitly
in a small LangGraph: model decision, bounded retrieval, final synthesis and
terminal outcomes. Preserve evidence and resource contracts. Connecting it to
the responsive conversation runtime and proving cancellation/isolation are
separate steps. No Hekate migration is required.

## Canonical examples comparison — 2026-09-26

Twelve local Gemma4 runs compared the same tools and schemas with and without
three fictional examples. Structural checks improved from 4/6 to 5/6, while
reported input tokens rose 39.3%; evidence coverage and absence wording remain
limited. Keep examples optional. See the [results](../../reports/doc-agent/examples-findings-2026-09-26.md).
The next framework-learning step remains LangGraph; a separate retrieval-quality
experiment should address missed sections before expanding the tool set.
