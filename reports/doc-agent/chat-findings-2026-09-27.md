# Conversation task integration — 2026-09-27

The opt-in chat integration successfully delegated documentation work through
Node → Python → LangGraph → local Ollama while the HTTP server continued serving
foreground requests. This is an integration check, not a model comparison.

## Live evidence

[Raw requests and responses](chat-v1-2026-09-27/results.json) were produced by
`experiments/doc-agent/chat_smoke.ts` with local `gemma4:26b`, a fresh task root,
an ephemeral HTTP port and mock foreground providers.

| Check | Result |
| --- | --- |
| First task admission | HTTP 202, about 1,137 ms including initial sidecar/model metadata setup |
| Duplicate start | Same task ID, HTTP 202 |
| Second task | Queued, then cancelled with zero model/tool calls |
| Foreground message during background work | HTTP 200, about 4 ms with mock providers |
| Different user's task access | HTTP 409 |
| First task completion | Answered with a citation to `docs/implementation/01b-evidence.md:1–40` |
| Completed task counters | Five model calls, three tool calls |

The completed answer correctly states that foreground processing does not wait
for a newly generated background summary. Cancellation of the second task did not
prevent the first from completing. These are single-run observations, not latency
percentiles or a general quality score. Runtime databases remain ignored by Git.

## Automated verification

- TypeScript type check and build passed.
- All 247 TypeScript tests across 43 files passed; see
  [test output](chat-v1-2026-09-27/tests.txt).
- All 54 Python documentation-agent tests passed. The three bridge tests also
  passed after strengthening the single-background-slot assertion.
- Prototype evaluation and benchmark comparison passed. The saved benchmark
  uses `simulate` mode with seed `default-v1`; it is not live model evidence.
  See [evaluation](chat-v1-2026-09-27/prototype-eval.md),
  [benchmark](chat-v1-2026-09-27/benchmark-summary.json) and
  [comparison](chat-v1-2026-09-27/benchmark-compare.md).

The first full TypeScript run encountered an unexpected test-worker exit after
242 passing tests. A complete rerun with `--maxWorkers=2` passed all 247. The
worker-exit cause was not established; the successful rerun does not explain it.

New tests cover duplicate/conflicting requests, conversation isolation, admission
capacity, queued cancellation, serialized background inference, persisted scope,
listing without claiming ownership, completion projection, subprocess exit and
timeout, and foreground HTTP handling while a task command is pending.

## Limits and next checks

Actual browser interaction remains untested; generated script syntax and safe
text rendering are checked offline. Foreground inference was mocked, so this
does not establish responsiveness when foreground and background models share a
GPU. Next validate the browser flow, then measure shared inference contention
before adding priority/admission policy across providers.

The integration is disabled unless `DOC_TASK_PYTHON` is set. It admits eight
background jobs and executes one at a time. Completed results appear in a task
panel; selecting evidence for subsequent chat context remains a separate design
step. Setup and operational limitations are in the
[implementation guide](../../docs/implementation/11-conversation-tasks.md).
