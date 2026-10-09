# Archived Hekate branch dispositions

Eight archived branches yield **one Keep, three Extract and four Retire decisions**. Only three bounded implementation checkpoints are justified. No old branch needs to return to GitHub.

Keep preserves useful behavior for adaptation. Extract preserves selected code or design ideas. Retire closes consolidation work; the verified local archive still preserves every tip and PR record.

The machine-readable [decision record](23-archived-hekate-branch-dispositions.json) contains exact refs, assessment task IDs, source findings, subchange decisions and follow-up acceptance criteria.

| Branch                              | Decision | Reason                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas-ui`                         | Extract  | Retain graph/layout and inline task-detail ideas as design reference. The archived React Flow dashboard projects the legacy ledger and collapses review/cancellation states; restoring it would give misleading execution status.                                      |
| `chore/sisyphus-cleanup`            | Extract  | This 165-file branch mixes distinct features and older implementations. Extract checkpoint observability and quota lessons; discard wholesale restoration and duplicate chat ownership.                                                                                |
| `docs/pr-workflow-policy`           | Retire   | The one-file policy patch contains dated PR workflow instructions. Current explicit user authorization and maintained repository instructions govern delivery; this decision does not prohibit a future PR workflow.                                                   |
| `feat/csharp-partial-support`       | Extract  | Partial type/method preservation is absent from published decomposition/generation. Extract the narrow semantics with compiler regressions; newer finalization/outbox code makes the old service/schema edits unsafe to restore wholesale.                             |
| `feat/image-gen-multi-arch`         | Retire   | Modular image/LoRA/video/ComfyUI work is a separate optional capability. It does not advance checkpoint management or executive observability. Retire it from the active MVP backlog while preserving the archive; no code-quality or runtime failure claim is made.   |
| `feature/claude-code-executor`      | Retire   | The published source already contains the executor, CLI provider, discovery, quota and verification modules, with later prompt/workspace/MCP changes. The context client circuit-breaker core is already preserved. No missing delta requiring a port was established. |
| `fix/list-tasks-include-deps`       | Keep     | The two-file patch addresses a confirmed published Gods list_tasks omission: its frontend contract expects depends_on/tools. Keep this behavior as a narrow adapted patch, not the branch itself. The managed PlanStore API is a separate ledger.                      |
| `orch/retry-diagnosis-before-retry` | Retire   | The archived sentinel reasoner is absent from published main; current Odin handlers already implement diagnosis and bounded retry transitions. The archived invalid-fix fallback retries as-is, which is not a suitable checkpoint escalation policy.                  |

## Implementation priority

These are implementation proposals, not completed features. The original eight tasks are source assessments and can close once this artifact passes its external checks. New checkpoints retain their own test and review gates.

### P1 — Expose finite checkpoint continuation phases and attention inline

Repository: **ChatAgent**. Hekate task: `84290f4f-29bd-527a-a1e6-a6c36037ee13`.

- Project current durable continuation states into executive summary and existing inline detail: reserved, running, snapshotting, verifying, review_pending and needs_operator; do not infer active work from task status alone.
- Retain exact task, attempt, content and source fences; display missing or stale evidence as unknown. Bound timeline retention and expose only sanitized metadata.
- Verify stale-attempt and source-change races, absent records, verifier failure, review pending and stopped-worker cases. No new AI call, automatic retry, next-task claim or separate navigation is required.

### P2 — Adapt Gods task-list dependency and tools projection

Repository: **Hekate**. Hekate task: `f9bd68e5-40d9-594f-b5f6-2840b3ce0efe`.

- Reproduce the published Gods GET /tasks/project/{projectId} dependency/tools omission against its maintained frontend consumer; keep the managed PlanStore contract separate.
- Return dependency IDs through a bounded bulk query and validate tools as a string array. Agree field scope with the consumer; do not add raw outputs or errors to the default list response without a separate requirement.
- Test dependency isolation, empty results, malformed and non-array tools JSON, project/status filters and query behavior. Run relevant maintained Python tests with uv.

### P2 — Preserve C# partial modifiers and declaration-only methods

Repository: **Hekate**. Hekate task: `58d1d46d-17bf-52f2-a7f0-521bc970bba2`.

- Reproduce loss of partial type and method modifiers in committed decomposition/generation source. Add compiler-backed round-trip fixtures including declaration-only and implemented partial methods.
- Adapt only the modifier and declaration semantics. Preserve current shared finalization, graph synchronization/outbox and file identity; do not restore the archived CodeService or schema wholesale.
- Verify both file and source decomposition entry points, parse/regenerate/compile behavior and relevant current tests. Do not restore personal seed scripts or overwrite unfinished local work.

Quota and reservation work stays in existing CA-ISSUE-008/009 tasks. The archived token bucket is only reference material; it does not settle provider quota, restart or spend authority. Canvas layout/inline interaction and semantic-edge references remain deferred, with no extra active implementation task.

## Source review and exclusions

Comparisons use published Hekate `7faf1873ed791c918ca778c3fd4c4a7321586719` and the eight exact archived tips. The 104-file immutable source pack is hashed separately. Commit counts and file differences were used to locate changes, not as proof of missing functionality.

The review distinguishes the legacy Gods task ledger from managed PlanStore. In particular, the dependency patch is a Gods dashboard compatibility issue; it is not evidence of a broken ChatAgent executive projection. The C# modifier findings concern committed compiler paths; unfinished local resolver work was not included.

The cleanup branch must not be merged wholesale. Its unbounded event polling, old schema migrations, Psyche chat service, historical metrics and deployment instructions do not meet current ownership or observability requirements. Gateway conversation and selected checkpoint model/form files already match main. Existing verification rules must not be weakened by older registration code.

## Checkpoint outcome and verification

Athena task `9b38f5c9-3e18-5d37-a633-0c47686da396` epoch 1 exited cleanly after 17.405 seconds and three observed assistant message IDs, but produced neither requested artifact nor a candidate commit. Its attempt is rejected. Six provider-reported turns and USD0.1020152 remain unverified metadata. The cause of the missing artifact is unconfirmed.

Epoch 2 is an explicit operator source assessment. It is not a successful model retry or completed cross-model review. The external gate checks all eight archive identities, all source-pack hashes, cited paths and representative source facts, then repository formatting, lint and documentation contracts. No archived runtime or service was launched for this review, and no production behavior changed.

Evidence is retained in `hekate-coordinator/runs/archived-hekate-evaluation-001`: immutable inventory, no-artifact rejection, operator recovery, source verification, check exit records and actual Hekate acceptance/follow-up readbacks. The archive restore proof remains in `hekate-branch-cleanup-003`; its bundle is retained locally at the user’s selected scope.

The next management unit remains a checkpoint with objective output and bounded retry cost. No per-step AI supervision or automatic resurrection of old work is introduced.
