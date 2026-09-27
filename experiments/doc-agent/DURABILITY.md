# Durable pause and resume for one documentation task

## 2026-09-27: independent task lifecycle

The [local task manager](TASKS.md) adds task IDs, status/list,
resume, and persisted cancellation around per-task checkpoints. Managed tasks
exclude paused time from their execution budget; the standalone durable CLI
retains its wall-clock policy. This supersedes earlier task-management next-step
notes. Conversation integration, admission control and scheduled triggers remain
future work; uncertain in-flight tasks are still refused.

`durable.py` adds a SQLite-backed wrapper around the existing LangGraph engine.
The ordinary loop and nonpersistent graph commands remain available. One database
owns one task. There is no multi-task scheduler or production chat integration.

## Try it

Install `requirements-durable.txt` in a dedicated Python environment. The existing
course environment was reused without modification for validation; missing SQLite
packages were placed in this experiment's ignored `.deps` directory. Those pinned
PyPI wheels were checked against their published SHA-256 hashes before extraction.
The wrapper supports that local directory as well as a normal pip installation.

```powershell
& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe experiments/doc-agent/durable.py start `
  --db experiments/doc-agent/my-task.sqlite `
  --question "Does ContextManager wait for a background summary?"

& D:\Git\LangChain\lca-lc-foundations\.venv\Scripts\python.exe experiments/doc-agent/durable.py resume `
  --db experiments/doc-agent/my-task.sqlite
```

Each invocation exits at a pause or terminal result. Run resume again for each
subsequent pause. The breakpoint is before a retrieval node (a batch of tool calls),
not a request for human authorization. The CLI fixes local Ollama settings and
verifies the installed model digest and server version when constructing the model.
No model download or cloud fallback exists. Start requires an unused task database;
resume takes its question and configuration from the saved task.

## Persisted state and budgets

Graph state now includes the document snapshot, retrieval counters, issued evidence
and initial wall-clock timestamp, alongside messages, events and model-call count.
Each node reconstructs its retrieval working state from the saved values. Successful
retrieval writes its updated counters and evidence back into graph state. Sources
are restored from the pinned snapshot, rather than reread from today's repository.

The SQLite manifest holds task identity, options, source snapshot, implementation
hashes, dependency versions, lifecycle status and latest result. Code or dependency
changes require an explicit migration; this slice refuses them. The checkpointer
saves graph state synchronously before the next node. A static `interrupt_before`
breakpoint saves progress before retrieval; invoking with None resumes it. This
uses static breakpoints, not dynamic interrupt()/Command(resume=...) semantics.

All original call and byte limits persist. The original 180-second deadline includes
paused time and process downtime. Resume does not grant a new budget. Expiration
is checked before model invocation and retrieval. Cross-process deadline accounting
uses the host wall clock, so reliable system time is assumed. Long user-driven pauses
will need an explicit different deadline policy in a future increment.

## Ownership and recovery boundary

An OS-released SQLite exclusive lock prevents two processes from advancing the same
task concurrently. The manifest is committed as running before graph execution.
Normal return records paused or completed after the checkpoint has been saved.

A restart after a confirmed pause is supported. Abrupt death while running leaves
uncertain state and is refused on resume, even if a checkpoint exists. This avoids
silently repeating an inference whose result may not have been committed. It is
not automatic crash recovery or exactly-once execution of external side effects.
The gap between checkpoint completion and manifest update intentionally fails closed.
The tools remain read-only. Completed tasks return their stored result without
repeating model or tool work. There is no automatic stale-task reset or migration.

Databases contain local documentation and telemetry; use trusted local checkpoint
files. SQLite files and local dependencies are ignored in the experiment directory.
No pruning/retention policy or encryption is added in this learning slice.

## Verification

33 offline tests pass. New checks use separate Python processes for start and
resumes, with original limits of three model calls and two tools. They finish with
exactly those counts and both E1/E2 evidence references. The model-call log has
one entry per expected invocation, and a completed-task resume performs no new work.
Other tests cover expiration before retrieval, uncertain-run refusal, duplicate
start, concurrent ownership, changed code and corrupt source-snapshot rejection.
The original loop/graph parity and cancellation tests still pass.

[Live Gemma4 evidence](../../reports/doc-agent/durable-findings-2026-09-27.md) records
four separate processes: three pauses followed by a supported answer within the
original budget. This does not simulate arbitrary power loss during inference.

References checked 2026-09-27: [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
and [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
