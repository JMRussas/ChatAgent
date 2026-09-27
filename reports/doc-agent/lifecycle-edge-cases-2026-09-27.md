# Lifecycle edge-case review

Expanded testing beyond model answer quality using deterministic fault injection,
controlled cancellation, separate processes and an actual killed worker. Five
implementation gaps were reproduced before fixes. The final suite passes **67
tests**: 51 documentation-agent tests, nine prompt-contract tests and seven
prompt-encoding tests. Eleven new tests are in `test_lifecycle_gaps.py`.

## Reproduced and fixed

| Gap | Before | Fix and regression evidence |
| --- | --- | --- |
| Invalid budgets | Zero/negative counts, NaN/infinite durations, boolean timeouts and unknown options entered the queue. | Validate supported options, positive integer limits and positive finite durations before writing a task. |
| Status transition race | A task finishing between the registry read and ownership probe could incorrectly appear uncertain. | Re-read lifecycle state under the acquired owner lock; if another owner acquired it, return the refreshed state. |
| Unsupported task version during cancellation | Cancellation modified the registry before status rejected its unknown schema version. | Validate version inside the cancellation transaction before mutation. |
| Provider ignores timeout cancellation | `asyncio.wait_for` could return the provider's late answer when it suppressed cancellation; stalled cleanup could also extend the await indefinitely. | Shared bounded invocation helper in both loop and graph stops waiting at the deadline, cancels the provider task and discards late completion. |
| Cleanup error during owner cancellation | Provider cleanup exception bypassed persistence of cancelled and replaced the caller's cancellation exception. | Preserve cancellation intent, record the cleanup error, persist cancelled and re-raise caller cancellation. |

The first three tests failed against the previous implementation. The late-response
and cleanup-error tests also failed before their fixes. Additional stalled-cleanup
coverage verifies that the deadline returns while provider cleanup remains pending,
then releases that provider deliberately to avoid leaving the test process hanging.

## Additional boundaries exercised

- A cancellation request wins over a successful result returned after cancellation;
  the late answer is not published.
- Registry persistence failure after the injected durable operation returns leaves
  uncertain work. Resuming is refused; this is simulated storage failure, not a
  physical full-disk test.
- A real child process announces entry to its model call, then is killed. A competing
  process is rejected while it owns the task; after death the lock is released,
  status becomes uncertain and automatic replay remains refused.
- Identical tool requests are still detected after a pause/resume. The second request
  does not execute or consume an additional tool call.
- Cancelling or advancing an already completed task returns its unchanged result.
- Model-factory failure produces a terminal failed task and is not retried implicitly.
- Existing tests continue to cover active-budget exhaustion, exclusion of paused
  time, independent tasks, evidence identities, source corruption and code/version
  mismatch across process restarts.

## Remaining boundaries

Timeout enforcement bounds the application's await, not the provider's execution.
An uncooperative provider may continue consuming resources after its result has
been discarded; this helper does not forcibly terminate a server or guarantee a
clean process shutdown for indefinitely stuck provider code. Synchronous blocking
Python code cannot be preempted by the event loop. Real disk corruption, operating
system power failure and every possible transaction interleaving are not certified.
Abrupt owner loss remains intentionally non-replayable; there is no recovery UI or
migration procedure. SQLite contention and GPU admission at larger scale remain
separate work.

No new live inference was needed to reproduce these lifecycle faults. Earlier
live reports retain their original source hashes and are historical evidence;
these fixes change implementation identity and therefore require migration for
older durable tasks. Production TypeScript and Hekate behavior are unchanged.
