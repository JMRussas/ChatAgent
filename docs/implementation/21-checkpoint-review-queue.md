# 21 — Durable checkpoint review queue (accepted planning boundary)

Status: lead-reviewed contract; implementation acceptance remains separate. Athena supplied the source survey and proposal; the lead selected the smaller read-only ledger slice and corrected unreachable ready-task states, incompatible pass/worker budgets and unsupported atomic-CAS/authentication claims. The original proposal and actual maintained run record are retained externally. The roadmap records source acceptance and integration.

## 1. One coherent increment

Implement a finite operator-triggered queue evaluation and durable local review ledger. It makes a stopped checkpoint, pending independent review and ready-but-unclaimed work explicit. It does not claim, dispatch, release, finish, accept, integrate, retry, wake or notify. A ledger on disk is not delivered escalation or unattended AI supervision. CA-ISSUE-004 remains open.

This uses [doc 19](19-checkpoint-execution.md)'s runner records and [doc 20](20-checkpoint-recovery-handoff.md)'s supplied gate semantics. The runner remains unchanged. Existing Hekate PlanStore transitions already support supervised claiming; a later manager needs its own reviewed mutation policy and exact CAS/claim fences, not an assumed new authentication mechanism or an automatic change to Hekate.

## 2. Source seams

- `src/integrations/hekate/devCoordination.ts`: `fetchCoordinationStatus`, `planApiBase`, `LeafStatus`. Loopback GET only; current leaf state and acceptance identities remain distinct from execution/liveness.
- `src/integrations/hekate/checkpointBudget.ts`: bounded `readCheckpointBudget`, current fence quarantine, `classifyGate`, overdue flag.
- `src/checkpoint/checkpointRecord.ts`: `parseBoundedJson`, record/gate schemas and bounded integer tokens. Reuse unchanged.
- `scripts/handoffCheckpoint.ts`: bounded reads, deadline before publication, exclusive temp creation and safe failures; copy only the necessary file patterns without modifying the existing CLI.
- New `src/integrations/hekate/checkpointQueue.ts`: closed manifest/ledger schemas, pure classification, bounded evaluate/read/publish helpers.
- New `scripts/checkpointQueue.ts`: one-shot `--evaluate` or `--show` using a trusted manifest.

No HTTP route, browser control, runner change, Hekate repository change, arbitrary command execution, process signal, directory crawl or model invocation is authorized in this increment. The existing paired executive page remains a separate presentation of the same task/attempt/budget facts.

## 3. Trusted manifest: `checkpoint-queue-manifest/v1`

One UTF-8 JSON file, at most 32 KiB. Refuse duplicate/unsafe keys, unsupported schema, unknown keys, non-finite or non-integer identity numbers. Configuration refusal never echoes input/path/content.

- `schema`, `queueId` (lowercase GUID), `planApiUrl` (validated existing loopback reader), `ledgerDir` (canonical absolute existing non-symlink directory).
- `entries`: 1–8 in operator order. Each has `entryId`, `rootId`, `nodeId` (GUIDs), `label` (1–80 printable ASCII characters), `expected` `{attemptId: bounded token|null, attemptEpoch: safe integer>=0, contentRevision: safe integer>=1}`, and `recordPath: canonical absolute path|null`.
- IDs and root/node pairs are unique. Non-null record paths are unique. A null record path is legitimate for ready/unclaimed tasks: do not require an invented run input or claim fence.
- The manifest is operator-declared scope, not authenticated actor authority. It supplies neither commands, executable/model/profile choices nor permission to mutate task state.

Only the manifest, its exact registered record paths and its ledger/instance lock are read. No discovery or worker text supplies a path. No startup environment or browser can enlarge scope.

## 4. Evaluation and classification

Fetch each distinct root once per evaluation through the maintained reader, within one shared monotonic 20-second deadline. Read registered budget/gate files through the existing bounded fence-aware helper. Pure classification receives already observed facts and reads no clock, filesystem or network. No model self-report or exit alone supplies acceptance.

First matching rules:

1. Unavailable/invalid plan or missing task: `unobservable`, fixed reason `plan_unavailable` or `task_missing`; no carried-forward budget numbers.
2. Current attempt/epoch/content differs from the manifest expectation: `needs_operator/fence_moved`; show bounded observed and expected fences, quarantine prior budget/gate values.
3. Current accepted decision matches leaf state, attempt, epoch, content and artifact: `accepted/current_acceptance_recorded`. A historical or contradictory decision is not accepted.
4. Rejected/stale/cancelled/inconsistent state: `needs_operator`, reason names the recorded condition without causal inference.
5. Unmet gates/blockers: `blocked/blocked_by_dependency`.
6. Ready task: `ready_unclaimed/prepare_or_claim_outside_tool`. Ready is not prepared or executing.
7. A reported record with cleanup failure, tripwire, failure or refusal: `needs_operator`, typed stop reason. A PID remains a descriptor, never authority.
8. Current gate `verifier_unavailable`, `partial` or `source_failed`: `needs_operator`, respectively `verification_unavailable`, `verification_incomplete` or `source_failure_reported`. Gate attribution is supplied, not certified by this tool; no model retry occurs.
9. Current `checks_passed` gate without accepted decision: `gate_recorded/awaiting_lead_acceptance`.
10. Plan `review_pending`, or a matching ended record with zero exit and no current conclusive gate: `review_pending/awaiting_independent_review`.
11. Matching running record: `running_recorded/liveness_unknown`; if existing overdue flag is true, `needs_operator/overdue_unreported`.
12. Claimed task without a registered readable current record: `claimed_unobserved`, reason `record_not_registered`, `record_missing` or other closed reader reason. Never infer a live or dead worker.

Every row has a fixed action key, e.g. `run_independent_review`, `review_acceptance_outside_tool`, `prepare_or_claim_outside_tool`, `inspect_evidence`, or `confirm_owner_outside_tool`. There is no executable action. A ready task never vanishes merely because its expected attempt is null.

## 5. Ledger: `checkpoint-queue/v1`

One file `<queueId>.queue.json`, at most 64 KiB, newline-terminated, closed schema.

Top-level fields: `schema`, `queueId`, `manifestSha256`, `generation` (positive safe integer), `evaluatedAt` (manager UTC timestamp), `outcome`, `entries`, `trust: supplied_not_authenticated`, `workerLiveness: unknown`, `taskMutationAllowed: false`, `delivery: not_sent`, `notification: none`, `wake: none`, `acknowledgment: none`.

Each entry: `entryId`, `rootId`, `nodeId`, `label`, `expected`, `observed` (same fence shape or null), `state`, `reason`, `action`, `artifactRef` (bounded source token or null), `runId` (GUID or null), `recordState` (running/ended/null), `stop` (closed existing kind/code or null), `gate` (current/history/unavailable/none with typed outcome and sourceRef where present), `firstSeenAt`, `stateSince`.

Do not retain prompts, worker text, private traces, arbitrary paths/URLs or numbers from quarantined records. Budget evidence remains in its registered runner record and the existing executive view. State/age timestamps are display metadata, not liveness thresholds. A changed fence, state or reason resets `stateSince`; unchanged observations preserve it. An unavailable read publishes explicit uncertainty, not old healthy data.

Outcomes are fixed: `all_accepted`, `review_required`, `operator_required`, `ready_requires_claim`, `blocked`, `running_recorded`, `unobservable`. Priority: unobservable or needs-operator, then review/lead acceptance, ready-unclaimed, blocked, running-recorded, all-accepted. Print affected entries and their fixed reason/action. Never print a bare healthy/idle/ok result when work needs review or claim.

## 6. One instance and publication

Before an evaluation write, exclusively create `<queueId>.lock` in the fixed canonical ledger directory, with a random instance token. An existing lock is `LOCK_BUSY` and is never taken over based on PID or age. A crash retains the lock; confirmed operator recovery is separate. This is a cooperative single-writer namespace, not a global lock or authentication claim.

Read existing ledger with lstat/open/fstat and bounded allocation. Reject malformed, oversized, duplicate-key or unsupported ledgers; do not overwrite or reset them. A changed manifest hash requires a new queue ID. Preserve original bytes on every refusal.

Under the owned lock, increment generation, validate and bound the new ledger, write an exclusive temp file in the same directory, sync and close. Re-read prior generation/hash before publication to detect an observed external change, then check the monotonic deadline immediately before atomic rename. For initial creation use a no-overwrite final-name operation so a racing creator cannot be replaced. Existing-ledger replacement is serialized only among writers respecting the owned lock; reread-plus-rename is not atomic CAS against arbitrary external edits. Recheck the instance token before publication; an observed replacement refuses publication. Remove only this process's temp and lock after checking the lock's instance token. A changed lock is retained and reported, never removed as ours.

No late publication after deadline refusal. Late filesystem reads/writes close and clean up when they settle; uninterruptible filesystem cancellation and directory-sync/power-loss safety are not promised. A result cannot silently claim clean cleanup if cleanup failed. No process termination is performed by this tool.

## 7. CLI

`checkpointQueue --manifest <file> --evaluate` observes and publishes one ledger, then prints fixed human/AI-readable text.

`checkpointQueue --manifest <file> --show` reads only the exact manifest and ledger, validates schema/hash/queue identity and prints the retained observation; it performs no API request or write. Say that it is a retained observation, not current state. No `--once`, polling, dispatch or arbitrary command flag exists.

Exit 0 only for `all_accepted`; exit 1 for recorded actionable/uncertain queue outcomes; exit 2 for usage/configuration refusal; exit 4 for ownership/ledger/publication failure. Preserve distinct closed codes. Stdout may include bounded trusted labels and IDs; refusal stderr contains codes only. Both modes share a 20-second monotonic wait bound from CLI entry, including manifest loading, and clean their owned resources. No global `process.exit` is needed.

## 8. Objective acceptance gates

- Classification: real fixtures for ready/null attempt, claimed/unregistered, running/overdue, ended/unreviewed, current passed/partial/unavailable gate, accepted current decision and rejected/stale/blocked. A wrong epoch/content/attempt, historical decision or different gate artifact never becomes current/accepted; sentinel numbers from quarantined records are absent.
- Persistence: two evaluations preserve unchanged `stateSince` and increase generation. Show works after a fresh process restart and prints the same observation without API reads. Changed observations reset state metadata and clear stale values.
- Ownership: concurrent invocation refuses the held lock; a crash-retained lock refuses automatic takeover; a replaced instance token is not removed. No PID adoption or process signal.
- Publication: initial racing target, moved generation/hash, malformed or wrong-schema prior ledger, changed manifest, unsupported link, late temporary sync and oversize input/output refuse without overwriting original bytes. Supported replacement is atomic under the cooperative lock; no claim of arbitrary-writer CAS.
- Privacy and authority: request log contains only exact loopback plan GETs; no PlanStore POST/PUT, model calls, shell, signals, notification/wake or automatic retry. Strict input/ledger parsing rejects unknown fields, duplicate keys, unsafe keys, integer decimals and unsupported delivery/authentication claims.
- End-to-end: evaluate actual allowlisted retained-store tasks including one review/ready/running state; show through the real CLI in a fresh process. Compare exact task/attempt/epoch/content against the existing real paired executive view without changing it. This proves ledger storage and visible reasons, not unattended continuation.
- Format, lint and docs checks; focused tests and full suite appropriate to the change. Retain any Windows identity recurrence; do not relabel it as a model/source failure.

## 9. Future authority required for actual queue advancement

A separately reviewed manager can reuse the existing PlanStore transition API under an explicit operator-approved task allowlist, fixed worker/source/profile pins, aggregate finite budgets and durable pre-dispatch reservation. It must independently prove one-instance/no-repeat/changed-claim/crash/review fences and a supported mechanism to resume independent review. It cannot automatically accept/integrate or retry an unknown failure. Human/AI presentation should consume shared queue data when that next contract is accepted. None of this is implemented by the read-only ledger increment. CA-ISSUE-004 remains open.
