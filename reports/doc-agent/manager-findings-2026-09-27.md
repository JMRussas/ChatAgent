# Independent task manager validation

Implemented task IDs, a shared lifecycle registry, per-task checkpoint databases,
status/list, resume and persisted cancellation. Managed tasks use cumulative active
graph time, excluding pauses and downtime. The standalone durable CLI retains its
wall-clock deadline. No production TypeScript behavior or dependencies changed.

## Deterministic verification

**56 offline tests pass:** 40 documentation-agent tests, nine prompt-contract tests
and seven prompt-encoding tests. The six new task-manager tests cover:

- Two simultaneous model awaits; cancelling one leaves the other running.
- Cancellation of the owning coroutine persists cancelled and propagates cancellation.
- Queued cancellation, invalid task IDs and uncertain owner loss.
- Exclusive execution ownership for the same task.
- Excluding paused wall time while enforcing cumulative execution time.
- Task B finishing while A remains paused, followed by a new process resuming A.

The last case uses a three-model-call/two-tool budget for each task. Both complete
with exactly those totals and separate E1/E2 evidence. Model-call logs verify each
expected call occurs once. Recorded deterministic demonstration artifacts:
[before restart](manager-v1-2026-09-27/demo-start.json) and
[after restart](manager-v1-2026-09-27/demo-resume.json).
These use scripted models and do not measure LLM answer quality.

## Live local Gemma4 check

[Process records and summary](manager-v1-2026-09-27/summary.json) preserve a separate
live run; [metadata](manager-v1-2026-09-27/metadata.json) records model identity,
dependency versions, code hashes and source snapshots. Each CLI operation ran in a
fresh Python process. Both tasks initially paused, then B was advanced while A's
record remained unchanged, and A was resumed afterward.

| Task | Outcome | Model calls | Tools |
| --- | --- | ---: | ---: |
| A: background summaries | Completed with supported citation | 5 | 3 |
| B: SSE disconnect | Failed output validation: answered without citations | 3 | 1 |

B searched but did not read a passage before answering. The existing evidence
validator rejected its final output. Its lifecycle became failed; A remained
paused, then completed independently. This live run demonstrates failure isolation
and process resumption, not two successful LLM answers. The deterministic test
provides the controlled two-successful-task demonstration. Failed live records
were retained rather than retried until success.

Both live tasks stayed within their original call/byte budgets. A's accepted
citation resolves to a saved read result. Its claim that the foreground does not
wait for a new background summary is supported by that passage. Raw task databases
and owner locks remain local and ignored; JSON evidence is reviewable.

## Limits and next step

This component advances tasks on explicit calls; it is not an unattended scheduler.
Status reports the last persisted result, not current token usage. Cancellation
stops the local graph await, without certifying immediate Ollama resource release.
Task-level concurrency does not guarantee parallel inference on the model server.
Uncertain owner loss remains non-replayable. Execution-time accounting excludes
model-factory setup and final checkpoint/driver overhead, and has no separate
calendar expiration. Long-lived task retention and GPU admission are future work.

Next: connect this lifecycle API to a responsive conversation/status interface and
define admission policy before adding autonomous scheduling or timed triggers.
See [run instructions and design](../../experiments/doc-agent/TASKS.md).
