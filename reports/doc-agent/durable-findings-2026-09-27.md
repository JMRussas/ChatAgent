# Durable task validation

Implemented SQLite checkpoints and a persistent task manifest for one local
read-only documentation task. Confirmed pause boundaries survive process restarts.
Unexpected in-flight crashes are explicitly refused rather than automatically replayed.

## Executed evidence

33 offline tests pass. The fresh-process test starts under a three-model-call and
two-tool budget, pauses before each of two reads, then finishes with both saved
citation IDs and exactly three model calls/two tools. A fourth invocation returns
the completed result without additional model calls. Separate checks cover expired
deadlines, concurrent owners, duplicate starts, uncertain lifecycle state,
implementation changes and snapshot corruption. Prior reference-loop parity tests
remain passing.

A live Gemma4 question about nonblocking background summaries ran across four
separate Python processes:

| Process | Outcome | Cumulative model calls | Cumulative tool calls |
| --- | --- | ---: | ---: |
| [0](durable-v1-2026-09-27/process-0.json) | Paused before retrieval | 1 | 0 |
| [1](durable-v1-2026-09-27/process-1.json) | Paused before retrieval | 2 | 1 |
| [2](durable-v1-2026-09-27/process-2.json) | Paused before retrieval | 3 | 2 |
| [3](durable-v1-2026-09-27/process-3.json) | Completed | 5 | 3 |

The final answer correctly says the foreground does not wait for a new summary,
with citations to the design and implementation passages. It used 8,636 retrieval
bytes under the original 10,000-byte budget, five of six model calls and three of
eight tools. Its two read results retain E1/E2 identities across restarts. Final
synthesis still follows the existing bounded draft-rejection policy.

The [exported manifest](durable-v1-2026-09-27/manifest.json) records the pinned sources,
model digest, Ollama version, dependency versions and implementation hashes. Raw
SQLite files remain local and ignored; JSON records preserve reviewable evidence.

No sibling environment was modified. Three missing packages were installed locally
from SHA-256-verified PyPI wheels in ignored `.deps`: langgraph-checkpoint-sqlite
3.1.1, aiosqlite 0.22.1 and sqlite-vec 0.1.9. Requirements for an independent normal
installation are pinned in requirements-durable.txt.

During implementation, tests caught unclosed SQLite connections on Windows and
an installed LangGraph error when synchronous durability was requested without a
checkpointer. Connections now close explicitly, and synchronous durability is only
requested for checkpointed runs. The final 33-test run passes.

## Limits

The original deadline includes paused time and downtime. This is restart from a
confirmed pause, not arbitrary crash replay, unlimited human wait, a scheduler or
production multi-user orchestration. Durable resumption of side-effecting tools
would need a stronger transactional/idempotency design. No production TypeScript
runtime or Hekate code changed.

[Run instructions and design](../../experiments/doc-agent/DURABILITY.md).
