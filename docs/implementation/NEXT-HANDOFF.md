# Next handoff after the context review corrections

2026-09-25. Read this before starting another numbered implementation milestone.

## Completed checkpoint

CTX-01–04 are fixed with named regression evidence in
[01A review follow-up](01a-review-followup.md). Effective output limits are resolved
once; shared rendering covers task wrappers and separators; route instructions are
captured before budgeting; replay emits queued state and latest activity wins.
History also uses the latest refined answer. Existing snapshots remain unchanged.

Validation: 152 tests / 32 files, default parallel run, type checking, build,
fixture evaluation and seeded simulated benchmark comparison all pass. Live model
quality and cross-repository integration were not tested. No service restart was
performed. Local directory remains ChatAgent; GitHub repo/package is ChatRuntime.

## Next bounded task: runtime ownership ADR and protocol proposal

Before implementing 01B or additional shared provider/streaming paths, execute
steps 2–3 of [07 consolidation](07-shared-chat-runtime.md) as a design task.
This sequencing supersedes the original instruction to start the next numbered
code milestone immediately. Preserve all existing implementations.

1. Read Hekate and Iris root CHAT-CONSOLIDATION.md and applicable repo instructions.
   Check Git status; never include unrelated work in commits.
2. Trace Hekate's active llm-gateway/gods execution and chat/context-store paths,
   and Iris's actual chat clients versus reusable libraries. Record file/call-site
   evidence; do not assume legacy orchestration owns production execution.
3. Write an ADR with a recommended runtime/persistence owner, language/service
   boundary, standalone mode, project/account isolation, credentials boundary,
   versioning, migration/rollback and service-failure behavior. Explicitly compare
   hosting ChatRuntime independently against integrating its behavior into Hekate.
4. Propose request/event schemas and example fixtures for one Iris fast/deep turn.
   Map existing fields to conversation/message/task/attempt/event identities and
   terminal outcomes; specify idempotency, reconnect and cancellation. Retain
   CTX-01–04 and RES-01–08 acceptance contracts.
5. Reconcile 01B/02–06 with the chosen boundary: identify assets reused, adaptations
   needed, and one next vertical slice with concrete acceptance tests. Update the
   three repo notes with the ADR link and unresolved decisions. Commit only this
   design deliverable; no deployment or broad cross-repo rewrite in this task.

Definition of done: another implementer can locate the runtime owner, protocol,
entry points, compatibility strategy and tests for that single slice. Unverified
assumptions remain labeled; no claim of working integration from source inspection.

## Outstanding implementation, not part of the fixes

- 01B summaries/source lookup and restart persistence remain unimplemented.
- 02 streaming/cancellation/activity extensions remain planned. During integration,
  include typed terminal context-overflow handling instead of blindly retrying an
  unchanged provider request; existing generic deep retries do not meet that rule.
- RES-01–08 describe future resource admission/accounting, not enforced spending
  controls. Ollama/CLI names are not execution-location or billing evidence.
- No live provider tests, model-quality certification, cloud provisioning or CLI
  subscription activation occurred in this checkpoint.

Suggested task prompt: "Read docs/implementation/NEXT-HANDOFF.md and complete the
runtime-ownership ADR and protocol proposal only. Inspect actual Hekate/Iris call
paths, preserve unrelated work, map the next slice to named acceptance cases, and
update all three consolidation notes. Do not begin the runtime migration yet."
