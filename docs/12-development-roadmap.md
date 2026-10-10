# Development roadmap

Repository publication: the GitHub remote is now `JMRussas/ChatAgent`. The root
license and package metadata use AGPL-3.0-or-later, matching the related software
projects. Merged branch cleanup preserves worktree files and an external Git
bundle; active and unmerged work stays available. Publication checks and remote
readbacks are retained under `chatagent-publish-001`.

License recognition repair: both root `LICENSE` files now contain GitHub’s standard
AGPL-3.0 text. The existing copyright and AGPL-3.0-or-later grant are preserved
verbatim in `NOTICE`, linked from each README; package metadata remains unchanged.
The standard body’s words are unchanged. Remote detection is verified separately
in `license-recognition-001`; it must report `agpl-3.0` before task acceptance.

## Current plan — executive observability and checkpoint delivery (2026-10-09)

This section is the authoritative execution order. Earlier dated entries below are
historical decisions, not competing instructions for the next step. The sports work
remains a deliberate demonstration of the general role/tool/evidence runtime.

### Current assessment and next execution gate (2026-10-09)

**Latest checkpoint loop (2026-10-09):** the bounded targeted-start queue is
implemented and independently verified against source `de518fc`
([document 26](implementation/26-persistent-checkpoint-queue.md)). It keeps future
nodes TODO, starts only the next pinned task, runs the existing finite continuation,
waits for exact external acceptance, then advances within its fixed lifetime and
aggregate budgets. A real retained-store two-task proof completed in one invocation:
each task has exactly one start, finish and acceptance event; A's acceptance precedes
B's start. Both real restricted Claude workers produced independently checked toy
artifacts. This proves queue sequencing, not arbitrary feature correctness.

The original queue candidate `13598a9` is rejected and preserved. CA-ISSUE-048's
five gaps are repaired at `a1e6c2`, followed by separate formatting commit `de518fc`.
Six regression assertions fail against the original production source. Final checks
pass **3,413 tests**, ten explicit skips, lint and documentation validation. Original
model attempts and failed gates remain unchanged; operator finalization uses a new
attempt with no inherited model counters. Lead review, exact finalization receipts,
checks and paired inline review evidence are external under `cleanup-loop-001`;
the live proof is `queue-live-001/reviewed-proof.json`.

**Hosted Windows verification (CA-ISSUE-050) is closed for that harness repair only.**
Verified and accepted at operator epoch 2, source
`26169e321cf0446889ea48797374e74cb3f81114`; both real hosted jobs succeeded in run
`38012851847`. Windows: 3,414 passes, 13 existing host-capability skips; Linux: 3,404
passes, 23 existing platform skips; no skips added. Production privacy is unchanged
and the Windows job is now required. Evidence is external under
`cleanup-loop-001/windows-ci-001/` (`reviewed-delivery.json`, `hosted-ci.json`).

**Next execution order:** CA-ISSUE-051 (operator mutation handoff guard, task
`4071b736-67ef-5f87-b180-d357356d15b5`) remains OPEN: the product source guard
correctly refused the old mutated candidate, and the cooperative handoff guard that
refuses nonterminal or stale verification is not yet delivered.

The scoped formatter runtime contract is lead-reviewed in
[document 27](implementation/27-scoped-checkpoint-formatting.md), after rejecting
proposal `0a7643e`, accepting repair `66fea48` and lead clarification `18bde4d`.
The formatter runtime is independently verified at `e0d7aa1`: **3,456 tests pass**
with ten existing skips, **109 browser cases pass**, and lint/documentation checks
pass. A real restricted worker intentionally produced unformatted TypeScript; its
raw source fails the pinned Prettier check, while the separate formatting commit
passes Prettier, TypeScript and focused Vitest. PlanStore records one start and one
finish, naming only the final commit. The queue completes in one invocation after
independent lead artifact acceptance. Paired candidate UI shows the exact current
source/gate in place. Raw/formatter facts remain in the v2 CLI record; explicit
same-page formatting detail is the next observability increment, not yet delivered.

CA-ISSUE-052 is closed for the defined formatter scope. The two budget-stopped
partial snapshots and failed gates remain unchanged. Narrow repair `b87fcec` uses
bigint file identities around staging and fresh claim checks before effects; both
new race assertions fail against older source `539af6f`. Separate formatting commit
`e0d7aa1` follows the functional source. Whole-feature task
`2c9aa7ef-c42a-5927-9212-24edb08ed585` and immediate repair `8666b9f3-a9c8-5cb0-8c71-37c91cb7f314`
use separately fenced operator finalization for the reviewed final source; no old
model counters are relabelled. Exact acceptance and integration mappings are
external under `cleanup-loop-001`; source delivery and required GitHub CI remain
separately recorded gates. Evidence includes `formatter-live-001/lead-review.json`,
`events.json`, `proof-review_pending-ui-proof.json` and retained check logs.

CA-ISSUE-004 remains open for wake, notifications and unattended recovery; bounded
queues do not provide a continuously running AI manager.

Repository cleanup preserved all unfinished local Hekate bytes and retired only
archived/reviewed bridge branches. Hekate now reports public in GitHub through an
external visibility change; this loop did not publish it. Historical bearer
provenance and the human visibility decision remain unresolved. Audit work is
reported separately from release clearance; no history rewrite or live key operation
has been performed.

**All seven original application tasks are accepted and their exact artifacts are
integrated.** The final task `21dcea12-cb65-54cf-8581-e2f896490139` is accepted at
attempt epoch 4, content revision 3, attempt `pilot-11c9f94a6bef-r1`, artifact
`0d1852940975241dd3367cef4299acf2911e5b86`. The native owner completed `all_done`
and exited cleanly. This count measures accepted milestones, not percentage of effort.

The maintained conversation workflow can inspect a prepared plan, launch a finite
native dispatcher, request a fenced graceful stop, and read bounded public attempt
progress with exact claim, decision and evidence identities. Real paired UI evidence
covers duplicate refusal, graceful A-to-B handoff, a retained late old-owner stop,
and exact uncertain-launch reconciliation. Host heartbeat is not worker liveness
or useful progress. Hidden launches/headless checks do not prove global Windows
foreground-focus behavior.

Three blocking repairs were executed as actual Hekate CLI tasks and integrated:
CA-ISSUE-032 retains uncertain launch identity; CA-ISSUE-033 forwards only the trusted
prepared-task npm cache; CA-ISSUE-035 accepts valid large native trace records within
the existing total observation budget while withholding private tool results.
The final native real-product verifier now passes. Its two earlier rejected model
attempts remain history; epoch 3 is explicitly non-model operator preparation.

Independent lead review also corrected operator documentation (CA-ISSUE-034):
accepted Mimir artifact `9d878502d4837c8d8d483c1e3cab897dd29aba78` supplied the
reviewed facts prefix, with a separately attributed lead delivery checklist.
The native final artifact was merged first; rejected original artifacts were not
merged. Prepared package 004 was **not pinned or executed**: the native pin guard
correctly refused an already attempted task, but a lead wrapper failed to propagate
its child failure. The accepted run used package 003. CA-ISSUE-036 records that
orchestration defect; evidence is retained rather than relabelled.

The prior combined main baseline passed **2,896 tests**, with one explicit Windows
link-capability skip, plus formatting, lint and documentation checks. The exact
accepted task 7 trace/claim and decision match across real paired UI reload on
integrated source `a54ca65`; reload issues no development request or mutation.
The actual UI has restored the genuine reliability backlog against the retained
store. Evidence: `rehearsal-rework-001/final-reload.json` and
`post-native-backlog-ui-launch.json`.

**Next delivery order — executive observability MVP first (2026-10-09):**

1. The first bounded CA-ISSUE-004 recovery assessment is accepted at epoch 1,
   attempt `recovery-assessment-001-r1`, exact artifact
   `34aa761667ceeca311a3b0a1910c948b713847eb`, integrated at `e73fce7`.
   Independent checks include 150 focused cases, four controlled regression
   negatives, and 3,037 passing tests with ten explicit worktree capability skips.
   Actual live CLI observations recognize the original and recovery accepted
   artifacts, refuse a wrong epoch, and preserve untouched null history. Evidence
   is `recovery-assessment-001/live-cli-proof.json`; the recovery task has partial
   observation evidence and unknown worker liveness. This is supervised API/CLI
   execution with independent external checks, not a native TaskSpec or captured
   native attempt trace. CA-ISSUE-004 remains open: no wake, escalation delivery,
   persistent recovery service or unattended operation is implemented. The
   independently accepted planning contract is
   [document 17](implementation/17-bounded-recovery-execution.md). CA-ISSUE-037's
   null-history repair is integrated and verified through the real paired UI.
2. The executive observability first slice is delivered: accepted implementation
   `98acbb0465e93f1fb2129014064ce12ba8729a37`, integrated at `a52c1d5` and running
   on the maintained `localhost:5133` product. Shared operator-only
   `GET /development/executive/overview` supplies three explicitly configured plans
   to any authorized client. ChatAgent shows recorded state, accepted task counts,
   attention reasons and in-place initiative → task → current attempt/evidence.
   Manual Refresh and expansion perform bounded GETs; page load/reload launch no
   work. Partial/unavailable roots, historical decisions and missing budgets remain
   explicit. Accepted in PlanStore is not proven integration/deployment; host
   heartbeat is not worker liveness. No fabricated effort percentage or ETA.
   Independent repair tasks CA-ISSUE-039/040 corrected syntax/type/test-fixture and
   current-evidence linkage defects, retaining failed proposals/gates and three
   behavioral old-source negatives. Final checks: 142 focused cases, eight browser
   cases, 3,108 full cases with ten explicit worktree capability skips, formatting,
   lint and documentation checks. Candidate and maintained paired UI verify all
   three real plans and the original native accepted artifact inline. Evidence:
   `executive-mvp-live-001/delivery-bundle.json`, `live-proof.json`,
   `native-inline-proof.json` and `maintained-inline-proof.json`. Delivery task
   `77aca710-3f0d-51c9-a8d5-91380fde2cd8` is accepted against integrated `a52c1d5`.

3. Checkpoint management is delivered within its supervised scope below: one coherent,
   independently verifiable change per checkpoint, with expected budgets, enforced
   hard limits, gate evidence and explicit escalation. Workers execute autonomously
   within the checkpoint. Management observes budget/process/ownership tripwires
   between gates, rather than reviewing every tool call. Preserve failed evidence;
   distinguish source failures from unavailable external verification before
   choosing a retry. Automatic retry, uncertain-owner restart and unattended
   recovery require their separately reviewed authority and fences.
4. The P1 checkpoint phase/attention projection below is accepted. Continue
   recovery fencing and handoff evidence, then persistent role
   assignment/review/recovery. Optional LangChain/LangGraph primitives already
   exist; an unattended role/recovery service remains unfinished.
5. Integrate measurements before setting execution-time thresholds: equivalent
   task/model/host/verification cohorts, phase durations, ready-to-acceptance,
   acceptance-to-integration, review backlog age, rework and attributed cost per
   accepted feature. Include failures. Timeouts are bounds, not performance SLOs.

**Checkpoint milestones and forecast.** The first useful executive slice shipped
on **2026-10-09**, within the provisional 2–4 focused-hour window. The contract worker
finished in about two minutes; implementation generation took about 11½ minutes,
followed by independent review, two scoped repairs, checks and real UI proof. This
single delivery does not establish a measured throughput baseline. Forecast the next
coherent increment at its accepted contract gate; unattended recovery and polish
remain separate work rather than delaying the useful first slice.

| Checkpoint                  | External acceptance gate                                                            | Hekate task                            | Current result                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Contract                    | Independently reviewed bounded API/UI contract and acceptance cases                 | `5cbe16e7-2c84-5ffe-8f01-c1cd3ed4bade` | Accepted `a57df9a`, integrated `a9d8258`                                                  |
| Working slice               | Shared API/inline UI artifact, schema/auth/projection/browser/full checks           | `4dea3423-c92b-55e0-8e2b-d5fe595df2e3` | Accepted `98acbb0`, integrated `a52c1d5`                                                  |
| Live delivery               | Maintained paired UI, exact source integration and retained-store evidence          | `77aca710-3f0d-51c9-a8d5-91380fde2cd8` | Accepted `a52c1d5`                                                                        |
| Execution contract          | Freeze bounded enforcement, counter units and objective gates                       | `2f54ab05-7d58-5cc3-aa4f-0bd64c9f684d` | Accepted `0e75f03`, integrated `6524c7f`                                                  |
| Enforcement                 | Maintained budget tripwires, owned cleanup and bounded typed checkpoint evidence    | `94438651-ed00-5656-803d-d6097d4a4e40` | Accepted `ff9230d`, integrated `6f9f288`                                                  |
| Enforcement delivery        | Real maintained CLI and paired inline current budget/gate evidence                  | `c22d6e63-171b-5751-9e91-203a2e55f874` | Accepted `ff9230d`; real source `6f9f288` on `localhost:5133`                             |
| Recovery contract           | Freeze one executive exception summary and fenced local operator handoff            | `2fd0efc9-fdf7-50c5-ba88-1a7a17e039fe` | Accepted `f4a7bee`; integrated contract, implementation pending                           |
| Recovery handoff            | Independently verified implementation, same-page detail and restart/fence negatives | `e2adb990-cffe-5129-81be-4ba202dac1f9` | Accepted `17ebec2`, integrated `2b4289e`; maintained paired attention/local handoff proof |
| Review queue contract       | Independently frozen finite manager/review continuation boundary                    | `ac55a6f7-0502-54f7-bdc1-654057c8cc92` | Accepted `0535a4e`, integrated `8df3130`; read-only durable ledger scope                  |
| Review queue implementation | Durable exact-fence state, no duplicate/retry/adoption and real idle/review proof   | `2d9e65de-80d8-5de3-a853-6f407240732b` | Accepted `cd609ba`, integrated `93d72a1`; 3,263 full passes and real CLI/UI proof         |
| Continuation contract       | Freeze generation-to-external-verification continuation without a user message      | `9bd14df4-5bc7-5d68-96e1-e8e0ffb4b627` | Operator contract `1031fd7` accepted, integrated `ec0714a`; original failed run retained  |
| Continuation manager        | Finite owned no-repeat execution and external review continuation proof             | `ffe5f5c6-c656-5761-a724-f13c5586059e` | Accepted final source `7aa55f5`, integrated `69ce8f3`; live delivery verified             |

These real tasks are stored under management root
`29141a72-9c9a-54f8-a357-fb6db74d84d9` with acceptance dependencies. Checkpoints,
not individual tool calls, are the management unit. Model self-report is never an
acceptance gate; generation, independent acceptance, integration and live delivery
remain separate facts.

**Maintained enforcement is delivered.** [Document 19](implementation/19-checkpoint-execution.md)
and `scripts/runCheckpoint.ts` define one operator-triggered, already-claimed worker
run. Pin the executable, Git, linked worktree HEAD, prompt and current claim; use a
fixed restricted tool profile and empty MCP configuration. Expected and hard budgets
use `assistant_message_ids_distinct/v1`, distinct assistant message IDs observed in
complete validated stream records. Hard units, monotonic wall time, combined output,
uncertain counters and readable claim supersession stop only the owned process tree.
A retained exclusive attempt lease prevents another run ID bypassing the same claim
in the fixed record namespace. Rework needs a newly fenced attempt; namespace
migration is explicit operator recovery, not a global cross-namespace lock.

CA-ISSUE-041/042 repairs are separately accepted (`015fae3`, `ff9230d`), retaining
failed proposals and four independent regression negatives across profile/duplicate
start and gate attribution/monetary parsing. Generic failed checks remain unattributed;
`source_failed` requires explicit lead attribution and evidence, and unavailable
verification does not become a model retry. Budget/gate files are supplied,
unauthenticated observations with unknown writer liveness. Optional registered
records enrich shared `executive-overview/v2` and same-page detail; unregistered
clients retain the v1 contract. Gates match exact source/attempt/content fences.

Final source checks: **3,183 passing tests**, ten explicit worktree capability skips,
146 focused cases, eight browser cases, formatting, lint and documentation checks.
A real maintained read-only Claude checkpoint consumed **two distinct message IDs,
17.924 seconds and 52,740 output bytes**, below its 60-unit/120-second/1-MiB hard
bounds; provider-reported cost was approximately USD 0.047704, labelled unverified.
The clean pinned worktree and actual paired product UI prove current budget and
lead-supplied gate visibility without navigation, mutations or automatic reload
reads. Evidence: `checkpoint-execution-001/reviewed-bundle.json`,
`checkpoint-maintained-smoke-001/reviewed-bundle.json` and `maintained-ui-proof.json`.
The implementation-generation run consumed 19 distinct IDs in about 11¾ minutes;
its private wrapper evidence is not retroactively a maintained runner record.
CA-ISSUE-038 is closed for the defined/enforced counter; provider `num_turns` and
`--max-turns` semantics remain unverified and are not treated as equivalent units.

**Next bounded priority:** durable review/queue state and observable bounded
manager continuation. The executive exception summary and local handoff are delivered. The Athena
contract task is accepted at `f4a7bee` ([document 20](implementation/20-checkpoint-recovery-handoff.md)).
Its real maintained run consumed eight distinct message IDs in 199.019 seconds,
462,089 output bytes and approximately USD 0.629877 provider-reported cost, all
within its declared bounds. Actual UI evidence shows the running record under the
Active claim, then the ended record while independent review was pending. Lead
review corrected no-overwrite publication, registry coverage, schema/bounds and
observational fence semantics before acceptance. The Hermes implementation completed generation at
`checkpoint-recovery-implementation-001-r1`, epoch 1/content 2: 26 distinct message
IDs in 398.453 seconds, 1,723,774 output bytes and approximately USD 1.730672
provider-reported cost, below every declared bound. The exact proposal `4d3d65f`
and failed gates are retained. CA-ISSUE-043's independent operator repair `17ebec2`
is accepted; its five regression negatives, 136 focused cases, nine browser cases,
format/lint/docs and actual candidate tripwire → same-page detail → local handoff
checks pass. Whole implementation is **accepted** at `17ebec2` and
integrated at `2b4289e`. The initial full gate passed 3,229 and skipped ten explicit
capabilities but hit CA-ISSUE-014's native Windows identity `EPERM`; its isolated
recheck passed and the fresh serial full suite passed **3,230 with ten skips**.
The holder/cause remains unknown, no source failure was inferred, and no model
retry was spent. Real maintained UI first showed the ended generation budget and
current `partial`/unattributed gate in Awaiting review, then the accepted exact
source/gate. The delivered v3 executive view surfaces registered checkpoint
exceptions at the top and opens current evidence in place. A real controlled
owned-tree tripwire (4 IDs against a hard limit of 3, both fixture processes gone)
proved that path; the one-shot CLI wrote and validated a fenced local handoff
explicitly marked not sent/no wake/no acknowledgment. Delivery verification task
`f6de8847-8de4-5a2a-8879-acf4862316ce` is accepted against `2b4289e`; accepting it
resolves its ordinary tripwire attention item while retaining budget and evidence.
Evidence: `checkpoint-recovery-implementation-001/reviewed-bundle.json`,
`review-pending-ui-proof.json`; `checkpoint-attention-live-001/reviewed-bundle.json`,
`maintained-ui-proof.json` and `handoff-live-proof.json`.

The lead advanced the accepted gate into the next actual model checkpoint rather
than ending with only queued work. Athena contract task
`ac55a6f7-0502-54f7-bdc1-654057c8cc92` is accepted at `0535a4e`, integrated at
`8df3130` ([document 21](implementation/21-checkpoint-review-queue.md)). Its real
maintained run ended within bounds: seven message IDs in 128.579 seconds,
391,985 output bytes and USD0.473135 provider-reported, unverified cost. Independent
lead review selected the smaller read-only durable ledger boundary, correcting
invented ready-task claim inputs, incompatible pass/worker budgets and unsupported
atomic-CAS/authentication claims. It makes current review/idle reasons durable;
it does not automatically claim/dispatch, accept/integrate, notify or wake.

Hermes implementation task `2d9e65de-80d8-5de3-a853-6f407240732b` ended at
14:21:56 UTC after 342.407 seconds, 13 distinct message IDs and 784,574 output
bytes; USD1.069912 is provider-reported, unverified cost. Its generated candidate
`5a5f8ec` was moved to Awaiting review, not left as an active worker. The lead resumed at the
user's check-in at 14:35 UTC; the budget monitor did not resume semantic review.
CA-ISSUE-004 remains open. Independent repair CA-ISSUE-044 fixed four
old-source negative cases reproduced deadline, lock-ownership and dependency
classification gaps. A two-hour overdue fixture was corrected without weakening
tripwires. Formatting-only commit `1a3f1f4` remains separate. Independent checks passed: 62 focused cases,
3,263 full-suite passes with ten explicit skips, pinned format/lint/docs checks,
actual retained-store CLI evaluation and fresh-process show, and paired UI
review-state/fence proof. The ledger distinguishes current incomplete verification,
accepted work and ready-unclaimed work; unchanged `stateSince` survives restart.
The completed model artifact cannot be amended through PlanStore: final repaired
source completion uses an explicit operator attempt, preserving the original
model proposal, run, fence and failed gates. This is not a model retry. Evidence
is retained under `checkpoint-review-ledger-001`.
The repair and implementation are accepted at `cd609ba`, integrated at `93d72a1`.
Final completion is operator attempt `checkpoint-review-ledger-001-finalize-r2`,
epoch 2/content 2. The original model budget remains fenced to epoch 1; it is not
presented as a current operator-run budget. `accepted-readback.json` and
`reviewed-bundle.json` preserve the distinction. No model retry was spent.

Planning task `9bd14df4-5bc7-5d68-96e1-e8e0ffb4b627` was claimed at
`checkpoint-continuation-contract-001-r1`, epoch 1/content 1, through the maintained
fixed-profile Claude CLI on source `93d72a1`. Its intended scope is a finite manager that
starts deterministic verification and a separate independent review after generation
without a user message; a ledger or this chat's process-local history is not a wake.
Implementation `ffe5f5c6-c656-5761-a724-f13c5586059e` remains gated by planning
acceptance. Hard bounds are 60 message IDs, five minutes, 4 MiB output and USD2
provider cap; expected 30 IDs remains a heuristic. An initial missing record-directory
preparation refused before spawning any model; the refusal is retained, the directory
precondition was fixed, and the same unopened run then started. This is not a model
retry. The model then reached its hard wall at 300.297 seconds with 11 message
IDs and produced no contract artifact. The tripwire stopped the owned run; the
proposal is explicitly rejected without attributing a source defect or spending
a model retry. Implementation was blocked at that point; CA-ISSUE-004 remains open.
Repository publication is complete. The lead/operator contract recovery is accepted
at `1031fd7`, integrated at `ec0714a`
([document 22](implementation/22-checkpoint-continuation-manager.md)). Planning
completion is a separate operator attempt, epoch 2/content 2; the original failed
model run remains on its old identity. The smaller increment snapshots declared
coding output into an isolated candidate, finishes only the current claimed
attempt and automatically starts fixed external checks. It ends at a supplied
review gate; semantic AI review, acceptance, integration and next-task claiming
remain separate. CA-ISSUE-004 is still open.

A subsequent Hekate branch audit removed remote `feat/plan-nodes-migration`
(already merged into published main) and `chore/untrack-settings-local` (its only
change is already fulfilled by the publication cleanup); superseded PR #7 is
closed. Content comparison then proved the entire `docs/chat-runtime-adr-pointer`
document is preserved in main with a newer handoff header; that third branch and
superseded PR #13 are retired too. A fresh full Git bundle verified before branch
deletion, exact tip leases
protected remote deletion, and source branch/HEAD/status/diff hashes are unchanged.
The dirty local migration checkout and every worktree file are preserved.
The initial cleanup retained eight remote branches and six open PRs for
consolidation (`hekate-branch-cleanup-002`). The user then prioritized repository
presentation: a subsequent private archive preserves every remaining tip in a
fresh verified bundle and 24 hashed PR/detail/review/discussion snapshots. All
eight remote branches are retired with exact tip leases and the six stale PRs
are closed. GitHub now exposes only `main`, with zero open PRs; visibility remains
private and published Hekate source stays `7faf1873`.

Actual retirement task `f8445275-e619-5658-9837-698bc8b0f2ae` is accepted;
prior aggregate triage `fa1f1f63-2623-5eda-99b6-a8e775426943` is superseded and
cancelled without a worker. All eight scoped assessments under
`31d5461f-81a4-5ee0-b650-8c7978d0f975` are now accepted against operator-reviewed
artifact `f08926fbd3b079f95b32aee02811c071d4abfef9`: **one Keep, three Extract and
four Retire decisions**. Assessment acceptance is not feature completion. The
[source-backed decision record](implementation/23-archived-hekate-branch-dispositions.md)
contains all eight exact tips, subchange decisions and narrow acceptance gates.
The verified local bundle, PR records, local branches and dirty source remain preserved.
No remote branch is restored.

All three implementation follow-ups are accepted against tested source artifacts:

- **P1 ChatAgent checkpoint phase/attention visibility**, task
  `84290f4f-29bd-527a-a1e6-a6c36037ee13`: accepted operator delivery epoch 2,
  content revision 3, source `94e2488d8cfc122fbb527805ea3455509c7b0d62`.
  [Document 24](implementation/24-checkpoint-phase-visibility.md) defines the
  optional trusted continuation path and closed shared `executive-overview/v4`:
  all six recorded phases, bounded summary/attention and existing inline detail,
  exact task/run/content/source fences, and explicit unavailable coverage.
  Current source-base agreement is required; liveness stays unknown and checks
  passing is not acceptance. Raw Claude candidate `becf03a` remains rejected.
  The finite coordinator actually finished the worker and ran three external
  checks without a new user message, then stopped at `needs_operator` when they
  failed. CA-ISSUE-047 records fixture/claim/source-currency repairs; a later
  eight-case integration timeout was reproduced and split into independent test
  budgets with all assertions retained. No production or global timeout increased.
  Final gate: **3,376 tests passed, ten capability skips**, **ten browser cases**,
  lint/docs and paired same-page UI proof of the real rejected phase/checks/source.
  The initial 3,368-pass/one-timeout full gate is retained. Evidence:
  `checkpoint-phase-implementation-001/reviewed-bundle.json`, automatic records,
  `full-gate-timeout-diagnosis.json`, `feature-accepted-readback.json` and paired UI proofs.
- **P2 Hekate Gods task-list dependencies/tools**, task
  `f9bd68e5-40d9-594f-b5f6-2840b3ce0efe`: accepted Claude artifact
  `d25e7cd5a7a4ea8de9e382161cc8ec22a5d8c086`. Sorted dependency IDs use bulk queries
  capped at 500 task-ID parameters, restricted to returned tasks; tools are
  validated string arrays. Raw output/error remain excluded. **31 API tests** and
  an independent tools probe pass, and two old-source negatives detect the missing
  fields. The existing SQLite fixture leak was repaired: baseline printed 11
  passes but hit its owned timeout; candidate closes the DB and exits cleanly.
  Managed PlanStore is a separate ledger. Evidence: `gods-task-projection-001`.
- **P2 Hekate C# partial round-trip**, task
  `58d1d46d-17bf-52f2-a7f0-521bc970bba2`: accepted source
  `1309ec2b227eea1593dddd193c7f8898e7e71c56`, retaining raw Claude commit `8fbf511`
  plus separately attributed documentation correction/formatting. Partial
  class/struct/method modifiers and bodyless declarations survive round-trip;
  implicit access, static type/method flags and void expression bodies generate
  valid code. **203 .NET tests** (193 existing plus ten new compiler fixtures)
  and API build pass; a compiler-only old-source negative reproduces invalid
  output. The six-method repository interface enables tests without changing
  persistence. CodeService, Schema, AGE/outbox and dirty local work are unchanged.
  General generator limits and absence of project-wide partial aggregation stay
  explicit. Evidence: `csharp-partial-001`.

Both Hekate fixes are integrated and pushed at
`baf032d3b6143361c32ca2d923bd869b78f7d73f`; all nine integrated file blobs match the
accepted artifacts. GitHub retains only `main`. Native Windows/NSSM services were
not redeployed; these receipts establish source delivery and tests. ChatAgent's
accepted phase-view source is delivered through the maintained operator product;
old epoch-1 records stay quarantined after operator recovery rather than becoming
new budgets or current phases. Unattended supervision remains CA-ISSUE-004.

Rate/budget references are attached to existing CA-ISSUE-008/009 tasks rather than
creating duplicate quota work. Canvas graph/layout ideas are retained as reference;
its archived needs-review-to-done status mapping and unfenced SSE path are retired.
The executor fork is superseded, the old retry module is absent, dated policy prose
is retired, and image expansion remains outside the execution MVP.

Batch Athena review `9b38f5c9-3e18-5d37-a633-0c47686da396` epoch 1 exited cleanly
in 17.405 seconds with three observed assistant IDs but produced no requested
artifact or candidate commit. It is rejected; the cause remains unconfirmed and
provider counters are unverified. Epoch 2 is an explicitly attributed operator
source assessment, accepted at `f08926f`; it is not delivered cross-model review.
Its external gate verified 104 immutable snapshots against Git, all eight branch
identities, unchanged archive hash and representative source facts, plus format,
lint and documentation checks. No archived runtime was certified or production
behavior changed. Evidence: `archived-hekate-evaluation-001/no-artifact-review.json`,
`source-verification.json`, `assessment-accepted-readbacks.json` and
`followups-final-readbacks.json`. The paired maintained UI check
(`assessment-final-ui-proof.json`) confirms all eight assessments accepted, three
implementation tasks ready with zero attempts, same-page detail and old epoch-1
budget quarantined from epoch-2 operator work. Original archive/restore evidence remains in
`hekate-branch-cleanup-003`.

Hermes implementation `ffe5f5c6-c656-5761-a724-f13c5586059e` ended cleanly
at 16:28:35 UTC on October 9 after 611.669 seconds and 19 distinct assistant
message IDs, below its 15-minute/60-message hard bounds. Provider-reported 40
turns and USD1.808362 remain unverified metadata. Raw candidate `4d0568a` and
separate formatting commit `66d7d0e` are retained. Format/type and docs checks
pass, but independent review rejected three authority cases; the first complete
focused gate passed 33 cases with two fixture failures. That original attempt
remains rejected; final acceptance uses a distinct operator attempt below.

CA-ISSUE-046 is recorded in real Hekate repair task
`d2284986-61fc-5433-a66f-3dd41d17c5c8`, attempt
`checkpoint-continuation-repair-001-r1`, epoch 1. Hermes ended the narrow repair cleanly after 125.033 seconds and 13 distinct
message IDs, below the 30-message/five-minute hard bounds and slightly above its
12-message provisional estimate. The 4 MiB output and configured USD2.50 provider
cap are retained; provider usage remains unverified metadata. Independent regression source is committed at `630f679`.
The original task is completed and rejected at its exact candidate, keeping the
old model run separate. Repair candidate `7aa55f5` passes all 38 focused cases and format/type/docs
checks; its corrected full suite passes 3,301 with ten existing skips. The prior
full failure was caused by the lead launcher omitting PowerShell from PATH; the
failed gate and harness diagnosis are retained. Exact scoped repair `7aa55f5`
is accepted. Actual retained-store delivery task
`dbfc5c3f-4819-59a8-81cf-6b1480e06759` passed and is separately accepted. A real
worker ended at 16:53:55.418 UTC, then the same finite coordinator created one
candidate, confirmed one finish-only CAS and automatically started Prettier,
TypeScript and focused Vitest at 16:53:56.092/56.317/54:01.645. All checks passed;
the coordinator ended at `review_pending` at 16:54:02.148, without another user
message. The paired executive view matches exact source, task fence and current
supplied gate. This is isolated toy proof: its helper and independently prepared
baseline tests are not integrated.

Whole-feature finalization is accepted at operator epoch 2/content 3,
`checkpoint-continuation-feature-finalize-r2`, exact source `7aa55f5`, integrated
at `69ce8f3`. The original epoch-1 budget is history, never relabelled as the
operator run. Final acceptance receipts, actual worker/check timestamps and
paired UI proof are retained under `checkpoint-continuation-live-001`. Evidence is retained under
`checkpoint-continuation-implementation-001` and
`checkpoint-continuation-repair-001`.

The runtime budget monitor continued independently until the model worker ended;
independent lead gates still determine acceptance. Bounded queue advancement is now verified above;
AI wake and unattended supervision remain unfinished (CA-ISSUE-004). Evidence is retained at
`checkpoint-recovery-next-001/reviewed-bundle.json`, `active-ui-proof.json` and
`active-state-proof.json`. This builds on the read-only recovery assessment and
explicitly leaves actual wake/notification delivery, acknowledgment, persistent
supervision and unattended recovery for separately verified increments. CA-ISSUE-004
remains open. Do not claim a stored local handoff is a delivered human notification.

The retained database currently has one finite API-only LocalStore owner for
supervised tasks, with a four-hour bound and no native dispatch or model execution.
The prior API owner shut down cleanly before replacement. The latest same-store
renewal is `cleanup-loop-001`, retaining project/database identities;
its predecessor shut down before the current owner started. API liveness does not mean a worker
is running. The previous native
backlog dispatcher exited on `inflight`; its conservative blocked-state relaunch
fence remains intact. Runtime ownership is separate from active task execution.

The genuine eight-task reliability backlog has one accepted bounded phase and
seven TODO tasks, retained in Hekate under root
`d6450921-6673-5535-b495-07cc165ada2d`. Dependency-ready tasks with `spec_pending`
are unprepared, not actively running workers. Use a work-in-progress limit of one
feature and its immediate blocking repair. Deferred metrics task
`ef5ef6dc-9f8f-543e-8c8f-ad8e1ab8e68c` remains TODO with prior candidates and failed
attempts retained; no measured cohort baseline or execution-time SLO exists.

One Start click arms a bounded dispatcher that polls and advances approved ready
nodes between clicks. Page load/reload never launches work. Neither continuous AI
supervision nor automatic source integration is implemented. Conversation history
is process-local; reload is not restart persistence. Preserve historical evidence,
including the unidentified Windows identity-file holder (CA-ISSUE-014), formatter
profile adoption limits and resource contention follow-ups.

Evidence is external under `D:/hekate-coordinator/runs/`, notably
`conversation-rehearsal-001`, `ready-plan-handoff-001`,
`application-rework-native-001`, `rehearsal-rework-001`,
`launch-identity-repair-001`, `dispatch-cache-repair-001`,
`runbook-facts-repair-001` and `trace-record-repair-001`.

### Roadmap review and application execution plan (2026-10-08)

**Continued supervision (2026-10-08).** The user directed continued execution,
live Active-view checks and defect logging as work proceeds. Work is not complete
when a plan is stored. Prepare, execute, observe, record findings, verify fixes and
advance through reviewed artifacts. Keep a defect's reproduction, expected/actual
behavior, evidence, priority, owner and Hekate task together in
[the issue register](open-issues.md); distinguish bugs from feature backlog and
operational limits. Never discard failed proof or worker evidence.

**Implementation now progressing (2026-10-08).** The optional Python planning-role
runtime and evidence manifest primitives are implemented, independently reviewed
and integrated into Hekate at `633e31a`. The runtime executes an injected
LangChain model through a LangGraph model/validation graph, rejects malformed
correlation/output, disables ambient tracing and leaves review pending. Evidence
manifests verify bounded exact bytes against distinct task, attempt, content and
state identities. Neither primitive claims process liveness or authenticates actors.
Their Hekate nodes `a08ee7ab-7b4a-5bde-967e-eb512132d089` and
`28520a10-c13d-55ec-8b20-1af2ecdda639` are accepted at attempt epoch 2 after
independent review rejected the original candidates. Failed candidates and repair
evidence are retained; Hekate HK-ISSUE-018/019 record the defects and closure.

Checks passed: 159 focused cases; the broader selection passed 359 cases, with
four harness cases rerun successfully after correcting the worktree's maintained
container selector. A separate default-dependency environment passed 50 evidence
cases and skipped the two optional-role test modules. Evidence is under
`D:/hekate-coordinator/runs/managed-role-adapter-001/`,
`managed-role-adapter-002/`, `role-evidence-001/` and `role-evidence-002/`.
Odin's managed-attempt/trace wiring task
`c2fd26d1-4643-561d-9601-6866e3810727` is accepted and integrated at `33feddc`.
It uses the existing claim, attempt journal, trace and finish path. Independent
verification passed 372 cases, with one Windows symlink capability skip. A real
Claude CLI model run through LangChain/LangGraph completed under a native claim;
the API returned a verified trace and the browser displayed it. The lead verified
its exact evidence manifest before recording acceptance. Evidence is retained at
`D:/hekate-coordinator/runs/role-live-001/` and `managed-role-wiring-002/`.

The shared observer task `9f18907d-ef1e-5288-a31f-b78d27ef1920` is accepted at
attempt epoch 2 and integrated into ChatAgent at `2f3d6df`. The GET-only collector
shares stable task/attempt metadata between human and AI projections, bounds the
whole exchange and retains exact response hashes. Its AI projection excludes raw
trace/prompt and other arbitrary free text. Liveness and useful progress remain
unknown. Verification passed 106 selected tests plus format, lint and docs checks.
Three live observations matched the native role's exact task/attempt and verified
trace, including record zero. CA-ISSUE-017 records the rejected candidate and repair.

Mimir's review task `efb428c9-5e44-5326-b856-0909efed76e1` is accepted at
epoch 2. Claim-key cross-checks/provenance limits are integrated at ChatAgent
`4b00df6`; explicit unknown-liveness/useful-progress labels are integrated at
Hekate `7fa394f`. Verification passed 109 selected observer/coordination tests,
138 backend cases (one Windows symlink capability skip), 13 focused browser
cases, typecheck and relevant lint checks. CA-ISSUE-018 records the rejected
incomplete reviewer launch; CA-ISSUE-019 records the claim-linkage improvement.
A real native role was captured Active/unverified, then done/verified and removed
from Active, with manifest verification preceding independent acceptance.

**Contention and dispatch repair (2026-10-08):** managed task
`2e272c20-db6c-576f-8cb7-73e87311c0ed` is accepted at epoch 2 and integrated at
`cf9d1a4`. Real Windows delete-pending kernel handles reproduce lock-open `EPERM`;
rotation recovers after release through bounded exclusive-creation retries, refuses
permanent contention, and refuses if another owner wins the name. The old source
fails the new recovery test with captured `open`/`EPERM` metadata. Full verification:
2,432 passed, 9 existing skips; format/lint/docs checks pass. The original field
holder remains unidentified. Initial fixture failure and a wrong-repository artifact
reference were preserved; the incorrect reference was explicitly rejected and a
new attempt reviewed against the exact ChatAgent commit.

Owned dispatch task `3764990e-b4ba-530f-91ad-6d107c4571e0` is accepted at
attempt `owned-dispatch-002-r1`, with source integrated at Hekate `24404af`. The first candidate was rejected before live use.
The host reuses native PlanStore/runner ownership and makes process identity,
heartbeat, blocked preparation/review, failure and ready-but-idle states explicit.
107 runner/store checks and 38 final dispatcher checks pass; independent Mimir
review found no blockers, and its scoped follow-ups are corrected/documented. The
real store rehearsal correctly reports `ready_idle/observe_only` without dispatch. The existing application API task is now
pinned to verified package `plan-status-api-006`, SHA-256
`61e3c2b8f35e61141dd97afbb9764dc23c1d9721c9c7db81a1698444cd1083c8`.
Native hidden dispatch launched the original API task and its trace was captured
Active/unverified through the live UI (22 GETs, no browser errors). Windows virtualenv
launcher/interpreter PID indirection left the first acknowledgement `unconfirmed`;
launch-ID correlation is corrected and its test passes. The two authorized model
rounds both failed the formatting oracle, and the owner stopped as `failed` with
`node_not_accepted/max_rounds`. Both rejected artifacts and the native journal remain
retained. Operator attempt `operator-format-review-001-r1` is accepted: a trusted
formatting-only derivative has identical TypeScript token streams and passes all 26
frozen oracle cases; the unchanged full verifier passed (26 frozen cases, 2,437 full-suite cases,
9 existing skips, typecheck/docs and clean tree). The original API task is
accepted at epoch 3 with artifact `d0fea19a1cfdc6350706c2fe3ae35368ebb4d630`. No third model round
was launched. CA-ISSUE-016 follow-up `db59fb7b-d963-537a-853a-8883601ab757`
requires a versioned pinned formatter capability rather than broadening shell
authority or altering frozen verification. Corrected live launch acknowledgement succeeded with distinct launcher/runtime
PIDs and launch ID. The four-hour owned host completed `plan-status-ui` and waits on `bounded-plan-launch/spec_pending`, with a five-second heartbeat. It dispatches only
prepared work and leaves planning, failed-budget recovery and integration to
explicitly attributed operator/role tasks. Source review is accepted; a duplicate launch was refused `owner_running` before
spawn. ChatAgent integration `1def1a2` passes all 2,450 tests plus format/lint/docs.
UI planning under application resumption is reviewed and linked from
`D:/hekate-coordinator/runs/application-ui-planning-001/review.txt`. UI preparation
`a1b71572-a9a4-5de2-b6c8-fb53ab1d3292` is accepted at epoch 3 after correcting
its mislabeled target ID and revalidating the exact package. Formatter capability
`db59fb7b-d963-537a-853a-8883601ab757` is accepted at epoch 2, source `c200ef7`.
Its 44 formatter cases and real Node 24.21.0 / Prettier 3.9.9 pre/post/idempotence
proof pass; old v0 evidence retains its shape. Initial rejected candidates and
fixture failures remain retained. UI package `plan-status-ui-002`, SHA-256
`ab3ad832448ead0b669f7049b04f0e603922872ea4ba2c819e35427a037bf35d`,
passes 68 frozen oracle cases, typecheck, 2,506 full-suite cases (nine existing
skips), docs and 12 headless browser checks. An independent XSS mutation fails.
The first browser proof was refused for an ignored generated output directory;
its immutable verifier helper now retains each round's evidence beside its owned
worktree with exclusive creation. CA-ISSUE-023 records the earlier unchanged CLI
case's timeout under concurrent verification; bounded two-worker full checks pass.
The dispatcher gracefully handed off to the accepted formatter source, with a
confirmed launch ID and distinct native launcher/runtime identities. It has now
completed the original UI task as `pilot-f5ea665af140-r2`, accepted at epoch 2. A real native
worker trace exists, and the headless UI shows In progress with the exact attempt
(18 read-only API calls, no page errors). The first candidate passed 67/68 cases and was rejected by a literal URL-variable
assertion (CA-ISSUE-025); the second passes all 68 cases and all remaining checks.
Exact accepted artifact `9659c7fcf45bb3df5a44a12b5fa9298a747a1616` is integrated
at ChatAgent `66985f3`; the combined suite passed all 2,515 tests, lint and docs. Both native rounds ran the pinned formatter twice with unchanged
output bytes and successful idempotence checks. Native CLI-reported costs are
`0.5148252` and `0.526193` USD; their sum is reported usage, not metered spend. The five-second owner heartbeat and separately recorded task state keep
worker liveness/useful progress explicitly unknown until observed evidence permits
stronger conclusions.
Athena planning `e2876010-1741-5d6f-8aa0-edd00a52d674` is accepted with lead
corrections; adapter preparation `3221839c-1b48-55b8-bb36-c9e425f13d9f` is Active
at epoch 2; its correction worker has exited and the candidate awaits lead completion
and review. It now passes 317 focused cases and lint, with stop-fence adoption still
pending. Its initial candidate passed 189
focused checks and lint, but independent review rejected workspace-selection and
journal validation gaps (CA-ISSUE-024). Initial files/tests/rejection remain retained. Measurement task
`ef5ef6dc-9f8f-543e-8c8f-ad8e1ab8e68c` is Active; its read-only audit proposes comparable
ready-to-acceptance delivery time, phase durations, throughput, rework and model
cost. The provisional current-run sample records worker durations of 407.558s,
328.837s and 114.996s for formatter/UI preparation/adapter planning respectively;
provider-reported costs remain attributed claims. Queue/phase/acceptance timestamps
are missing from that sample and remain unknown. Overlapping worker durations
cannot be summed into delivery time. No performance baseline or SLO is established;
hard limits are execution bounds. The audit found the pilot journal uses a logical
clock (`now=1000`, fixed tick increments), so that field cannot supply execution
durations. Readiness intervals must use actual observation gaps, acceptance must
match artifact as well as epoch/content, and UTC/local dates are explicitly qualified.
Instrumentation/projector source is now a candidate: the first implementation timed
out and was explicitly rejected; epoch 2 finished its follow-up worker. Independent
assessment passes 46 projector/hook tests. Actual dispatcher/verifier integration
coverage, acceptance and deployment remain pending. Evidence lives under the external
`task-formatter-001`, `ui-prepare-001`, `ui-native-observation-001`,
`launch-adapter-planning-001`, `launch-adapter-prepare-001` and
`execution-metrics-001` directories. Continuous autonomous AI supervision beyond
the active session is not claimed.

**Current:** application resumption `47f98ae5-c0ec-5be1-919b-7ea615f07952`,
attempt `application-resume-001-r1`, is accepted. Original UI task
`7d8f5bcc-9c77-5a58-b18a-dde27e4b37be` is accepted at epoch 2 under the native dispatcher.
The import mapping and live PlanStore agree: `6bbefda0-cc3b-510d-ab02-f1fbc5b5ba61`
is the later bounded-plan-launch node. The earlier roadmap/preparation note mislabeled
that ID; the correction is explicit and original evidence is preserved. Formatter
capability task `db59fb7b-d963-537a-853a-8883601ab757` is accepted at epoch 2. Supervision rehearsal
`5544af83-8716-528b-aabf-2ceb21719bde` is accepted at epoch 3 after the
prior finish correctly refused `stale_prerequisites`: adding the historical repair
gate required releasing the old attempt and revalidating the exact bundle under
current pins. Evidence and that review are retained in
`D:/hekate-coordinator/runs/supervision-audit-002/repin-review.txt`. Windows
recurrence diagnosis `c3c70c65-52ea-53e4-9209-d3d39893f927` is accepted at
`6cfd9fc`; 39 focused cases and the full suite (2,428 passed, 9 existing skips)
passed. The narrow lock-acquisition refusal fix preserves native error cause; the
original field holder remains unconfirmed. The application API package has passed reference proof and has run two native
model rounds; its explicit operator formatting/review attempt is described above.
Historical-trace defect `248e4707-3124-59a2-abf8-0eba1b069fc7` is accepted and
integrated at `9d408b9` after 124 selected tests and eight native observer/browser
comparisons.
The first audit harness exceeded the maintained eight-node import bound and failed
before importing work; it was rejected and retried within that bound. The second
native rehearsal exercised eight controlled failure/injection cases, retained
unaccepted evidence, stopped failed allocations explicitly, and proved duplicate
claims invoke no second model. A bounded real HTTP 503 fixture verifies observer
refusal without exporting its body or issuing writes. CA-ISSUE-020 records a real
historical-trace omission after cancellation; the bounded worker fix is reviewed
and rehearsal acceptance requires its accepted artifact. Evidence is under
`D:/hekate-coordinator/runs/supervision-audit-001/002/` and
`observation-history-001/`.

The prior rehearsal monitor ended; an observer alone left execution idle until the
lead started the shared-observer task. That operational failure is recorded against
CA-ISSUE-004. A 30-minute, 15-second polling observer adds evidence collection;
the lead remains responsible for dispatch, independent review and advancing gates.
Direct CLI assignments recorded through state transitions do not yet have native
journal traces: the collector explicitly refuses their missing trace instead of
inventing progress. Persisted role assignments and native coding-worker dispatch
remain follow-up work.

**Human and AI supervision (2026-10-08).** The user authorized management,
observation and improvement through the task system. Athena's role-contract task
`d0a3d0bb-92a2-578a-8577-b7b47c77b049` was expanded to auditability and executed
by a read-only CLI worker. Its report, independent lead corrections, launch/exit
facts and timestamped GET snapshots are retained under
`D:/hekate-coordinator/plans/role-contract-audit-20261008/`.
The [shared supervision contract](implementation/13-hekate-plan-node-integration.md#managed-roles-and-shared-supervision-contract-2026-10-08)
defines role boundaries, causal evidence links, freshness/liveness distinctions,
public decision rationale, trust limits, bounded read-only monitoring and refusal
cases. It is implementation acceptance criteria, not a completed monitoring runtime.

The next role slice must include an evidence manifest, shared human/AI observation
projection and a rehearsal of failed, interrupted, stale and duplicate work.
Those deliverables are tasks in the same Hekate role plan, linked to managed wiring
and review validation. Each observer must identify the same attempt and exact
evidence; recommendations are distinct from authorized control operations. Keep
already authorized lead actions moving through explicit tasks and review gates.
Do not interpret new trace lines as useful progress or missing observations as
permission to relaunch. Session supervision is active; persistent unattended
monitoring, recovery and stronger independently anchored audit guarantees remain
unimplemented. Current CLI streams are restricted local evidence pending a
sanitized, managed viewer trace path.

The broader roadmap is now represented in the same Hekate project, alongside the
application sequence:

- **Reliability, recovery and evidence backlog:** plan
  `d6450921-6673-5535-b495-07cc165ada2d`, eight stored items: CA-ISSUE-004,
  CA-ISSUE-008, CA-ISSUE-009, recovery/fencing, handoff manifests and evidence
  binding, shared deployment, optional independent quality evidence and memory
  research. Existing deferrals remain explicit; these are pending specs, not
  running work or newly claimed completion.
- **Workflow defects and maintenance:** plan
  `9edb606e-59ff-536b-b1f2-541a2683c51e`, with CA-ISSUE-015 (Windows focus),
  CA-ISSUE-016 (formatting acceptance) and a source/evidence reconciliation task
  for remaining roadmap, documentation and CI commitments. The latter keeps
  historical assertions from being silently promoted into new work or forgotten.

Their import files, deterministic node IDs and readbacks are under
`D:/hekate-coordinator/plans/chatagent-reliability-backlog-20261008/` and
`chatagent-workflow-defects-20261008/`. PlanStore owns task state. Application work
remains the implementation sequence. Before its next launch, the user requested
role-based planning using the existing LangChain/LangGraph work. Planning task
`d03b6782-01e2-5fce-ade6-149fe746dcd0` under root
`29141a72-9c9a-54f8-a357-fb6db74d84d9` was assigned a bounded, read-only Claude
CLI worker. Its prompt, stream, exit result and reviewed report are retained under
`D:/hekate-coordinator/plans/gods-managed-planning-20261008/`. Planning is explicit
work, not invisible preparation outside the task system.
The planning artifact is now done and manually accepted with corrections in
`review.txt`; it is not implementation acceptance. Eight follow-up tasks are stored
in that same plan: role contract → read-only role adapter → managed attempt wiring
→ review/Active UI validation → resume the existing application plan, plus verifier
fail-open, CLI turn-bound investigation and CA-ISSUE-014 recurrence. Dependencies
require accepted predecessors. Follow-ups are scoped backlog, not runnable frozen specs.
The real planning task appeared in Active while running and its CLI exited successfully;
its stream remains a disk artifact until native managed trace wiring is implemented.

**Role direction:** Athena plans, Odin coordinates, Hermes executes, Mimir reviews,
and Hephaestus integrates. Roles define responsibilities and contracts independently
of model bindings. Reuse ChatAgent’s `src/app/roleCatalog.ts` and evaluate Hekate’s
existing, untracked `Odin/langgraph_engine/` before adding orchestration code.
LangChain supplies model/tool integration; LangGraph can express workflow steps.
Deterministic dispatch, attempt fencing and verification gates remain code, not
model judgment. PlanStore must own task/attempt/review state; checkpoints must not
override that authority. The local profile intentionally disables the gods dispatcher.

The experimental engine currently projects its own graph state into legacy
`orchestration.db` with best-effort writes, and its Mimir node returns `passed`
when the model verifier throws. These are integration blockers for managed work,
not claims about the existing managed runner. Review failure must remain unknown
or awaiting review, never accepted. This planning run is a supervised CLI invocation
with retained stream evidence, not yet execution through the LangGraph roles.

The `plan-status-api` reference proof also remains blocked: corrected route
inventory and all 26 oracle cases passed, but the full suite reproduced Windows
identity-rotation `EPERM` (CA-ISSUE-014, reopened). No API worker was launched.

Review baseline: ChatAgent `8a68f31`, clean before this review; Hekate `e27cae3`,
with unrelated local changes preserved. Source inspection confirms that
`scripts/devcoord.ts` provides read-only plan inspection and `--check` exit codes;
Hekate's `e1/plan_cli.py` supports persistent local runs, dependency gating and
separate CLI workers. The live API on port 5111 returned four earlier demonstration
plans. Those observations are fresh; the test counts and rehearsal outcomes below
are retained evidence, not a new full-system test run.

**Assessment.** The supervised coding loop exists and has delivered reviewed
artifacts. ChatAgent's conversation, document tasks, context controls and bounded
runtime are implemented foundations. Hekate has authoritative plan state, accepted
dependency gates, worker execution, independent verification, attempt traces and a
read-only task browser. The remaining product gap is joining these capabilities in
ChatAgent: selecting a plan, launching bounded work, seeing progress and reviewing
the result from the conversation. A recorded `in_progress` state does not prove
process liveness. A passing worker result does not by itself establish integration
or user acceptance.

The user requested this review, a stored Hekate plan, and execution of its first
task with this assistant driving and monitoring. The plan is **ChatAgent supervised
development from the conversation — 2026-10-08**, with the sequence below. PlanStore
owns live state; this table defines scope and acceptance, not a duplicate task
ledger. Execution remains one task at a time through the existing local runner.

Stored plan root: `b556d4ce-b813-50fa-8ac5-3633297518a6`, in the existing local
coordinator project `198f91ad-9a47-44d0-823e-c3e7993dc10f`. Its immutable import is
`D:/hekate-coordinator/plans/chatagent-app-20261008/plan.json` (SHA-256
`925544720a65fb9bdc1b46bcd0440d6f32e474bb59022ca1e527477fa1068248`).
Readiness and import readback are retained alongside it. Select the plan by title
in the Hekate Tasks/Plans browser at `http://localhost:5193/`; refresh is explicit.

| Node                        | Deliverable and acceptance                                                                                                                                                                                                                                                                                                                                                                | Dependency                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `monitor-runbook`           | README instructions for the existing read-only status command, loopback configuration, JSON output, progress exit codes and liveness limits. Frozen oracle, full suite, typecheck and documentation checks; independently review the worker diff.                                                                                                                                         | None                        |
| `plan-status-api`           | Opt-in ChatAgent read-only plan-status endpoint reusing `fetchCoordinationStatus`. Bound requests, preserve local authentication/ownership rules, distinguish unavailable from complete, and reject invalid roots and unsafe URLs. HTTP regressions prove no write or worker launch.                                                                                                      | `monitor-runbook`           |
| `plan-status-ui`            | Attach a selected plan root to the visible conversation and render dependency, attempt and review states. Browser tests cover scope switching, reload, unavailable API and historical decisions. Show observed time and unknown liveness honestly.                                                                                                                                        | `plan-status-api`           |
| `bounded-plan-launch`       | Host adapter invokes the existing Hekate persistent local runner using an explicitly prepared plan, approved workspace/tool pins and limits. No arbitrary shell input or second scheduler. Prove duplicate-submit refusal, unavailable coordinator, bounded output and uncertain/in-flight stop behavior. Settle viewer/runner API ownership before launch.                               | `plan-status-ui`            |
| `conversation-run-controls` | A conversation action selects a prepared plan and starts its next permitted work through the adapter. Persist correlation to plan/run/attempt and expose started, stopped, awaiting review and unavailable outcomes. Define safe stop semantics; never portray killing a process as completed rollback. Browser and HTTP tests cover duplicate clicks, reload and conversation switching. | `bounded-plan-launch`       |
| `attempt-progress-view`     | Expose Hekate attempt conversations and tool events in ChatAgent, with bounded incremental refresh and cancellation on view disposal. Keep verifier decisions separate from worker claims. Test truncation, unavailable trace, attempt changes and refresh cleanup.                                                                                                                       | `conversation-run-controls` |
| `integrated-rehearsal`      | Run one useful bounded change from ChatAgent, watch worker and verifier evidence, review the exact accepted artifact, integrate it separately and reload the conversation. Retain commands, revisions, test results, trace identities and observed limitations. Demonstrate a refused or failed launch without a duplicate worker.                                                        | `attempt-progress-view`     |

The first four nodes are accepted. The three remaining nodes stay
`spec_pending` until their predecessor artifact is reviewed and their own frozen
acceptance and satisfiability proof exist. The existing adapter refuses package,
lock and dot-configuration edits; the first node therefore documents the existing
`npx tsx scripts/devcoord.ts status` command rather than adding an npm alias.
Future tasks must respect those restrictions or explicitly extend the adapter in
a separately reviewed increment. Do not weaken the runner to fit a task.

First execution evidence: run `2adf0389b8ab`, attempt `pilot-2adf0389b8ab-r1`,
accepted artifact `1b9d2d24303eb5faae623bdb71df9636fb12f907`. The pinned task base is
`f8735d1`; spec SHA-256 is
`601cde42a2dc467a7cb4941fd69224a30504790876ed1976447c2b956e8579e0`.
The independent verifier passed the two-case oracle, typecheck, documentation
contracts and 2,353 tests with nine opt-in skips. The worker reported unavailable
shell tools, so its own formatting/lint claims were not used as evidence. The lead
reviewed the exact README-only diff and integrated the artifact with its ancestry;
Prettier's table alignment is a separate formatting correction. CLI-reported usage
was $0.0640438 over 11 turns, within the $1/40-turn/two-round bounds.

The run stopped with `spec_pending` at `plan-status-api`; dependency readiness is
not executable readiness. Its persistent state and accepted first node remain in
the coordinator. Evidence is under
`D:/hekate-coordinator/runs/chatagent-app-20261008/monitor-runbook/pilot-2adf0389b8ab/`.
ChatAgent monitor snapshots and the run result are beside the plan import. An
initial launch refused the missing container-workspace selector before dispatch;
the corrected launch used the maintained `HEKATE_E1_CONTAINER_WORKSPACE` setting.
The read-only viewer was stopped through its own STOP marker for runner ownership
and reopened after the run. No unattended recovery was added.

Integration checks passed: required format/lint, documentation contracts (seven
symbols, 15 invariants) and 13 focused monitor/oracle tests. A live browser check
opened the accepted task and displayed “Attempt finished; trace matches its
recorded hash.” Its 15 API requests were all GET; screenshots and the request
manifest are beside the plan import. The viewer restart required restoring
`HEKATE_TRACE_ROOT=D:/hekate-coordinator/runs`; without it the trace was unavailable.
The Tasks UI at port 5193 was also restarted from clean Hekate `e27cae3`.

For each node, the assistant checks authoritative readiness, prepares its exact
base and allowlist, reviews the frozen oracle/reference proof, launches at most
one worker, monitors plan state and retained attempt evidence, reviews the
verifier result and exact diff, and records integration separately. Stop on stale
pins, rejection, uncertain effects, missing evidence or exhausted bounds. Preserve
failed attempts. This is active session supervision, not a promise of unattended
background monitoring after the session ends.

Deferred work remains explicit: CA-ISSUE-004 unattended recovery; quota
reconciliation and persistence (008/009); wider recovery/fencing and manifest
publication; shared deployment; optional answer-quality evaluation; and memory
consolidation research. None is silently closed by the visible application loop.

**Documentation correction.** The older checkpoint and step 6 foundation table
below describe their dated baselines. Their statements that real coding workers
and persistent plan execution are absent have been superseded by the October 8
rehearsals and current source. Retain their evidence without treating those stale
absence claims as current blockers. The current product gaps are the seven nodes
above and the explicitly deferred work.

**Priority update (2026-10-08, user direction).** Make the useful happy path
visible before extending hardening: create one bounded plan, watch its worker
execute in the existing Hekate Plans UI, and review the accepted result and its
integration. The next demonstration adds a development-workflow overview and
links to the existing UML in the repository README. Use the existing runner,
verifier and browser; keep the normal review and validation needed for that task.
The initial browser demonstration needed manual refresh and exposed plan state
and events. The trace increment below adds observable worker conversation;
verifier progress and automatic refresh remain later work.

**Demonstrated (2026-10-08).** Plan `readme-001` (task base `2ebd31e`, one
README-only node with a frozen four-case oracle) ran through the existing runner.
The worker artifact `44b67b5` was accepted in round 1 (run `387015eba30a`) and is
integrated unchanged as the README "Development workflow" subsection; an
independent clean-worktree check passed the oracle, the full suite, `tsc` and the
documentation check. The Plans browser showed the run live, driven only by its own
Refresh button: todo, in progress, done, then done and accepted with the artifact
and review evidence. The retained capture under
`D:/hekate-coordinator/view-ca004-001/captures-readme-001` holds eight frames and a
manifest of 93 API requests, all GET. Observed limits: no automatic refresh; no
view while the runner's API builds or after it stops, so the accepted frame came
from the read-only view reopened after the run; and no worker conversation,
verifier steps or attempt trace. The product target below is the next increment.

**Product target (2026-10-08, user direction).** Run this development workflow
outside VS Code: the application hosts the main conversation and review, Hekate's
database holds the plan and node state, and Claude CLI or Codex CLI executes a
node in its assigned repository worktree. Each node owns its context, tool scope
and observable execution conversation; each attempt retains a separate trace.
Persistent repository-wide worker conversations are unnecessary. After the
current demonstration, prioritize the smallest usable path toward this target:
inspect the existing Claude execution path, add Codex execution where missing,
and expose node/attempt conversation and tool events in the UI. The local
CLI/trace increment below demonstrates that execution path. Hosting the main
conversation and launching plans from the application remain product work.

Current increment: per-attempt prompt/stream capture, the read-only trace endpoint,
the central conversation viewer and both CLI worker adapters are integrated in
Hekate at `1a3b6d9`. Independent checks passed 95 capture/CLI tests, 21 initial UI
trace tests, 20 pure endpoint tests and 18 Codex adapter tests; retained
implementer checks include 387 capture tests with one opt-in skip, 192 pure and
66 disposable-database endpoint tests, and 22 UI trace tests after the layout
follow-up. The viewer displays messages, tool calls/results, stderr and final
usage separately from Hekate's acceptance decision.

Live rehearsals reused the frozen README task without changing its spec or oracle:

- Claude plan `readme-trace-001`, run `71e5acf5dcaa`, was accepted in round 1.
  Its prompt and 37-record trace match their recorded hashes. The browser showed
  the conversation during execution and the verified trace after completion.
- Codex plan `codex-trace-001`, run `6640483a3350`, was accepted in round 1.
  Its prompt and 12-record trace match their recorded hashes. The trace contains
  a real README file-change call/result and three shell startup failures.
  Acceptance came from Hekate's independent verifier: oracle, typecheck,
  full suite (2,351 passing, nine skipped) and documentation check all passed;
  the worker explicitly reported that its own validation could not run.

Retained browser captures are under
`D:/hekate-coordinator/view-trace-001/captures-trace-001` and
`captures-codex-001`. The latter records 128 API requests, all GET, and ends with
accepted state and verified trace. The local viewer runs on API port 5111 and UI
port 5179. It requires explicit refresh/check-for-new requests; temporary API
shutdowns during runner/viewer ownership changes remain visible as unavailable.

The Codex adapter uses standalone Windows CLI 0.157.0 without VS Code. Its
workspace-write sandbox bounds shell access, but does not enforce a per-command
allowlist or the Claude dollar/turn flags; supervisor time and output bounds
remain enforced. The accepted Codex rehearsal exposed packaged PowerShell access
denied under the unelevated sandbox. A Codex-only PATH correction at `c063455`
removes both the shell alias and packaged-app directories. The subsequent real
`codex-smoke-005`, launched from PowerShell, completed a UTF-8 shell read and an
exact file addition with empty stderr; retained event hashes were independently
verified. The earlier failed attempt remains intact. A complete node rehearsal
after that correction has not been repeated.

**Task navigation (2026-10-08, user direction).** The Hekate application now has
an additional Tasks view (integrated at `e27cae3`) for Active, Saved and History, with List and Board
layouts. Filters combine plan, text search, status, effective review decision and
readiness; History adds an event-kind filter. Saved means all stored tasks,
including completed work; Active means the recorded state is `in_progress`, not
an assertion of process liveness. Selecting a task opens its fresh detail and
attempt conversation; a history event opens its recorded attempt. Returning to
the catalog retains the filters and layout.

This increment uses the existing GET-only API, loading 20 plans per catalog page
with four concurrent plan reads. Counts/search cover loaded plans; Load more
exposes the remaining plans and each plan's history pages. Refresh is explicit,
and filters are not saved across page reloads. Task creation, saved drafts,
execution controls and launching plans from the main chat remain next product
work. Hekate plan 049 records the behavioral contract. The live preview is
`http://localhost:5193/`, backed by viewer API 5111. Its capture under
`D:/hekate-coordinator/view-task-navigation-001` records four stored tasks and
12 history events; opening the Codex node shows its verified trace, with 18 API
requests, all GET. Existing demo services on 5179 remain available. The full Hekate UI browser suite
passed 81 tests, including eight new navigation tests; type checking and production
build passed. Changed navigation modules and tests pass ESLint; full UI lint still
has two pre-existing errors and three warnings in App, ChatPanel and DebugPanel.

Later research candidate, requested 2026-10-08: Cognition's
[Memory and Dreaming](https://devin.ai/blog/memory-and-dreaming) and
[Agent Memory Repo](https://cognition.com/agent-memory-repo). Evaluate reusable,
source-linked lessons and periodic consolidation after the CLI/trace happy path.
Keep original attempt traces and authoritative plan state separate from derived
memory; this is a research reference, not an installed skill or scheduled job.

All remaining items are retained as **later work**, not removed or declared
complete: recovery envelopes and manifest publication, evidence-binding CLI and
UI checks, recovery/continuation and fencing, ongoing-work stall detection and
automatic resumption, further reliability work, shared deployment and optional
quality evaluation. Preserve their contracts, issue entries and existing
evidence. Resume those items after the visible happy path has been demonstrated
and reviewed; they are not new gates for this demonstration.

**Priority update (2026-10-07, user direction relayed by the ChatAgent lead).** The
first pilot is a usable, supervised local loop for one bounded development task:
implementation, independent verification and validation, correction, commit and a
fresh handoff. Verification and validation are part of that loop, not a later
phase. Human-labelled benchmarking is deferred to optional quality evaluation: it
is not a blanket gate for working-tool increments, though any claimed
factual-quality improvement still needs it (step 5). Shared deployment is outside
the first pilot. Step 6 describes the loop; the Hekate handoff consumer and plan
integration are its current path. Work faster where it does not reduce quality.

Known defects and gaps are tracked in the [open-issue register](open-issues.md) by
`CA-ISSUE-NNN` ID. CA-ISSUE-001, CA-ISSUE-002 and CA-ISSUE-003 are verified and closed
for their recorded scopes. Remaining pilot dependencies belong to Hekate's worker
integration. Unattended blocker: CA-ISSUE-004
(idle lead/worker recovery). Hekate- and bridge-owned dependencies are linked there
to their owners' registers.

### Visible conversation history correction (2026-10-08)

Documentation questions, results, failures and cancellations now render as task
turns within the same visible history as ordinary chat, ordered by persisted task
creation time. Reload and conversation switching retain the correct projection;
background tasks remain separate from the chat event store and model context.
Successful task submission clears the unchanged composer text. The conversation
scope note now sits below both ID fields so their labels and inputs align.
Browser regressions cover mixed chat/task ordering, reload, cancellation, scope
changes, literal model text and desktop/mobile field layout. The Python bridge
regression checks that task creation time survives completion and restart.
Validation on pinned Windows Node 24.21.0: 2,219 TypeScript tests and 36 browser
tests pass; six Python bridge tests pass under the uv-managed interpreter.
Formatting, lint and documentation contracts pass. The live UI rehearsal completed
conversation recall, a cited documentation answer and task cancellation.

UI clarity follow-up: the optional action is now **Ask project docs**. Completed
task replies distinguish answered, insufficient evidence and unavailable answer
outcomes while preserving execution status, text and citations. Foreground budget
readouts name estimated input used, input capacity and remaining capacity, and
show the full window and reserves. Input capacity honors the smaller of available
window input and an active role's input limit. Budgeting and execution behavior are unchanged.
Focused browser regressions cover answer outcomes, legacy results, reload and
budget arithmetic against the admitted timeline event, with and without an active
role. Five focused unit tests and all 39 browser tests pass on pinned Windows Node
24.21.0; formatting,
lint and documentation contract checks pass.
The full TypeScript suite at `4d1fa16` subsequently passed all 2,230 tests across
157 files, with no skips. Retained log: `node_modules/.cache/main-4d1fa16-full-validation.log`
(SHA-256 `ac5f0e4c076933302939080fe281dbd7d1445fde93ed4e287c4e4486f76dace2`).

### Active supervised plan loop (2026-10-08)

The [UML architecture diagrams](development-workflow-uml.md) show the conversation
and documentation path, the evidence readers, the supervised development loop and
the initial-response classifier, with implementation status and design reasons.

The loop's CA-ISSUE-014 task is complete: safe Windows identity replacement, with no
missing-file interval and no new principal. ChatAgent's implementer owned the
mechanism, the frozen acceptance tests and the satisfiability reference. Hekate's
implementer owned task authoring and the plan and run package. The lead reviewed each
frozen revision before execution and before integration.

- **Evidence before authoring:** a deterministic delete-sharing-reader reproduction
  and a native replacement probe.
- **Authoring and the run (root GO 2236):**
  - The frozen oracle has 19 cases: 17 assertion failures and two passing controls at
    base `ec39a9b`.
  - The reference proof passed the oracle, typecheck, the full suite (2,240 passed /
    nine skipped in the isolated clone) and the documentation checks.
  - Spec SHA-256: `2eac3967fafe7b74f4ed5b13f755cddc336d71bafe8dfddc4bc5ad4dfb454e8c`.
  - Coordinator state: `D:/hekate-coordinator/state-ca014-001`; run:
    `D:/hekate-coordinator/runs/ca014-001`.
- **Worker result:** run `22ac83497795` was accepted in round 1 (artifact `89432e9`;
  CLI-reported $0.37, 20 turns). ChatAgent Claude reviewed it independently.
- **Integration corrections:** the lead's review of the immutable artifact found two
  helper-transport defects: a deadline-killed helper could still yield a result, and
  the output cap was checked after appending. Both were corrected in a separate
  integration commit, with a regression that fails on the artifact as accepted.
  Existing non-delete-sharing refusal and retry behavior is unchanged.

PlanStore owns the task state. The
[issue entry](open-issues.md#ca-issue-014--identity-rotation-can-fail-on-windows-with-eperm)
records its node reference, the closure for holders that share delete access, and the
remaining limit.

Hekate's bounded host-observed provenance is integrated at `2066614` (HK-ISSUE-016
closed for that metadata scope).
The epoch/ref-only guarded takeover primitive is integrated at `521d33e`, with
eight independent tests passing. It does not reconcile a stream or authorize
any historical disposition. The pending-effect inspection fix is integrated at
Hekate `9778b7e`: operator-closed intents remain visible while later intents and
arbitrary reservation mismatches still fail closed. The follow-up HK-ISSUE-017
fix protects new resolutions and retains legacy uncompacted records during time
compaction and pressure eviction. Its source is reviewed at `274e71f`. The broader
suite passed 1,193 tests with one skip and exposed a previously missed replay
revision check. The correction at `61e254b` preserves frozen bundle bytes and
strict replay results; 97 independent focused tests pass. The stack is integrated
at `61e254b`, preserving all pre-existing dirty paths and frozen fixture bytes.

ChatAgent's current increment is read-only initial-response detection for named
bridge assignments (CA-ISSUE-004). The bridge and transcript readers, CLI and
classifier are integrated. The readers and CLI landed at `8edbbd7`. The classifier is
the supervised worker artifact `87e4601` (plan `ca004-001`, accepted in round 1;
CLI-reported $0.15, nine turns), carried unchanged, then formatted in a separate
commit. A real transcript larger than the 1 MiB tail reads as `session_unknown`. This
increment neither resumes agents nor detects ongoing-work stalls; CA-ISSUE-004
remains open.
A live adoption check linked each Claude's initial reply to its assignment. The
CLI observed both correlations: Hekate's own credential was authenticated;
ChatAgent's proxy reply was reported with its declared role and session. Final
classifier integration checks passed 2,347 TypeScript tests with nine skips and
all 39 browser tests, plus lint and documentation contracts.
Hekate's pure recovery projection is integrated at `5e55ac7`, with 56 independent
tests passing. It lists caller-supplied sanitized observations and preserves unknown
effects and missing evidence; it has no recovery authority. Its separate read-only
journal collector library is integrated at `d7b51e2`. Collection uses one journal
transaction, capped reads and whitelist sanitization; its deadline is soft, and it
has no CLI or output-file writer. Manifest publication and evidence-binding checks
are retained later proposals, behind the visible happy-path demonstration.

The existing Hekate Plans browser was exercised against the completed `ca004-001`
plan: tree, node details, dependency map and event history matched its accepted
first attempt and worker artifact. The retained capture under
`D:/hekate-coordinator/view-ca004-001/captures` recorded nine API requests, all GET.
The local demo uses UI port 5179 and API port 5111; service lifetime is separate
from this retained evidence.
The HK-ISSUE-015 recovery/continuation design is under revision, with fencing,
truthful unknown outcomes and cross-run attempt
bounds still open. Historical `check-002` stays stopped and unchanged. Bridge
delivery or polling presence does not establish that a model is executing.

### Historical handoff checkpoint — 2026-10-07

This checkpoint describes the October 7 baseline. The October 8 review and stored
application execution plan at the top supersede its execution-gap statements;
historical milestones and their validation evidence remain below:

| Area                | Current scope                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime reliability | Local limits/authentication, cancellation, discovery/reload and document-task recovery; declared quota windows, per-call settlement/lower bounds, operator quota view and legacy idle-poll optimization implemented; 2,104 TypeScript tests pass; the latest browser checkpoint passed 34 tests                                                                                                                                                                           |
| Documentation pilot | Accepted three-component reference; 7 symbols and 15 behavioral invariants pass contract checks; historical independent-review and artifact evidence below                                                                                                                                                                                                                                                                                                                |
| Hekate              | Durable claims/pins, browser, H1 and bounded E1 interop accepted; E2a, E2b-a, E2c, E2d and E2e disposable fixtures accepted by the Hekate lead (`d0ed671` plus reviewed overlay, plans 029–035). E2e: 597 default checks, 33 pinned interop checks and 4 live-fixture checks. Reviewed reference fixtures imported; ChatAgent byte-reader, verification and offline composition accepted; offline CLI and host slot accepted; no production journal, real workers or wake |
| Open gates          | First pilot: the smallest supervised local task → independent V&V → fix → commit → fresh-handoff loop. Still open: fixed/rolling quota reconciliation and unattended recovery. Outside the first pilot: shared deployment. Optional: human-labelled quality evaluation                                                                                                                                                                                                    |

Read the [runtime reference](runtime-reference.md), the relevant implementation
contract and its evidence, and the [bridge workflow](agent-bridge-development-workflow.md).
`npm run docs:build` generates `dist/docs/index.html`; `npm run docs:check` checks
the pilot contracts, and `npm run docs:graph` generates the static import graph.
The dated validation paragraphs below retain their original slice scope.

**Lead review decision (2026-10-06):** `codex-chatagent` accepts step 1 within
the measured, scaled-down, scripted in-process scope and the reviewed single-process
loopback boundary at `fcceff2`. This is engineering acceptance, not user acceptance
of production operation. The
[acceptance report](measurements/sustained-memory-acceptance-2026-10-06.json)
passes 163 assertions and heap tolerance; its
[provenance](measurements/sustained-memory-acceptance-2026-10-06.provenance.json)
records 151 source files with digest
`4e065abbaf0d509bf09a89b5557c1403d4ed96855084bea44189251dc86c6fbf`,
matched to the accepted source. Primary validation passed 1,272 TypeScript tests
across 131 files and 34 browser tests; independent lead review ran 92 focused tests.
Hekate's read-only plan browser is lead-accepted at `bb2af8b`, including ChatAgent
consumer review. Its lead reports 172 pure, 51 live-store and 66 HTTP checks,
51 repository browser/parser tests plus one temporary visual check (52 total),
and passing typecheck/build/scoped lint. Full lint retains the disclosed baseline
diagnostics. Hekate's plans 021/022 record the exact scope and evidence. Shared
supervisor/context ownership, H1 and bounded E1a/E1b fake-worker interop are
lead-accepted. ChatAgent
execution/recovery and bridge visualizations are not implemented by this browser.

HTTP boundary review fixes are committed in `f9c578f`: `/sports/chat` now parses
and validates its body outside the scope-specific catch, preserving shared HTTP
errors. Enabled-route regressions cover declared and chunked overflow, status/code,
connection closure and absence of downstream operations or conversation claims.
The default-limit test now omits the option explicitly, accepts valid JSON padded
to exactly 1 MiB and rejects one byte beyond it. Temporary mutations restoring the
catch bug and lowering the default to 256 bytes each fail their targeted tests;
both are reverted. Validation on Windows Node 24.21.0: 931 tests across 108 files
and 29 browser tests pass. That historical slice did not establish concurrent-request
or stream bounds; later step 2 increments below cover their stated limits.

The October 5 review findings are resolved: conversation changes preserve the
in-flight submission lock and stale send errors cannot alter the new conversation;
custom queues without removal retain cancelled retry resources until physical
dequeue. Regression coverage exercises both races. Validation on Node 24.21.0:
886 tests across 106 files, 29 browser tests, format and lint pass.
The later lead decision above accepts step 1 only within its measured scope.

Conversation retention, dead-letter admission and quota-pool cardinality limits are
implemented, including review fixes for overflow terminal publication, protocol
identity allocation and dead-letter snapshot/byte accounting. The working baseline
is the latest commit on this branch (`git log -1`); older commit hashes and
validation counts below describe prior slices. The quota-pool slice includes the
review fix: explicit constructor limits are validated and copied, so invalid
values or caller mutation cannot bypass the cap.

The step 1 retained-state inventory is complete: see "Retained-state inventory"
under step 1. It enumerates every process-lifetime store, pending-work registry,
timer and buffer with its owner, limit, cleanup trigger and dependent references.
It is a code-read enumeration backed by regression tests, not a measurement.
Review also fixed a worker recovery gap: attempt creation after dequeue now runs
inside dead-letter recovery, so expired history cannot silently lose a task. The
boundaries it found are listed there: findings 2, 3, 5 and 6 are now bounded;
finding 1 is bounded by the committed turn-admission limit (`b578256`), and
finding 4 by the implemented and reviewed event-stream limit and write-backpressure
slice. Ordinary HTTP connections are limited by `HTTP_MAX_CONNECTIONS` (2026-10-06).
Authenticated shared deployment remains open. Finding 7 is closed for the measured scope.

Expiry UI, coordinated identity retirement and the assembled-runtime
sustained-memory gate are implemented; see the two entries after the inventory.
The gate passes for its stated scope and exclusions. This increment, with the
review fixes described below, is committed in `d9ef86d`. Validation on
Windows Node 24.21.0: 875 tests across 105 files, 28 browser tests, formatting
and lint; the strengthened memory gate also passes. No live
provider calls or service restart.

Step 2 has three increments. The first, committed in `f9c578f`, is a streaming
request-body limit and a local-only deployment boundary (loopback bind, `Host`
and `Origin` policy). The second, committed in `b578256`, is the
admission limit on concurrent turns (inventory finding 1): `CHAT_MAX_CONCURRENT_TURNS`
refuses a further submission with 429 `TURN_CAPACITY` before anything is claimed,
and a turn holds its slot until its detached inline retrieval settles. The third,
implemented and reviewed in this increment, bounds event streams (inventory finding 4):
one shared `HTTP_MAX_EVENT_STREAMS` limit across the legacy and v1 stream routes,
and bounded buffering for slow clients with a stall deadline. See the increment
entries under step 2 for contracts, decisions and what they leave open. All were
started at the user's direction; none records a step 1 acceptance decision. The
second increment re-read the first against its contract while wiring the new
limit through the same error path and found no divergence; that is a code read,
not an independent review. The third was reviewed continuously by
`codex-chatagent` over the agent bridge while it was implemented.

**Acceptance and deployment checkpoint:** step 1 is lead-accepted within its
measured scope. Local authenticated ownership of conversations, result handles,
tasks and operator endpoints is implemented; shared deployment remains open. The user
approved a local-first design with one trusted installation principal. It is now
activated, meaning the source enforces it for newly started servers (no running
service was restarted):

- every request passes the local boundary and a default-deny route table before
  routing, and protected routes require the principal;
- browsers pair through `/pair`;
- local commands send least-privilege tokens, and only to loopback addresses;
- legacy client routes cannot reach protocol v1 conversations, while operator
  retention, retirement and replay still can;
- the operator dead-letter view is redacted.

Evidence on Windows Node 24.21.0:

- 1027 tests across 119 files and 34 browser tests pass, with format and lint.
- Temporary mutations that disabled the access decision, the cookie Origin rule,
  the repeated-header check or the v1 guard each failed their tests.
- The sustained-memory gate passed 160 assertions with heap within tolerance
  (run 2026-10-06T18:29Z). Its report was written to the ignored
  `node_modules/.cache/auth-gate/`, and no tracked measurement was modified.

Known side effect: before a test was isolated, one test run created a real
installation identity in the user profile (`%LOCALAPPDATA%\ChatAgent`). It was
left in place; whether to keep it is the user's decision.

Ownership is now per principal:

- owners are principal-scoped 90-character keys across conversations, v1,
  results, games, briefings and document tasks;
- reads without an owner check the principal;
- unclaimed conversations are visible only while empty, with a re-check on every
  stream read;
- legacy document-task rows are preserved and unreachable, and retirement fails
  closed on them.

Two principals are exercised only in tests: 12 cases in
`tests/integration/principalOwnership.test.ts`, plus a real-sidecar Python
regression. Still open for step 2: a second principal type in production (for
example a shared login), adoption of legacy document-task owners, and the
decision to allow shared deployment, which stays refused. See
[local authentication](implementation/14-local-authentication.md) and the runtime
reference.
Rolling-window reconciliation belongs to step 3.

Declarative development coordination is now a planned workstream; see step 6.
Its contract design and a bounded mailbox experiment may accompany existing
reliability tasks, but do not replace this execution order or record acceptance
implicitly. Production workflow execution and recovery follow the relevant
reliability gates. The manually supervised multi-agent workflow used meanwhile is
described in the [agent-bridge development workflow](agent-bridge-development-workflow.md).

On 2026-10-06 the user directed a parallel workstream: Hekate plan-node planning
on this machine, with Hekate started locally on demand. The ownership split and
first pilot boundary are in the
[Hekate plan-node integration contract](implementation/13-hekate-plan-node-integration.md);
see step 6. This direction does not accept step 1, close step 2, or authorize
remote execution or durable-recovery claims. The event-stream slice of step 2 was
later resumed at the user's direction and is the third step 2 increment.

Hekate's plan-only local profile is committed as `b94c276`. Its lead and Hekate's
`scripts/local/VALIDATION.md` report live lifecycle, plan/dependency persistence,
backup and repaired fresh-restore gates passing, with final 49/49 Pester tests.
The profile is stopped with image, volume and data retained; see the contract's
local-profile entry for evidence scope and remaining limits. Pure plan-node
contracts are committed as `3fb3663`, with 101/101 tests in a clean isolated
dependency closure, and source recovery as `a1f8237`, with 26 gateway and 30 Odin
offline tests, as reported by `codex-hekate`. Managed-plan store integration
(increment 2b1) is accepted by that lead at `9bc2cec`: PostgreSQL-authoritative
new roots, compare-and-set operations, whole-graph validation and legacy-writer
fences, with identity-only AGE projection in the same transaction. Independent
Hekate checks passed 132 pure, 25 live-store, 28 HTTP and 50 launcher tests.
AGE availability is required for plan writes; no outbox is used. The API is
opt-in and local-only. Legacy enrollment, execution integration, authentication
and UI remain deferred, and full database credentials remain trusted. See the
integration contract for evidence and remaining writer-path limits. The attempt
provenance audit (increment 3a) is accepted by that lead at `31274bc`: applied
attempt, decision and content-revision operations derive append-only, per-plan
sequenced audit events in the same transaction, with read-only event cursors;
claim-next, durable claim receipts and worker execution remain deferred.

Do not infer whole-process memory bounds from individual store limits. Keep
self-graded quality separate from calibrated factual evaluation.

Use Node **24.21.0** from `.node-version`; the machine-wide Windows 24.15.0 runtime
has a reproduced native crash. Switch PATH to the pinned runtime before using npm.
Validate with `npm test`, `npm run format`, `npm run lint` and `npm run test:browser`.
On this workstation the evaluated Windows executable is
`node_modules/.cache/worker-diagnosis/new24/node.exe`; it is a local convenience,
not a required repository artifact. Read `AGENTS.md`, preserve generated evidence,
and keep the two excluded local review documents out of Git. No live provider
calls or service restart were needed for these retention changes.

Earlier prototype baseline (2026-10-01): configurable roles, selected evidence,
separate display payloads and native/graph execution comparisons. The four delivery,
grading, review and reference-layout fixes are committed in `c9ce23f`; their
last verification was 740 tests / 95 files, 26 browser tests and TypeScript build.
These results establish covered behavior, not sustained-operation or calibrated
factual-quality guarantees. Subsequent reviewed milestones and open commitments
are recorded in the current checkpoint and numbered reliability steps above/below.

Formatting maintenance is implemented ahead of further retention work: the overflow
fix is committed in `ccfeba3`, pinned Prettier tooling in `e9f1238`, and mechanical
formatting in `f6f4f08`. `.git-blame-ignore-revs` records the mechanical commit.
Generated evidence, measurements and local review files are excluded; Python
formatting remains separate. CI checks formatting through `lint` / `verify:release`.
Formatting, TypeScript and 26 browser tests passed. Intermittent worker exits were
subsequently reproduced with diagnostic instrumentation: Windows Node 24.15.0
aborted with `3221226505` / `0xc0000409` during HTTP tests. A standalone script using
only `node:http` and built-in `fetch` reproduced the same exit during a request,
without application imports or Vitest; a copied executable reproduced it too.
This isolates the failure to the native runtime/platform boundary. No native stack
was captured, so the precise internal defect is not established; do not attribute
it to a particular upstream shutdown bug based only on the exit code.

Node 22.23.3 passed 200 isolated HTTP reproduction processes and three complete
803-test suites (one with a single worker, two with two workers). Node 24.21.0
passed 100 controlled reproduction processes and the suite. Following the comparison
below, `.node-version` now pins Node 24.21.0 for development and both CI jobs;
Windows CI now exercises it, and Vitest rejects the confirmed-bad Windows 24.15.0
runtime before running tests. `npm run diagnose:http` preserves a bounded,
dependency-free reproduction and stops on the first failure, without retries.
Large consecutive stress batches also exhausted temporary TCP ports and produced
ordinary connection errors; those were recorded separately from the native exit.
Temporary Vitest instrumentation was restored. The machine-wide Node installation
is unchanged: switch the development shell to the pinned version before testing.
Formatting and TypeScript checks pass. The new Windows CI job is configured but
has not yet run on GitHub; Windows acceptance used isolated x64 executables.

#### Runtime baseline evaluation (2026-10-01)

Decision approved: adopt Node 24.21.0 as the primary development and CI baseline.
Node 22.23.3 remains an evaluated fallback if deployment constraints require it;
it is no longer the project pin. Both candidates satisfy
every declared Node engine constraint in the current lockfile. The existing
`@types/node` 22 package is a compile-time API baseline, not a runtime requirement
to stay on Node 22.

| Check                                | Node 22.23.3        | Node 24.21.0                  |
| ------------------------------------ | ------------------- | ----------------------------- |
| Lockfile Node engine constraints     | All satisfied       | All satisfied                 |
| Complete 803-test suite              | 3 passes            | 3 passes                      |
| Isolated HTTP reproduction processes | At least 200 passed | 200 passed across two batches |
| Browser acceptance                   | 26 passed           | 26 passed                     |
| TypeScript check                     | Passed              | Passed                        |

As of this evaluation, Node 22 is Maintenance LTS with support ending 2027-04-30;
Node 24 is Active LTS, enters maintenance on 2026-10-20, and ends support on
2028-04-30. These dates come from the official
[Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
Node 24 therefore gives another year of support and keeps development on the
already-installed major version. Existing Node 22 CI is migration work, not a
compatibility requirement. Node 26 is still Current until 2026-10-28 and need not
be introduced to resolve this issue.

The comparison used the same checkout and installed dependencies with isolated
Windows executables, no global runtime replacement and no test retries. Adoption
also passed a clean `npm ci`, `npm run verify:release` (803 tests, lint, evaluation
report and simulated benchmark gates), and `npm run build` using the checksum-verified
Linux x64 Node 24.21.0 release in an isolated checkout. Generated reports stayed in
that checkout. Hosted CI and Linux browser acceptance remain unrun; the earlier
26-browser-test pass was on Windows. These checks do not establish live-provider
behavior, a performance advantage, or the precise cause of the old native crash.
Pin the chosen patch for reproducibility and keep updating it for fixes; do not
freeze it indefinitely.

### 1. Bounded retention and sustained operation — in progress

First slice committed in `c9ce23f`: coordinator retention. Reproduced capacity
failure on the third sequential request with `maxRuns: 2`; 50 sequential requests
now complete with bounded run/request/profile/settlement indexes and zero settled
jobs/waiters retained. Queued/running/draining adapters remain protected. Known
`BRIEFING_CAPACITY` errors survive the chat tool boundary; other exception details
remain hidden. Tests cover retry conflicts/expiry, pressure, cancellation, waiters
and reduced limits on reload. Full verification: 746 tests / 95 files and TypeScript
build passed. No live provider calls, preview restart or commit.

Settlement/eviction review gap closed: a deterministic microtask test evicts the
completed run before either waiting continuation resumes. Both callers receive
independent completed snapshots; new lookups fail and the replacement run completes
with bounded indexes. A temporary mutation that re-looked up the evicted run failed
this test with `BRIEFING_NOT_FOUND`, confirming the intended interleaving is exercised.
The mutation was reverted; runtime behavior needed no fix. All 19 coordinator/HTTP
tests and TypeScript build passed. No commit.

Configuration: sports `coordinator.settledRunTtlMs` defaults to 300000 (five minutes),
range 1–86400000 ms. `maxRuns` still bounds active plus retained runs (default 20).
Cleanup is lazy on access/start/reconfiguration; under capacity pressure the oldest
settled, fully drained run is evicted before TTL. Retained identical request IDs
return the same run and conflicting requests fail. Retention does not extend on
reads/retries. After eviction/expiry an old run ID returns `BRIEFING_NOT_FOUND`, and
reusing its request ID creates new work: this is bounded process-local deduplication,
not durable exactly-once execution. Needs-input-only settled runs are also eligible;
there is no resume-in-place API for those runs. Reducing capacity never evicts active
work; new admission waits for available space by returning `BRIEFING_CAPACITY`.

Second slice committed in `c9ce23f`: lifecycle/dispatch retention. Reproduced 12
completed turns retaining 12 lifecycle records. Explicit consumers now protect an
in-flight submission and queued/physical deep work until dependent writes and retries
settle. Completed turn/dispatch caches are bounded by count and lazy TTL; metrics keep
only the configured latest entries. Recent terminal state remains available for cancel
responses and replay; older execution objects/contexts are released. Timeline history
is separate and is not deleted by execution-cache cleanup.

`EXECUTION_RETENTION_MAX_COMPLETED` defaults to 100 completed turns and independently
100 completed dispatch phases; `EXECUTION_RETENTION_TTL_MS` defaults to 300000;
`EXECUTION_RETENTION_MAX_METRICS` defaults to 1000. These are construction-time settings
requiring restart, with strict positive integer validation. Capacity pressure can evict
before TTL. Reads do not extend TTL. Active work remains protected regardless of
age/count. Cache eviction does not expire message identity: submissions check retained
user events and reject reused IDs; a new question needs a fresh ID. Explicit replay
is a separate operation that can reclaim an expired execution record. Catalog replay protects its snapshot
while queued; if that snapshot is gone, it fails `DISPATCH_SNAPSHOT_UNAVAILABLE` and
preserves the dead-letter record rather than choosing a different provider silently.

Regression coverage includes repeated direct/failed turns, held and cancelled deep
work, queued retries, cancelled queue entries, explicit replay/expiry, shutdown,
delayed terminal writes and retry write failure before enqueue. The write-failure
case now releases an orphaned replacement attempt. Deliberately ignoring lifecycle
consumers or completing a dispatch before its retry made the new tests fail; both
mutations were reverted. No generic eviction framework or automatic retry was added.

Review fixes: replay rejects an active replacement and only cleans up the attempt
it created; failed initial enqueue releases its task pin even if terminal writes fail.
Historical message-ID reuse is rejected on both submission paths, with concurrent
claim and history-read failure regressions. The history check currently reads the
conversation timeline; a persistent store should provide an indexed existence lookup.

Further review fixes: capability startup releases its task pin even when its terminal
write fails; pre-attempt setup failure releases the submission claim for retry; queue
discard drains remaining tasks before reporting cancellation-write errors. Regression
tests reproduced all three failures before the fixes. Submission claims now release
in the outer cleanup so a failed preparation cannot expose the ID prematurely.

Validation after the uncommitted-change review: 767 unit/integration tests across
97 files passed with one worker, TypeScript build passed, and all 26 browser tests
passed. Ten lifecycle review regressions now cover the reproduced failure paths.
The existing role-snapshot test also covers configuration capture before asynchronous
work. No live calls or commit.

Third slice implemented: admission ledger compaction and exact decimal accounting. Full resource
requests now remain only for active reservations. Completed/released IDs retain a
compact diagnostic row under the same construction-time `EXECUTION_RETENTION_MAX_COMPLETED`
and `EXECUTION_RETENTION_TTL_MS` settings, independently of the execution caches.
Lifetime known/estimated spend, unpriced counts, reported/unsettled counts and consumed
quota totals survive diagnostic eviction. Idle compute-pool entries are deleted.
Repeated finish/release cannot refund or double-count work; atomic rejection leaves
consumption unchanged. A reservation released while waiting cannot later start.

Dispatch telemetry now separates bounded `reservations` from lifetime `accounting`.
Old telemetry snapshots remain readable; neither old nor new telemetry restores the
admission ledger after restart. Quota aggregates retain one fingerprint/total per
encountered pool, not per request. Conflicting snapshots still fail closed after
history expiry. This preserves existing admission semantics; it does not implement
rolling-window resets, cross-process billing or late usage reconciliation.

Repeatable measurement: `npm run bench:admission-retention` uses explicit GC and no
providers. Across 30,000 sequential calls with a 32 KB resource note, the ledger kept
100 recent rows, zero active reservations, zero idle compute entries and one quota
aggregate. Heap samples were 9.10–9.15 MB; consumed quota reached 30,000. See
[raw measurement](measurements/admission-retention-2026-10-01.json). This is a scoped
ledger measurement, not an absolute heap assertion or whole-process memory guarantee.

Validation after the decimal fix: 794 tests across 99 files and the TypeScript
build passed. The refreshed 30,000-call measurement still retains 100 diagnostic
rows and exact lifetime quota consumption. No live provider calls. The ledger
measurement is saved separately from test assertions.

The earlier reviewed work is committed as `c9ce23f`. The ledger review's fractional
spend regression is fixed: reservations of $0.30, $0.20 and $0.10 under a $0.60 cap
can finish in every order without changing admission. Spend and quota arithmetic
use internal BigInt units at 324 decimal places, covering the decimal spelling of
all finite nonnegative JavaScript numbers, including Number.MIN_VALUE. Inputs are
not rounded and no epsilon relaxes the cap. Numbers already rounded by a caller
cannot be reconstructed. Telemetry converts totals back to numbers for display;
those projections never feed accounting decisions. Overflow-safe telemetry now keeps
normal totals numeric. An overflowing spend total uses `completedUsd: null`,
`completedUsdOverflow: true` and `completedUsdExact` as a decimal string; quota pool
totals use the corresponding `units`, `unitsOverflow` and `unitsExact` fields.
Validation requires a consistent overflow representation, and persisted telemetry
preserves it. This reporting change does not clamp or change admission accounting.

Step 1 delivered execution slices and retained contracts:

Conversation-retention slice implemented: history now has
construction-time manual limits from `.env.example`: 100 retained histories,
1000 lifetime conversation identities per registry, 24-hour idle TTL, 10000 events
and 8 MiB of serialized event data per history. Validation rejects nonpositive or
inconsistent limits. Limits apply to the in-memory store; custom stores must
implement the optional retention/lease contract to offer the same guarantees.
The existing scope-specific hardcoded cap is replaced by conversation admission.

Cleanup is lazy on access/admission/stat inspection. It expires idle, unleased
histories and retires the oldest eligible history under count pressure. Reads do
not extend TTL; appends and final lease release start a new idle interval. Submission
setup, generation writes, queued tasks and cancelled-but-draining physical work
hold leases. Neither age nor capacity evicts leased history. Expiry clears timeline
payloads, selected scope, summary memory and source identity indexes, and aborts
pending summaries. Expired IDs stay reserved: history/model submission returns
`CONVERSATION_EXPIRED` (HTTP 410); replay fails and preserves its dead letter.
Ownership checks still protect retained evidence and independent document tasks.
Per-history overflow rejects the append atomically with
`CONVERSATION_HISTORY_CAPACITY` (413), without silently truncating active output.
Review fixes add a separate emergency budget of at most `maxEvents` terminal
records, each bounded to 1 KiB, reserved when generation attempts are admitted.
Normal history limits exclude this additional bounded reserve. Overflow publishes
an explicit compact error terminal even after the normal write chain fails; worker
failures preserve dead letters independently of terminal-write success. Exhausted
attempt reservations reject new attempts. Invalid/abandoned streams and unknown
cancellations no longer allocate permanent v1 identities; streams opened before
submission discover the mapping when the first message arrives.

**Explicit limitation:** identity tombstones and ownership/v1 scope indexes are
never recycled automatically. After 1000 distinct identities, new identities
are rejected with `CONVERSATION_CAPACITY` (503); existing live conversations can
continue within their history limits. The v1 scope registry has its own count cap.
An operator can release expired identities one at a time (see "Expiry UI and
identity retirement" below). Ownership and deduplication are still not durable:
a restart forgets every identity and a retired ID is reusable. This is deliberate
backpressure with an explicit release, not a claim of indefinitely sustainable
operation.

Validation: 820 tests across 101 files passed on Node 24.21.0, including 17 new
retention regressions; all 26 browser tests and formatting/TypeScript checks passed.
Regressions exercise TTL without read renewal, pressure and identity exhaustion,
owner protection after expiry, held submissions, actual queued/cancelled/draining
deep work, delayed/failed writes, failed preparation, atomic overflow, replay
restoration, dependent-store cleanup, terminal publication at event/byte capacity,
bounded emergency reservations, rejected/abandoned stream admission and HTTP status
codes. No live provider calls or runtime restart. The end-to-end sustained-memory
gate remains open.

Dead-letter slice implemented: the store is bounded by admission, not expiry.
Construction-time manual limits from `.env.example`: `DEAD_LETTER_MAX_RECORDS`
(default 100) and `DEAD_LETTER_MAX_BYTES` (default 16 MiB of serialized tasks).
Records and reserved slots share both limits. `ChatOrchestrator` reserves a slot
sized to the task before writing the user event; the slot is held while the task
is queued, running, awaiting retry or replayed, becomes the record on final
failure, and is freed on success, cancellation, shutdown discard or a failed
submission. A full store rejects a new deep-routed message with
`DEAD_LETTER_CAPACITY` (HTTP 503) before any timeline or queue write, so its
message ID stays reusable and dispatch reservations are released; direct turns
continue. Admitted queued deep tasks are therefore bounded by the same limit.

Nothing expires or is evicted, because a record is the only replayable trace of
work whose external execution is uncertain. Records leave by replay or the new
explicit `DELETE /workers/deep/dead-letters/<taskId>`; the terminal error event
stays in the timeline. Replay claims the record without giving up its slot, so
a failed replay (expired conversation, missing dispatch snapshot, conflict or
queue failure) is always restored, even at capacity and against a competing
admission. Records keep the complete task; they do not pin conversation history
or dispatch snapshots, so those replay failures remain explicit as before. The
list endpoint reports limits and current usage.

Review fix: reservations own task snapshots, so recording an admitted failure uses
the originally reserved task even if a provider or replay caller mutates its copy.
Added records and list results are defensively copied. Replacing an unreserved
record recalculates its serialized task bytes; overflow rejects atomically, retaining
the old record and all accounting. The byte limit measures serialized tasks, not
JavaScript heap overhead or failure metadata. Mutation/growth and shrinking or
rejected replacement regressions cover these contracts.

**Explicit limitation:** this is deliberate backpressure. A full store blocks
deep-routed work until an operator replays or discards, including records that
can no longer be replayed; there is no automatic compaction, alerting or UI
treatment. Only work admitted through `ChatOrchestrator` holds a reservation: a
task placed directly on the queue is recorded when room exists and otherwise
fails with `DEAD_LETTER_CAPACITY`, leaving only its timeline terminal event.
`CapabilityChat` runs deep work inline and does not use this queue. Custom
stores must implement the optional reserve/release/claim contract to offer the
same guarantees. Dead letters remain process-local and are lost on restart.

Validation: 835 tests across 102 files passed on Node 24.21.0, including 15 new
dead-letter regressions; formatting/TypeScript checks and all 26 browser tests
passed. Regressions cover count and byte limits, idempotent reservation, rejection
before the user event, message-ID reuse after discard, queued/running/retry slots,
replay restoration under competing admission, cancelled/discarded work, failed
submission and terminal-write paths, 50 sequential failures with discard, catalog
dispatch release, and HTTP responses. Seven temporary mutations (replay without
claim, each missing release, skipped reservation, ignored byte limit) each failed
these tests and were reverted. No live provider calls or runtime restart.

Quota-pool slice implemented: `ResourceAdmission` tracks at most
`ADMISSION_MAX_QUOTA_POOLS` distinct pools (default 100, range 1–10000, read at
construction, documented in `.env.example`). Pool identity is the configured
`poolId`; the fingerprint is a hash of the whole quota snapshot, so a changed
allowance or refreshed evidence for a retained pool still fails with
`QUOTA_SNAPSHOT_CONFLICT`. The dispatch policy is read once at startup and never
reloaded, so the assembled runtime only encounters pools declared there; startup
now fails when the policy declares more distinct pools than the limit. The limit
bounds the ledger itself against callers and future reload paths.

A pool occupies a slot from reservation, not from settlement, so started work
always has room to record its consumption. The slot is permanent once started
work settles, including a zero-unit report. Releasing the last unstarted
reservation of a pool with no settled work frees the slot. Nothing is expired or
evicted. A further pool is rejected with `QUOTA_POOL_CAPACITY` during validation,
before any reservation exists, so a batch is all-or-nothing and accounting is
unchanged. The bounded quota wait does not retry it. Selection reports the binding
as excluded and other bindings remain eligible; with none left the request returns
the existing 503 `NO_ELIGIBLE_MODEL` with exclusions. `retentionStats().quotaPools`
now counts occupied slots, including pools with only live reservations. Exact
decimal accounting is unchanged.

**Explicit limitation:** the ledger cannot distinguish a renamed pool from a new
one. Within the limit, a new `poolId` is admitted with its own declared allowance;
it never resets, refunds or displaces a retained total, and churn ends in
`QUOTA_POOL_CAPACITY` rather than eviction. Binding one identifier to one real
account is the operator's responsibility until step 3 defines authoritative pool
identity. A full ledger has no operator release path: recovery requires a restart,
which discards every total. The limit counts pools, not bytes; `poolId` length is
unbounded by schema. Active reservations and compute-pool keys are bounded only by
upstream admission.

Validation: 847 tests across 103 files passed on Node 24.21.0, including 11 new
ledger regressions and one dispatch integration test; formatting/TypeScript checks
and all 26 browser tests passed. Regressions cover repeated pools, a new pool at
capacity, atomic batches, live/released/started reservations, settlement at
capacity, conflicting fingerprints, 50 renamed identifiers with expiring diagnostic
rows, the non-waiting rejection, unmetered requests, limit validation and the
startup policy check, invalid explicit constructor limits and caller mutation.
Three temporary mutations (no capacity check, live
reservations holding no slot, waiting on pool capacity) each failed these tests
and were reverted. The first of six full-suite runs failed 4 tests in 4 files under
roughly double the usual test time; the output was not captured and five subsequent
runs, two repeating the same format/lint/test sequence, passed. Treat that as an
unexplained transient, not as resolved. No live provider calls or runtime restart.

#### Retained-state inventory

Inventory complete (2026-10-01). Scope: server-process state in `src` outside the
offline `eval`/`bench` command-line tools; browser page state is excluded. Limits
are the defaults in `.env.example` or the configuration schema. "Lazy" means the
cleanup runs on the next access to that owner, never on a timer, so an idle
process keeps expired entries until something touches the store. Custom timeline,
source, summary or dead-letter stores that omit the optional retention contracts
provide none of these limits.

Which runtime owns deep work matters for every row below. `startServer` builds
`ChatOrchestrator` only for the mock pair without catalog dispatch. Every live or
catalog configuration builds `CapabilityChat`, which runs retrieval inline, never
enqueues a deep task and is not given the dead-letter store. In that runtime the
deep queue stays empty and `DEAD_LETTER_*` admission never applies.

Retained stores (survive the work that created them):

| State / owner                                                                      | Limit                                                                   | Cleanup trigger                                                                                     | Dependent references                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Timeline history / `InMemoryConversationTimelineStore`                             | 100 histories, 1000 identities; 10000 events and 8 MiB per history      | Lazy idle TTL (24 h) and count pressure; never while leased; tombstones only by operator retirement | Leases from submissions, attempts and queued tasks; expiry listeners                              |
| Owners and selected scope / `ChatService`                                          | Owners ≤ identity limit; scopes ≤ live histories                        | Scope on history expiry; owners only by operator retirement                                         | Ownership guards retained evidence and external document tasks                                    |
| Wire scope mapping / protocol v1                                                   | ≤ identity limit                                                        | A first submission failing before ownership; operator retirement                                    | Keeps an expired wire ID from becoming a fresh internal ID                                        |
| Source identity index / `InMemorySourceStore`                                      | One entry per user/answer event of a live history; no limit of its own  | History expiry (scans every key)                                                                    | Summary memory resolves its references through it                                                 |
| Summary memory / `InMemorySummaryStore`                                            | One per live history, ≤ `CONTEXT_SUMMARY_MAX_TOKENS` bytes              | History expiry                                                                                      | Source references into the index                                                                  |
| Dead letters / `InMemoryDeadLetterStore`                                           | Records plus reservations ≤ 100 and 16 MiB of serialized tasks          | Replay or operator DELETE; reservations on task settlement                                          | Own task snapshot including context; pins neither history nor dispatch snapshot                   |
| Quota aggregates / `ResourceAdmission.quotaTotals`                                 | ≤ 100 pools                                                             | Never; a pool with only unstarted reservations frees on release                                     | Fingerprint of the configured quota snapshot                                                      |
| Admission diagnostics / `ResourceAdmission.recent`                                 | 100 rows, 5 min                                                         | Lazy on archive or stats                                                                            | Compact views only; no request payload                                                            |
| Completed turns / `GenerationLifecycle`                                            | 100 turns, 5 min; live turns protected                                  | Lazy, after consumers and writes settle                                                             | Settled attempts keep status/model metadata and a timeline handle; answer text is released        |
| Completed dispatch phases and metrics / `CatalogDispatch`                          | 100 phases, 5 min; 1000 metrics                                         | Lazy, after `complete()`                                                                            | Replay context, catalog entry clones and provider bindings; settled ranking contexts alias replay |
| Briefing runs / `BriefingCoordinator`                                              | `maxRuns` 20 (active plus settled); settled TTL 5 min                   | Lazy; pressure evicts the oldest drained run                                                        | Request, profile and waiter indexes; evidence results                                             |
| Tool results / `ToolResultStore`                                                   | `maxSnapshots` 100 records and 16 MiB serialized bytes; oldest evicted  | Lazy expiry on put/get; cleared on reload, close or retirement of the conversation                  | Owner and conversation check; rows are also copied into timeline `payloadResults`                 |
| Directory cache, resolution and game snapshots / `TeamDirectory`, `GameOperations` | 2 directories (1 MB response each); 100 + 100 snapshots                 | Lazy TTL on the next lookup or search; cleared on reload or close                                   | Snapshots bind user, conversation and registry revision                                           |
| Shared source cache / `SharedSportsSource`, `SportsRequestBudget`                  | 20 entries (15 s), 4 pending reads, 5 start times per minute            | Lazy on read                                                                                        | Waiter count cancels the shared read when the last caller leaves                                  |
| Model observations / `InventoryStore`                                              | 4096 observations, 8 MiB; listings ≤ 1000 models and 4 MiB responses    | Atomic replacement on complete refresh; no tombstones                                               | Cloned into every catalog `prepare`                                                               |
| Latency samples / `InMemoryLatencyEstimator`                                       | 1000 samples per provider/model/route/size bucket                       | Oldest samples dropped on record                                                                    | Persisted in the telemetry file                                                                   |
| CLI pool keys and inspection cache / `CliRunner`, `ClaudeInspectionCache`          | One key per busy pool; one cached and one pending inspection            | Key deleted at zero; inspection TTL 5–30 s                                                          | Shared by every CLI adapter of the account                                                        |
| Evaluation trace / `EvaluationRecorder` (opt-in)                                   | `EVAL_MAX_EVENTS` 10000, `EVAL_MAX_BYTES` 10 MiB; then drops and counts | Retention timer (7 d) or `finish()`                                                                 | Turn and call indexes ≤ recorded events                                                           |

Pending work (exists only while something is in flight):

| State / owner                                                    | Limit                                                                      | Cleanup trigger                                                                                         | Dependent references                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| In-flight requests / `ChatService.inFlight`, server `responses`  | Submissions ≤ `CHAT_MAX_CONCURRENT_TURNS` (8); other requests unlimited    | Settlement; socket close                                                                                | Request body, a history lease, one history clone plus its source snapshot          |
| Live turns / `GenerationLifecycle.turns`, `claimed`, `consumers` | ≤ `CHAT_MAX_CONCURRENT_TURNS` admitted turns plus queued deep phases       | Attempt settlement and consumer release                                                                 | Attempt buffers, history lease, emergency terminal reservation                     |
| Deep task queue / `InMemoryTaskQueue`                            | 100 tasks and 16 MiB serialized bytes by default; direct enqueues included | Worker dequeue, queued cancellation or shutdown discard                                                 | Task with context; if admitted: slot snapshot, task pin, history lease, phase      |
| Retry counters / `DeepWorker.attemptsByTaskId`                   | One integer per task awaiting retry                                        | Success, cancellation or final failure                                                                  | None                                                                               |
| Inline retrieval work / `CapabilityChat.pending`                 | ≤ `CHAT_MAX_CONCURRENT_TURNS` turns of ≤ 3 tool calls, each tool-bounded   | Work settlement, then `releaseTask`; frees the turn's slot                                              | Message, tool snapshot and plan; deep attempt; history lease; lifecycle consumer   |
| Pending summary snapshots / `ContextManager.jobs`, `pending`     | One job per conversation, each ≤ `CONTEXT_SUMMARY_TIMEOUT_MS` (5 s)        | Completion, timeout, supersession, history expiry, shutdown                                             | Cloned events, source snapshot and prefix; no history lease                        |
| Active admission reservations / `ResourceAdmission.charges`      | None of its own; one per prepared phase, fallback or summary call          | `release` if unstarted, `finish` if started                                                             | Cloned request and resources; quota-pool slot; spend toward `SPEND_LIMIT`          |
| Compute-pool keys / `ResourceAdmission.running`                  | One key per pool with started work; ≤ declared compute pools               | Deleted when the pool's count returns to zero                                                           | The started reservations it counts                                                 |
| Live dispatch phases / `CatalogDispatch.phases`                  | None of its own; one per prepared phase                                    | `complete()` by the owning workflow, then count/TTL retention                                           | Same payload as a completed phase, plus its reservation ticket                     |
| Admission waiters / `reserveWithWait`, `begin`                   | Count unlimited; each ≤ `waitTimeoutMs` (≤ 120 s)                          | Grant, timeout, or abort (`begin` only)                                                                 | One 10 ms poll timer each                                                          |
| Briefing jobs and waiters / `BriefingCoordinator`                | Jobs ≤ runs × plan tasks, 2 running; waiters unlimited per run             | Settlement, deadline (30 s) or cancellation                                                             | Per-job timer and `AbortController`; a draining job protects its run from eviction |
| Document-task requests / `PythonDocumentTasks.pending`           | 32                                                                         | Response, 30 s timeout or bridge failure                                                                | One timer each; the child's stdout line buffer has no length limit                 |
| Discovery refreshes / `InventoryStore.inFlight`                  | One per connection, 4 concurrent                                           | Settlement, 10 s timeout or shutdown                                                                    | One `AbortController` each                                                         |
| CLI generations / `CliRunner`                                    | `CLI_MAX_CONCURRENCY` (1) running per pool; waiting callers unlimited      | `CLI_TIMEOUT_MS` (120 s), completion or cancellation                                                    | Child process; stdout ≤ `CLI_MAX_OUTPUT_BYTES` (1 MiB)                             |
| Telemetry saves / `FileLatencyTelemetryStore`                    | One physical write plus one latest replacement                             | Each write completing                                                                                   | One serialized active snapshot plus one latest pending snapshot                    |
| Event streams (v1 and legacy SSE)                                | `HTTP_MAX_EVENT_STREAMS` (32) across both routes, since 2026-10-06         | Client close, finish, stall timeout; shutdown `closeStreams`; slot held until an in-flight read settles | Two timers each; the legacy stream also keeps a serialized copy of the timeline    |

Timers. Three process-lifetime intervals run in `startServer` and are cleared by
`stopBackground` on shutdown or server close: telemetry save (5 s), deep-worker
tick (500 ms) and discovery refresh (5 min). Every other timer belongs to one unit
of pending work and is cleared when that work settles: SSE poll (100 ms v1, 350 ms
legacy) and 15 s heartbeat per connection; a ≤ 50 ms delta flush per attempt; the
summary timeout per job; the workflow deadline per evidence or review turn; 10 ms
admission and CLI polls; the deadline per briefing job; provider and adapter
request deadlines; 30 s per document-task request; 10 s per discovery refresh.
Only the evaluation retention timer and the document-bridge kill timer are
unreferenced, so a clean exit depends on the shutdown path clearing the rest.

Buffers and payload references. Stored answers are capped at 1 MiB per attempt,
provider stream frames at 1 MiB, CLI output at 1 MiB, sports responses at 1–2 MB
and the evaluation trace at `EVAL_MAX_BYTES`. A streamed answer is written to
history as deltas, an answer event and a terminal event, so it costs about three
times its size, all counted by `CONVERSATION_MAX_BYTES`. The following copies of
conversation data are not counted by that limit: the source identity index, the
summary memory, each pending summary snapshot, the per-request history clone, the
context copies in queued tasks, dead-letter slots and dispatch phases, and the
serialized timeline each legacy SSE connection keeps. Each HTTP request body is
limited to `HTTP_MAX_BODY_BYTES` and concurrent submissions to
`CHAT_MAX_CONCURRENT_TURNS` (step 2, 2026-10-05); the number of concurrent reads,
streams and other requests is not.

Open boundaries found by the inventory. None is implemented; each needs a decision
before or during the sustained-memory gate:

1. **Bounded (2026-10-05): concurrent-turn admission.** `ChatService` admits at
   most `CHAT_MAX_CONCURRENT_TURNS` turns (default 8) across both submission
   paths, counting a turn until its response has returned and any detached
   inline retrieval has settled. A further submission is refused with
   `TURN_CAPACITY` before ownership, history or a message ID is claimed. In-flight
   requests, live turns, inline retrieval work and the reservations and dispatch
   phases they create are therefore bounded by that limit times their per-turn
   caps. Reads, streams, cancellation and operator requests are not admitted
   through it. The gate now probes `CapabilityChat` with held turns at the limit;
   see "Second increment" under step 2.
2. **Bounded (2026-10-04): deep queue and queued cancellation.** The in-memory
   queue caps count and serialized task bytes, defaulting to dead-letter limits.
   Direct enqueues own cloned tasks and cannot bypass those queue limits.
   Cancellation through `ChatService` removes matching queued work promptly and
   releases its slot, pin, lease and dispatch references. Dequeued work keeps its
   physical-settlement protection. Custom queues lacking removal still drain on
   cancellation; their bounded-admission contract remains the embedder's duty.
3. **Bounded (2026-10-04): retained execution payloads and tool results.** Settled
   attempts clear text after writes and all consumers settle. Completed dispatch
   candidates alias replay context rather than retaining ranking-only copies.
   `ToolResultStore` caps aggregate serialized bytes (16 MiB default) as well as
   count; oldest eviction preserves the existing unavailable-reference behavior,
   and an oversized single result is rejected without evicting live evidence.
4. **Bounded (2026-10-06): event streams.** Open streams across both
   routes are limited by `HTTP_MAX_EVENT_STREAMS`, admitted before any timeline
   read. Write backpressure is honored: a blocked stream stops reading and
   writing until drain and is disconnected after `HTTP_STREAM_STALL_TIMEOUT_MS`.
   Each stream runs at most one timeline read at a time. Unchanged: the legacy
   stream still re-sends the whole timeline on every change and keeps a
   serialized copy, and the v1 stream still clones the whole timeline every
   100 ms to find new events, so per-stream memory still scales with
   `CONVERSATION_MAX_BYTES`. Only the stream count and buffering are bounded.
5. **Bounded (2026-10-04): telemetry snapshots.** One physical write and one
   latest replacement snapshot are retained. Superseded callers share the final
   replacement's completion; a failed batch cannot poison later writes. Shutdown
   saves and awaits the latest snapshot. Snapshot byte size follows the existing
   estimator/catalog state; disk stalls still obey the shutdown timeout.
6. **Bounded (2026-10-04): discovery observations and listing bodies.** Complete
   successful listings replace observations per connection atomically, without
   accumulating tombstones. Missing observations are unchecked and ineligible.
   Partial, failed, malformed, aborted and over-limit listings leave prior evidence
   unchanged and cannot renew its expiry. Configured count/byte limits cap retained
   observations; built-in adapters also cap response bodies before parsing. Custom
   adapters must bound their own transport before returning allocated objects.
7. **Closed for the gate's scope: owners now expose counts.** `CapabilityChat.pending`,
   `ChatService.inFlight`, open event streams and wire mappings, `ToolResultStore`,
   `TeamDirectory`, `GameOperations`, the source and summary indexes and the worker's
   retry counters have `retentionStats()`, and the gate asserts them. `InventoryStore`
   and `SharedSportsSource` still expose none; the gate excludes discovery and
   bounds the shared source only through heap samples.

Unchanged boundaries carried from the earlier slices: durable identity lifecycle
(ownership and deduplication across restart); operator visibility and recovery
for a full dead-letter store or quota ledger; authoritative pool identity
(step 3). Cancellation through initial catalog admission is implemented
(2026-10-06): preparation takes an abort signal, admission waits are abortable,
unstarted reservations and phases are rolled back, and legacy turns can be
cancelled before their attempts exist; see
[generation](implementation/02-generation.md). UI treatment of history expiry and
operator retirement of owners and the wire scope mapping are implemented below.

Inventory validation: `tests/integration/retentionInventory.test.ts` adds four
regressions for the claims that were not already covered: direct enqueues hold no
slot, lease or pin and a failure past dead-letter capacity leaves only its
terminal event; a cancelled queued task holds its slot, pin and lease until
dequeued and then releases all of them without calling the provider; summary jobs
stay at one per conversation across repeated and superseding prepares and are
aborted by history expiry; a dequeued task whose history expired is recorded as a
dead letter without calling the provider or leaking pins. Two temporary mutations (no abort of a superseded
summary job; no dead-letter release when the worker settles a task) each failed
these tests and were reverted. Reservation and compute-pool cleanup were already
covered by `tests/unit/admissionRetention.test.ts`. The remaining rows were read
from code and are not exercised by a test or a measurement.

Prior worker review validation (2026-10-01): 851 tests across 104 files and all 26 browser
tests passed using Windows Node 24.21.0. The four inventory regressions include the
worker recovery fix above. Formatting and lint passed. No live provider calls or
sustained assembled-runtime memory measurement were performed.

##### Expiry UI and identity retirement (2026-10-01)

What a user sees after expiry: the legacy stream sends a `conversation-expired`
event before it closes, and a page that loads an already expired ID learns it
from the 410 on the events endpoint (an `EventSource` cannot read that status).
The page shows a notice, keeps the last copy it received as read-only text,
disables Send and offers "Start a new conversation", which switches to a fresh
ID. A send rejected with 410 does the same; a full history (413) shows the offer
without disabling Send; server conversation capacity (503) is explained in the
status line because a new ID would not help. The other panels still show their
generic errors for an expired ID.

Retirement is an explicit operator action, not a policy: `GET
/conversations/retention` lists expired identities and `DELETE
/conversations/<id>/identity` releases one. `ChatService.retireConversation`
only accepts an expired identity, asks every dependent first, and then deletes
in one synchronous step with ownership last: evidence (tool results, team and
game snapshots), the v1 wire mapping, settled execution records, selected scope,
the tombstone and finally the owner. It refuses with named blockers while a dead
letter or reserved slot, a queued task, an active turn or a document task refers
to the conversation, and fails closed when a custom queue, dead-letter store or
timeline store cannot be inspected or the document sidecar cannot be asked. It
never discards a dead letter itself, so uncertainty about external execution is
resolved by the operator, not by cleanup. Legacy and v1 streams that followed the retired
conversation are closed instead of continuing into unrelated work.

Decisions and their cost. No automatic recycling: a full identity table still
returns 503 until someone retires identities. A retired ID is unknown to the
process: any user may claim it and its old message IDs are no longer rejected, so
this is bounded process-local identity, not durable deduplication. Document
tasks block retirement outright because the sidecar has no abandon operation
(step 3); such a conversation keeps its slot for the process lifetime. The
sidecar's own durable owner table is untouched. Both endpoints are
unauthenticated like the rest of the server and belong in step 2's access rules.
Custom stores that omit the optional contracts get no retirement.

Initial validation: 15 regressions in `tests/integration/conversationRetirement.test.ts`
(slot release, reuse semantics, each blocker, fail-closed inspection, participant
ordering and failure, a race through a slow participant, shutdown, HTTP outcomes,
the document-task rule, v1 mapping and stream), one stream-event regression in
`conversationRetention.test.ts`, and two browser tests for the notice on a live
stream, after reload and for each send failure. Six temporary mutations (no
dead-letter check, owner released first, no live-history check, no recheck after
the awaited participants, wire mapping kept, execution records kept) each failed
these tests and were reverted.

Review fixes (2026-10-01): pending team-directory/game searches and document-task
starts now lease history through publication. Without that lease, expiry and
retirement could release an owner while a request was still creating protected
state. Retirement now compares an opaque incarnation token after awaiting
participants, so a slow request cannot retire a reused ID based on the previous
owner's blocker answers. It also rechecks shutdown before deletion. Legacy
streams bind to that incarnation; v1 streams reject changed mappings even at
cursor zero. Both close instead of following a reused ID. Seven regressions cover
the stale-retirement race, all three external publication paths, the legacy
stream crossing owners, a v1 stream with no turn cursor and a refused final
timeline deletion. A store that refuses deletion retains ownership with
`RETIREMENT_REFUSED`, even if dependent cleanup has run. The expiry notice no longer claims that expiry always
comes from idleness or that explicit retirement cannot release an ID.

Review validation: 875 tests across 105 files and 28 browser tests passed on
Windows Node 24.21.0; formatting and lint passed. The strengthened memory gate
also passed: 134 distinct assertions, 3,343 checks, including 17 assertions that
the advertised workloads and summary publication actually occurred. The new
[review report](measurements/sustained-memory-review-2026-10-01.json) preserves the
original default and soak reports. Post-warmup heap decreased by 2.0–2.5% across
the three runtime sample points; the separate ledger increased by 0.10%. These
remain scoped observations, not an absolute bound or proof that every retained
owner is bounded. `--measured` requires at least three integer rounds.

Earlier review disposition (superseded by the scoped lead acceptance above): keep step 1 open until findings 2, 3, 5 and 6 each have an
explicit bounding or deferral decision. Operator-only retirement, reusable IDs
and the document-task blocker are consistent with the stated process-local
contract. Endpoint access control remains step 2 work for deployment. A standalone
memory gate is reasonable for now; whether it becomes a required release check
is still a policy decision. Its 5% threshold measures net drift under fixed
concurrency and scaled limits; it does not cover the excluded owners.

##### Sustained-memory gate (2026-10-01)

`npm run bench:sustained-memory` builds two runtimes in one process from the
classes `startServer` wires and drives them over loopback HTTP: the live shape
(`CapabilityChat`, catalog dispatch with four bindings on three quota pools,
inline retrieval, the sports registry on a fixture transport) and the queue shape
(`ChatOrchestrator`, deep worker, dead letters). Providers are scripted. Limits
are scaled down and listed in the report: 40 identities, 12 histories, 1 MiB and
400 events per history, 20 completed turns/phases, 6 dead letters, 3 quota pools.

Each round runs 24 live conversations at concurrency 8 (large answers, 162 KB
table payloads on pinned bindings, game searches, tool failure, provider error,
invalid plan, held retrieval with cancellation, a reused message ID), two
configuration reloads, protocol-v1 and scoped conversations, streams, and every
seventh timeline append delayed. One conversation is filled to its history limit
and the identity table to its limit; both rejections and the survival of a live
conversation are asserted. The queue runtime fills the dead-letter store, is
refused further deep work while direct turns continue, cancels a queued task,
retries, replays successfully and unsuccessfully, and summarizes a long
conversation. Three samples are taken per round after quiescing: with payload
histories retained, with the identity table full, and after idle expiry, discard
and retirement of every identity. The run ends with shutdown while three
retrievals, a stream and two queued tasks are in flight.

Result on Windows Node 24.21.0
([raw report](measurements/sustained-memory-2026-10-01.json)): 117 distinct
registry assertions, 3,326 checks, none failed, over 3 warm-up and 12 measured
rounds (13,566 timeline appends, 1,938 delayed; 2,128 provider calls). Every
registry returned to its expected size: no lease, consumer, task pin,
reservation, compute key, stream, summary job or retry counter survived its work;
completed caches stayed at their limits with indexes in agreement; and after
retirement nothing identity-keyed remained (identities, owners, scopes, wire
mappings, source and summary indexes all zero). Shared-pool consumption equalled
the provider calls of both bindings sharing it, the scarce pool stopped at exactly
its 25-request allowance, and a policy with a fourth pool was refused at
construction. The separate historical isolated ledger workload used Windows
Node 24.15.0, rather than the current pinned runtime, and kept 50 pools and exact totals for
30,000 calls while rejecting 12,000 renamed pool identifiers, with heap samples
of 27.04–27.07 MB. Post-warmup heap rose 0.5–0.9% between the first and last
third of the measured rounds at each of the three sample points (limit 5%).

A [200-round soak](measurements/sustained-memory-soak-2026-10-01.json) passed
the same assertions with a stored `heapPlateauTolerance` of `0.1` (10%), not the
5% threshold of the earlier gate/report comparison. The retained artifact is
unchanged. Its idle heap rose from 26.80 to 27.66 MB (20-round means),
slowing from about 7 KB to 2 KB per round. Heap-snapshot comparisons of an
equivalent run (rounds 20 to 110, then 110 to 200) attribute that growth to V8
code objects and their metadata (about 505 of 638 KB, then 141 of 201 KB) and to
the harness's own stored samples (about ten objects and nine numbers per round).
The reported comparison found no growing runtime object class. The snapshots
were not kept, so that attribution cannot be independently checked from the
retained reports; it is supporting analysis rather than reproducible gate evidence.

Current evidence: the [2026-10-06 run](measurements/sustained-memory-current-2026-10-06.json)
used 16 histories and a live turn-admission limit of 16, passed 159 registry
assertions, and used a 5% heap tolerance. Its
[source-digest provenance](measurements/sustained-memory-current-2026-10-06.provenance.json)
identifies the measured source, including the event-stream implementation;
stream counts, backpressure and connection stress remain excluded from this gate.

What this does not establish. The limits are scaled down, so there is no claim
about absolute memory at the defaults: at defaults the live histories alone may
hold 100 × 8 MiB. Concurrency was fixed by the driver; the live runtime still
has no admission limit on concurrent turns (finding 1). Live adapters, discovery,
the CLI runner, the telemetry file store, the evaluation recorder, the document
sidecar and the three `startServer` timers were not constructed, and execution
caches were bounded by count only because their TTL uses the wall clock. Request
bodies, stream backpressure and connection counts were not stressed (step 2).
Three temporary mutations (inline task pin never released, owner kept on
retirement, no quota-pool limit) each failed the gate and were reverted. The
gate is not part of `verify:release`.

##### Remaining-bound increment (2026-10-04)

Implemented findings 2, 3, 5 and 6 rather than deferring them. See the current
inventory boundaries above and the runtime contracts for configuration and failure
semantics. Regression coverage includes a physically stalled telemetry writer with
1000 superseding saves and failure recovery; byte-pressure eviction and oversized
evidence rejection; settled buffer cleanup with a held consumer; atomic queue
count/byte rejection and exact removal across conversations sharing a task ID;
cancellation behind a blocked worker; discovery churn, partial/over-limit/invalid
replacement rollback; streamed fetch/Bedrock body limits; and Azure pagination
exhaustion. Existing cancellation regressions now expect prompt queue removal.

The expanded gate measures discovery churn and actual file telemetry under held
writes separately from the assembled HTTP runtimes. It also asserts zero retained
answer buffers and ranking context copies, tool-result byte limits and drained queue
byte accounting. Live discovery endpoints, production periodic timers, evaluation
recording and the document sidecar remain excluded. No whole-process bound at
production defaults or unlimited request concurrency is claimed.

Validation on Windows Node 24.21.0: 885 tests across 106 files, all 28 browser
tests, formatting and lint. The [expanded gate report](measurements/sustained-memory-bounds-2026-10-04.json)
passes 151 distinct assertions and 3,618 checks. Post-warmup heap increased by
0.66%, 0.70% and 0.81% at the payload, identity-cap and idle sample points; the
separate quota ledger increased by 0.09%, all within the 5% tolerance. The owner
workload churned two connections through 20 complete replacement rounds and
persisted the latest of 1000 saves per stalled-write round without accumulating
intermediate snapshots.
The earlier reports remain unchanged. The first full test run hit four cold
LangGraph import timeouts under the existing five-second timeout; the focused
rerun passed. Two cancellation assertions encoded the superseded drain behavior
and were updated. No test timeout was increased.

##### Step 1 status

Lead-accepted within the measured scope at `fcceff2`; the current checkpoint
links the report, exact source provenance and limitations. The following delivered
contracts remain operative.

1. **Complete: fix decimal accounting.** Fractional-cost regressions cover all six
   completion orders, reported usage, release/cancellation, atomic rejection,
   history expiry and true overages. Fractional quota reports use the same exact
   arithmetic. Invalid amounts are rejected by the conversion helper.
2. **Inventory complete; remaining retained-owner bounds implemented.** Conversation history,
   dead letters and quota pools are bounded, expiry has a user-visible treatment
   and identities have a coordinated operator release. Inventory findings 2, 3,
   5 and 6 now have the implemented bounds described above. Original scope: cover conversation history,
   dead letters, ownership indexes, quota-pool aggregates and other ID-keyed stores,
   pending work, timers and buffers discovered during the inventory. For each,
   record its owner, size/count limits, expiry or durable-storage policy, cleanup
   trigger and dependent references. Keep configuration manual and explicit.
   Decide what users see after history expiry and how duplicate IDs, conversation
   ownership and replay behave. Ownership must not disappear while protected data
   remains accessible; uncertainty about external execution must survive cleanup.
   Bound active admission as needed; never evict live work to satisfy a cache cap.
   Bound distinct quota-pool cardinality without discarding consumption or treating
   a new pool identifier as permission to reset an existing allowance. Step 3 owns
   actual rolling-window reconciliation; step 1 retains conservative accounting.
3. **Gate implemented; passes for its stated scope (see above).** Exercise the assembled runtime
   with repeated conversations, large retained payloads, failed/replayed tasks,
   cancellations, slow writes and supported configuration churn. Use deterministic
   assertions on registry sizes and references plus repeatable post-warmup heap
   samples. Include configured-cap rejection/backpressure and shutdown/drain paths.
   Exercise quota-pool cardinality independently of the one-pool ledger benchmark.
   Record workload, settings, raw results and exclusions. Disk-backed history still
   needs a bounded in-memory working set and an explicit disk-retention policy.

Step 1 is lead-accepted at `fcceff2` within the scope and source-linked evidence
recorded in the current checkpoint. The memory gate does not construct live
providers, the CLI runner, evaluation recorder or Python sidecar. Periodic timers
and cache TTL expiry are not measured there; connection/body/SSE stress has
separate regression evidence. Role/evidence/review modes and model summarization are
excluded, as are default-limit or whole-process memory claims and disk-backed
history. Quota reconciliation, shared deployment, quality and unattended recovery
remain open. This decision does not expand production or worker authority.

Delivered requirements (contracts retained below):

- Reproduce coordinator exhaustion after its configured run cap. Add configurable
  retention for settled runs and clean associated request/profile/waiter indexes.
  Never evict active work; define retry/idempotency behavior after retention expires.
  Capacity errors must remain identifiable through the tool result path.
- Separate live lifecycle/dispatch state from retained history. Release completed
  execution objects and cloned contexts only when all dependent work and writes
  have settled. Keep execution claims bounded and check retained user events for
  duplicate message IDs; cache expiry must not enable duplicate execution.
- Bound dispatch metrics and inspect admission ledgers/telemetry snapshots for
  retained state. Keep model/subscription-specific quotas and accounting semantics.

Accepted-scope criteria: execute substantially more than the configured capacity sequentially;
verify new calls continue, active jobs survive pressure, retained state plateaus,
indexes agree, retries obey the retention contract, and cancellation/shutdown still
settle correctly. Include concurrent completion/eviction races. Check registry sizes
and retained contexts deterministically; supplement with a repeated-use memory
measurement rather than relying on a brittle absolute heap assertion.

### 2. Request limits and an explicit deployment boundary — in progress

- Bound POST bodies by bytes while streaming, including chunked input and misleading
  Content-Length headers. Reject oversized requests consistently and stop reading.
- Default local operation to loopback. Define explicit access controls for any
  nonlocal deployment, covering sensitive reads, SSE and mutating endpoints. Local
  browser access also needs an explicit Origin/Host policy for privileged actions.
- A userId in JSON is not authentication. Shared deployment requires authenticated
  ownership of conversations, result handles and tasks, including event reads,
  cancellation, configuration reload and administrative operations. A shared server
  token alone does not establish separate user identities.

Acceptance: limit-boundary/chunked-body tests, unauthorized read/write/SSE rejection,
cross-owner denial and normal local UI operation. Document the supported local mode
and keep shared deployment gated until its identity/ownership requirements pass.

#### First increment: body limit and local boundary (2026-10-05)

Committed in `f9c578f`. The contract is in the
[runtime reference](runtime-reference.md#local-deployment-boundary-and-request-limits);
settings are `BIND_HOST` and `HTTP_MAX_BODY_BYTES` in `.env.example`.

- Every POST body is read through one byte-counting reader (default 1 MiB, at
  most 16 MiB, strict validation at startup). A declared `Content-Length` over
  the limit is refused before reading; chunked input is refused at the chunk
  that crosses it. The response is 413 `REQUEST_BODY_TOO_LARGE` with
  `Connection: close`, and nothing is appended or enqueued.
- `startServer` binds `BIND_HOST`, default `127.0.0.1`, and fails startup for any
  address other than `127.0.0.1`, `::1` or `localhost`. Before this it bound
  every interface.
- `createChatServer` checks every request before routing or reading its body:
  403 `HOST_NOT_ALLOWED` unless `Host` is a loopback name, 403
  `ORIGIN_NOT_ALLOWED` when an `Origin` is present and is not `http://<Host>`.
  This covers page loads, timeline reads, both event streams, mutations and the
  operator endpoints (identity listing and retirement, dead letters, reload).

Decisions and their cost. Nonlocal bind is refused instead of token-gated: a
shared token would not establish separate users, so no partial access-control
mode exists. The request policy has no opt-out, so embedders and tests get it
too; a different local port, a `null` origin and a proxy that rewrites `Host` or
terminates TLS are all refused. Clients that send no `Origin` are trusted, which
means any local process can still read any timeline, cancel any turn, reload
configuration and retire identities. No owner check was added to event reads or
cancellation: it would compare another self-asserted `userId`, and the page's
`EventSource` and cancel calls do not send one. Rejection stops reading and
closes the connection, so a client that is still uploading may see a reset
instead of the 413. A body shorter than its declared length is settled by client
disconnect or Node's default request timeout, which is not configured here.

Against the step 2 acceptance list: limit-boundary, chunked and misleading
`Content-Length` tests pass; cross-origin and non-loopback-`Host` reads, writes
and streams are rejected; the browser suite passes against `http://127.0.0.1`.
Cross-owner denial and authenticated ownership are not implemented, so shared
deployment remains refused. Still open in step 2: concurrent-turn admission
(finding 1), stream count and backpressure (finding 4), and the authenticated
identity design.

Validation on Windows Node 24.21.0: 930 tests across 108 files, 29 browser tests,
format and lint. The 44 new tests are 27 unit cases for configuration and the
`Host`/`Origin` policy, 13 HTTP cases in `tests/integration/httpBoundary.test.ts`
(exact limit and one byte over, a declared oversize with no body sent, chunked
crossing without ending the body, cumulative chunks, bytes versus characters,
protocol v1 and other routes, the default limit, understated and overstated
`Content-Length`, cross-origin and foreign-`Host` rejection across 14 routes,
rejection before the body, same-origin acceptance) and 4 startup cases (refused
nonlocal binds, invalid limit, loopback address, configured limit reaching the
assembled server). The occupied-port regression now occupies `127.0.0.1`. No
temporary mutations were run for this increment. The first full run hit the
known cold LangGraph import timeouts (4 tests under the five-second timeout);
the rerun passed. Those four files now load the package in a `beforeAll` hook
with its own 60-second limit, so a cold load no longer counts against a test;
the five-second test timeout is unchanged, and the cold case was not reproduced
to confirm the fix. `npm run bench:sustained-memory` still passes under the new
boundary (151 assertions, heap within tolerance); no new report was written. No
live provider calls or service restart.

#### Second increment: concurrent-turn admission (2026-10-05)

Implemented and committed in `b578256`. The contract is in the
[runtime reference](runtime-reference.md#local-deployment-boundary-and-request-limits);
the setting is `CHAT_MAX_CONCURRENT_TURNS` in `.env.example` (default 8, at most
1000, strict validation at startup; `src/config/turnAdmission.ts`).

- `ChatService.submitMessage` counts admitted turns and refuses the next one with
  `TURN_CAPACITY` (retryable) when the count reaches the limit. The check runs
  synchronously after the shutdown and unsupported-run-control checks and before
  the conversation is claimed, the history leased or the message ID claimed by
  the lifecycle, so a refused turn leaves no owner, event, identity, wire
  mapping or duplicate-ID record. The same body may be resent unchanged.
- The orchestrator may report `detachedTurns()`. `CapabilityChat` reports its
  `pending` inline retrieval, so a turn whose response has returned keeps its
  slot until that work settles or is cancelled. The mock `ChatOrchestrator`
  reports nothing; its deep work is queued and bounded by the queue limits.
  Between the response returning and the request count dropping, a detaching
  turn is counted twice for one microtask; that can refuse one extra
  submission, never admit one too many.
- `createChatServer` answers `429` with code `TURN_CAPACITY`, the service's
  message and `Retry-After: 1` on both `POST /messages` and protocol v1. Protocol
  v1 now propagates capacity refusal before looking for an earlier terminal
  event, so resubmitting a completed message ID while full cannot become a
  false `200` generation-failure response. A regression in
  `tests/integration/protocolV1.test.ts` covers this case and verifies that
  duplicate detection returns `409` again after capacity frees. Protocol
  v1 already released its wire mapping for an unclaimed identity. The page shows
  a send-failed status for the code and re-enables the send button; it does not
  retry on its own.
- `retentionStats()` reports `activeTurns`, `detachedTurns` and
  `maxConcurrentTurns`; `startServer` passes the loaded limit explicitly, and an
  explicit constructor limit is validated like the environment value.

Decisions and their cost. Submissions are refused, not queued: a wait would hold
request bodies and history leases for callers that may have gone, and the page
already serializes its own sends. The limit is global, not per user or per
conversation, because identities are self-asserted; a per-identity limit would
be trivial to evade and would suggest a fairness property that does not exist.
Reads, event streams, cancellation and operator endpoints are not counted, so a
client can still open any number of streams (finding 4). The deep worker's own
runs are not counted either; they are bounded by the queue and worker
concurrency. The default of 8 is a local-use figure with no measurement behind
it; `CLI_MAX_CONCURRENCY` (1) and provider limits will usually bind first.

Against the step 2 acceptance list: this adds concurrent-request bounding for
submissions only. Still open: stream count and backpressure (finding 4, now the
third increment), cross-owner denial and the authenticated identity design, so
shared deployment remains refused.

Validation on Windows Node 24.21.0: 940 tests across 110 files, 29 browser
tests, format and lint. The 9 new tests are 3 unit cases for the configuration
(`tests/unit/turnAdmission.test.ts`), 5 cases in
`tests/integration/turnAdmission.test.ts` (refusal past the limit with no owner,
history or identity claimed and admission after a slot frees; slot release on a
failed turn; a detached turn keeping its slot until its work settles; `429` on
both HTTP protocols with the wire mapping released and the refused body accepted
afterwards; environment default and explicit-limit validation) and 1 startup
case for an invalid value. The orchestrator in those tests is a stub that
settles turns on command; the assembled `CapabilityChat` path is covered by the
gate instead. `npm run bench:sustained-memory` now builds the live runtime with a
limit of 16 and `maxHistories` 16 (one leased history per held turn), and adds
five probe assertions: exactly the limit is admitted from 17 held submissions,
every slot is detached inline work, the refused turn claimed nothing, cancelling
drains every slot, and the refused body is accepted afterwards. The gate passes
(159 assertions, heap within tolerance); no new report was written, so the
recorded evidence still describes the 12-history configuration. No temporary
mutations were run. No live provider calls or service restart.

#### Third increment: event-stream admission and backpressure (2026-10-06)

Implemented and reviewed. The contract is in the
[runtime reference](runtime-reference.md#event-stream-limits); the settings are
`HTTP_MAX_EVENT_STREAMS` (default 32, at most 1000) and
`HTTP_STREAM_STALL_TIMEOUT_MS` (default 30000, 1000 to 600000) in `.env.example`,
validated strictly at startup and again for explicit `createChatServer` options
(`src/config/streamAdmission.ts`). Both defaults are local-use choices, not
measurements. `src/app/eventStreams.ts` holds one registry shared by both stream
routes, so the limit is global; as with turns, self-asserted identities would make
a per-user limit meaningless.

Decisions:

- Admission happens before any timeline read, header, listener or timer. At
  capacity the answer is `429 STREAM_CAPACITY` with `Retry-After: 1`; a refused v1
  stream allocates no identity.
- A slot is held until the response finishes or closes and any timeline read the
  stream started has settled, including the read before headers. Timers and
  listeners are cleared at once, and a read that returns after close cannot write.
- Bounded drain rather than disconnect on the first full write. A single snapshot
  or replay routinely exceeds the 16 KiB high-water mark on a healthy client, so
  disconnecting would make streams flap. Both streams derive from timeline state,
  so pausing loses nothing and no event queue is needed. While blocked, a stream
  does not read, write or ping; a frame refused while blocked is reported as not
  written (`blocked`), separately from a full write that was accepted (`full`), so
  neither the v1 cursor nor the legacy last snapshot records it.
- Each frame is one write, so a full buffer never separates an event line from its
  data. A stall deadline bounds both a blocked stream and an ended stream that has
  not flushed. Shutdown destroys streams that are blocked, flushing or headerless.
- Chromium closes an `EventSource` for good after a non-200 response: a probe on
  Chromium 153 made one request to a `429` endpoint and none in the following 5 s.
  The page therefore reopens a closed stream itself, with one pending timer tied to
  the failed stream and conversation, after checking for expiry.

Review over the bridge found and fixed, before verification: a skipped write while
blocked being reported like an accepted one, which lost an event or snapshot; an
untracked pre-header read that let an abort free a slot early; a synchronous throw
in the stream step leaking its read flag; a drain arriving mid-read not scheduling
the next step; shutdown cancelling the deadline of an ended but unflushed stream;
and a stall timer armed after a synchronous finish.

Validation on Windows Node 24.21.0: 968 tests across 113 files, 30 browser
tests, format and lint; `npm run bench:sustained-memory` passes (159 assertions,
heap within tolerance; no new report written). New tests are 4 configuration
cases (`tests/unit/streamAdmission.test.ts`), 13 helper cases with a response
whose writes can report full (`tests/unit/eventStreams.test.ts`), 10 integration
cases through the real request handler (`tests/integration/eventStreams.test.ts`:
shared cap across both routes with no read or identity on refusal; slot release on
`410`, `409` and validation paths; a pre-header read keeping its slot after abort;
v1 resume without gaps or duplicates; legacy not resending a buffered snapshot;
the heartbeat-blocked race on both routes; no overlapping reads; stall disconnect;
`closeStreams`), and 1 browser case in which the page's reconnect is refused with
`429` and the page reopens on its own. Temporary mutations (reverting the
blocked-write distinction, the cursor advance on a full write, the tracked
pre-header read, the synchronous-finish timer guard and the page's reopen) each
failed their targeted tests and were reverted. No live provider calls or service
restart.

Still open for step 2: peak per-stream memory still scales with the conversation size
for changed legacy snapshots; unchanged polls now avoid full copies with the
in-memory store. A v1 poll is budgeted but
one event can still reach the conversation byte limit, and stores without the
optional reads copy whole timelines; cross-owner denial with an authenticated identity remains the prerequisite for
any shared deployment.

_Legacy idle-poll revision check implemented and reviewed 2026-10-07; see the
[runtime reference](runtime-reference.md#event-stream-limits):_ a legacy stream
checks the optional cheap timeline revision before copying a snapshot. Unchanged
polls still enforce ownership, expiry and conversation-version checks, but copy
and serialize nothing. The accepted snapshot's own last sequence replaces the
retained serialized cache; only accepted or buffered writes advance it. Initial
empty snapshots, pre-header reads and the full-snapshot wire format stay intact.
Stores without revisions or usable snapshot sequences retain content comparison.
This reduces idle allocation and retained cache size, not peak memory during
changed polls or generation. Claude implemented the change and regressions; Codex
reviewed source and verified 104 focused stream/ownership/retention/protocol tests,
1,711 tests across 143 files, 34 browser tests, format, lint and documentation
contracts. No sustained-memory measurement or new heap bound is claimed.

_V1 budgeted reads implemented 2026-10-06; see the
[runtime reference](runtime-reference.md#event-stream-limits):_ with the in-memory
store, a v1 stream checks its cursor at open without copying events, and each poll
copies at most the larger of 256 KiB of serialized event bytes and one event,
admitting each event before adding it; backlogs continue over later polls. This is
a per-poll serialized-byte bound, not a heap, per-stream or whole-process bound.
Primary validation passed 1,395 TypeScript tests across 133 files and 34 browser
tests. Independent review passed 55 stream, protocol and timeline checks.
Seven mutations were rejected; removing expiry cleanup of the size array survived
because returned events are unchanged, but it would retain memory. The cleanup
was verified by source review rather than claimed as mutation-tested.
The full run preceded a test-helper listener cleanup found during independent
review; the final 24 protocol checks passed afterward without the listener warning.
Format, lint and documentation checks passed. No sustained-memory claim is added.

_V1 suffix reads implemented 2026-10-06; see the
[runtime reference](runtime-reference.md#event-stream-limits):_ after opening, a v1
stream's polls copy only the timeline events after its cursor instead of the whole
timeline, so idle polls copy none. At this initial increment (`919b869`), the open
still copied the full timeline and polls could copy a large unsent suffix; the
budgeted-read increment above supersedes those limitations for the in-memory store,
with its stated large-event exception. Custom stores can still fall back to a full copy.
Primary validation passed 1,388 TypeScript tests across 133 files and 34 browser
tests, with six rejected mutations. Independent review passed 48 suffix-read,
protocol and stream checks, including blocked reads, cursor resumption and
unchanged expiry behavior. Format, lint and documentation checks passed.
The deterministic idle-poll check observed zero copied events; no sustained-memory
gate was rerun because that gate does not exercise SSE streams.

_Last-Event-ID resumption implemented 2026-10-06; see the
[runtime reference](runtime-reference.md#event-stream-limits):_ a v1 stream resumes after
the later of `afterSequence` and a strictly validated `Last-Event-ID`, so a native
`EventSource` reconnect no longer replays delivered events; cursor and runtime checks
are unchanged, and the legacy stream is unaffected.
Primary validation rejected five named cursor mutations and passed 34 browser
tests, documentation checks/build and lint. The full suite exposed the earlier
startup-test timeout: Windows identity ACL checks launch PowerShell during setup
and authentication. A separate test-only correction gives that one integration
test a 15-second enclosing budget while preserving its two-second refined-output
check, five-second benchmark deadline and both real auth-header calls. Three
consecutive full runs then passed 1,383 tests across 132 files. Independent review
passed 30 protocol/startup checks before that timeout-only correction. There is
no global timeout or runtime authentication change.

_Connection limit implemented 2026-10-06; see
[connection limit](runtime-reference.md#connection-limit):_ Node's native
`server.maxConnections`, set from `HTTP_MAX_CONNECTIONS` (default 128, at most 4096)
or a validated direct option before listening. Incomplete, keep-alive and stream
connections count alike; an excess connection is closed before HTTP, with no 429.
Server timeouts, per-connection request counts and fairness between clients are
unchanged and not claimed.

Validation on Windows Node 24.21.0: 1,272 tests across 131 files and 34 browser
tests passed. Independent review reran 92 boundary, connection, startup and stream
tests. Seven temporary mutations were rejected, including omitted bootstrap wiring.
The sustained-memory gate passed all 163 assertions with heap within tolerance;
its before/after source digests match the independently reviewed source. Format,
lint and documentation checks passed. The memory workload does not stress the
connection cap; real-socket integration tests cover that boundary separately.

### 3. Cancellation, recovery and configuration correctness

- Pass cancellation/deadlines through initial catalog admission; release reservations
  on every aborted preparation path and stop cancelled callers waiting for quota.
  _Implemented 2026-10-06; see
  [generation](implementation/02-generation.md) and
  `tests/integration/preparationCancellation.test.ts`:_ an abort ends a quota wait
  promptly as `CANCELLED` or `WORKFLOW_DEADLINE`, never as a model exclusion or a
  fallback to another candidate; an abort or failure after reserving (including in
  phase creation or summary scheduling) releases every unstarted ticket and
  registered phase; legacy turns are cancellable, and shutdown-cancellable, from
  their history check onward, with 409 for the cancelled request. Started
  consumption stays charged. Compute waits after an attempt exists already
  honoured its signal; their sleep is now abortable too.
  Validation: 1,117 tests across 124 files, 34 browser tests, format and lint;
  the sustained-memory gate passed 162 assertions with heap within tolerance,
  including zero preparation controllers after each completed workload. Independent
  review reran 23 cancellation/shutdown tests and 53 adjacent regression tests.
- Implement provider/model-specific rolling-window quota reconciliation after
  cancellation-aware admission. _Prerequisite contract implemented 2026-10-06:_
  [quota observation v1](implementation/08-resource-policy.md#quota-observation-contract-v1-2026-10-06)
  validates and describes observations (capability-gated provenance, as-of
  anchored freshness, explicit coverage, successor classification) but grants,
  resets and reconciles nothing, and is not yet wired into admission. Define pool identity, units, fixed versus rolling
  windows, overlapping limits, authoritative snapshot/reset timestamps and whether
  provider observations already include our reservations or completed usage.
  Preserve outstanding reservations across refresh/reset and account for reports
  arriving later without double-counting or refunding uncertain consumption.
  Retain only the usage needed by active windows plus required accounting totals;
  do not reintroduce an indefinitely growing per-call ledger. Unsupported, stale
  or ambiguous observations remain explicitly unavailable or fail closed, with
  an operator recovery path. Do not infer a quota reset from elapsed cache TTL,
  model changes or a local counter clear. Keep local, metered API, cloud and CLI
  subscription policies configurable; avoid automatic usage checks on every call.
  _Configured envelope ledger implemented 2026-10-06 (initially unwired); see
  [configured quota envelopes](implementation/08-resource-policy.md#configured-quota-envelopes-2026-10-06):_
  conservative local accounting against operator-declared fixed windows, not
  provider reconciliation. Open charges count against the active window, unknown
  usage stays debited, debt is kept, and refusals change nothing. The admission integration below now uses it; provider-authoritative
  reconciliation still needs per-charge
  coverage proof that no current adapter supplies.
  Lead review accepts this configured, process-local prerequisite only. Final
  validation passed 1,420 TypeScript tests in two full runs and 34 browser tests;
  independent review passed 90 focused quota/admission/retention tests on the
  final source. Ten earlier independent boundary assertions preceded the final
  ID-counter and documentation changes. Fourteen temporary mutations were caught;
  one survived and was judged equivalent while the latest window is retained.
  An earlier full run had one unexplained failure in the unchanged local-identity
  rotation test; its full diagnostic output was not retained. That file passed
  three isolated reruns, and both later full runs passed without source changes.
  The cause remains unknown. Format, lint and documentation checks passed.
  _Opt-in admission integration implemented 2026-10-06:_ bindings with
  `quotaEnvelope` reserve money and declared quota together, gate starting on
  compute availability and a fresh envelope check, and settle with one report
  decision; unreported
  work stays debited until a per-call report, so envelopes can be exhausted by
  unreported usage. Envelope-free configurations are unchanged. Still open: a
  runtime window-declaration route, per-call usage reporting from providers, and
  provider-authoritative reconciliation.
  Lead review accepts the process-local integration. The implementer passed all
  1,441 TypeScript tests across 135 files and 34 browser tests on the final source;
  independent validation passed 140 tests across nine quota, admission, retention,
  selection, configuration and cancellation files. Twelve earlier independent
  boundary assertions preceded the final identity-allocation and inventory fixes.
  Final format, lint and documentation checks passed. Unreported charges retain
  bounded settlement links independently of diagnostic history; exhausting that
  bound refuses new work. Restart still loses the ledger, and elapsed time never
  retires uncertain usage.
  _Per-call usage reporting slice Q1c-a implemented and reviewed 2026-10-07; see
  [per-call usage reporting](implementation/08-resource-policy.md#configured-quota-envelopes-2026-10-06):_
  Ollama results carry the provider's own terminal-frame token counts, and catalog
  dispatch settles the exact token-envelope ticket through `reportQuotaUsage`,
  retiring its settlement link. Money, static quotas and request envelopes are
  unchanged; thrown, rejected, cancelled or count-less results stay estimated.
  Validation on Windows Node 24.21.0: 1,513 tests across 138 files and 34 browser
  tests pass, together with format, lint and documentation-contract checks. Claude
  implemented the slice; Codex source review and lead verification included added
  regressions for reported overage/debt, settlement beyond the open-charge cap and
  an Ollama deep response settling only its own ticket. All provider responses in
  these checks are offline fixtures; no live provider calls or service restart.
  _Slice Q1c-b (Azure) implemented and reviewed 2026-10-07; see
  [per-call usage reporting](implementation/08-resource-policy.md#configured-quota-envelopes-2026-10-06):_
  Azure chat completions report `prompt_tokens` and `completion_tokens` (detail
  counts not added again; a present `total_tokens` must equal their sum), and fast
  and deep results carry them to the same settlement path. Non-streaming calls report
  only with an explicit accepted stop or length finish. Streamed calls request
  `stream_options.include_usage` only when the API version is exactly `2024-10-21`,
  as the stable spec and official SDK document for text-only requests (evidence
  linked in the contract). Usage is accepted only from the final empty-choices chunk
  after an accepted finish and attached at `[DONE]`; early, repeated or non-final
  usage withdraws the report but keeps the answer. Other API versions keep their
  previous request shape and stay estimated. Tests: the "azure per-call usage" and
  "azure streamed usage (api-version 2024-10-21)" blocks in
  `tests/unit/azureProviders.test.ts` and the Azure cases in
  `tests/integration/quotaUsageSettlement.test.ts`. Claude implemented the slice
  and review corrections; Codex reviewed source and verified the terminal-wait
  cancellation boundary and completed-response settlement. Validation on Windows
  Node 24.21.0: 1,559 tests across 138 files and 34 browser tests pass, together
  with format, lint and documentation-contract checks. All provider responses
  are offline fixtures; no live provider calls or service restart.
  _Slice Q1c-c (Bedrock) implemented and reviewed 2026-10-07:_ Converse usage is
  normalized as `inputTokens` plus cache reads and writes for input and
  `outputTokens` for output, with every sum checked and `totalTokens` required to
  match (evidence linked in the contract). Non-streaming calls report only with an
  explicit accepted stop reason. Streams keep the answer validated at `messageStop`
  and then read at most one more event for up to 250 ms within the request's signal
  and deadline; only a valid metadata-only event settles, and every other tail
  outcome returns the answer without usage, including an oversized or malformed
  tail and a read that resolves just before cancellation. The stream is now driven
  by hand so an abandoned read or failing close cannot delay the result; the
  adapter bounds the return and handles rejections but cannot force an arbitrary
  iterator to settle. Tests: `tests/unit/bedrockUsage.test.ts` and the Bedrock
  cases in `tests/integration/quotaUsageSettlement.test.ts`. First focused
  verification passed 117 tests across 5 files before the review corrections
  (tail size limit, malformed tail and post-read cancellation checks). Installed
  SDK cleanup was verified independently by the lead with a local probe kept in
  the ignored cache (`node_modules/.cache/bedrock-review/cleanup.cjs`): Bedrock
  client 3.1140.0 with Smithy core 3.35.0 and NodeHttp2Handler 4.12.1 against a
  real local HTTP/2 server that sent an encoded answer and `messageStop`, then
  stalled. The stream's `return()` queued behind the pending read; the transport
  abort settled both, the server saw the stream and session close, no unhandled
  rejection occurred, and cleanup took 15 ms. No live AWS call was made. Claude
  implemented the slice and review corrections; Codex accepted the corrected
  source and ran final validation on Windows Node 24.21.0: 1,614 tests across 139
  files and 34 browser tests pass, together with format, lint and
  documentation-contract checks. Provider responses in the suite are offline
  fixtures; the separate transport probe uses only loopback. No service restart.
  _Q1c-d (CLI token usage) lower-bound reporting implemented and reviewed
  2026-10-07:_ a read-only audit of the installed Claude Code 2.1.285 found
  `result.modelUsage` cumulative per fresh process across every model call,
  auxiliary ones included, while the main-loop `result.usage` undercounts. It also
  found that completeness cannot be proven: auxiliary queries keep invisible SDK
  retries and some main-loop retries after an HTTP error response continue
  silently. A candidate that finalized CLI charges at that count was withdrawn
  before acceptance. Instead the Hekate bridge reports the summed `modelUsage` as an
  observed lower bound (fresh unpersisted process, one init reporting 2.1.285, one
  accepted result, nothing after it), a distinct `ObservedUsageLowerBound` that can
  never pass as `ProviderUsage`. Dispatch applies it to a token-envelope ticket
  through `ResourceAdmission.reportQuotaLowerBound`; the ledger raises the open
  charge to max(estimate, highest minimum), idempotently, in every window it
  reaches, keeps its link and open-charge slot, ignores request envelopes, and
  refuses a later complete report below the minimum. A lower bound above the
  allowance leaves debt that refuses the next admission. Length stops that end the
  CLI before its result still keep the estimate. Offline bridge, ledger, parser and
  real-subprocess-to-dispatch fixtures only; no live CLI call, so no live
  correctness is claimed. Outstanding: re-verify on every CLI upgrade. Local
  request counting (Q1c-e) does not depend on it.
  _Slice Q1c-e (request units) implemented and reviewed 2026-10-07:_ a request
  envelope counts local adapter invocations, the one unit admission already
  reserves per dispatch ticket, not external API calls or a provider allowance.
  `CatalogDispatch.execute` passes explicit completion evidence to `finish` for a
  returned stop or length result, which finalizes the ticket at exactly one
  whatever its token usage, CLI calls included, retiring the link without changing
  the debit. Direct cleanup without completion evidence, errors, cancelled or
  finish-less results and validation rejections keep their unit and link; a result
  completed after an abort still counts; a failed attempt and its fallback count
  as two. Token envelopes still require valid usage, and money and static quotas are
  unchanged. Tests: the request cases in
  `tests/integration/quotaUsageSettlement.test.ts`, including the open-charge cap
  and a window rollover; the fallback tests now prove the replacement ticket is a
  new, reserved ID before the retried call. Claude implemented the slice and
  review corrections; Codex accepted the source and verified 1,627 tests across
  139 files and 34 browser tests on Windows Node 24.21.0, plus format, lint and
  documentation-contract checks. No live provider calls or service restart.
  _Runtime quota-window declarations implemented and reviewed 2026-10-07; see
  [runtime declarations](implementation/08-resource-policy.md#configured-quota-envelopes-2026-10-06):_
  the operator-only `POST /routing/quota-envelopes/declare` passes one strict envelope
  declaration to `ResourceAdmission.declareQuotaEnvelope`, which accepts only pools
  configuration already declared and applies the ledger's existing rules unchanged
  (identical no-op, newer-evidence refresh, increasing non-overlapping successors
  that do not start before now, retained-window cap). One admission time is
  committed only on success, and refusals change nothing. Bounded codes: invalid
  400, unknown pool 404, conflict and capacity 409, clock 503, and 404
  `QUOTA_ENVELOPES_DISABLED` without catalog dispatch. The route is in the route
  table and the authentication inventory (44 routes, 19 operator). Tests:
  `tests/unit/quotaEnvelopeDeclaration.test.ts` and
  `tests/integration/quotaDeclarationHttp.test.ts`. Combined acceptance for runtime
  declarations and CLI lower bounds: Codex verified 1,681 TypeScript tests across
  142 files and 34 browser tests on Windows Node 24.21.0, 32 Python bridge tests
  using uv-managed Python 3.13.13, format, lint and documentation contracts
  (7 symbols, 15 invariants). No live provider calls or service restart. Not in scope:
  persistence (a restart returns to configured windows), an inventory route, new
  pools or bindings at runtime, automatic refresh and provider reconciliation.
  _Operator quota-window view implemented and reviewed 2026-10-07:_ Claude implemented
  operator-only `GET /routing/quota-envelopes`, projecting local accounting with
  pool/window digests, retained window phases, effective open charges and unresolved
  link counts. Reads do not commit the admission clock or prune state. Codex's
  source review found no blocker; all 31 focused endpoint/authentication tests,
  including empty pools, ordering, active calls and no pruning, pass, together with
  34 browser tests, format, lint and documentation contracts. The final broader run
  passed 1,694 of 1,695 tests across 143 files; the sole failure was a Windows rename
  `EPERM` in identity rotation. It also occurred in the preceding full run, while
  the seven-test identity file passed an isolated rerun. The subsequent identity
  replacement fix below restores full-suite validation. Complete provider
  accounting remains outside this view.
  _Windows identity replacement retry implemented and reviewed 2026-10-07:_ a
  disposable Node 24.21.0/PowerShell probe reproduced `EPERM` while another process
  held the destination open and a successful rename after release. The holder in
  the failed suite runs is not established. Rotation now retries only Windows
  `EPERM`, using the same atomic replacement under the existing rotation lock,
  with at most seven attempts and six waits totaling 1,575 ms (filesystem call time
  is additional). Persistent failures still throw; no destination unlink, copy or
  permission relaxation occurs. Real held-file tests verify delayed success,
  bounded exhaustion, non-Windows and other-error refusal, lock retention, cleanup
  and preservation of the old identity after failure. Claude implemented the fix;
  Codex reviewed it and verified 13 identity tests, two consecutive full runs of
  1,701 tests across 143 files, 34 browser tests, format, lint and documentation
  contracts. No real installation identity was read or rotated.
  Still open: streamed Azure usage on other API versions (each needs its own
  primary evidence), complete CLI token accounting (unproven as above), persisting runtime
  declarations and provider-authoritative reconciliation.
- On bridge protocol failure, terminate/drain the child and settle pending requests.
  _Containment implemented 2026-10-06; see
  [conversation tasks](implementation/11-conversation-tasks.md#bridge-failure-containment)._
  It provides strict bounded stdout framing and envelope validation, settlement
  exactly once (start, resume and cancel uncertain; reads unavailable), and
  termination confirmed by the child's exit. There is no respawn, no re-send and
  no retry promise. Still open: automatic recovery. _Atomic task creation
  implemented 2026-10-06:_ a new start's owner, queued task and binding commit in
  one transaction, a resent request returns its one task without scheduling it
  again, and a start that fails before the commit leaves no new sidecar rows (a
  scheduling failure after the commit keeps the bound task by design); see
  [atomic task creation](implementation/11-conversation-tasks.md#atomic-task-creation).
  This does not make model execution exactly-once. _Operator restart implemented 2026-10-06:_
  a supervisor runs one bridge per generation, waits for a fixed sidecar health
  answer before serving, and replaces only a failed generation whose exit is
  confirmed, on an explicit operator request with the expected generation; see
  [operator restart](implementation/11-conversation-tasks.md#operator-restart). _Stdin admission implemented 2026-10-06:_ requests are sent
  as pure ASCII within the sidecar's 16000-character line limit (`REQUEST_TOO_LARGE`,
  413), and a full stdin buffer refuses new work with `BRIDGE_BUSY` (503,
  `Retry-After: 1`) until that child drains; see
  [request admission](implementation/11-conversation-tasks.md#request-admission).
  Give orphaned document tasks an operator-visible reconciliation/abandon path that
  preserves uncertainty about external execution instead of claiming clean rollback.
  _Inspect and abandon implemented 2026-10-06; see
  [orphaned task recovery](implementation/11-conversation-tasks.md#orphaned-task-recovery):_
  operator routes guarded by generation, server-resolved owner, both execution
  locks, digest compare-and-set and an exactly replayable receipt; the external
  outcome stays unknown. _Recovery after a server restart implemented 2026-10-06:_
  the sidecar resolves the owner from its durable binding and owner rows, checks it
  against the server's owner when that is known, rechecks it inside the abandonment
  transaction, and refuses legacy or unscoped owners; nothing is adopted and no client
  access is created. _Recovery-candidate listing implemented 2026-10-06:_ operators
  page through bound running or cancel-requested tasks, including ones whose owner is
  still active, with an advisory owner probe and the owner's scope but never its key.
  Adopting conversations after a restart and migrating legacy owner labels remain open.
  Initial inspect/abandon validation: 1,215 tests across 128 files, 34 browser tests and 91 doc-agent tests
  through uv-managed Python 3.13.13 passed. Independent review reran 101 focused
  TypeScript tests (including seven real sidecar cases) and 34 Python recovery,
  creation and bridge tests. Nineteen distinct temporary mutations were rejected;
  corrupt timestamps/counters fail before any write. Format and lint passed.
  Restart-recovery validation: 1,245 tests across 130 files, 34 browser tests and 102
  doc-agent tests through uv-managed Python 3.13.13 passed. Independent review reran
  84 TypeScript tests, including nine real-sidecar cases with required Python coverage,
  and 45 Python recovery, creation and bridge tests. Fourteen temporary mutations were
  rejected; format, lint and documentation checks passed. Generations remain process-local;
  recovery neither adopts conversation identities nor grants client access.
  Recovery-listing validation: primary checks passed 1,367 TypeScript tests across
  132 files, 34 browser tests and 114 doc-agent tests through uv-managed Python
  3.13.13. The full TypeScript run preceded the final `__proto__` query fix; its
  54 HTTP/authentication checks passed afterward. Independent review passed 101
  focused TypeScript tests, including both required real-sidecar restart cases,
  and 36 Python recovery tests on the final source. Twenty distinct final mutants
  were rejected (14 Python, 6 TypeScript); two earlier mutants were superseded.
  An earlier full run hit a five-second startup-test timeout; that test passed
  alone and in the subsequent full run, so a possible timing flake remains disclosed.
  Review corrections cover concurrent payload growth, corrupt-row byte accounting,
  a non-creating owner probe with relative-path support, and strict query parsing.
  Format, lint and documentation checks passed. Pages remain advisory and are not
  a consistent snapshot; abandonment still rechecks its own locks and digest.
- Validate complete discovery batches before publishing inventory changes. Retain
  last good observations without extending freshness, and expose sanitized failure
  reasons without credentials or raw provider responses. _Implemented 2026-10-06;
  see [inventory](implementation/03-inventory.md#batch-validation-and-refresh-status-2026-10-06):_
  full-batch runtime validation (shape, identity, duplicates, clock, expiry),
  bounded per-connection refresh statuses with owned codes, and
  `discoveryRefresh` in `GET /models`.
- Define reload compatibility: preserve unaffected result handles/in-flight work;
  invalidate incompatible dependencies explicitly. Scope directory revisions to
  the relevant league/provider so an NFL read cannot invalidate NBA resolutions.
  _League-scoped revisions implemented 2026-10-06; see
  [request to evidence](implementation/12-request-to-evidence.md):_ each snapshot
  certifies only the leagues its lookup searched, with the revisions it read.
  _Component reload implemented 2026-10-06; see
  [component reload](implementation/12-request-to-evidence.md#component-reload):_
  profile, news and coordinator reloads keep the directory and game operations;
  game-only reloads replace game operations and drop only their results;
  directory reloads replace both.
  League revision validation: 1,165 tests across 125 files and 34 browser tests passed on Windows
  Node 24.21.0; independent review reran all 26 team-directory and game-operation
  tests. The expired-cache regression rejects a mutation restoring the old
  comparison. Format and lint passed.
  Reload validation: 1,179 tests across 126 files, 34 browser tests and the
  sustained-memory gate's 163 assertions passed, with heap within tolerance.
  Independent review reran 53 focused tests and then the final 14 reload tests;
  seven temporary mutations were rejected, including loss of the shared game
  cache. Format and lint passed.
- Make Azure/Bedrock deadlines configurable through the appropriate provider/model
  settings; retain separate workflow bounds. Audit Claude usage inspection and make
  its credential access/undocumented endpoint explicit and opt-in if not already so.
  _Implemented 2026-10-06:_ `AZURE_OPENAI_FAST/DEEP_TIMEOUT_MS` (default 10000) and
  `BEDROCK_FAST/DEEP_TIMEOUT_MS` (default 60000) accept whole milliseconds from 1 to
  600000 and are validated at startup, including hand-built factory settings;
  workflow deadlines are unchanged. Claude usage inspection now requires
  `HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED=true`; see [CLI](implementation/05-cli.md).
  Validation: 1,204 tests across 128 files, 34 browser tests and 20 offline bridge
  tests through uv-managed Python 3.13.13 passed. Nine temporary mutations were
  rejected. Bedrock streamed-body tests cover both roles, configured timeout,
  caller cancellation and timer/listener cleanup; format and lint passed.

Acceptance: cancellation while quota-blocked leaves no reservation; malformed stdout
and process kills leave no child/promise leaks or automatic duplicate execution;
orphaned tasks can be reconciled. Invalid timestamps cause no partial inventory write.
Unrelated league refresh/reload preserves valid handles, while incompatible changes
fail clearly. Verify configured deadlines and usage-inspection disabled/enabled paths.

Quota acceptance: deterministic clock tests cover fixed/rolling and overlapping
windows, exact reset boundaries, shared model pools, out-of-order/stale snapshots,
concurrent reservations, cancellation before/after start, and delayed/duplicate usage
reports. Refresh must neither grant the same allowance twice nor permanently block
valid work after a verified reset. Test adapter capability differences and bounded
window-state retention. Reliable long-running quota handling is not complete until
these checks pass. Cross-process/account-wide enforcement requires separate shared
coordination and is not implied by this process-local reconciliation work.

### 4. Current-state documentation and maintenance checks

The first increment below is implemented for its three components; extending it to
further components remains planned. Update nearby contracts and regression tests with
each change. Quota reconciliation and the other open reliability limits in steps 1–3
remain open.

_First increment implemented 2026-10-06:_ `GenerationLifecycle`, `CatalogDispatch` and
`BriefingCoordinator` carry `@lifetime`, `@invariant`, `@test` and `@decision` tags
(declared in `tsdoc.json`) for the seven symbols listed in `docs/contracts/pilot.json`.
`npm run docs:check` (part of `verify:release`) parses them with `@microsoft/tsdoc` and
the TypeScript compiler API and fails on a missing tag, malformed syntax, a duplicate or
malformed invariant id, a test title that is not an actual declaration, or a decision
link without a real heading. `npm run docs:build` writes TypeDoc HTML and JSON, a
consolidated invariant and lifetime index, bundled escaped copies of every linked source,
test and decision file, and a Madge import graph (JSON plus a searchable page, static
imports only) to `dist/docs`, stamped with the source revision and whether the tree was
dirty, then verifies that every relative link and fragment resolves inside the output.
CI keeps that output as a downloadable artifact; nothing generated is committed. Tools
are exact-pinned: TypeDoc 0.28.20, Madge 8.0.0, `@microsoft/tsdoc` 0.17.1. The import
graph currently reports 18 cycles, which it lists but does not fail on.

Validation on Windows Node 24.21.0: 1,243 tests across 129 files and 34 browser
tests passed; twelve temporary checker mutations were rejected. Independent review
reran 93 tooling and referenced behavioral tests, rebuilt the artifact, and copied it
outside the checkout. All bundled links still resolved; Chromium opened the index,
source anchor and TypeDoc page and filtered the 152-module graph without page errors.
Format and lint passed. The Linux CI artifact upload has not been exercised locally;
these checks establish documentation consistency and navigation, not behavioral proof.

_Implemented 2026-10-06, a related maintenance check:_ the Ubuntu CI job sets up
uv-managed Python, installs and checks the document-agent requirements, runs the offline
Python suites and requires the real document-task sidecar tests; see the
[README](../README.md). Linux runner execution was not exercised locally; equivalent
commands passed against a fresh Windows environment: 91 document-agent, 9 prompt-contract,
7 prompt-encoding and 4 inspection tests. Required-mode missing Python fails; optional
mode reports seven skips. All seven sidecar cases pass with the interpreter installed.

First increment: document `GenerationLifecycle`, `CatalogDispatch` and
`BriefingCoordinator`, then generate a browsable reference for those modules.

- Extend the existing root `AGENTS.md` with documentation-maintenance rules; tool-specific
  instruction files should point to it. Behavioral changes update the nearby
  contract and relevant tests. Avoid repeated session narratives in handoff files.
- Add TypeDoc and `tsdoc.json` with `@invariant`, `@lifetime` and `@decision` block
  tags. Module comments explain responsibility and boundaries; state owners explain
  retained state, cleanup eligibility, cancellation, failure behavior and known
  unbounded state. Link consequential decisions to existing or new ADRs and link
  invariants to regression tests. Do not repeat signatures or imports in prose.
- Enforce comment/tag presence and valid syntax for the initial three components.
  TSDoc syntax validation alone does not enforce presence. Select/configure the
  presence checks explicitly; do not impose a repository-wide documentation gate
  or infer ownership solely from a Map, Set or array. Extend coverage deliberately
  to queues, timers, subprocesses, reservations and state captured in closures.
- Generate an invariant/lifetime index from the documented tags with source,
  decision and test links. Custom tags alone do not produce this consolidated page;
  include the extraction/rendering step in the implementation scope.
- Add separate documentation check/build and dependency-graph commands, then wire
  them into `verify:release` and CI. Use Madge for import dependencies, configure
  TypeScript resolution and surface unresolved imports. Provide a machine-readable
  graph and a browsable view; document any rendering dependency such as Graphviz.
  Label it as an import graph, not runtime ownership or task flow. Publish generated
  artifacts rather than committing regenerated HTML/diagrams after every change.

Acceptance for the first increment: generated pages explain why terminal status
alone does not allow eviction, how task/consumer pins protect physical work, why
historical message IDs survive execution-cache expiry, and why cleanup must not
refund quota/spend. Each claim points to its implementation and relevant tests.
Checks reject a missing required contract/tag, malformed comment or broken required
link in the covered scope. Generation succeeds from a clean checkout, and dependency
resolution failures are visible. Documentation checks do not establish correctness;
regression tests remain the behavioral evidence.

Second increment: consolidate the reading path and broaden maintenance coverage.

- Keep one short current roadmap, durable ADRs and a concise `CHANGELOG.md` entry
  per meaningful change: what changed, why, validation and remaining limits. Session
  boundaries do not define entries. The changelog does not replace outstanding-work
  tracking. Stop appending parallel status accounts to implementation journals.
- Inventory active specifications and unresolved commitments before archiving
  historical journals, including the handoff. Preserve operative contracts, raw
  evidence and attribution; check inbound links and leave pointers where needed.
  Extract current commitments before moving dated roadmap history out of the main
  reading path. Do not blindly apply the review's proposed archive list.
- Rewrite README/case-study entry points around the runtime that exists, the sports
  demonstration, supported deployment boundary and remaining limits; link to the
  generated reference and current roadmap.
- Run Python tests in CI, adding bridge JSON-lines coverage. TypeScript/Prettier formatting checks are already implemented; keep any
  additional language formatting changes separate from functional diffs. Review abstraction costs against demonstrated uses; do not add durable
  state/retry machinery solely to justify the optional LangGraph dependency.

Acceptance: a reader can find current purpose, setup, supported boundary, evidence
and next work without resolving contradictory journals. Archived commitments remain
accounted for, CI exercises both languages, and formatting changes stay separate
from behavior changes. Expand documentation enforcement only after the pilot proves
useful; Python documentation generation is deferred until there is a demonstrated need.

### 5. Independent quality evidence, then renewed feature work

Re-scoped 2026-10-07 (priority update above): the human-labelled work below is
optional quality evaluation, not a gate for working-tool increments. It remains
required before claiming a factual-quality improvement. The text below is kept as
originally planned.

- Build a small independently human-labelled held-out set covering ambiguity, team
  resolution, unsupported sports, temporal scope, partial evidence, citation support
  and task completion. Keep development examples separate and record rubric/model/
  thinking settings. Human labels are outstanding work, not something the coding
  assistant can manufacture or claim as calibration.
- Separate runtime success, delivery integrity, factual quality and task completion.
  Blind model comparisons where feasible; calibrate model judges against human labels.
  Self-review remains an optional user-controlled quality-improvement step, distinct
  from independent assessment. Do not relabel historical assistant grades.

Resume provider-supported structured output after reliability/recovery gates and
review of this increment. Any claimed factual-quality improvement needs the independent
quality gate. Broader sports sources, automatic routing/review loops, persistent user
memory and general durable background roles remain longer-term work. Preserve manual
model/thinking/scope controls, model-specific budgets, payload/context separation and
the decision not to reject answers merely because expanded display references are large.

### 6. Declarative role coordination — planned (2026-10-05)

Goal: a generic way to carry out most complex tasks. The intended capability is the
same for every kind of task:

- an outcome;
- tasks and their dependencies;
- capability assignment;
- execution;
- verification and validation of each result;
- revision on rejection;
- durable state;
- delivery.

Roles, task dependencies and transitions are plan data, not a coding-specific
pipeline embedded in the engine. Target a stable interpreter with configurable
objects and registered capability adapters. New workflows that use existing
capabilities must not require engine changes; a genuinely new external capability
may require an adapter. Models may propose definitions and results, but cannot
grant themselves permissions or bypass validated progression conditions.

**Demonstrated so far: one application, software development.** Its single adapter,
Hekate's e1 software-development adapter, covers Git, npm and the Claude coding CLI.
A task is an allow-listed source change. When the task is authored, a reference
implementation proves that its frozen failing tests can be satisfied. The worker's
result is verified by those frozen tests and the repository's checks, and delivered
as a reviewed commit. That is how this adapter verifies work, not a requirement for
every task. Research, analysis, planning and operations tasks need their own
outputs, their own verification and their own adapters, and none of those exist
yet. Product orchestration of users' ongoing background objectives remains a
separate scope and acceptance decision.

Contract design and a manually supervised experiment on an existing
roadmap task may proceed alongside reliability work. The step 1 scoped lead
acceptance and current single-process loopback boundary review are recorded at
`fcceff2`; this permits contract design and the manually supervised experiment,
not a duplicate interpreter or automatic worker authorization. Do not silently
reorder steps 1–5 or treat the experiment as evidence of production readiness. Remote
execution requires authenticated ownership and the applicable step 2 deployment
boundary; durable recovery requires the applicable reliability/recovery gates.

#### Current foundation and gaps

| Area        | Existing foundation                                                                                                                   | Required addition                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roles       | Versioned catalog, instructions, model bindings, tool allowlists, budgets and definition hashes                                       | Logical roles separate from worker/model bindings; capability requirements, task context and validated result contracts beyond the fixed retrieval/evidence enums |
| Plans       | Human roadmap and bounded answer/clarify/retrieve capability plans                                                                    | Versioned executable tasks, dependencies, artifact inputs, acceptance gates and conditional transitions                                                           |
| LangGraph   | Optional model → validation adapter; tools remain application-owned                                                                   | Generic role execution and plan interpretation, persistent workflow state and resumable handoffs; engine and location pending the cross-repository decision below |
| Context     | Bounded conversation context, selected references, source provenance, omission diagnostics and one byte-preserved required H1 package | Separate optional-handoff consumer, source-read/destination-use authorization and immutable import provenance                                                     |
| Dispatch    | Model/provider registry, eligibility, admission and resource controls                                                                 | Worker registry with agent identity, machine/workspace access, capabilities, availability and assignment ownership                                                |
| Execution   | Bounded, cancellable CLI generation and provider adapters                                                                             | Coding-worker execution; the current CLI runner deliberately requires answer-only programs                                                                        |
| Transport   | Agent-bridge mailbox confirmed reachable on this machine (2026-10-06); not part of this checkout                                      | Inspect the actual mailbox and integrate assignments/results through a transport adapter                                                                          |
| Artifacts   | Tool results and answer/evidence validation                                                                                           | Revision-linked patches, findings, validation reports and review approvals                                                                                        |
| Durability  | Python single-task checkpoint experiment with confirmed-pause restart                                                                 | Production persistence, ownership and reconciliation of uncertain side effects; storage and language pending the cross-repository decision; no crash-replay claim |
| Integration | Repository rules and required checks                                                                                                  | Worktree lifecycle, exact-revision review gates, commit reconciliation and controlled roadmap updates                                                             |

_Source-outcome diagnostics implemented and reviewed 2026-10-07:_ the context's
host-only `omittedSourceCount` records distinct requested source events shown as
neither exact history, resolved excerpts nor unavailable markers. It is computed
after older exact pairs are admitted, and excludes duplicate and never-attempted
references. Model prompts, allocation priorities and token accounting are unchanged;
zero-room outcomes are visible to the host rather than claimed model-visible.
H1 still supplies its one byte-preserved required package and requires the count
to be zero. Claude implemented the change; Codex verified 127 focused context/H1
tests, 1,717 tests across 143 files, 34 browser tests, format, lint and documentation
contracts. No cross-conversation import or new authority is introduced.

_Offline handoff byte-reader foundation implemented and reviewed 2026-10-07:_ the
reviewed E2e reference bundle is captured byte-for-byte in
`tests/fixtures/hekate/e2e-consumer-v0/` with its pinned hash index, provenance and
formatting/line-ending protection. `handoffConsumer/exactJson.ts` reads bounded
strict UTF-8 JSON into immutable nodes with exact byte spans and numeric lexemes,
hashes raw bytes, preserves large integers and refuses unsupported numeric
conversions. Depth and node bounds are enforced without recursive parsing; duplicate
decoded keys, lone surrogates and forged numeric nodes are refused. It validates
JSON grammar only, not Python canonical spelling, finite clock semantics, delivery
bindings, current authority or composition. Those consumer layers remain pending.
Claude implemented the primitive and review correction; Codex verified 159 focused
reader/H1/C1a tests, 1,779 tests across 144 files, format, lint and documentation
contracts. H1 and C1a implementations are unchanged by this increment.

_Offline handoff delivery verification implemented and root-accepted 2026-10-07:_ `handoffConsumer/delivery.ts` and `pyCanon.ts` port the accepted
consumer's verification stage over the exact v0 bytes: ingress caps, wrapper and
codec, the closed receipt and raw digests, strict reading, the closed H1 options,
canonical `py-canon.v0` manifest/envelope/task checks with cross-field digests and
032 caps, then a host-supplied as-of snapshot and the H1 instruction binding, in the
reference refusal order. Canonical floats are verified within -0.0 and [0, 1e16);
unproven digit differences and other floats are `codec_unsupported`, never a guessed
mismatch. The reviewed byte-compatibility supplement is captured in
`tests/fixtures/hekate/e2e-byte-compat-v0/`. Tests cover every golden and
supplement variant and vector; numeric parity is tested evidence (including an
independent Hekate probe), not a proof for all doubles. Claude implemented the stage
and its review corrections (a wide-array traversal crash, the shared-buffer and
`Buffer.slice` copy gap, intrinsic byte lengths, uncoerced text fields, the exact
five-field snapshot identity); Hekate's implementer independently reviewed and
accepted it, and its probe ran the actual canonical checker over 3,268,010 number
lexemes in -0.0 and [0, 1e16) with no unsound verdict. Codex verified 228 focused
tests, 1,945 tests across 146 files, format, lint and documentation contracts.
CA-ISSUE-001 is now fixed: detached `ArrayBuffer` fields receive `strict_json`
after ingress checks. Claude reproduced the failure against the prior revision and
ran 1,951 tests across 146 files; root reviewed the fix and independently passed
90 delivery tests. The issue register records the verified source hash and closure
evidence.

_Offline handoff composition implemented and root-accepted 2026-10-07
(CA-ISSUE-002):_ `handoffConsumer/compose.ts` ports the reference composition:
policy stub, bounded retrieval, imports and note, the consumer view with its digest
and fixed-width reservation, and ChatAgent's own H1 under the reduced window, bound
to the committed task. It writes `py-canon.v0` without printing a JavaScript float,
binds the snapshot, policy and request as given, and budgets with exact integers.
The golden compositions reproduce byte for byte with H1 at HEAD and the recorded
windows; the supplement compositions reproduce with a labelled port of the
reference stub. Root independently passed 68 composition tests after reviewing the
policy, callback, malformed-output and budgeting corrections; Claude's final full
run passed 2,019 tests across 147 files, with lint and documentation checks passing.
Tests only: no host slot (CA-ISSUE-003), route, CLI or network.

_Offline handoff CLI implemented and root-accepted 2026-10-07:_
`scripts/handoff.ts compose` runs the accepted composition with ChatAgent's own H1
over explicitly named delivery, snapshot, policy, request and optional recorded
retrieval files, with descriptor-bounded reads, strict exact-integer JSON and typed
codes, and writes the exact view part, the bound H1 text and a provenance summary to
a new, exclusively created directory. The golden deliveries reproduce byte for byte
through it, including as a subprocess. It is an offline operator tool for the
supervised loop, not conversation activation: the host slot stays CA-ISSUE-003.
Root reviewed the exact request matching, descriptor bounds and partial-write
cleanup and independently passed 34 CLI/publishing tests. Claude's final full run
passed 2,053 tests across 149 files, with lint and documentation checks passing.

_Host slot for the consumer view implemented and root-accepted 2026-10-07
(CA-ISSUE-003):_ `handoffConsumer/workerContext.ts` attaches a composed view to
ChatAgent's H1 worker context as an escaped, attributed `[HANDOFF_VIEW]` data block
rendered last by the shared adapter seam, binds it to that composition and H1 result,
recomputes the estimate and checks it against the original budget. The CLI's
`--emit-request fast|deep` writes the resulting worker request offline. No provider
call, conversation creation or worker launch; contexts without a view are unchanged.
CA-ISSUE-010 records the open older-attempt status gap from Hekate plan 038.
Root independently passed 243 focused tests, including 47 host-slot tests, after
reviewing the final corrections. Claude's final full run passed 2,104 tests across
150 files, with format, lint and documentation checks passing.

_Coordination status parity with Hekate plan 038 implemented and root-accepted
2026-10-07 (CA-ISSUE-010):_ C1a now reports a Done leaf whose stale acceptance
belongs to a strictly older positive attempt epoch as `review_pending`, labelled
`acceptanceHistorical`, instead of `stale`. Same-epoch drift and missing, zero or
non-older decision epochs stay `stale`; no acceptance or execution acknowledgment is
inferred, and existing output is unchanged.
Root independently passed all 38 status-consumer tests; Claude's final full run
passed 2,113 tests across 150 files, with format, lint and documentation checks
passing.

_Cross-repo view parity gate implemented and root-accepted 2026-10-07
(CA-ISSUE-011):_ the handoff CLI's `--expect` reads a closed
`handoff-expectation.v0` from the producer and refuses to publish unless its own
composition (with ChatAgent's real H1) has the same view digest, view-part hash,
reservation, cost, H1 supplied digest and candidate. It claims view parity only. The
Hekate producer and `--export` input are now accepted below; checking a model
review session's actual input remains a later increment.
Root independently passed 56 CLI and publishing tests; Claude passed 171 focused
tests on the final source and 2,131 tests before only the summary wording changed.
Format, lint and documentation checks passed. The consumer gate is accepted;
The end-to-end closure is recorded below.

_Export input implemented and root-accepted 2026-10-07 (CA-ISSUE-011):_
`compose --export <dir>` reads the closed 13-file `handoff-export.v0` layout root
froze in bridge message 1549. It refuses missing, extra, nested or linked entries,
files replaced after listing, and any index other than the canonical one, then
always checks the expectation. Tests use a synthetic golden-derived export; the
real producer capture and end-to-end check are recorded below.
Root independently passed 86 CLI and publishing tests after reviewing the bounded
directory-listing correction. Claude passed all 435 handoff tests; format, lint and
documentation checks passed.

_Real pilot export captured and CA-ISSUE-011 closed 2026-10-07:_ the real Claude
CLI round `a5882739c150` at Hekate `1af9a9e8` used the pinned real H1 at `5255daa`
to prepare and compose its handoff. ChatAgent at `2383e85` rebound the task and
matched the view bytes, digests, reservation and cost. The unchanged 13-file export
is preserved in `tests/fixtures/hekate/pilot-export-v0/` with its hash index and
adjacent provenance. Claude passed 22 independent acceptance checks; root
reproduced the original CLI result and passed 90 CLI and publishing tests on the
captured fixture. All 439 handoff tests, format, lint and documentation checks pass.
Hekate's producer passed 807 tests and both replays from clean committed source.
The reviewer was a deterministic verifier; the request is still an offline
artifact, the snapshot historical, and the policy a test stub. Next is the first
reviewed existing-repository task through this supervised loop, with an immutable
acceptance oracle and a bounded operator configuration. Unattended recovery and
production policy remain outside this local pilot.

_First existing-repository task verified and integrated 2026-10-07 (CA-ISSUE-012,
closed):_ operator reload of the role catalog without restarting, with a bounded
strict-UTF-8 read, atomic replacement and an operator-only route. The real Claude
CLI produced artifact `a7fd2ec` against the isolated oracle base `1f75576` and frozen
task spec `b919504a…22d4e`. The original Hekate pilot stopped before tests because
the verifier worktree exceeded Windows' path limit; its outcome remains
`needs_operator`, with no recovered PlanStore decision. The repaired runner at
`30279d8` accepted the same artifact in a fresh verifier-only recheck: all 15 frozen
oracle tests and typecheck passed. Root independently checked its preserved binding,
artifact and evidence; the raw review view was not preserved or replayed.

Implementation and tests are integrated together, including the existing auth route
inventory update, explicit 30-second HTTP test startup timeouts and pinned
formatting. Root's integration checks passed 2,171 tests (nine skipped, zero
failures), lint and documentation contracts. The register records the evidence
digests and exact scope; acceptance of the frozen oracle is narrower than full-repo
regression checks. Hekate's PlanStore remains the authority for each pilot's task
state. The broader roadmap is still coordinated through the bridge and documents;
it is not a persistent live roadmap graph in either application. Unattended recovery
and production policy remain deferred.

_Second supervised task prepared 2026-10-07 (CA-ISSUE-013, assigned, not
implemented):_ align the TypeScript consumer with the revised Python reference so a
missing required review identity field is refused at verification as
`delivery_mismatch`. Its oracle is frozen on the isolated branch `task/ca013-base` at
`18d5ec9` (intentionally failing there; never merged to main as-is), and its candidate
spec `467fde17…a4a1d8` adds the full repository suite and the documentation check to
the oracle and typecheck, so the verifier sees full-repo regressions this time. A
supervised run needs root's GO; Hekate's PlanStore remains the task authority.

_CA-ISSUE-013 re-prepared 2026-10-07 (still assigned):_ the first pilot was correctly
rejected at the full-suite step in both rounds. An existing test still asserted the old
revalidation-stage code, so the source-only task was unsatisfiable. Task base v2
`1bdc103` also updates that assertion and pins both test files. Spec v2
`b644847c…2ccc3` was proven satisfiable by a throwaway reference implementation
across all four steps before it was frozen. A second pilot needs root's review and GO.

_Windows limitation registered 2026-10-07 (CA-ISSUE-014, closed 2026-10-08 for
delete-sharing holders; see the active plan loop above):_ identity
rotation can fail safely with `EPERM`, with a suspected external file holder (cause
unproven; 80-run reproduction: about 7.5% of rotations, and the existing retry
recovered none of the 6 observed failures). It stays in the
default suite as a visible platform failure; a safe atomic replacement is the bounded
follow-up.

_CA-ISSUE-013 verified and integrated 2026-10-07 (closed):_ the second pilot was
accepted in round 1. The real Claude CLI artifact `bd03650` changed only `delivery.ts`,
and the runner's verifier passed the frozen oracle, typecheck, the full repository
suite and the documentation check. This is the first task accepted with full-repo
regression checks inside the verifier. The integration carries the artifact unchanged
with both frozen oracle files. The TypeScript and Python consumers now refuse a
missing review identity field at the same stage with the same code.

_Plan-driven dependent tasks (2026-10-07, first real run 2026-10-08):_ This is the first
demonstrated application of the generic flow above, using the software-development
adapter. Hekate runs a prepared plan of dependent tasks:

- plan-run v0: plan 042, `5b37ed7`;
- D3 v1: plan 044, `7661168`;
- a persistent local store: P2, plan 043, `0d3c3d1`, with its create command at `019c5bf`.

- **Import and drive.** A small plan is imported into PlanStore. Its ready nodes are
  driven one at a time through the existing supervised runner.
- **Successor bases are derived automatically.** A successor's task base comes from its
  predecessor's accepted artifact plus a pinned oracle. This works only within the same
  source repository and needs no operator step between tasks.
- **Command line.** `plan_cli` validates and runs a prepared plan. `local_cli create`
  makes the coordinator's own marked database, and `--store local` keeps PlanStore
  state there.
- **Restart.** A cleanly stopped plan continues in its bound run root, after an operator
  pin if needed. A second process does not rerun accepted work; this was verified across
  two OS processes. A single coordinator holds the database, and record times are UTC.
- **First real run (2026-10-08, root GO 1946).**
  - The plan: two dependent ChatAgent tasks. Task A adds blocker predecessor names to
    the coordination status; task B shows `blocked by` and `ready now` in the human
    CLI.
  - The run: real Sonnet workers in one `plan_cli run --store local`, with no operator
    step. Each task was accepted in its first round after all four verify steps
    passed. B's base was derived from A's accepted artifact. The run took 3 min 50 s,
    from 05:08:10Z to 05:12:00Z.
  - Spend: a nominal $1 CLI budget per round, which can overshoot at a turn
    boundary. The actual spend was not retained.
  - The accepted artifact was a candidate only. It was integrated through a separately
    reviewed branch carrying the same source and frozen oracles.
- **Second real run, stopped (2026-10-08, root GO 2063).**
  - The plan: one task, `devcoord status --check` (spec `df43cd3c`, base `5f4be3a`),
    with at most 2 rounds.
  - Round 1: the Sonnet worker produced candidate `a6fb96d`, which changes
    `scripts/devcoord.ts` only. The oracle and typecheck passed. The full suite
    failed two `localIdentity` tests at their PowerShell step, so the verifier
    rejected the candidate.
  - Round 2: creating its worktree failed before any worker started.
  - The plan stopped at `needs_operator` at 06:01Z. Its store and evidence are
    retained, and it was not retried.
  - Cause: both failures coincide with a Windows restart attempt. Session teardown
    started at about 06:01:51Z, and the failed restart was logged at 06:01:57Z. The
    machine slept at 06:04Z. The same tree later passed the identical full-suite
    command twice. This is a strong inference from timing; the failing child exit
    codes were not retained.
  - Spend: CLI-reported (not metered) $0.06 in 9 turns, round 1 only.
  - The original stop and the round 1 rejection stand unchanged.
- **Operator artifact verification of that candidate (2026-10-08, root GO 2092).**
  - What it is: one independent re-run of Hekate's existing verifier on `a6fb96d`,
    in a new owned clone under a new output directory. It used no model, journal or
    PlanStore, and it is not a recovery or a review decision.
  - Bindings: it was bound to the original spec, the run and evidence records (by
    sha256), the round 1 receipt and the run-owned ref. The raw review view was not
    preserved, so the original verifier's report is the declared trust basis.
  - Result: accepted, with all four frozen steps passing (2221 tests passed,
    9 skipped). Evidence `verify-evidence.json` sha256 `45e4bd75`. The original
    records were unchanged by sha256 afterwards.
  - The candidate's source and its frozen oracle were integrated unchanged, through
    a separately reviewed branch.
- **Progress in ChatAgent.** The read-only coordination status reports plan progress
  from PlanStore's own verdict, so `no_ready_work` is never shown as done.

The earlier manual handoff, in which an operator prepared each successor's base, stays
recorded in Hekate's plan 042 and its fixture provenance.

Limits:

- **Manual authoring.** The lead or authoring agent still writes the plan, the task
  specs, the oracles, the recipes and a satisfiability proof against a reference
  implementation. Nothing decomposes a roadmap automatically.
- **No in-tool resolution.** In-flight or uncertain work, including an uncertain
  operator act, stops the coordinator, with no in-tool resolution and no automatic
  recovery. There is no unattended operation. A dispatch that stopped before its
  worker launched also stays unresolved. The second run's stopped round is one such
  case. Its stopped state is kept as the truthful record, and its candidate was
  verified and integrated separately.
- **Why there is no reconciliation command yet (decided 2026-10-08).** A reviewed
  design was deferred, including a read-only check mode. Resetting the node to `todo`
  would let a new run root rerun it with a fresh round budget. It would also show
  work as unfinished when that work is already integrated. A safe design also needs
  three things: an idempotent writer takeover and re-acquisition; replay after a
  crash part-way through an operator act; and recipe predecessor selection. These
  belong in one joint recovery and continuation design.
- **A stopped node cannot continue.** A node's run root holds exactly one run. Plan
  identities are derived from the plan file, so a new run root re-attaches to the same
  PlanStore node.
  - While an attempt is open, as check-002's is, a run in the same root or a new root
    stops at `inflight` before any claim.
  - Only a reset to `todo` would change that, and no reset is authorized for this stopped run. After one,
    the same root would stop at `node_run_root_exists`, and a new root would run the
    node again with a fresh round budget.
  - PlanStore's attempt epoch records attempts, but no round bound is enforced across runs.

  Continuation needs its own design: a retry root per node, predecessor binding across
  runs, and an enforced cross-run attempt bound.

- **Single, same-repository chains.** A recipe successor has exactly one predecessor in
  the same repository, and it continues only in the original run root.
- **Manual integration.** Accepted work is not integrated into the primary repository
  or pushed automatically; integration stays a reviewed step.
- **Spend is reported, not metered.** Since Hekate `c701ce0` the evidence keeps each
  round's CLI-reported cost, turns and duration. Nothing meters spend independently.
- **Setup failures in older runs lack Git detail.** The second run's worktree-setup
  failure kept no Git exit code or error text, and its evidence stays as recorded.
  Since Hekate `115ab6d`, a failed worktree setup keeps Git's exit code and the tail
  of its error output. A failed read of the run-owned refs is now recorded as an
  error, not as an empty list.

Next: more real prepared plans. The first run's friction was hand-built spec packages.

- **Single-task authoring is implemented and verified.** Hekate's `task_author`
  (`04106f2`) builds one pinned spec from a draft and the reviewed ChatAgent profile
  (`docs/contracts/hekate-task-profile.json`, doc 13). It proves the spec by baseline
  capture, the unchanged preflight and the real verifier on a reference patch.
- **Rehearsal.** An offline rehearsal reproduced the first chain's task A spec in
  92 seconds, with no model or spend.
- Task choice, oracles, reference implementations, recipes and multi-task plans stay
  manual, and nothing decomposes prose into tasks.

Reuse context, provider, budget and lifecycle components where their contracts fit.
Do not turn the bounded retrieval planner into an unrestricted coding executor or
import Hekate's full orchestration stack. Hekate provides design references for
structured prompts, task policies and event-driven handoffs; its active-path and
context-history findings reinforce one canonical execution path and recording the
actual supplied context. Storage of context alone does not establish its delivery
to the model. See [the ownership audit](adr/0001-chat-runtime-ownership.md) and
[durability experiment limits](../reports/doc-agent/durable-findings-2026-09-27.md).

#### Cross-repository direction (2026-10-06)

The user prioritized Hekate plan-node planning, with Hekate startable locally when
needed. The [integration contract](implementation/13-hekate-plan-node-integration.md)
records the split. Hekate owns on-demand local startup, status and stop; plan nodes
in its existing PostgreSQL/AGE store; and the choice of execution engine after its
inventory. ChatAgent owns context assembly and the answer runtime, and may propose
a worker contract. Hekate's supervisor adapter owns claim/finish/release mutations
under accepted design 023; ChatAgent owns pure context assembly. Hekate already
has coding executors; reuse of its prepared-prompt provider boundary remains gated.
Any coding adapter stays separate from ChatAgent's answer-only CLI runner.

This corrects an earlier assumption. `Odin/gods` is Hekate's designated engine
in its source architecture. The initial missing import was subsequently recovered
from existing source history, with successful offline imports and tests reported
by `codex-hekate`; live engine integration remains unverified, as the contract records.
`Odin/langgraph_engine` is an uncommitted, undeployed experimental candidate,
not the canonical engine. Increment 2's generic interpreter therefore waits for a
cross-repository engine decision. Do not build a second generic interpreter in
ChatAgent before that decision. Increment 1 contract work should target fields
that Hekate plan nodes can carry, rather than a ChatAgent-only plan store.

_Development coordination status (C1a) implemented 2026-10-06; see
[the contract](implementation/13-hekate-plan-node-integration.md#development-coordination-status-c1a):_
a read-only, fail-closed projection of a Hekate managed plan into per-leaf states,
identities and stale-input flags, with a loopback-only CLI. It mutates nothing and
reports execution acknowledgement as unknown. Evidence: offline regressions on a
captured raw view and labelled synthetic edits, a CLI subprocess test against a fake
loopback server, and an independent CLI smoke against a disposable Hekate API; no
live model or wake-up was involved. Durable acknowledgement, review handling,
progress evidence and wake-ups remain unfinished and depend on Hekate.
Lead review accepts this read-only slice. Final implementer validation passed
1,470 tests across 136 files and 34 browser tests; independent validation passed
97 status-consumer and H1 tests on the frozen source. The independent live CLI
smoke used a clean Hekate `d0ed671` archive and the same source hashes, with verified
cleanup of its disposable API and database. A temporary container-classification
mutation was caught and restored. Format, lint and documentation checks passed.
The next increment is Hekate-owned durable execution acknowledgement and review
progress, followed by a supported wake adapter. Hekate's lead has not acknowledged
the handoff. A separate, read-only Claude continuation was refused by the CLI's
workspace-trust gate; no session was interrupted and no trust setting changed.
This reader does not resolve either coordination blocker.

_Receipt-to-context package (H1) implemented 2026-10-06; see
[the contract](implementation/13-hekate-plan-node-integration.md#receipt-to-context-package-h1):_
deterministic validation and rendering turn one raw Hekate claim response and the
required rule texts into a frozen, length-framed task text, its supplied-text hashes
and the pinned receipt source; a context wrapper builds the context with the whole
package as fixed cost.
Hekate's supervisor owns claiming, finishing and releasing; ChatAgent has no
network client, worker launch or runtime wiring for it yet.

H1 is lead-accepted. Earlier full primary validation passed 1,335 TypeScript tests
across 132 files and 34 browser tests before final raw-number/rule-framing fixes;
after those fixes primary and lead each passed 79 focused tests (68 H1 and 11
contextBuilder), with 105 earlier adjacent lead tests and 20 distinct rejected
mutations. Format, lint and docs checks passed; raw fixtures match Hekate `bb2af8b`
byte-for-byte. Hashes cover mandatory current-user text, not system/role text.
Hekate design 023 is accepted at `68bab95`; E1a `bf61588` passed 103 independent
tests, and E1b `6f50dac` passed 113 default, 31 pure H1 interop and one live test
(145 total, zero skips). Clean-source/runtime checks pinned ChatAgent `5255daa`
and Node 24.21.0. The bounded real-API → H1 → fake-worker → guarded-finish seam
preserves structured uncertainty/holder evidence with no retries. Owned API,
disposable databases and `.run` cleanup were verified; the container is stopped.
Hekate plans 024/025 record the evidence. E2a, a test-only in-memory evidence model
and classifier for launch and review-pending evidence, is accepted at `d0428dc` (plan
027); no durable journal, coherent production read, restart recovery, real worker,
wake or model activation is established.
The E2b-a disposable-database journal experiment is independently accepted and
committed in Hekate `d0ed671` (design 028, evidence 029). Final `uv run --locked`
validation in the clean `ca672ec` archive plus the owned overlay passed **366 default
tests and two independent regression probes**. The probes first reproduced unsafe
first-intent retry after retention and stale-entry reinsertion during queue cleanup;
both pass after Claude's corrections. A second reviewer confirmed the fixes.
The earlier corrected checkpoint passed 31 pure H1 and one separately run live H1
check; those interoperability suites preceded the final journal/queue corrections.
The final source differs from the tested source only by a comment clarifying the
snapshot boundary; plan 029 records the exact hashes and validation timing.
Missing streams now require operator reconciliation; retry identity remains a
caller rule. Queue cleanup reflects its database read, so later resolutions may
remain visible until another scan. Logical journal caps do not bound writer/audit
rows or total database storage. No production journal, coherent-read contract,
real worker, automatic wake or unattended recovery is established.
Claude completed the fixes in its existing session; a separate continuation and
workspace-trust change were unnecessary for this increment. Normal development
services remain running (API 5103 and UI 5179 returned HTTP 200 after validation);
the shared PostgreSQL container stays up. Test API 5108 is stopped, no test database
remains, and earlier failing-probe artifacts are retained for diagnosis.
Provider reuse and real execution remain gated;
this does not decide the generic orchestration engine wholesale.

#### Increment 1: executable contracts and context

- Define versioned `Plan`, `Task`, `Role`, `Artifact`, `Transition` and
  `ExecutionPolicy` schemas. Specify dependency/input references, role instructions,
  required capabilities, result schemas, acceptance evidence, deadlines, budgets
  and bounded attempts/review rounds. Validate identifiers, references, schemas
  and reachability; allow deliberate bounded fix loops. Use a small validated
  condition language rather than arbitrary executable expressions in plan data.
- Give roadmap tasks stable IDs. Translate a selected prose section into a
  structured proposal, validate it and snapshot its requirements before assignment.
  Plan changes require an explicit revision/update or cancellation, not silent
  reinterpretation by the next worker. Missing decisions become visible blockers.
- Build task context through existing context machinery. Preserve assignment,
  acceptance criteria and repository rules as mandatory context; shorten optional
  background first. Split the task or choose a capable model when required context
  cannot fit. Distinguish requirements, verified facts and agent conclusions.
- Record plan/role versions, base revision, context sources/hashes and the actual
  supplied context under bounded retention and access policy. Provide source
  retrieval for further investigation. Each worker session must be able to start
  fresh without relying on another model's conversation memory.
- Define role-specific inputs: implementers receive the assignment and relevant
  code/contracts; reviewers receive the original requirements, exact proposed
  revision/diff and evidence. Implementation summaries supplement independent
  inspection. Fix assignments preserve original requirements and findings.

Acceptance: two meaningfully different workflows validate using the same schemas;
invalid references, unsupported contracts/capabilities and unbounded loops are
rejected. Context-budget tests preserve mandatory requirements and identify missing
inputs. No executable plan can expand the configured tool/permission boundary.

#### Increment 2: one local interpreter and complete handoff

- Implement a generic LangGraph execution shell: load the current task, assemble
  context, resolve a worker, invoke the role adapter, validate its output, persist
  state and evaluate plan-defined transitions. Role names and coding-stage order
  must not appear as engine-specific routing rules. Keep model/provider, tool
  execution and native/graph comparison boundaries explicit.
- Add a coding-worker adapter with explicitly configured workspace/tool access,
  cancellation and bounded resource use. Preserve existing answer-only CLI
  guarantees; do not relax that contract to obtain editing capabilities.
- Represent patches, review findings, validation evidence and approvals as typed
  artifacts with task/attempt identity and revision provenance. Approval applies
  only to the reviewed content; subsequent changes require renewed review.
- Manage isolated worktrees and a single integration owner. Transfer commits or
  patches between machines rather than assuming shared files. Express Git/checks/
  roadmap updates as registered operations used by plan steps, not engine stages.
  Required repository checks and explicit human acceptance decisions remain gates.
- Prepare a concise roadmap update with completed work, evidence, limitations and
  next task. Include it in the final reviewed/validated content before committing;
  store the resulting commit hash in execution state. Do not manufacture a
  self-referential commit hash in its own roadmap update or overwrite unrelated
  working-tree changes. A next task starts only when its dependencies are satisfied.

Acceptance: an existing bounded roadmap task completes implement → independent
review → fix if needed → checks → local commit → roadmap handoff. A second,
meaningfully different workflow runs without engine-code changes, using only plan
and role definitions plus existing capabilities. Regression coverage proves stale
approval rejection, failed-check routing, cancellation and bounded fix loops.
No push, merge or service restart is implied by local commit capability.

#### Increment 3: durable mailbox coordination and recovery

- Inspect mailbox identity, delivery, acknowledgement and reconnect behavior before
  selecting integration details. Define versioned assignment, progress, question,
  result and cancellation messages; keep transport separate from workflow logic.
- Register workers separately from models. Track capabilities, authorized workspace,
  machine identity and availability. Persist exclusive assignment ownership with
  leases and attempt fencing; stale workers cannot advance a superseded task.
- Persist authoritative workflow state and artifact references before progression.
  Duplicate delivery must not duplicate transitions or commits. Bound queues,
  artifacts, event history, retries and disconnected-worker retention.
- Reconcile uncertain edits, validations and commits after interruption. A graph
  checkpoint alone cannot prove whether a side effect occurred. Use operation
  identities and inspect resulting repository state before replay; block ambiguous
  outcomes with evidence instead of guessing. Authoritative persistence failure
  stops advancement even if an optional searchable context copy can degrade.
- Exercise remote cancellation/draining, lost acknowledgements, worker replacement
  and coordinator restart. Preserve failures and measurement artifacts; distinguish
  workflow correctness from subjective model quality.

Acceptance: restart and duplicate-delivery tests preserve task ownership, artifacts
and budgets; stale results cannot advance state; interruption around a commit is
reconciled without duplicate commits. Demonstrate a cross-machine handoff through
the actual mailbox. Record unresolved recovery cases and supported deployment scope
before claiming unattended execution. Dynamic decomposition, semantic memory,
specialist hierarchies and elaborate routing are deferred until demonstrated needs.

### Review interpretation and tracking

Source: [deep review](deep-review-2026-10-01.md). Track each implementation with a
reproduction, acceptance result and exact commit plus dirty-tree/source identity.
The review names HEAD `968e47d` but reports the current 740-test working tree; its
snapshot needs clarification before treating it as a commit-only audit. It remains
unchanged as the reviewer's original report.

Findings 1–2 map to step 1; finding 3 to step 2; findings 4–9 to step 3. Documentation,
CI/formatting and abstraction concerns map to step 4; quality calibration to step 5.
Dispatch retains contexts, but telemetry clones metrics/admission state, not the
entire phase map. The Azure timeout is a confirmed fixed default; whether a specific
answer exceeds it requires measurement. Scope drift and dependency motivations are
interpretations, not reproduced defects. Confirm untested claims with targeted cases
before selecting their fixes.

Plan update only: no reliability implementation, deployment, migration or commit is
claimed here. For each increment, run targeted regressions plus relevant build/CI
checks; expand verification when changes or failures justify it.

## Historical roadmap entries

## Native/graph integration comparison — 2026-09-30

Twelve deterministic integration checks now run six identical scenarios on each engine
through CapabilityChat, ChatService, catalog dispatch and the live sports adapter with
fixture transport. They cover sports payload/context separation, selective row injection,
foreign/expired references rejected before inference, shared sports-request admission,
inaccessible pinned models without substitution, model-account quota denial, and a
held tool while another turn completes followed by cancellation/late-result suppression.

All 12 tests and TypeScript build pass. An initial assertion incorrectly matched the
user-facing error text against an error code; it now checks the actual code. No runtime
fix was needed. No live model/provider calls or performance measurements were made.
The graph adapter remains opt-in and uncommitted; native remains default. These tests
show equivalent behavior for the listed cases, not general reasoning-quality parity.

Next bounded step: design the dependent retrieval-to-answer contract and deterministic
fixtures before expanding the graph. Specify exactly which evidence reaches the next
model call, total model/tool-call budgets, partial-evidence behavior, cancellation and
independent grounding checks. Do not automatically inject full payload tables or turn
on review/retry loops. Production adoption still needs broader error/deadline/reload
coverage and live model quality evidence. The whole-plan status table below (handoff
and roadmap) remains applicable; step 3 has stronger deterministic coverage, while
quality evaluation, general background roles and persistent memory remain incomplete.

## Whole-plan checkpoint and graph comparison start — 2026-09-30

Committed `eb50551`: manual role UI/context-budget display and metadata attempt-ID
fix. Regression checks show metadata shares the actual attempt and terminates on both
success and failure. The next framework increment is uncommitted: an opt-in TypeScript
LangGraph model/validate adapter behind ROLE_PLANNER_ENGINE, used only by selected
roles. Native is default. Existing provider bridges/tool executor remain shared.

| Plan area                        | Actual state                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sports foundation                | Provider directories, bounded NBA/NFL search, shared quotas, basic details and configured news retrieval implemented; exhaustive latest-game selection and richer statistics remain incomplete. |
| Payloads and manual evidence     | Direct UI tables, owned/expiring references, bounded row attachment and explicit review/revision implemented.                                                                                   |
| 1. Role containers               | Implemented and committed: versioned definitions, model/tool enforcement, limits and recording.                                                                                                 |
| 2. Manual role UI/budgets        | Implemented and committed first slice. Budget is latest admitted-call evidence; unsent preflight, richer grouping and role-file hot reload remain follow-ups.                                   |
| 3. Framework comparison          | Started with a one-model-call graph and deterministic parity checks; broader parity/adoption gate remains open.                                                                                 |
| 4. Grounded reporting/evaluation | Runtime/contract tests and manual review exist. Full 27-case session runner, independent payload/answer quality grading and calibrated model comparisons remain pending.                        |
| 5. Layer-one background roles    | Existing background retrieval/document work exists. General role-job coordination, durable multi-task scheduling and restart/replay semantics remain pending.                                   |
| Longer-term profiles/memory      | Topic scope and explicit references exist; editable persistent profiles, semantic retrieval and automatic context selection remain pending.                                                     |

We have a usable manual prototype, not a completed autonomous or production system.
No live quality gate or framework performance claim has been made. Next bounded work:
expand the native/graph comparison to payloads, ownership/expiry, admission and held
cancellation before adding dependent tool loops. No preview restart or live calls.

## Manual role UI and admitted context budgets — 2026-09-30

Role execution and review fixes committed as `df65366`. The next slice adds a manual
role picker, definition inspection, restricted model/thinking options and individually
selectable allowed tools. An additive context estimate accompanies each admitted
planner call in the timeline, v1 events and evaluation recording; the UI shows the
latest call's breakdown and reserves. It is not provider token usage or a preflight
preview of unsent edits. Role choices reset on reload. No automatic role selection,
trimming or output-reserve changes were added.

Validation: 666 tests / 87 files and 22 browser tests passed; TypeScript build passed.
Next: bounded LangChain/LangGraph adapter comparison. Preflight estimation and richer
tool grouping remain follow-ups. No live calls or preview restart. This new UI slice
is uncommitted pending review.

## Role catalog and enforced tool exposure — implemented 2026-09-30

Opt-in role configuration now packages model binding, instructions, tool allowlist,
thinking, context/output contracts and input/tool-call limits. API selection captures
an invocation snapshot, rejects disallowed overrides and validates the entire plan
before executing any tools. Role-free calls retain existing behavior. Timeline and
evaluation records track the effective role under existing capture policy.

Set `ROLE_CATALOG_PATH` to `data/roles/sports.example.json` (fixed-provider example);
select with `runControls.roleId`. See [configuration and limits](implementation/12-request-to-evidence.md).
Next: manual role picker and context-budget visibility. LangChain migration,
background role coordination, automatic role selection and role-file hot reload are
not implemented. This increment makes no live-model quality claim.

## Active direction: versioned role containers — 2026-09-30

The [updated implementation plan](implementation/12-request-to-evidence.md#active-plan-role-containers-and-focused-execution--2026-09-30)
supersedes older next-step ordering. A role packages its model, instructions, tools,
context policy, thinking settings, limits and output contract. Roles remain manually
selected initially, with effective configuration and versions recorded per invocation.

Next implementation: validated role catalog and identical tool allowlists in model
exposure, validation and execution. Follow with manual role selection/context-budget
visibility, a bounded opt-in LangChain/LangGraph adapter comparison, grounded reporting
and role-specific evaluation, then layer-one background-task coordination. Existing
account quotas and user-payload/reference separation remain mandatory. Independent
quality grading stays separate from production review. OSS execution requires no
LangChain cloud services; hosted tracing/deployment is not part of the initial plan.

Current state: game-operation review fixes remain uncommitted; their 22 focused unit
and 21 browser tests plus build passed. No role runtime or framework migration has
been implemented. Persistent user profiles and semantic retrieval remain longer-term,
starting with manual context selection and an inspection of Hekate storage for reuse.

## Bounded game search and snapshot details — 2026-09-30

General NBA/NFL date-window search, provider team-name resolution and bounded
latest-completed searches are implemented. Direct UI browsing and specific retrieved
row details use separate user payloads; rows enter model context only when attached.
Latest means most recent final found by start time within configured windows, with
partial coverage. Details do not make a fresh lookup. Shared account quotas still apply.
Configuration and limitations: [request-to-evidence plan](implementation/12-request-to-evidence.md).

Next: grounded reporting from selected game evidence and stage-specific evaluation.
Registry context size needs attention for smaller models: the browser fixture required
16K instead of 8K with the expanded registry. Runtime budget checks remain enforced.
No live provider/model calls or preview restart performed for this increment.

## Reference selection increment — 2026-09-30

Manual-control lifecycle fixes committed as `ffa1089`. Explicit bounded table-row
selection, detachment and selected-row payload review are implemented. References
are validated against owned server results; nonselected rows do not enter model
context. Reference hashes/content follow evaluation capture policy. Payload grading
remains separate from production review. Next: general game search and specific-game
details, including latest-completed selection. See the
[current handoff](implementation/NEXT-HANDOFF.md) for verification and limitations.

## Manual controls increment — 2026-09-30

Scope review corrections are committed as `72971f8`. Per-run model selection and
manual text review/revision are now implemented, preserving resource admission.
Thinking controls expose configured defaults plus explicitly verified Ollama boolean
options; other provider overrides remain unsupported. Review is a separate turn,
requires a selected answer, and cannot execute tools or silently rewrite the draft.
Requested controls and effective model metadata are recorded. Validation: 637 tests,
16 browser tests and build passed; no live quality scores claimed. Next is broader
reference attachment/detachment and payload-review evidence, followed by game search.
See [handoff](implementation/NEXT-HANDOFF.md) for limits and remaining work.

## Latest increment — 2026-09-30

Review fixes committed as `1e2d60d`: versioned API payload delivery, close-race guard,
and explicit unrated status for payload-bearing answers under text-only grading.
Minimal sport/league/team browsing and frozen scoped conversations now work, with
opt-in selected-team reference attachment. Browsing another topic leaves conversation
scope unchanged. Expired reference content is excluded from new model calls.
Validation: 632 tests, 13 browser tests and build passed. No model-quality claim.
Next: manual model/thinking/review controls and broader reference management.
See [current handoff](implementation/NEXT-HANDOFF.md) for scope and limitations.

## Active plan: payload separation and manual topic workflows — 2026-09-30

This section supersedes next-step ordering in the historical entries below.
Team resolution and owned candidate selection are implemented. Latest completed game
retrieval remains pending, but is no longer the immediate next implementation.

The first slice below now separates model results, direct user payloads and
evaluation records for team lists. Next add minimal topic navigation and scoped conversations, explicit reference
attachment/manual model-thinking-review controls, general game search (including
latest completed), specific-game details and grounded reporting. Evaluate each slice.

Longer term: persistent editable profiles and semantic retrieval for relevant context,
initially selected manually; inspect Hekate before choosing storage reuse. Semantic
retrieval avoids predeclaring every relationship. Keep exact ownership/provenance IDs
and confirmed settings. Automatic context assembly, profile extraction, review loops,
background briefings and broader domains follow evidence from manual use.

The [updated implementation plan](implementation/12-request-to-evidence.md) is authoritative for scope, sequencing,
acceptance and deferred automation. Implementation status and limitations are recorded below.

## Delivered slice: direct team-list payloads — 2026-09-30

`tool-result-v1` separates model context from a typed user table and evidence metadata.
The team-list tool and direct “Show teams” UI use the provider directory. Direct
browsing calls no model; model-requested lists preserve compact metadata in history
and render rows separately, including timeline replay. Existing tools are not all
migrated. Scoped result handles expire; storage is process-local. Manual attachment
and selective reference reads remain next-stage work. Directory lists may include
historical teams and do not claim active-only membership.

Evaluation recording stores separate payload hashes; answer-capture mode can retain
redacted payload content under existing size limits. Direct browsing is outside model
run recording. Validation: 628 unit/integration tests across 82 files, TypeScript
build, and 11 browser tests passed. A 1,000-row canary verifies next-call exclusion.
No new live provider/model calls were required. Next: minimal topic navigation and
scoped conversations/reference selection, then manual controls and general game search.

## Historical implementation journal

## Current priority: general contracts and resource-specific policies — 2026-09-30

This supersedes earlier next-step ordering and incorporates the plan review plus the
user's resource-policy correction. Admission is selected by service/account/model
binding and actual deployment/billing facts, not by transport labels. Data APIs,
metered inference, local compute, cloud inference (including through Ollama) and
subscription CLI windows have different constraints and share lifecycle mechanics.
Reuse the existing resource-admission infrastructure; preserve usage history on reload.

Order: (1) contracts and independent evaluation cases; (2) scope selection plus team
resolution and conversation-bound candidate selection; (3) bounded latest completed
game retrieval; (4) game-specific reporting and grounded synthesis; (5) full evaluation.
The Patriots request is one development example, not the design specification.

Step 1 is now implemented as a contract foundation: validated operation/result schemas,
server-snapshot candidate selection guard, and a 27-scenario versioned evaluation
specification (12 development, 15 evaluation-only). Tests check ownership, expiry,
revision changes, scope, evidence chronology, partial coverage and completion semantics.
These schemas are not wired into live routing yet. Evaluation source fixtures and the
session runner are pending; no end-to-end quality scores are claimed.

Next executable task: verify provider team-directory access, then implement registry
scope selection and provider-backed name resolution against these contracts. Clarification
must carry forward issued candidate handles; no model-invented IDs or team exceptions.
Game-specific reporting is an explicit later capability rather than an assumed property
of league RSS. Resource waits/retries must follow the applicable binding policy.

See [contracts, resource policies and evaluation gates](implementation/12-request-to-evidence.md).

## 2026-09-30: prioritize useful tool operations

Next build provider-backed team-name resolution and a bounded latest-completed-game
operation, then evidence-backed answers. The model should request a useful operation;
tools should handle provider IDs, pagination, date filters and quota coordination.
Do not add team-name routing exceptions or ask users for database identifiers.

Review and evaluate each slice, then test the complete Patriots-last-game interaction.
Preserve foreground interaction during retrieval. The task board, general web search,
MLB and broader memory/dependent planning follow this slice. This supersedes older
next-step orderings below. See [tool contracts](18-nba-briefing-demo.md) and
[current handoff](implementation/NEXT-HANDOFF.md). No runtime change is claimed here.

## 2026-09-30: NFL active-season verification

Sports demo scope now includes NFL games alongside NBA. The same account/key
successfully returned 16 NFL games in one authenticated request. League-specific
normalization and a games-only NFL profile are implemented. This verifies access,
not complete briefing quality. Continue with news, shared request budgeting and the
task UI; see [the current handoff](implementation/NEXT-HANDOFF.md).

## 2026-09-30: active NBA briefing workflow

The current direction is the [personalized NBA briefing demo](18-nba-briefing-demo.md):
league and favorite-team briefings on launch/manual start, fresh sourced evidence,
continued foreground interaction and specific follow-ups. This supersedes older
instructions below to defer sports until all spec 06 work completes. Apply remaining
multitask evaluations inside the sports workflow without claiming spec 06 complete.
First implemented slice is the offline `sports:plan` contract; next are source fixtures
and bounded task coordination. The latest handoff is authoritative. Explicit user
preferences and topic/thread navigation come before broad memory automation. Email
is a later domain, not part of this implementation.

## 2026-09-29: spec 04 dispatch implemented

Catalog-mode selection, captured-context previews, provider registry, resource
admission, frozen retries, explicit bounded fallback and per-turn model labels are
implemented. Fixed mode remains the default. [04 evidence](implementation/04-evidence.md) maps
acceptance and resource fixtures: **391 tests / 57 files**, type checking, build and
seeded simulated release gate pass. No live/billed provider or real-browser run was
performed. Cost bounds are declared, usage remains unsettled when unreported, and
reservations are process-local; see the evidence for limits.

**Next bounded task: [spec 05 — CLI execution](implementation/05-cli.md)**, starting with its
product/account selection and documented adapter contract. Keep spec 06 evaluation
mode queued and the sports demo after the runtime sequence. Do not reactivate the
parked documentation-agent experiments as the default next task.

## 2026-09-29: spec 04 started

Task classification and its corpus are implemented, with 351 passing tests and
passing type/build/seeded simulated release checks. See
[04A evidence](implementation/04a-evidence.md). Selection, admission and dispatch
integration remain open; runtime routing is unchanged. Continue spec 04 before 05.

## Next domain project: temporally grounded sports agent

After completing and verifying the active runtime sequence through spec 06, build
a sports demonstration in ChatAgent. Start with one league and latest/next games,
scores and standings, including conversational follow-ups. Choose the league and
verify provider coverage, freshness, access terms and cost before implementation.

Expose focused team-resolution, schedule, game and standings tools. Return stable
game/team IDs, game status, scheduled start, source update time when available,
retrieval time and provenance. Interpret relative dates using explicit timezone
context; an unknown update time remains unknown. GraphQL is optional, not required.

Use timestamped recorded fixtures to test pregame/live/final transitions, postponed
games, stale or unavailable feeds, timezone boundaries and repeated matchups. Score
game selection, factual support, freshness disclosure and appropriate uncertainty.
Keep the sourced live demonstration separate from repeatable fixture results, using
the planned evaluation recorder. First milestone: grounded latest/next-game answers
for one team with natural follow-ups and visible dated evidence.

This is queued domain work; spec 04 dispatch remains the next runtime task.

## 2026-09-29: spec 03 (inventory) implemented

Real discovery adapters (Ollama `/api/tags`+`/api/show`, Azure ARM management
plane, Bedrock `ListFoundationModelsCommand`), catalog v1->v2 migration, and
the RES-01/03/04/08 resource-policy metadata fixtures are done. `GET /models`
now computes real readiness (`disabled`/`unsupported-adapter`/`unchecked`/
`stale`/`denied`/`unavailable`/`ready`) instead of a hardcoded value. 299 tests
/ 51 files pass; see [03 evidence](implementation/03-evidence.md). Next:
[spec 04 — dispatch](implementation/04-dispatch.md).

## 2026-09-29: canonical direction confirmed — resume the numbered runtime spec

Explicit user decision: the numbered runtime spec (01–06,
[implementation handoff](implementation/README.md)) is the canonical plan
going forward. The doc-agent/learning experimental track recorded below is
parked, not abandoned — its evidence stays as historical record — but it is
not the active priority. **Current task: [spec 03 — inventory](implementation/03-inventory.md).**
See [NEXT-HANDOFF](implementation/NEXT-HANDOFF.md) for full reasoning.

## 2026-09-28: shared inference decision

[Controlled contention findings](../reports/doc-agent/contention-findings-2026-09-28.md)
now separate application admission wait, first answer text and completion across
Node/Ollama and Python/LangGraph. With equal foreground bursts and a FIFO control,
overlap medians were 477 ms concurrent, 479 ms FIFO and 569 ms foreground-priority.
All 18 documentation tasks completed; cancellation/recovery checks passed.
**Keep normal runtime scheduling unchanged.** The gateway and policies are optional
experiments, not a production scheduler. This supersedes the older instruction to
measure first-token/admission timing next; it does not establish an SLA or a general
scheduling result. See the report for the preserved exploratory run and limitations.

Next: held-out multi-part documentation evaluation for requirement coverage,
citation support and scoped uncertainty, before selecting completed-task evidence
for on-demand conversation context. Keep planning optional. Revisit scheduling if
longer calls or sustained/multi-worker load misses the documented latency target.

Latest learning experiment: [observable plans versus actual execution](../reports/doc-agent/plan-findings-2026-09-28.md)
compares eight local runs under shared budgets. Both conditions pass 4/4 structural
checks, but manual review finds citation and uncertainty gaps; planning remains
optional and outside production. Next: held-out requirement/evidence review and
plan readability before considering runtime integration.

Earlier validation: [browser and shared Ollama findings](../reports/doc-agent/browser-contention-findings-2026-09-27.md)
records a fixed development-browser rendering bug, 248 passing TypeScript tests,
and a small same-model contention probe (295 ms baseline median; 888 ms during
background work). That timing follow-up is now recorded in the 2026-09-28 findings above.

Current integration: [conversation documentation tasks](implementation/11-conversation-tasks.md)
adds an optional background action, scoped status/results, cancellation and bounded
admission through a local Python sidecar. Earlier notes describing all Python work
as disconnected from chat are superseded for this opt-in path. Shared GPU priority,
automatic context insertion and scheduled triggers remain future work.

Latest lifecycle review: [edge-case findings](../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) records
five reproduced fixes and 67 passing offline tests, including a killed worker,
late provider completion, cancellation races and failed persistence. Historical
live-run hashes predate these fixes; old durable tasks still require migration.

## 2026-09-27: independent task lifecycle

The [local task manager](../experiments/doc-agent/TASKS.md) adds task IDs, status/list,
resume, and persisted cancellation around per-task checkpoints. Managed tasks
exclude paused time from their execution budget; the standalone durable CLI
retains its wall-clock policy. This supersedes earlier task-management next-step
notes. Conversation integration, admission control and scheduled triggers remain
future work; uncertain in-flight tasks are still refused.

## 2026-09-27: durable single-task checkpoint

[SQLite pause/resume](../experiments/doc-agent/DURABILITY.md) now supports process restarts from confirmed
retrieval pauses, preserving sources, evidence and budgets. 33 offline tests and
a four-process local Gemma4 run passed. This supersedes earlier descriptions of
persistence as entirely future work; the ordinary graph engine remains optional
and nonpersistent. Arbitrary in-flight crash replay is refused. The next increment
is task lifecycle/scheduling around this unit, with explicit long-pause policy.

## 2026-09-27: explicit LangGraph learning slice

The [LangGraph workflow](../experiments/doc-agent/LANGGRAPH.md) is implemented as an optional
engine, with the original loop retained for comparison. 29 offline tests pass,
including contract parity, invocation isolation and cancellation propagation.
This supersedes earlier text proposing graph translation as future work. The next
learning step is designing durable state and pause/resume; neither is implemented
by this invocation-local graph. Production runtime integration remains separate.

2026-09-27: use the [model-specific reference guide](14-model-reference-guide.md) before
changing model integration or designing local evaluations. Start with official
guidance and published benchmarks, then test the application-specific gaps.

## Latest priority: learn through a working retrieval agent

The immediate slice is [spec 10](implementation/10-doc-retrieval-agent.md): a
standalone LangChain/Ollama agent using bounded documentation search/read tools,
Markdown prompt sections and source-linked answers. It builds on sibling course
examples. Learning and completing this project come first; Hekate integration is
optional and is not the next prerequisite. The subsequent learning milestone is
an explicit LangGraph version of this loop, then a separately scoped connection
to responsive chat. Earlier production-provider-first planning below is superseded.

## 2026-09-26 direction and current priority

Latest increment: [spec 09 prompt contract](implementation/09-prompt-contract.md)
defines Task / Guidelines / Response Framework plus referenced context.
[Experiment 2](../experiments/prompt-contract/README.md) adds validated immutable
packages, literal-content prose/JSON/XML renderers, a no-heading control, and
held-out cases with scoring frozen before execution. These are standalone
experimental artifacts; production integration and framework dependencies remain
future work. Review the results before selecting the production renderer.

Experiment 2 is complete: [600 live local calls](../reports/prompt-contract/findings-2026-09-26.md).
Held-out TGR content accuracy was 66.7% versus 63.3% for flat identical-content
text, with roughly 4.7% more input tokens. The net paired gain was two answers;
calibration favored flat by one. Maintain configurable renderers and proceed to
production contract/provider integration only as a separate increment. Sixteen
experiment tests passed; all requests and source/package hashes match the frozen
protocol. No runtime behavior or dependencies changed.

[ADR 0002](adr/0002-layered-context-and-orchestration.md) records the latest design:
ChatRuntime remains responsive conversation infrastructure; evaluate Hekate for
independent concurrent/scheduled objectives and specialized roles. Context policy
differs for conversation, orchestration, execution and verification, with shared
provenance and dynamic retrieval contracts. Record execution/context telemetry;
analyze it and propose improvements in a separate process. Evaluate a structured
prompt translation layer instead of assuming XML/JSON improves model behavior.
Learn LangChain/LangGraph through bounded integrations with preserved invariants.

The [first local prompt-encoding experiment](../experiments/prompt-encoding/README.md)
and design reconciliation are complete. Current work is spec 09 and experiment 2
above; next is a production contract/telemetry boundary and bounded framework
integration planning. Inventory/dispatch/CLI remain queued. Persistent
orchestration, semantic retrieval, scheduled recovery and automatic learning are
proposed, not implemented. The learning journal remains outside source control.

Current implementation includes 01A, 01B, spec 02 and an opt-in protocol v1 Iris
slice; all runtime stores remain in memory. Older dated notes below that describe
01B as outstanding are historical and superseded by [01B evidence](implementation/01b-evidence.md).

Prompt experiment complete: [240 live local calls and findings](../reports/prompt-encoding/findings-2026-09-26.md).
Full prose led aggregate content accuracy in this small pilot; compact encodings
reduced tokens without consistently preserving performance. Preserve a configurable
renderer design and prose baseline; do not promote a universal XML/JSON policy.

## Earlier implementation record

Updated: 2026-09-25. This is the current plan; earlier review and design documents
remain as historical context.

Executable handoff: [implementation specs and execution order](implementation/README.md).
Those specs define the proposed interfaces, behavior and acceptance tests for the
six next milestones. They take precedence over this overview for implementation
details; their presence does not mean the features are implemented. Start with
[01 — Conversation context](implementation/01-context.md).

Context revision 2: [internal memory extension](implementation/01-context-memory.md)
adds budget-triggered summarization inside ContextManager, original source records,
provenance, revision validation and bounded source checking. It also retains pending
request awareness separately from accepted answers. Implement in two stages: 01A
bounded snapshots/task state, then 01B compression/source-backed memory. These are
planned changes; no context implementation is claimed by this documentation update.

Runtime ownership across ChatAgent, Hekate, and Iris is now decided in
[ADR 0001](adr/0001-chat-runtime-ownership.md): ChatRuntime keeps owning chat
request-handling logic, reusing Hekate's context-store as a durable persistence
backend. This is a design decision, not an implemented migration; see the ADR's
"Next vertical slice" for the first concrete cross-repo integration step.

Spec 02 now implements [02 activity sub-bubbles](implementation/02-activity-ui.md):
attached per-turn progress, expandable step history, observable model/activity labels,
elapsed time and preserved substantive answers with separate updates. These preserve the 01A context guarantees. Persistence, natural-language task
supersession and aggregate budget enforcement are explicitly separate follow-ups.

## Current status and next implementation order

Post-implementation review corrected visible outcome labels for retained partial
answers and froze UI attempts against late answer/terminal events. Latest checks:
**203 tests / 38 files**, type checking, build and seeded simulated release gate
passed. See [02 review evidence](implementation/02-evidence.md#post-implementation-review).

**Spec 02 is implemented with offline acceptance coverage.** Fast/deep attempts
stream answer deltas, carry unique attempt IDs and safe terminal outcomes, and
support explicit cancellation. Transient failures retry only before output;
truncated/cancelled/failed answers stay out of accepted history. The UI preserves
substantive answer versions, attached activity/history, server-based timers and
Stop controls. Ollama explicit thinking controls require runtime metadata.
Verification: **195 tests / 38 files**, type checking, build and the seeded
simulated release gate passed. See [02 evidence](implementation/02-evidence.md)
for acceptance tests and adapter documentation. 01B, Iris integration, live-provider checks and real-browser
mobile/failure checks remain outstanding.

Review follow-up (2026-09-25): startup now bounds context by the minimum of the
application window and configured catalog context limits for the selected fast/deep
bindings, then validates output/safety reserves before constructing providers.
Unknown/unlisted model limits retain the application bound. The full Iris vertical
slice requires spec 02; snapshot SSE alone cannot meet its cancellation acceptance
case. ADR 0001's example now contains valid wire payloads in a fixture envelope.

Validation for this follow-up: **162 tests across 34 files passed**, type checking
and build passed, and `verify:release` passed with `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`. No live providers or cross-repository integration ran.
Regression evidence:

- `tests/unit/contextConfig.test.ts`: selected fast/deep limits, application cap,
  unknown/unlisted limits, unrelated bindings, exhausted reserves, and a turn that
  fits the application window but is rejected before provider/timeline work under
  the model window.
- `tests/integration/startup.test.ts`: `rejects a catalog window consumed by
reserves before starting the server` verifies startup uses the catalog limit.
- `tests/unit/protocolFixture.test.ts`: `ADR protocol fixture type-checks against
its declared wire interfaces` compiles the actual example against the ADR's
  interfaces and checks event identity/sequence continuity.

Reconciled through implementation commit `8afce48` on 2026-09-25, plus 01A below.
The earlier 01A implementation check passed **152 tests across 32 files and TypeScript
checking**, and a full `npm run verify:release` (tests, lint, fixture evaluation,
simulated benchmark, baseline comparison) passed with `BENCH_MODE=simulate` /
`BENCH_SIM_SEED=default-v1`. The full clean-install/release/build verification
below belongs to the earlier stabilization baseline; it has not been rerun for
every subsequent feature.

**Spec 01A (bounded conversation snapshots and pending-task awareness) is
implemented; 01B (internal summarization and source-linked memory, from
[01's memory extension](implementation/01-context-memory.md)) is explicitly
outstanding.** Added: `src/domain/context.ts` (shared v2 `ConversationContext`
types), `src/app/contextBuilder.ts` (pure `buildContext`, budget accounting,
active-task derivation), `src/app/contextManager.ts` (capture + prepare seam
for 01B to extend), `src/app/systemInstructions.ts` (frozen grounding text and
trusted-facts rendering), `src/config/contextConfig.ts` (validated
`CONTEXT_WINDOW_TOKENS` / `CONTEXT_MAX_HISTORY_TURNS` / `CONTEXT_SAFETY_TOKENS` /
`CHAT_FAST_MAX_OUTPUT_TOKENS` / `CHAT_DEEP_MAX_OUTPUT_TOKENS`, startup-rejects
misconfiguration). `ChatService` now claims per-conversation ownership by
`userId` (409 `CONVERSATION_OWNER_MISMATCH` on mismatch); an oversized turn
returns 413 `CONTEXT_TOO_LARGE` before anything is appended or enqueued.
Azure/Bedrock/Ollama adapters send role-based system+history messages and the
configured output cap when a `ConversationContext` is supplied, and fall back to
their original single-prompt shape when it is not (legacy/direct adapter callers,
per spec). Ollama moved from `/api/generate` to `/api/chat` (verified against
the upstream API docs on 2026-09-25; source note in `ollamaProviders.ts`).
`ChatTimelineEvent` now carries a stable `eventId`/monotonic `sequence`, assigned
by `InMemoryConversationTimelineStore`, as the memory extension asks for ahead
of the full SourceStore. Memory stays `null` and `resolvedSources`/
`unavailableSources` stay empty until 01B; pending/failed/retrying/incomplete
turns surface as `activeTasks` (capped at 4 most recent) instead of being
silently dropped. Not yet done: `SourceStore`, `ContextSummarizer`, extractive/
model summarization, `resolveSources()`, and their settings
(`CONTEXT_SUMMARY_*`) — all 01B. Spec 02 now adds streaming while preserving these snapshots.

| Area                 | Implemented                                                                                                        | Still needed                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Runtime reliability  | Message correlation, worker concurrency guard, body timeouts, serialized telemetry writes, truthful startup errors | Graceful shutdown, backpressure, Bedrock deadlines                    |
| Chat progress        | Answer streaming, cancellation, per-attempt activities/timers, preserved answer updates                            | Live provider and real-browser/mobile verification                    |
| Model inventory      | Validated catalog, `/models`, capability/task eligibility filtering                                                | Provider discovery, fresh account access/health observations          |
| CLI subscriptions    | Catalog schema for profiles, authentication, billing and shared quotas                                             | Actual CLI adapters and verified subscription automation support      |
| Conversation context | 01A: bounded shared snapshot, grounded runtime facts, active-task awareness, ownership/budget guards               | 01B: internal summarization, source-linked memory, `resolveSources()` |
| Model selection      | Fixed environment-configured fast/deep pair                                                                        | Task-based dispatch, measured ranking, explicit fallback              |
| Evaluation           | Automated regression tests and labeled fixture/simulation reports                                                  | Fresh live golden run and measured answer-quality evaluation          |

Implementation order following the latest discussion:

1. **Context and grounding.** Use standard role-based messages, a shared per-turn
   snapshot, and bounded recent history. Prefer refined answers over provisional
   ones, exclude activity events, and preserve the snapshot when deep work is queued.
   Supply verified runtime facts and explicitly acknowledge unknowns. Test follow-ups,
   overlapping turns, and input/output budget limits. Add internal budget-triggered
   compression per 01B, preserving source records and exact recent turns; do not
   summarize at the chat/UI layer or erase pending task awareness.
2. **Generation controls and streaming.** Verify model thinking controls; explicitly
   configure them for the fast path. Tune output budgets from measurements, handle
   all length-truncated answers, and add token streaming/cancellation while retaining
   per-bubble activity and terminal states. These controls are implemented with offline acceptance coverage; live checks remain.
3. **Discovery and account inventory.** Separate the provider's catalog from our
   reachable, authorized deployments/models. Discover Ollama and cloud candidates;
   add connection IDs, API compatibility, revision and observation freshness.
   Keep Foundry provisioning separate from live chat dispatch.
4. **Task-based dispatch.** Select coding/conversation/reasoning candidates using
   explicit capability and context requirements, health, budget and evidence. Store
   the selected binding and reason per turn so the UI names the actual model used.
5. **Subscription CLI execution.** Implement one chosen CLI adapter with verified
   noninteractive support, session authentication, process cancellation and quota
   handling. Enforce explicit workspace permissions and paid-fallback policy.
6. **End-to-end validation.** Complete shutdown and browser/automatic-worker tests,
   rerun live golden cases, and compare against one model with streaming. Measure
   time to first useful answer, final correctness, cost and failures.

The milestones below retain detailed acceptance criteria. Cloud provisioning,
automatic model dispatch, CLI execution, context management and model-token
streaming were not delivered by the catalog commits; streaming is now implemented by spec 02.

All changes are committed locally on `main`; no Git remote is configured. Running
servers do not hot-reload (`npm run dev` uses `tsx`, not watch mode). The last server
started by this session predates the bubble/catalog changes; restart it to load
them unless it has already been restarted separately.

## Baseline and scope

The target is a convincing local demonstration of fast replies followed by useful
deep answers, with honest measurements and interchangeable providers. Keep the
current TypeScript/Node server and vanilla browser UI. Provider selection remains
read-only in the UI and changes through environment configuration plus restart.

The stabilization pass includes:

- UUID message/task identities and correlation across user, fast, and deep events.
- Per-turn completion and route display; late fast replies cannot replace refined answers.
- Deep tasks queued before waiting on the fast provider, with a fallback acknowledgment
  if the fast provider fails on a deep-routed request.
- One active deep task per worker, shared by automatic and manual execution.
- Azure/Ollama timeouts covering response-body reads, not just headers.
- Serialized atomic telemetry saves, unique temporary files, recovery after failed
  writes, and handled background save failures.
- Explicit routing-threshold environment settings taking precedence over saved policy.
- Evaluation CLI failures returning nonzero exit status, synthetic measurement labels,
  and corrected golden routing expectations for current-day questions.
- A GitHub Actions workflow for clean install, release checks, and compilation.
- Vitest upgraded to 4.1.11; `npm audit` reports zero known vulnerabilities after
  the upgrade. The upstream [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
  identifies 4.1.11 as a patched release. Node requirements now match the tooling.

## Verification and evidence

Spec 01A verification on Windows / Node 24.15.0 (2026-09-25): 140 tests across 31
files, type checking, and `npm run verify:release` (tests, lint, fixture
evaluation, simulated benchmark comparison) all passed with `BENCH_MODE=simulate`
`BENCH_SIM_SEED=default-v1`. New coverage: `contextBuilder` history
selection/budget/active-task cases, ownership-conflict (409) and oversized-turn
(413) cases at the ChatService/orchestrator/HTTP layers, and adapter
request-shape cases for the context-aware Azure/Bedrock/Ollama paths. No live
provider run was performed for this milestone; that follow-up (grounded-fact
acknowledgment, follow-up-question quality) belongs to spec 01's "optional live
follow-up exercise," not to this offline pass. 01B (summarization/source store)
was not attempted and is not claimed; see the status table above.

Follow-up startup diagnosis: the server on port 3100 was still the process started
at 16:51, before stabilization. A second `npm run dev` printed a premature success
message and then failed with EADDRINUSE. Startup now waits for a successful bind
before logging success or starting timers, and reports an explicit occupied-port
error. After restarting the verified old process, live HTTP probes confirmed the
new HTML and message IDs plus `processingStatus: complete` on direct timeline events.
The startup regression brings coverage to 109 tests across 28 files; tests and
type checking pass. This fixes startup observability, not model hallucinations.

Stabilization verification on Windows / Node 24.15.0: 108 tests across 27 files,
type checking, fixture evaluation, benchmark comparison, and compilation passed.
A clean isolated copy also passed `npm ci` and the full release/build checks with
no `.env` file present. `npm audit` reported zero known vulnerabilities. The hosted
GitHub Actions workflow has not run yet; there is no remote configured.

The original working directory had an active process holding `esbuild.exe`, so
`npm ci` there encountered Windows EPERM. Dependencies were restored with
`npm install`; the clean-install check was completed in an isolated copy without
stopping existing user processes. Stop local dev/watch processes before future
in-place clean installs if the same file lock recurs.

Run `npm ci`, `npm run verify:release`, and `npm run build` from a fresh checkout.
The release command runs tests, type checking, fixture evaluation, deterministic
simulated benchmarks, and baseline comparison. CI sets `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`; use those settings locally when verifying the baseline.
Compilation is a build check; `npm run dev` remains the documented runtime entrypoint.

Regression coverage includes overlapping turns, deep completion before the fast
reply, fast-provider failure, worker concurrency, stalled response bodies, overlapping
telemetry writes, write recovery, golden routing parity, and failed evaluation exit codes.

The saved `reports/golden-eval.*` files are historical live evidence: 3/5 cases passed.
They predate this stabilization and the corrected day-question expectation. They
have not been overwritten with mock results or claimed as a current live pass.
Mocks test plumbing; they do not answer the live golden suite's factual questions.
Benchmark quality values and fixture scores are not evidence of answer correctness.

## Next milestones, in order

### 1. Reliable live demo

- Implemented: per-bubble generation/queue/thinking/retry indicators and terminal
  failure events, correlated by message ID. Deep-provider activity is visible before
  its answer arrives. Spec 02 now adds answer streaming and preserved update versions.
- Add graceful shutdown that stops intake, bounds in-flight work, flushes telemetry,
  closes SSE clients, and handles SIGINT/SIGTERM. The current close callback alone
  does not guarantee a flush when a process is terminated.
- Add an automatic-worker HTTP integration test and a browser smoke test covering
  two overlapping turns, a fast reply, a refined reply, and a terminal failure.
- Align provider instructions for clarify/direct/deep behavior and timestamp handling.
- Run the live golden suite against one explicitly recorded provider/model pair;
  record configuration without credentials, latency, outputs, and failures.

Acceptance: all five current golden cases pass on the chosen live configuration;
two overlapping turns stay correctly paired in the browser; every deep turn ends
in success or a visible failure; normal shutdown saves the latest telemetry.

### 2. Useful answers and trustworthy evaluation

- Pass bounded conversation history to fast and deep providers.
- Add actual retrieval with source provenance for external-data requests; until
  then, do not present deep routing as evidence that facts or citations were verified.
- Replace route-derived quality scores with a documented human or automated rubric.
- Make live benchmark profile labels reflect the server's actual providers; the
  current runner does not switch providers when iterating configured profile labels.
- Expand the golden set with pronoun ambiguity, keyword substring false positives,
  follow-up questions, unsupported factual claims, and citation verification.

Acceptance: factual answers link to retrieved evidence; follow-ups use prior turns;
quality depends on the answer itself; each live report records the providers actually used.

### 3. Latency and routing decisions backed by measurements

The [model catalog](13-model-catalog.md) now provides validated task/capability
metadata and eligibility filtering. Health discovery, per-task model dispatch,
and measured ranking remain follow-up work; the running router still uses its
configured fast/deep pair.

CLI subscription access is represented in the catalog as a separate access path
with authentication, billing/quota-pool policy, and adapter requirements. CLI
execution remains unimplemented and excluded from candidates until each adapter
and subscription's automation support are verified.

- Separate provisional-generation and deep-generation metric buckets when both use
  the same provider/model; they currently share the `deep` route key in that case.
- Measure queue wait, time to first answer, time to final answer, failure rate, and
  provider duration separately, including retries.
- Consolidate base/adaptive/simulation routing to avoid divergent heuristics.
- Revisit queue-depth tuning: a busy deep queue currently lowers the fast threshold,
  which can send more work into that same queue. Use server-owned queue depth.
- Retain current-profile priors when loading telemetry from an older configuration.

Acceptance: compare single-path and dual-path runs on identical prompts and recorded
hardware/provider settings; demonstrate first-response improvement without hiding
final-latency, quality, cost, or failure regressions.

### 4. Shared deployment, only after the demo is reliable

Add authentication, request-size limits, durable tasks/history, retention limits,
backpressure, Bedrock request deadlines, and operational monitoring before sharing
the service beyond local use. Do not expand the UI framework or add runtime provider
switching unless a demonstrated need justifies the extra state management.

## Working agreement

- Keep `.env` and local telemetry out of Git. Commit `.env.example` changes when
  configuration changes; never include credentials in reports or startup output.
- Make small commits with focused regression tests for behavior changes.
- Keep failing live evidence and fix the cause; update expectations only when the
  intended behavior changes, and explain that change.
- Run the release checks before merging. A simulation pass is a code baseline,
  not a provider performance claim.
- The repository currently has no remote. Commits are local until a destination is
  configured; the included CI workflow will run when hosted on GitHub.

## 2026-09-25 review and resource-policy checkpoint

01A review corrections CTX-01–04 now pass their named regressions; see
[boundary invariants](implementation/01a-review-followup.md). Acceptance now
requires named regression-test evidence, not just a green suite.

Specs 03–06 also require [resource policy](implementation/08-resource-policy.md):
execution location, billing mode, quota and compute capacity are independent of
transport. RES-01–08 are future acceptance requirements, not implemented controls.
Context corrections are complete; now honor the cross-repository reuse
checkpoint before adding overlapping provider or memory implementations.

### Canonical examples learning checkpoint

The [controlled local comparison](../reports/doc-agent/examples-findings-2026-09-26.md)
is complete: one additional structural pass across six paired questions, with
39.3% more input tokens. Keep the optional examples variant and the two-tool
retrieval surface; missed source sections need separate evaluation. LangGraph
translation remains a learning increment, without claiming improved retrieval.
