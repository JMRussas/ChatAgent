# Multitask session evaluation

## 2026-09-30 application to the sports demo

The user selected [NBA briefings](18-nba-briefing-demo.md) as the concrete workflow.
Apply the session scenarios below to league/team work and follow-up questions;
the generic runner-first ordering is superseded by the demo's bounded source and
coordination slices. Keep these grading, fairness and evidence requirements. This
change does not make the sequential runner comparative or add concurrent workers.

Status: design v1, 2026-09-30. No session comparison has run. This is the next
spec 06 evaluation slice; the doc-agent experiment remains separate.

## Question and conditions

Does a responsive interaction layer manage several user intentions effectively
while deeper calls perform substantive work? Single-answer latency is secondary
to interaction availability, accurate coordination and completed useful tasks.
A clarification or truthful status response can be a successful layer 1 action
without completing a deep task.

| Condition                                 | Purpose                                                           | Availability                                               |
| ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Blocking single agent                     | Measures the benefit of allowing interaction during work          | Evaluation control to implement                            |
| Single agent with background work         | Controls for concurrency when assessing layered specialization    | Not implemented; do not substitute a blocking baseline     |
| Layer 1 with deep worker                  | Current layered architecture, one active deep job and queued work | Runtime exists; overlapping-session evaluation does not    |
| Layer 1 with multiple active deep workers | Tests concurrent deep execution and out-of-order completion       | Not supported by the current worker; separate runtime work |

The first comparison can establish an interaction-availability benefit, not prove
that specialized layers outperform every single-agent design. Start with a
synthetic capability test, then choose live bindings. Keep the same substantive
worker model, evidence and total session budgets where possible. A same-model
layered control can help separate scheduling benefits from model specialization.
Record all intended differences; never describe differing prompts/configurations
as identical. Streaming is useful but not required to test task coordination.
Claude's current final-only bridge cannot supply streaming first-token evidence.

## Seed sessions

Use fictional supplied evidence with checkable answers and no external retrieval.
Each row is a five-message session; A and B denote separate substantive tasks.
Cancellation endpoints are additional control actions, not user messages. These
six sessions provide 30 user messages and at least 12 deep-eligible task requests.
Exact prompts, references and accepted outcomes must be frozen before live runs.

| ID                        | Five-message sequence                                                                                                         | Main assertions                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MT-01 interaction         | Start A comparing supplied options; ask unrelated arithmetic; start B summarizing another excerpt; ask A status; ask B status | Quick answer while A remains active; accurate queued/running state; A/B results retain their identities                                                       |
| MT-02 correction          | Start A using budget 100; change A budget to 60; start unrelated B; ask which budget applies; request current task status     | Correction targets A; no claim that an immutable running call received it; old answer is not presented as satisfying the revised request                      |
| MT-03 cancellation        | Start A; start B; ask status; request cancellation of B; ask which task remains                                               | Separate natural-language handling from explicit endpoint cancellation; A unaffected; queued/running cancellation and late output checked in fixture variants |
| MT-04 result order        | Start long A; start short B; ask unrelated arithmetic; ask B status; ask for both results                                     | Results attributed correctly; serial queue behavior recorded honestly; B-before-A variant requires multiple active workers and is unavailable today           |
| MT-05 failure             | Start A; start B; ask A status after a controlled failure; ask unrelated arithmetic; ask final task status                    | Failure is visible; B and quick interaction remain usable; no fabricated success or duplicate retry result                                                    |
| MT-06 ambiguity/isolation | Start A; start similarly named B; say “change that to 60”; clarify “B only”; ask both statuses                                | Ambiguous target elicits clarification; A remains unchanged; revision belongs to B; an additional separate conversation supplies a leakage control            |

Correction handling is a capability probe. Accept an explicit limitation as honest
coordination, but mark requested revision completion unavailable/failed as applicable.
Do not silently cancel/restart through the test harness and credit the model with
performing that action. For endpoint cancellation, label it an explicit client
operation. Natural-language cancellation is a separate end-to-end requirement.
An intentionally cancelled task is not a completed substantive task; score correct
cancellation separately so it is neither a fabricated completion nor a system error.

## Scheduling and evidence

Build a separate versioned session action contract and runner; do not send this
plan to the sequential grounding-scenario CLI. Actions need stable IDs, session/task
references, submission order, trigger type, timeout and expected observations.
Use explicit submit, observe and cancel actions. Record scheduled and actual times,
trigger satisfaction and prerequisite failures. Correlate by IDs, never answer text.

Synthetic fixtures hold/release provider calls at explicit lifecycle barriers.
For example, hold A active, submit the quick question, verify its completion, then
release A. This proves overlap without sleep-based races. A barrier timeout is a
failed/unreached action, not a reason to omit the session. Continue independent
branches where safe; mark dependent actions blocked. Always perform bounded cleanup.

For live comparisons, freeze user-arrival offsets and deadlines before execution;
do not wait for each condition's answer before sending the next request. Otherwise
the faster system receives a different workload. Record whether actual overlap
occurred. Event-triggered stress tests are a separately labelled experiment, because
their arrival times depend on the condition. Do not select only sessions where a
provider happened to run slowly enough. Use the same initial history and user input
schedule; subsequent generated histories naturally differ and must be retained.

Persist run/session/action/task/turn/attempt identities, evidence and plan digests,
actual context snapshot identities where observable, configuration and code hashes,
queue/provider/terminal events, all user-visible answer phases and their hashes,
control acknowledgments and outcomes. Store no private reasoning. Reuse recorder
retention/redaction limits; missing or expired artifacts cannot support grading.
A cancellation acknowledgment is not proof the provider stopped or billing ceased.

## Grading and measures

Grade two dimensions separately; neither substitutes for the other.

| Dimension            | Code checks                                                                                       | Evidence-based answer review                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Layer 1 coordination | Task/result IDs, lifecycle transitions, overlap, cancellation scope, cross-conversation isolation | Accurate status, appropriate clarification, correct intent/target, honest correction limits, no unsupported completion claims |
| Deep work            | Expected structured outputs and fixture facts when checkable                                      | Correctness, groundedness, relevance and completion against the latest accepted task requirements                             |

Review every user-visible phase, including misleading early answers and obsolete
results. Model graders require supplied references, versioned rubrics and human
calibration; initial assistant review must be labelled as such. Existing final-answer
annotations alone do not establish coordination quality. Start with code checks
and exact-answer review; automated judge integration is a later bounded addition.

Measure per-action response and first-useful coordination latency while work is
pending; time to useful task result; task queue and execution durations; session
makespan; correctly completed tasks per elapsed minute; status/association errors;
revision/cancellation success; failures and timeouts. Record first-token latency
only where observable. Report p50/p95 with sample counts and individual session
results; three repetitions give exploratory, not robust tail estimates. Treat the
session as the experimental unit rather than 30 independent messages.

Count all attempts and abandoned/replaced work toward resource totals. Report
usage/cost as measured, estimated or unknown; never convert unknown to zero.
Budget failures and cancellations stay visible. Report planned, executed, blocked,
unsupported and graded coverage separately; unsupported capabilities cannot pass.
Task failures cannot be averaged away by responsive acknowledgments or good prose.

## Capability audit and implementation order

Current source inspection:

- `ChatOrchestrator.handleUserMessage` captures context before generation;
  corrections do not mutate an already captured task snapshot.
- `DeepWorker.runSingle` has a shared running guard: one deep job executes at a
  time. Multiple queued tasks are not multiple active deep calls.
- Message cancellation has a public endpoint; automatic natural-language task
  mutation/cancellation must not be inferred from that endpoint's existence.
- Browser tests already exercise an overlapping quick turn and deep answer, plus
  cancellation, but do not constitute a live multitask-quality comparison.
- `runLiveBenchmark` completes each prompt before advancing. Grounding scenario
  groups preserve history but remain sequential. Existing linked comparisons do
  not support multi-turn session comparisons.

Next implementation: add the action schema, deterministic overlapping-session HTTP
runner and fixtures for MT-01 and endpoint-driven MT-03. Demonstrate a quick turn
completing while A is held active, correct task attribution, bounded deadlines and
cancellation without affecting A. Preserve existing isolated comparison contracts;
new session evidence must be explicitly versioned and initially non-comparable.

Then add remaining supported scenarios and full phase/coordination grading. Document
revision handling and multiple-worker gaps before choosing whether to implement
those runtime capabilities. Add session-specific evidence linkage and compatibility
checks before any comparative claim. Select available model bindings and freeze an
experiment manifest with exact cases, budgets, deadlines, expected outcomes, warm/
cold conditions, shared-resource limits and grader identity. Run at least three
repetitions per supported condition with counterbalanced order. Publish failures,
unsupported conditions and costs alongside quality/latency tradeoffs. No winner is
presumed, and no account settings or live provider calls are required for this design.

Sports retrieval follows this self-contained session baseline; it adds temporal
source selection, tool correctness and freshness as separate dimensions.
