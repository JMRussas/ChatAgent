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
sends SIGTERM after five seconds and SIGKILL five seconds later if the child is
still running. Forced termination can leave uncertain work, which remains
non-replayable. The server close callback does not certify that the model server
released its GPU resources or that every Python operation drained.

### Bridge failure containment

Node reads the sidecar's stdout strictly:

- Lines are split on the newline byte, so multibyte characters may cross chunk
  boundaries.
- A line, complete or not, may not exceed 1 MiB. The limit is checked before
  bytes are buffered, and an unfinished line is copied into one buffer capped at
  that size.
- Each line must be valid UTF-8 JSON of exactly `{id, result}` or
  `{id, error: CODE}`, where `id` is a positive integer and `CODE` matches
  `[A-Z][A-Z0-9_]{0,63}`.
- A reply for a request that already timed out is dropped once. The bridge
  remembers the last 64 such ids. Any other unknown or repeated id is a protocol
  failure.

The bridge fails in the following cases:

- a protocol failure, including a line that is too long, malformed JSON, invalid
  UTF-8 or an unknown id;
- a stdin or stdout error;
- stdout ending or closing while the bridge is up, even if the child is still
  alive or a line is unfinished;
- a child error;
- an unexpected exit. A failed spawn counts as exited when it closes.

On failure the bridge stops reading at once and settles every pending request
exactly once. Then it closes stdin, sends SIGTERM, and sends SIGKILL after five
seconds unless the child has exited. It reports itself down only once the child's
exit is confirmed. A bridge never spawns a replacement and never re-sends a
request. Only an operator restart starts a new child (see
[operator restart](#operator-restart)); automatic recovery is separate later work.

What an unanswered request reports:

- **Not handed to stdin:** `BRIDGE_UNAVAILABLE`. A write that only fills the stdin
  buffer still counts as handed over.
- **`list` or `status`:** `BRIDGE_UNAVAILABLE`, or `BRIDGE_TIMEOUT` on a timeout.
- **`start`, `resume` or `cancel`:** `BRIDGE_UNCERTAIN`. HTTP answers
  `503 {code, op, uncertain: true}` with an operation-specific message, and with
  no `Retry-After` and no retry advice. The sidecar records a started task and its
  request binding in separate transactions. A crash between them leaves a durable
  task with no binding, so resending the same `requestId` is not proven to avoid
  a duplicate. Making this idempotent is deferred reconciliation work.

### Request admission

Requests are written to stdin as pure ASCII JSON: every non-ASCII UTF-16 unit is
escaped as `\uXXXX`, so a surrogate pair becomes two escapes and existing escapes
are left as they are. One character is then one byte, whatever encoding Python
uses to read stdin. Python 3.13 on Windows may read a pipe with the locale code page
unless UTF-8 mode is enabled, so unescaped UTF-8 could otherwise reach the sidecar
altered.

The sidecar refuses an input line longer than 16000 characters, newline included,
and its refusal carries no request id. Node therefore checks the line it would
send, including the newline and the digits of the id it would assign, against
16000 bytes. A longer request is refused with `REQUEST_TOO_LARGE` (HTTP 413)
before an id, timer or write is spent, and the healthy child is untouched. The
current HTTP schema cannot produce such a line, so this is a defensive bound.

When a write reports a full stdin buffer, the request still counts as handed over
and the bridge stops admitting work. New requests are refused with `BRIDGE_BUSY`
(HTTP 503, `Retry-After: 1`) before they are serialized, numbered or timed, so
resending them is safe. Only the next `drain` of the same child reopens
admission, once per full buffer. Timeouts never reopen it. A failure or close
removes the drain listener, so a late drain cannot revive a bridge that is down.
Nothing is replayed, and a written request keeps its timeout or uncertainty
semantics.

Queued request bytes are therefore bounded by the stdin buffer's high-water mark
plus one request of at most 16000 bytes, and at most 32 requests are pending.

### Operator restart

`DocumentTaskSupervisor` (`src/app/documentTaskSupervisor.ts`) is the stable
document-task service the server uses. It runs one sidecar bridge per numbered
generation. Each generation is a separate child with its own request ids, timers,
stream buffers and drain listener, so nothing an earlier child does can reach a
later one. A failed generation is never revived. The server fixes the Python
path, script, store root and model once at startup, so a replacement always opens
the same store with the same configuration.

Readiness. A new generation answers no requests until the sidecar's `health`
command returns exactly `{"service":"chatagent-document-tasks","protocol":1}`.
The sidecar takes its `bridge.owner` lock before reading input and opens its
store on the first request, so this answer proves both. `health` reads no scope,
calls no model, and neither lists nor reconciles task state; the HTTP client
schema cannot send it. The deadline is 5 seconds. A timeout, another payload or
an error reply terminates that child, which is kept until its exit is confirmed.
A child that fails on its own (spawn error, exit, closed output, or the owner
lock held by another sidecar) is never ready either. A factory that throws is
recorded as `SPAWN_FAILED` without a child. A failed startup stays failed until
an operator restarts it; nothing restarts unattended.

Operator routes. Both are operator-only and answer 404 when document tasks are
disabled.

- `GET /workers/document-tasks/status` returns
  `{status: {phase, generation, restartable, failureCode}}`. The phases are
  `starting`, `ready`, `stopping` (failed, exit not yet confirmed), `failed`
  (exit confirmed) and `closed`. `failureCode` is a fixed internal code such as
  `CHILD_EXITED`, `STDOUT_CLOSED`, `HEALTH_TIMEOUT` or `SPAWN_FAILED`. It
  never carries a path, process id or raw error.
- `POST /workers/document-tasks/restart` takes exactly
  `{expectedGeneration: <positive safe integer>}`. Only a `failed` generation
  of that number is replaced. A stale number gives 409 `STALE_GENERATION`; a
  starting or ready generation, 409 `NOT_FAILED`; a generation whose child has
  not confirmed its exit, 409 `NOT_EXITED`. These refusals spawn nothing and
  never stop a running child. Server shutdown gives 409 `CLOSED`, possibly after
  a replacement had started. A replacement that does not become ready gives 503
  `STARTUP_FAILED`. Only a ready replacement gives 200. A successful restart and every
  refusal above include the current status; validation, authentication and
  disabled responses do not.

The checks and the spawn run without yielding, so concurrent restarts with the
same number spawn at most once; the others are stale. Shutdown is permanent: it
settles a pending restart at once, clears the readiness deadline, closes the
current child and keeps it until it exits. A readiness answer that arrives later
promotes nothing.

A restart replays nothing. The replacement opens the same owners, bindings and
checkpoints. A paused task stays paused and unscheduled, and a task abandoned
while running is reported `uncertain` and is not resumed. Reconciling or
abandoning such tasks is later work.

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
