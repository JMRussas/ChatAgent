# LangGraph translation validation

The optional LangGraph engine preserves the reference loop's tested contracts.
29 offline tests pass: 17 existing tests, nine existing agent contracts exercised
against the graph, and three graph tests for trace parity, concurrent isolation
and cancellation propagation. The parity test checks nine scripted scenarios and
compares normalized requests, tool events, budgets, errors and answers. Timings
and graph-only fields are excluded.

The existing Windows course environment already had LangGraph 1.2.6. No packages
were installed or upgraded. The runner now records the selected engine and
LangGraph version. Production TypeScript code was not changed.

## Live validation

[Run metadata](langgraph-v1-2026-09-27/metadata.json) and
[source snapshot](langgraph-v1-2026-09-27/sources.json) preserve the local Gemma4
configuration, model digest, code hashes and documentation used. The run used the
baseline prompt, without examples, and the original four smoke questions.

| Case | Structural checks | Model calls | Tool calls |
| --- | --- | ---: | ---: |
| [Restart](langgraph-v1-2026-09-27/restart.json) | Pass | 5 | 3 |
| [Memory](langgraph-v1-2026-09-27/memory.json) | Pass | 4 | 2 |
| [Routing](langgraph-v1-2026-09-27/routing.json) | Pass | 4 | 2 |
| [Unknown cost](langgraph-v1-2026-09-27/unknown.json) | Pass | 6 | 3 |

A post-run audit confirmed the snapshot checksum, metadata completion, call/byte
limits and resolution of every accepted citation to an issued read result. Manual
review supports the three positive answers against their cited passages. The cost
answer declined to invent a number, but still made a broader claim about absence
from documents than bounded retrieval supports. All cases used the bounded final
synthesis after a rejected draft. Four structural passes do not mean four fully
verified factual answers.

This is a smoke check, not an accuracy or speed comparison with the earlier loop
run: the document snapshot has changed since that run. Deterministic parity tests
provide the controlled comparison of execution behavior. The graph does not fix
retrieval selection or output-format tendencies.

## Scope

Nodes explicitly represent model invocation, validation and retrieval. Final
synthesis is the model node's tool-free mode. Node traces are separate from the
model context. There is no checkpointing, process-restart recovery, durable
scheduler, interrupt/resume UI or production runtime integration.

Retrieval counters, issued IDs and source snapshots must be incorporated into a
durable-state design before checkpoint-based resumption can be claimed. Fake-model
cancellation does not certify server-side Ollama resource release.

See [implementation and run instructions](../../experiments/doc-agent/LANGGRAPH.md).
