# 11 — Optional conversation-scoped documentation tasks

The chat server can now delegate a documentation question to the local Python
LangGraph worker while continuing to handle foreground messages. This is explicit
user-triggered work, not automatic agent routing or a scheduled-task service.

## Enable and use

Use `uv` to manage a dedicated environment from the repository root with Python
3.13.13. If needed, first run `uv python install 3.13.13`; subsequent commands
disable implicit interpreter downloads. In WSL with the Windows installation,
invoke `uv.exe` and select Windows interpreter paths when Node runs on Windows.

```bash
uv venv --python 3.13.13 --no-python-downloads .venv
uv pip install --python .venv/bin/python -r experiments/doc-agent/requirements-durable.txt
```

On Windows, use `.venv/Scripts/python.exe` for the install command's `--python`
argument. The existing runtime starts that interpreter directly; activation and
a launcher rewrite are unnecessary. The existing direct dependency pins remain
unchanged; installation resolves transitive dependencies rather than treating
these requirements as a complete lockfile.

Ollama must already be running locally on port 11434 with the selected model
installed. Published runs used `gemma4:26b`; the worker verifies tool support,
thinking=false, context capacity and model identity. It does not download models.
Check model memory requirements before running it on another machine.

Set these variables before starting the server. PowerShell:

```powershell
$env:DOC_TASK_PYTHON = (Resolve-Path '.venv/Scripts/python.exe').Path
$env:DOC_TASK_ROOT = 'data/document-tasks'
$env:DOC_TASK_MODEL = 'gemma4:26b'
npm run dev
```

Bash:

```bash
export DOC_TASK_PYTHON="$PWD/.venv/bin/python"
export DOC_TASK_ROOT=data/document-tasks
export DOC_TASK_MODEL=gemma4:26b
npm run dev
```

The Python executable must run on the same OS as Node (Windows Node requires
Windows Python paths). Omitting DOC_TASK_PYTHON leaves the feature disabled.
Foreground chat still uses its separately configured providers; enabling this
worker alone does not switch foreground mock responses to live inference.

In the composer, enter a documentation question and choose **Run documentation
task**. **Send** remains available for ordinary chat. The conversation's task panel
polls status, displays answers with source references or failures, and offers
Cancel. After a restart, previously queued/paused unscheduled tasks offer Resume.
Question and answer text are rendered using textContent, not HTML.

## Contract and ownership

`POST /document-tasks` accepts `op` (start/list/status/resume/cancel), conversationId
and userId. Start also requires a UUID requestId and question. Status/resume/cancel
require taskId. Start/resume return 202; other successful operations return 200.
Admission failure returns 429, ownership/request conflicts 409, unknown tasks 404,
and bridge failure 503. Invalid fields return 400. Reusing requestId with the same
conversation/question returns the existing task; conflicting reuse is rejected.
Clients retrying an uncertain start must reuse the original requestId, or inspect
list before creating another task. The UI does not automatically retry starts.

ChatService applies its existing owner guard. The sidecar also persists conversation
owners and task bindings and checks them on every command. List on an empty
conversation does not claim an owner. This is the prototype's client-supplied userId
ownership guard, not authentication. Task completions appear in a dedicated panel;
they are not inserted into the conversation timeline or LLM context automatically.

## Execution and admission

Node starts one optional Python sidecar using argument arrays and JSON-lines stdin,
without a shell. Requests have a 30-second response deadline and at most 32 pending
bridge commands. Python starts inference asynchronously after acknowledgement,
automatically advancing ordinary retrieval pauses to a terminal result.

The sidecar admits at most eight scheduled tasks and executes one background task
at a time. Each task retains independent execution, call and retrieval budgets.
Cancelling queued work frees admission capacity; cancellation of running work is
persisted. One sidecar owns a task root. The root stores task/checkpoint databases
and durable conversation bindings and is ignored by Git.

This slot limit applies to documentation work only. It does not coordinate the
existing fast/deep providers or guarantee low foreground model latency if both
use the same GPU. HTTP responsiveness and GPU scheduling are different concerns.
There are no timed triggers, distributed workers or automatic uncertain-crash replay.

On orderly server closure, stdin closes and the sidecar cancels its jobs. Node
allows five seconds before terminating it. Forced termination can leave uncertain
work, which remains non-replayable. The server close callback does not certify that
the model server released its GPU resources or that every Python operation drained.
Bridge exit rejects pending requests without automatically starting another worker.

## Verification

See [integration evidence](../../reports/doc-agent/chat-findings-2026-09-27.md).
The live check uses an actual HTTP server, Node/Python subprocess transport and
local Ollama for background work, with mock foreground providers. It verifies a
completed sourced answer, independent cancellation, duplicate-request identity,
owner rejection and foreground response. It is not a shared-GPU latency benchmark.
A later [real-browser and shared Ollama check](../../reports/doc-agent/browser-contention-findings-2026-09-27.md)
verified start, foreground Send, queued cancellation, sourced completion and scope
switching in headless Chrome. It also fixed a tsx-generated helper missing from the
embedded turn renderer. A small live foreground probe measured a 295 ms baseline
median versus 888 ms while background work ran; this is not a p95 or broad latency
guarantee. Restart/resume and reconnect browser scenarios remain untested.

The [controlled timing follow-up](../../reports/doc-agent/contention-findings-2026-09-28.md)
now measures application admission and first-answer latency. It did not justify
enabling the experimental priority policy. Next: evidence-quality evaluation before
selecting completed-task evidence for conversational context.
