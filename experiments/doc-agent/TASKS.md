# Independent documentation tasks

Latest lifecycle review: [edge-case findings](../../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) records
five reproduced fixes and 67 passing offline tests, including a killed worker,
late provider completion, cancellation races and failed persistence. Historical
live-run hashes predate these fixes; old durable tasks still require migration.

`task_manager.py` provides submit/start, status, list, resume and cancellation around
the durable graph. Each task gets a random ID and a separate checkpoint database.
A shared SQLite registry records lifecycle state. Different tasks can advance in
parallel; an exclusive owner lock prevents duplicate execution of the same task.

This is a local task-management component. It has no scheduling daemon, automatic
resume, future-time trigger, admission queue or production chat endpoint. The CLI
runs one task until its next retrieval pause or terminal result, then exits.
The Python API supports `asyncio.gather(manager.advance(a), manager.advance(b))`.
Concurrent model awaits do not guarantee that Ollama executes inference in parallel.

## Run

Use the same isolated `uv` dependencies as [durable tasks](DURABILITY.md), from
the repository root. The PowerShell example stores the common runner arguments;
in WSL with the Windows installation use `uv.exe` for the equivalent invocation.

```powershell
$uvArgs = @('run', '--no-project', '--isolated', '--no-env-file', '--python', '3.13.13', '--no-python-downloads', '--with-requirements', 'experiments/doc-agent/requirements-durable.txt', 'python')
$script = 'experiments/doc-agent/task_manager.py'
$taskRoot = 'experiments/doc-agent/tasks'
$a = & uv @uvArgs $script --root $taskRoot start --question 'Does ContextManager wait for a new background summary?' | ConvertFrom-Json
$b = & uv @uvArgs $script --root $taskRoot start --question 'Does an SSE disconnect cancel generation?' | ConvertFrom-Json
& uv @uvArgs $script --root $taskRoot list
& uv @uvArgs $script --root $taskRoot resume $b.task_id
& uv @uvArgs $script --root $taskRoot status $a.task_id
& uv @uvArgs $script --root $taskRoot cancel $a.task_id
```

Repeat resume when the selected task reports paused. A fresh process uses the same
root and task ID. Python `submit` only queues a task; `advance` runs it. CLI start
combines both. Status includes the last saved checkpoint result, not live token
streaming or current in-flight usage. Model configuration and sources are pinned
by the underlying durable task. Schema, dependency and code compatibility guards
remain in effect. Earlier task databases are not automatically migrated.

## Lifecycle and cancellation

- queued: submitted and not yet advanced.
- running: an owner is advancing the task.
- paused: saved before the next retrieval batch.
- completed: accepted final result.
- failed: model/validation/budget failure or an execution exception; no automatic retry.
- cancel_requested: another caller requested cancellation while an owner was running.
- cancelled: queued/paused work was cancelled, or its running owner acknowledged it.
- uncertain: a task recorded running/cancel_requested has no owner lock; replay is refused.

Queued and paused tasks cancel immediately. Running owners poll the persisted
request at 50 ms intervals and cancel the graph await. A cancel request that wins
the registry transaction prevents publication of a racing final answer. Cancelling
a completed task leaves its result unchanged. Cancelled tasks cannot resume.
Cancellation of the owning Python coroutine is persisted and propagated.

This does not certify that Ollama releases server-side resources immediately.
Synchronous metadata HTTP checks run in a worker thread; cancelling their await
cannot forcibly stop that thread. No model inference is started from a discarded
metadata result. Abrupt owner loss still fails closed, rather than inferring that
an in-flight model call or side effect did not happen. No administrative recovery
or reset command is provided.

## Time policy

Managed tasks select `deadline_mode=active`. The default 180 seconds applies to
cumulative graph execution time, measured with a monotonic clock within each run
and saved in graph state between runs. Queued time, paused time and process downtime
do not consume this budget. Model calls and retrieval bytes remain cumulative.
The original durable CLI retains its wall-clock policy for compatibility.

Active elapsed time is checkpointed at node boundaries. It includes model/tool
work and intervening graph execution, but excludes model factory setup before the
graph starts and the checkpoint flush/driver work after the last tracked node.
It is an execution budget, not a full end-to-end latency or resource-cost measure.
Uncertain crashes are refused, so an unfinished segment cannot receive a fresh
budget through automatic replay. No separate calendar expiration is implemented.

## Verification and boundaries

Tests cover simultaneous active model awaits, cancellation isolation, caller
cancellation propagation, duplicate owners, queued cancellation, active-time
expiration, exclusion of paused wall time, and separate-process resumption.
The deterministic demonstration finishes task B while A remains paused, then
resumes A in another process, with both tasks retaining exactly three model calls,
two tools and independent evidence IDs.

See [the recorded results](../../reports/doc-agent/manager-findings-2026-09-27.md).
Next: connect task lifecycle/status to a responsive conversational interface, with
explicit admission/concurrency policy and optional scheduling. This component alone
does not implement the larger assistant orchestration or improve retrieval quality.

Model invocation now bounds its await independently of provider cancellation
cleanup. Late responses cannot publish task results, but provider computation may
continue; no server-resource-release guarantee is made.
