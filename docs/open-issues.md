# Open issues

The single register of known ChatAgent defects and gaps. It is not task state:
Hekate's PlanStore owns task, attempt and review state, and the bridge carries
messages and delivery evidence only. Assignments and checkpoints refer to issues by
ID. Evidence stays beside the contracts and tests it concerns; each entry links to
it. The register is not a complete inventory: an issue is listed only once it has
been observed or recorded in a reviewed document.

Issues owned elsewhere are listed under [external dependencies](#external-dependencies)
as links to their owner's register, never with a status or closure of their own here.

## How to use it

- **IDs** are `CA-ISSUE-NNN`, assigned in order and never reused or renumbered. An
  ID issued for an item later found to be owned elsewhere stays as an alias under
  external dependencies. Reference IDs in bridge assignments, checkpoints and commit
  messages.
- **Kind**: a _defect_ was observed or reproduced; a _gap_ is missing or unfinished
  capability recorded in a reviewed document, not a reproduced bug.
- **Gate**: _pilot blocker_ (blocks the first supervised local loop in the
  [roadmap priority update](12-development-roadmap.md)), _unattended blocker_ (blocks
  running that loop without a person watching) or _deferred_ (neither; the entry
  says why).
- **Status** moves `open` → `assigned` → `implemented` → `verified` → `closed`.
  Implemented is not closed: an issue closes only when its closure criteria are met
  and independently verified. Closed rows stay, with the fixing revision and the
  verification evidence.
- **Owner** decides scope and closure (the ChatAgent lead, `codex-chatagent`, unless
  stated); the **assignee** does the work.

When an actionable issue becomes a Hekate plan node, preserve its issue ID and
record the node reference here. PlanStore then owns its live status and assignment;
this entry retains the explanation and evidence links, without a second status
ledger. Deferred issues can remain backlog nodes until selected for work.

## Register

Initial issue baseline: ChatAgent `7ba66ef`, the accepted delivery validator
(2026-10-07). Later fixes are identified separately below.

| ID           | Title                                                              | Kind   | Gate                       | Status   | Owner / assignee                             |
| ------------ | ------------------------------------------------------------------ | ------ | -------------------------- | -------- | -------------------------------------------- |
| CA-ISSUE-001 | Detached buffer escapes the delivery validator as a TypeError      | defect | deferred                   | closed   | codex-chatagent / claude-chatagent           |
| CA-ISSUE-002 | No handoff composition after delivery verification                 | gap    | pilot blocker              | closed   | codex-chatagent / claude-chatagent           |
| CA-ISSUE-003 | No host slot for the consumer view                                 | gap    | pilot blocker              | closed   | codex-chatagent / claude-chatagent           |
| CA-ISSUE-004 | No automatic recovery of an idle lead or worker                    | gap    | unattended blocker         | open     | codex-chatagent / continuation task          |
| CA-ISSUE-008 | No provider-authoritative quota reconciliation                     | gap    | deferred                   | open     | codex-chatagent / unassigned                 |
| CA-ISSUE-009 | Runtime quota-window declarations are not persisted                | gap    | deferred                   | open     | codex-chatagent / unassigned                 |
| CA-ISSUE-010 | Coordination status shows an older-attempt decision as stale       | gap    | deferred                   | closed   | codex-chatagent / claude-chatagent           |
| CA-ISSUE-011 | No cross-repo parity check of a handoff view before use            | gap    | pilot blocker              | closed   | codex-chatagent / claude-chatagent           |
| CA-ISSUE-012 | Role catalog changes need a restart                                | gap    | deferred                   | closed   | codex-chatagent / supervised pipeline worker |
| CA-ISSUE-013 | Missing review identity fields pass TS verification                | defect | deferred                   | closed   | codex-chatagent / supervised pipeline worker |
| CA-ISSUE-014 | Identity rotation can fail on Windows with EPERM                   | defect | verification blocker       | reopened | codex-chatagent / supervised pipeline worker |
| CA-ISSUE-015 | Background launches interrupt desktop focus                        | defect | deferred                   | open     | codex-chatagent / unassigned                 |
| CA-ISSUE-016 | Task verifier omits formatting acceptance                          | defect | acceptance gap             | open     | codex-chatagent / unassigned                 |
| CA-ISSUE-017 | Role observer candidate loses native trace and exposes raw AI text | defect | acceptance blocker         | closed   | codex-chatagent / supervised Odin worker     |
| CA-ISSUE-018 | Review worker cannot read required source and evidence             | defect | review blocker             | closed   | codex-chatagent / supervised Mimir worker    |
| CA-ISSUE-019 | Observer does not compare current event and trace claim keys       | gap    | audit acceptance           | closed   | codex-chatagent / Codex lead                 |
| CA-ISSUE-020 | Cancelled tasks lose historical traces in shared observation       | defect | audit acceptance           | closed   | codex-chatagent / supervised Hermes worker   |
| CA-ISSUE-021 | Operator exporter selected the wrong repository artifact           | defect | audit evidence             | closed   | codex-chatagent                              |
| CA-ISSUE-022 | Hidden launch acknowledgement selected launcher PID                | defect | dispatch observation       | closed   | codex-chatagent                              |
| CA-ISSUE-023 | Full-suite CLI deadline under concurrent verification              | defect | verification resources     | open     | codex-chatagent                              |
| CA-ISSUE-024 | Adapter workspace selection and journal validation gaps            | defect | host adapter               | open     | codex-chatagent                              |
| CA-ISSUE-025 | UI oracle constrains variable spelling                             | defect | test design                | open     | codex-chatagent                              |
| CA-ISSUE-026 | Stop request can target a replacement dispatcher                   | defect | host adapter               | closed   | codex-chatagent / supervised Mimir worker    |
| CA-ISSUE-027 | Launch adapter omits the trusted observer trace root               | gap    | conversation observation   | closed   | codex-chatagent / Athena controls worker     |
| CA-ISSUE-028 | Generated observer helper shadows Python stdlib queue              | defect | supervision tooling        | closed   | codex-chatagent                              |
| CA-ISSUE-029 | Controls compare a native plan key with a canonical task ID        | gap    | conversation correlation   | closed   | codex-chatagent / Athena controls worker     |
| CA-ISSUE-030 | Attempt-progress preparation cannot parse                          | defect | preparation verification   | closed   | codex-chatagent / Athena correction worker   |
| CA-ISSUE-031 | Maintained startup omits attempt progress                          | gap    | startup wiring             | closed   | codex-chatagent / Athena correction worker   |
| CA-ISSUE-032 | Unconfirmed launch loses recovery identity                         | defect | owner recovery             | closed   | codex-chatagent / supervised Mimir worker    |
| CA-ISSUE-033 | Prepared UI launch omits required dependency cache                 | defect | prepared execution         | closed   | codex-chatagent / supervised Athena worker   |
| CA-ISSUE-034 | Generated runbook conflates configuration layers                   | defect | operator facts             | closed   | codex-chatagent / supervised Mimir worker    |
| CA-ISSUE-035 | Observer rejects valid large native trace record                   | defect | observation compatibility  | closed   | codex-chatagent / supervised Hermes worker   |
| CA-ISSUE-036 | Lead wrapper hides failed pinning                                  | defect | orchestration prerequisite | closed   | codex-chatagent                              |

| CA-ISSUE-037 | Observer rejects valid null empty event history | defect | recovery observation | closed | codex-chatagent / supervised Hermes worker |

| CA-ISSUE-038 | Checkpoint turn budgets lack an auditable counter | defect | checkpoint management | closed | codex-chatagent / checkpoint execution task |

| CA-ISSUE-039 | Generated executive source fails syntax/type gate | defect | MVP acceptance | closed | codex-chatagent / operator source repair |

| CA-ISSUE-040 | Executive evidence selection and decision linkage are insufficiently fenced | defect | audit acceptance | closed | codex-chatagent / operator audit repair |

| CA-ISSUE-041 | Checkpoint launch profile, duplicate-start fence and cleanup gate gaps | defect | checkpoint enforcement | closed | codex-chatagent / operator repair |

| CA-ISSUE-042 | Generic gate failures imply source cause and valid monetary tokens are rejected | defect | audit attribution | closed | codex-chatagent / operator repair |

| CA-ISSUE-043 | Checkpoint attention evidence and publication gates are incomplete | defect | acceptance blocker | closed | codex-chatagent / operator repair |

| CA-ISSUE-044 | Checkpoint ledger deadline and ownership publication gates are incomplete | defect | acceptance blocker | closed | codex-chatagent / operator repair |
| CA-ISSUE-046 | Continuation authority and publication checks are incomplete | defect | acceptance blocker | closed | Hermes / scoped repair |
| CA-ISSUE-047 | Phase visibility fixtures and contract claims fail independent gates | defect | acceptance blocker | closed | codex-chatagent / operator repair |
| CA-ISSUE-048 | Bounded checkpoint queue candidate cannot complete and has admission, review, slot and stop gaps | defect | acceptance blocker | closed / verified scoped repair | Hermes / lead verification |
| CA-ISSUE-049 | Formatter proposal rejects required config and contradicts unsupported-file gate | planning defect | acceptance blocker | closed / contract repaired | Athena / lead review |
| CA-ISSUE-050 | Hosted Windows CI failures hidden by advisory job | verification defect | P1 | closed / verified harness repair | Mimir / CI repair |
| CA-ISSUE-051 | Operator source mutation overlapped independent verification | operator defect | P1 | open / handoff guard queued | Codex lead |
| CA-ISSUE-052 | Formatter generation stopped at hard output budget | generation defect | P1 | closed / verified scoped repair | Codex lead |
| CA-ISSUE-053 | Operator handoff proposal accepted supplied exits as ownership proof | planning defect | P1 | closed / contract repaired; implementation open | Codex lead |
| CA-ISSUE-054 | Owner-wrapper candidate test seam typed as Record<string, unknown> | test defect | P1 | closed / precise fixture type verified | Codex lead |
| CA-ISSUE-055 | Remaining multi-fixture lease refusals exceeded hosted test allowance | test harness defect | P1 | closed / both required hosted jobs passed | Codex lead |
| CA-ISSUE-056 | Operator validation launches used incomplete tool/environment profiles | operator defect | P1 | closed / corrected owned checker verified | Codex lead |

### CA-ISSUE-001 — Detached buffer escapes the delivery validator as a TypeError

- **Observed problem and impact:** a delivery field backed by a detached
  `ArrayBuffer` passes the `Uint8Array` check, measures 0 bytes at ingress, and the
  private copy (`new Uint8Array(field)`) then throws a native `TypeError` instead of
  a typed refusal. It fails closed and echoes no content, but a caller cannot treat
  it as a refusal code.
- **Affected revision:** `src/integrations/hekate/handoffConsumer/delivery.ts`
  SHA-256 `61f3bc0bb62a875fca377a89bfc49cedd4064eaee89d0a04e3fba033ae2fd396`.
- **Reproduce** (no secrets; any delivery with valid other fields):

  ```ts
  const task = new Uint8Array([123, 125]);
  structuredClone(task.buffer, { transfer: [task.buffer] }); // detaches task.buffer
  verifyDelivery({ ...delivery, task }); // throws TypeError, not DeliveryRefusal
  ```

- **Evidence:** finding L1 of the independent review by Hekate's implementer
  (bridge message 1430), accepted as non-blocking by the ChatAgent lead (1434).
- **Why deferred:** it fails closed without echoing content and needs a deliberately
  detached buffer; it is fixed first in the next handoff-consumer increment.
- **Closure criteria:** a regression test through `verifyDelivery` with a detached
  buffer in each byte field returns `strict_json`, preserving the first-failure
  order; the focused and full suites pass; independently verified.
- **Implemented, independently verified and closed 2026-10-07:** the private copy refuses an
  unreadable (detached) buffer as `strict_json`, after the ingress checks, so the
  first-failure order is unchanged. `delivery.ts` SHA-256 `5168299291f268e588b376088f245a393e3541d08ea6d0c76b27332d8bb9ca11`
  (uncommitted, base `7ba66ef`). Regressions in `tests/unit/handoffDelivery.test.ts`:
  one detached buffer per byte field, and the wrapper-size check still preceding it;
  all five per-field cases fail against `7ba66ef` and pass with the fix.
  Root reviewed the exact source change and independently ran all 90 delivery tests
  on Node 24.21.0; all passed. Claude's full run passed 1,951 tests across 146 files
  (`node_modules/.cache/ca-issue-001-full.log`), with lint and documentation checks
  passing. The source hash above identifies the verified fix; the commit containing
  this closure record records its integration without a self-referential commit ID.

### CA-ISSUE-002 — No handoff composition after delivery verification

- **Gap:** plan 034's composition (import policy stub, bounded retrieval, the
  consumer view and its digest, the fixed-width reservation, and binding ChatAgent's
  H1 under a reduced window) is not implemented, so verification alone cannot give a
  fresh conversation its context. Source evidence:
  [doc 13](implementation/13-hekate-plan-node-integration.md#offline-handoff-delivery-verification-e2e-consumer-verification-stage)
  lists it as not implemented; `src/integrations/hekate/handoffConsumer/` holds only
  `exactJson.ts`, `pyCanon.ts` and `delivery.ts`.
- **Next action:** the composition plan and acceptance matrix (bridge message 1433)
  starts after the validator commit, with CA-ISSUE-001 first.
- **Closure criteria:** the golden `valid`, `denied` and `wrong-destination`
  compositions reproduce their view parts, digests, reservations and H1 text byte for
  byte with the recorded calls; the supplement compositions likewise; the acceptance
  matrix's structural and no-effect cases pass; independently verified.
- **Implemented, independently verified and closed 2026-10-07:** `handoffConsumer/compose.ts`
  SHA-256 `9669e673541e2713370184b35c04e8115f5497f83e20109963719e97c02c3b10` (uncommitted, base `5cf0180`), tests in
  `tests/unit/handoffCompose.test.ts`. The golden compositions reproduce byte for byte
  with ChatAgent's H1 at HEAD and the recorded windows; the six supplement
  compositions reproduce with a labelled reference-stub port. The 16-call retrieval
  cap is tested; the 10-digit reservation overflow is unreachable on the pinned Node
  24.21.0 runtime (see doc 13).
  Root reviewed the final source and corrections and independently ran all 68
  composition tests; all passed. Claude's final full run passed 2,019 tests across
  147 files (`node_modules/.cache/ca-issue-002-full.log`), with lint and documentation
  checks passing. The source hash identifies the verified fix; its integration is
  recorded by the commit containing this closure entry.

### CA-ISSUE-003 — No host slot for the consumer view

- **Gap:** ChatAgent has no place to deliver a consumer view to a new conversation.
  Hekate plan 034 leaves this as unresolved decision C3, and its offline contract
  stops at `{h1Context, viewPart}`; no ChatAgent context type carries a separate
  attributed view part (`src/domain/context.ts`).
- **Next action:** a lead decision on where the view part goes and what owns it,
  after CA-ISSUE-002. Depends on: CA-ISSUE-002.
- **Closure criteria:** a decided, documented slot with a test that a composed view
  reaches a fresh conversation's context exactly once, as attributed data, never as
  instructions; independently verified.
- **Implemented, independently verified and closed 2026-10-07:** the lead chose the existing
  untrusted-data rendering seam (bridge message 1483). `workerContext.ts` SHA-256
  `3337daa386002bb7dc200bd2da3b34948f4ed8ec53fbecc51b30b92e14b9a3b0` (uncommitted, base `9d08c65`) attaches the view as a
  `handoffView` block rendered last by `buildSystemAndMessages`, with the CLI's
  `--emit-request`. See doc 13, "Host slot for the consumer view".
  Root reviewed the final source and independently passed 243 focused tests,
  including 47 host-slot tests and the CLI request path. Claude's final full run
  passed 2,104 tests across 150 files (`node_modules/.cache/ca-issue-003-full.log`),
  with format, lint and documentation checks passing. Closure covers the explicit
  offline context factory and request artifact; automatic conversation creation,
  provider invocation and worker launch remain outside this issue's scope.

### CA-ISSUE-004 — No automatic recovery of an idle lead or worker

- **Gap:** the [bridge workflow](agent-bridge-development-workflow.md) records that no
  watchdog or automatic lead recovery is implemented, and a retained completion
  message cannot resume an inactive model turn. Observed instances: a bridge reply
  unread for about 20 minutes until the user prompted the lead (2026-10-06); on
  2026-10-07, `codex-chatagent` idle about 52 minutes with 27 unread messages (bridge
  directory, about 12:42 local), and this interactive session stalled about an hour
  on an unseen permission prompt (bridge message 1283).
- **Next action:** partial, initial-response detection is designed in
  [doc 15](implementation/15-stall-detection.md) (revision 5, 2026-10-08). Its
  read-only readers, `scripts/agentStalls.ts` and the classifier (supervised worker
  artifact `87e4601`, plan `ca004-001`) are integrated. The
  doc records two retained 2026-10-08 instances: a watcher-starved assignment, and a
  session stopped by an interrupted tool call. This issue stays open until a bounded
  escalation or resumption is demonstrated. A supervised pilot can run without it;
  unattended operation cannot.
- **Closure criteria:** a stalled lead or worker is detected from recorded evidence
  and resumed or escalated within a stated bound, demonstrated by the proposed
  review-pending handoff acceptance scenario in doc 13; independently verified.

- **Supervision recurrence (2026-10-08):** after the native role rehearsal,
  the lead ended execution and restarted only a read-only observer. Both services
  were healthy and the UI showed zero active tasks; roadmap work remained ready.
  User correction triggered `role-observation-001-r1` on existing Hekate task
  `9f18907d-ef1e-5288-a31f-b78d27ef1920`; the browser then verified it as active.
  Evidence: `D:/hekate-coordinator/runs/monitor-resume-20261008/` and
  `role-observation-001/`. This is manual recovery, not closure of idle-lead
  detection or unattended continuation. Monitoring must lead to explicit dispatch,
  independent review and the next eligible task within the authorized session.

The first bounded assessment phase is now accepted and integrated from `34aa761`:
read-only reconciliation/recommendations and a finite CLI preserve current attempt,
content and artifact fences without mutating task state. Independent checks include
150 focused cases, four controlled regression negatives and 3,037 passing tests with
ten worktree capability skips. Actual retained-store CLI and paired UI readback verify
exact accepted artifacts, wrong-epoch refusal, untouched null history and explicit
unobserved availability failure at a controlled closed port. Evidence:
`recovery-assessment-001/live-cli-proof.json`, `live-closed-port.json`, and
`accepted-ui-proof.json`. No delivered escalation, wake, resumption or persistent
unattended service is established, so the original issue remains open.

- **2026-10-09 supervised queue gap:** after accepting the recovery contract, the
  lead handed back with its implementation still TODO and no worker running. A
  healthy retained API was not execution. The user detected the gap; the actual
  preflight readback (`checkpoint-recovery-implementation-001/preflight-task.json`)
  records TODO/epoch 0. The lead explicitly resumed task
  `e2adb990-cffe-5129-81be-4ba202dac1f9` through the maintained checkpoint runner
  at epoch 1/content 2. Real Hekate Active and ChatAgent exact budget/claim evidence
  are retained in `hekate-active-proof.json` and `active-state-proof.json`. This
  operational correction does not close persistent queue advancement, supervision
  or wake-delivery scope. Service heartbeat remains separate from task execution.

- **Latest checkpoint:** continuation contract task
  `9bd14df4-5bc7-5d68-96e1-e8e0ffb4b627` stopped at its five-minute hard wall
  without a contract artifact (11 observed message IDs). The lead recorded the
  budget stop and rejected the absent proposal; cause remains unattributed and
  no model retry was spent. The subsequent operator recovery is accepted at
  `1031fd7`, integrated at `ec0714a`; the finite external-verification coordinator
  is accepted as task `ffe5f5c6-c656-5761-a724-f13c5586059e` at operator
  epoch 2/content 3, source `7aa55f5`, integrated `69ce8f3`. Real isolated
  delivery proves a worker automatically continues to candidate/finish/checks
  in one owned process; exact source/current gate is visible in the paired UI.
  Semantic AI review, acceptance/integration and next-task claiming remain
  separate; this does not close the persistent supervision gap.
  `checkpoint-continuation-contract-001/no-artifact-review.json` and
  `rejected-readback.json` retain the actual decision.

### CA-ISSUE-008 — No provider-authoritative quota reconciliation

- **Gap:** fixed or rolling quota windows are reconciled only against operator
  declarations; no adapter supplies provider-authoritative coverage, and
  `src/routing/quotaObservation.ts` is imported by no other source file. Recorded in
  roadmap step 3 and [08-resource-policy](implementation/08-resource-policy.md).
- **Why deferred:** the local pilot runs under declared windows and conservative
  admission; no provider currently supplies the coverage evidence this needs.
- **Closure criteria:** a provider-backed reconciliation path with deterministic tests
  for rolling and overlapping windows, stale snapshots and duplicate reports.

### CA-ISSUE-009 — Runtime quota-window declarations are not persisted

- **Gap:** windows declared through `POST /routing/quota-envelopes/declare` live only
  in the process; a restart returns to the configured windows. Recorded as out of
  scope of the declaration increment (roadmap step 3); `ResourceAdmission` has no
  storage for them.
- **Why deferred:** a supervised local pilot can re-declare after a restart; it needs
  a storage-location and recovery-semantics decision first.
- **Closure criteria:** declarations survive a restart under the decided semantics,
  with recovery tests; independently verified.

### CA-ISSUE-010 — Coordination status shows an older-attempt decision as stale

- **Gap (status interoperability, not an execution failure):** Hekate plan 038
  (`context-store/plans/038-older-attempt-decision-review-candidacy.md`, SHA-256
  `f862c9522cf9019c1aca1f20cc57f296b5091a943fc66dca2a50b100b0d773e1`) makes a
  valid decision recorded for a strictly older attempt epoch historical, so the
  current Done attempt is a review candidate. ChatAgent's C1a projection
  (`src/integrations/hekate/devCoordination.ts`, `stateOf`, base `9d08c65`) still
  reports a Done leaf from the node's effective acceptance alone, so such a leaf
  shows `stale` where Hekate now treats it as awaiting review.
- **Next action:** a small C1a change after CA-ISSUE-003: distinguish a decision for
  a strictly older attempt epoch (review pending) from same-epoch drift (still
  `stale`), never inferring an execution acknowledgment.
- **Why deferred:** status display only; it changes no execution, and the
  supervised pilot can read the Hekate state directly meanwhile.
- **Closure criteria:** a fixture with an older-epoch decision projects as review
  pending and same-epoch drift stays `stale`; execution acknowledgment stays
  `unknown`; independently verified.
- **Implemented, independently verified and closed 2026-10-07:** `devCoordination.ts` SHA-256
  `106cc8b5420f817e03103da0dfd35889c8f80ed256857c9514c7054812175713` (uncommitted, base `6d23488`): `review_pending` with
  `acceptanceHistorical: true` for a strictly older positive decision epoch, the human
  CLI labelling it historical. Tests in `tests/unit/devCoordination.test.ts` cover both
  decisions, a reused attempt id, same-epoch drift, zero, future and missing
  decisions (all `stale`) and the unchanged captured fixture.
  Root reviewed the exact change and independently passed all 38 status-consumer
  tests on Node 24.21.0, including the human CLI subprocess. Claude's final full run
  passed 2,113 tests across 150 files (`node_modules/.cache/ca-issue-010-full.log`),
  with format, lint and documentation checks passing. The commit containing this
  closure record records integration of the verified source hash.

### CA-ISSUE-011 — No cross-repo parity check of a handoff view before use

- **Gap:** nothing checked that the view ChatAgent composes for a handoff is the one
  the producer's own consumer composed for the same delivery, so a divergence
  between the two consumers would reach a fresh session unnoticed. The first pilot's
  verification and validation needs that independent agreement.
- **Implemented and independently verified 2026-10-07, ChatAgent side:** the handoff CLI's
  `--expect` gate (doc 13, "Offline operator CLI"), `cli.ts` SHA-256
  `6aec840bfb1093bcc078121ce5b6cf64cc5a53eac4b51377150cc794891ea339` (uncommitted, base `6d355db`), tests in
  `tests/unit/handoffCli.test.ts` (a match, each field mismatch, eight malformed and
  three unreadable expectation cases, none publishing output).
  Root reviewed the exact source and independently passed all 56 CLI and publishing
  tests on Node 24.21.0. Claude passed 171 focused CLI, publishing, composition and
  host-slot tests on the final source; its 2,131-test full run preceded only the
  summary-claim wording change. Format, lint and documentation checks passed.
  This first increment verified the consumer gate; the end-to-end closure is recorded below.
- **Export input implemented and independently verified 2026-10-07:**
  `compose --export <dir>` reads one `handoff-export.v0` directory (contract frozen by root in bridge
  message 1549) and always checks its expectation. Tests use a synthetic,
  golden-derived export labelled as such; the later real capture is recorded below.
  `cli.ts` SHA-256 `eb1f974b8de6c48f5d0cb772a63e8016084daf325f15630323d682d6c0875d5b`
  (uncommitted, base `d7a6c32`). Root reviewed the fixed layout, streamed listing,
  descriptor identity checks and parity gate and independently passed all 86 CLI and
  publishing tests. Claude passed all 435 handoff tests; format, lint and
  documentation checks passed. This verifies the consumer path with synthetic
  inputs. The actual producer and its acceptance are recorded below.
- **Dependency satisfied:** Hekate's producer at `1af9a9e8c20216c05ea43a521277b32cc5dff3d9` writes
  `handoff-expectation.v0` from its consumer run with ChatAgent's real H1 (schema
  proposed in bridge message 1515 and acknowledged unchanged by Hekate's implementer
  in 1524). Its source is integrated in Hekate primary at `489f7910`.
- **Closure criteria:** a real pilot handoff export, composed by ChatAgent with
  `--export` (or `--expect`), matches; a deliberately altered expectation is refused;
  independently verified.
- **Independently verified and closed 2026-10-07:** the real Claude CLI round
  `a5882739c150` (root GO 1611) produced the indexed export now preserved unchanged
  in `tests/fixtures/hekate/pilot-export-v0/`; its adjacent `PROVENANCE.md` records
  the source, runtime, evidence and limits. INDEX SHA-256
  `264a494b37f7470fce95645dfd12db61069c9484ceb6995967c0332ef4f99bec` identifies the
  exact 13-file bundle. The Python producer used the verified real H1 at `5255daa`;
  ChatAgent's real H1 at `2383e85` rebound the committed task and matched the view
  bytes, digests, reservation and cost. Claude independently passed 22 acceptance
  checks, including altered-expectation and tampered-byte controls on copies.
  Root independently composed the original export and confirmed identical view,
  summary and emitted-request hashes, then passed all 90 CLI and publishing tests
  on the captured fixture. Claude passed all 439 handoff tests; format, lint and
  documentation checks passed. The emitted request remains an offline artifact;
  the reviewer was a deterministic verifier. Provenance and model identifiers are
  declared, not authenticated; the snapshot is historical and policy is a test stub.

### CA-ISSUE-012 — Role catalog changes need a restart

- **Original gap (resolved):** the role catalog was read once at startup (`src/server.ts`,
  `loadRoleCatalog(process.env.ROLE_CATALOG_PATH)`), through an unbounded file read.
  `RoleCatalog.replace` exists and claimed messages already keep a snapshot
  (`tests/unit/roleCatalog.test.ts`), but nothing re-reads the file at runtime, so an
  operator's role edit needs a restart, which also drops in-memory state such as
  runtime quota-window declarations (CA-ISSUE-009).
- **Why deferred, and why selected:** it blocks neither the supervised loop nor
  unattended running. It is the first existing-repository task chosen to run through
  the supervised loop, because it is small, operator-usable and testable offline.
- **Scope:** startup and reload read the configured file through one
  descriptor-bounded read of at most 1 MiB as strict UTF-8; startup keeps
  `ROLE_CATALOG_INVALID`. An exported `reloadRoleCatalog` replaces the startup
  catalog in place, synchronously from read to replace, or throws
  `ROLE_CATALOG_RELOAD_FAILED` and leaves it unchanged. `POST /roles/config/reload` is
  an operator route with a strict empty body that re-reads only the configured path:
  200 `{version, roleIds, sha256}`, 404 `ROLE_RELOAD_DISABLED` without a path, 400 with
  the catalog unchanged on any failure, echoing no file content. No watcher, UI or
  automatic reload. Allowed changes: `src/app/roleCatalog.ts`,
  `src/auth/routePolicy.ts` (the route table is default-deny) and `src/server.ts`.
- **Acceptance oracle (frozen, isolated):** `tests/unit/roleCatalogReload.test.ts`
  (SHA-256 `8232625cdcfdf38f014d753a00014306f2fb508286bf6468ffcd66276909397f`) and
  `tests/integration/roleReloadHttp.test.ts`
  (`f921fe94164bcf7f6de7bce1dc6d37bcc6445dc2af9b730e5a2f2f84186ed472`), committed only
  on branch `task/ca012-base` at `1f75576a70fb3379d18f2d4aa9f0f4d5b6ab1a45` (anchor
  `2383e85`; the anchor-to-base diff is exactly these two added files). They are
  intentionally failing there and are never merged to main as-is: 14 of 15 tests fail
  on named assertions, the exact-1 MiB load passes. The HTTP file observes the live
  catalog through a pass-through wrapper of the real loader, with no production hook.
- **Task spec (frozen):** `supervised-task-spec.v0` SHA-256
  `b919504a353bbc21c730caedbbab244c2e457e2ef2d249c5456d91b60c322d4e` (bridge messages
  1636, 1644 and 1651). It binds the oracle and its structured baseline cases, the
  verify steps (Vitest oracle and `tsc --noEmit` on pinned Node 24.21.0), the npm CLI,
  lockfile and tool hashes, and the worker bounds (40 turns, $1.00 per round, at most
  two rounds).
- **Runner:** Hekate plan 040 at `30279d83a5814a641e3ba06c1da67645a9fe0d3a`,
  independently reviewed by root (bridge message 1726), with 933 default tests
  passing and one optional live test skipped. The real npm interoperability check
  passed separately.
- **Closure criteria:** a supervised worker's artifact passes both oracle files
  unchanged and `tsc` under the runner's independent verifier, with only the allowed
  files changed; root reviews the source, including descriptor growth and concurrent
  reloads, and integrates it onto current main with the oracle; independently
  verified.
- **Closure evidence (2026-10-07):** the real Claude CLI produced artifact
  `a7fd2ec7225e480af20c581844663ffb7853be48` in one round, changing only the three
  allowed source files. ChatAgent Claude independently reviewed the source, including
  file growth, atomic replacement, snapshots and operator authorization (bridge
  message 1707); root also reviewed it.
- **Verification recovery:** the original Hekate pilot stopped before test execution
  at a Windows worktree path-length failure and remains `needs_operator` /
  `review_uncertain`. After the runner fix, one fresh verifier-only recheck accepted
  the same artifact: all 15 frozen oracle cases and typecheck passed. Its
  `verify-evidence.json` SHA-256 is
  `3c05d6cd87e9014f21a89682b91e51dfcfe187cbb5ec4fc6d7280d2dabb23331` (bridge
  message 1729; root independently checked its bindings, unchanged originals,
  worktree and oracle hashes). This uses the original recorded binding; the raw
  review view was not preserved. It is artifact verification, not recovery of the
  original H1 or PlanStore decision.
- **Integrated checks:** root's isolated integration on current main passed 2,171
  tests, with nine skipped and zero failures, plus format, lint and `docs:check`
  (seven symbols, 15 invariants). The local full-suite report is
  `node_modules/.cache/root-ca012-checks/full-suite.json`, SHA-256
  `0beb05fec67e1f4184550b04bf9c026600bf203cc7d80aa443c51fd0e9559896`.
  Integration adds the new operator route to the existing route-inventory test,
  gives the integrated HTTP tests explicit 30-second startup timeouts and applies
  pinned Prettier formatting. The frozen verifier oracle and historical evidence
  remain unchanged. Tests and implementation are integrated together; the failing
  oracle-only branch is not merged on its own.

### CA-ISSUE-013 — Missing review identity fields pass TS verification

- **Observed problem:** a re-signed delivery whose manifest review identity lacks a
  required field (`rootId`, `nodeId`, `attemptId`, `attemptEpoch`, `artifactRef`), or
  whose identity is not an object, passes `verifyDelivery`: `verifyStored`
  (`src/integrations/hekate/handoffConsumer/delivery.ts`) only checks that the identity
  object exists. The delivery is refused later, at revalidation, as `fresh_mismatch`.
  The revised Python reference consumer (Hekate HK-ISSUE-002, consumer `aea15fa4`)
  refuses it at verification as `delivery_mismatch`, so the two consumers now disagree
  on the stage and code (bridge messages 1752, 1755). Both refuse; the canonical
  producer cannot emit such a manifest.
- **Why deferred:** no pilot blocker. It is the second existing-repository task for
  the supervised loop, with a fuller acceptance gate than CA-ISSUE-012.
- **Scope (bridge messages 1755, 1757):** presence only, as the reference's
  `review_identity` does. No new value or type rules (a present null `artifactRef` still
  verifies), extra identity keys stay accepted, and revalidation semantics and the
  documented depth-64 `codec_unsupported` difference are unchanged. Allowed change:
  `src/integrations/hekate/handoffConsumer/delivery.ts` only; it is not a pilot-manifest
  component, so no contract tags.
- **Acceptance oracle (frozen, isolated):** `tests/unit/handoffIdentityVerify.test.ts`
  (SHA-256 `f228ff5cb41531b1fe13e202e2ef142a39f96c8afbb0d07ebf2e6ca018ec7573`),
  committed only on branch `task/ca013-base` at
  `18d5ec9b3e38fb59919c5e3873e2cc52aa1ef713` (anchor `b3cfee5`; the anchor-to-base diff
  is exactly this added file). Each malformed delivery is fully re-signed (manifest,
  the envelope's embedded manifest, receipt and candidate digest). At the base, 13
  named assertions fail and 4 controls pass (unchanged golden, optional `lead`
  removed, present null `artifactRef`, extra key). In the full suite only those 13
  fail.
- **Task spec (frozen candidate):** `supervised-task-spec.v0` SHA-256
  `467fde174ceb7e9429150121a019165b4da22b2c9e06d6b6394b6cdb19a4a1d8`. It validates under
  Hekate's runner `30279d8`. Verify steps: the oracle with its structured baseline (17
  cases), `tsc --noEmit`, the full repository suite and `docs:check`, on pinned Node
  24.21.0; worker bounds 40 turns, $1.00 per round, at most two rounds. Only the
  vitest and tsc entries are hash-pinned; tsx is covered by the lockfile and `npm ci`.
- **First pilot (v1 spec), stopped 2026-10-07:** run `d7784379a3e3` (root GO 1768)
  ended `needs_operator` / `max_rounds`. Both real Claude CLI rounds changed only
  `delivery.ts` and passed the oracle and typecheck, and the verifier correctly
  rejected both at the full-suite step. An existing assertion,
  `tests/unit/handoffDelivery.test.ts` (the missing-`artifactRef` case), still expected
  the old revalidation-stage `fresh_mismatch`, and the `delivery.ts`-only scope kept the
  worker from updating it, so the v1 task was unsatisfiable (bridge messages 1775,
  1777). The oracle preparation had run the full suite only at the base. The v1 base,
  spec and run evidence are preserved.
- **Task base v2 (frozen, isolated):** branch `task/ca013-base-v2` at
  `1bdc1034d2f336a0b795512cd0daea4a2dce1dd8`, descending from `18d5ec9`. It changes only
  that existing assertion to `delivery_mismatch`, with a comment (`handoffDelivery.test.ts`
  SHA-256 `4c18545b9bb94bd749c2b0dae60e6377e486950082b3b314df37ee59ecf104e0`). The raw
  anchor-to-base diff is exactly `A tests/unit/handoffIdentityVerify.test.ts` and
  `M tests/unit/handoffDelivery.test.ts` (100644), and both files are pinned oracle
  files. At this base the oracle fails 13 named assertions with 4 passing controls, and
  the full suite fails those 13 plus the updated assertion.
- **Task spec v2 (frozen candidate):** `supervised-task-spec.v0` SHA-256
  `b644847cf964fda80b0c3d6c8e8e8740f23e0de78ee290c731f46d02fae2ccc3`. It validates under
  Hekate's runner `30279d8`, with the same four verify steps, worker scope and bounds.
- **Satisfiability proven before freezing:** a throwaway reference implementation,
  never committed or shared with the worker, passed all four steps at the v2 base: all 17
  oracle tests, typecheck, the full suite (2,188 passed, none failed) and the documentation
  check. Known risk: the existing Windows test `tests/integration/localIdentity.test.ts`
  can fail independently of the task (an `EPERM` rename during identity rotation), which
  would reject at the full-suite step.
- **Closure criteria:** the worker's artifact passes both oracle files, typecheck, the
  full suite and the documentation check under the runner's independent verifier, with
  only `delivery.ts` changed; root reviews the source and integrates it onto current
  main with the oracle, formatted; independently verified.
- **Closed 2026-10-07:** the second pilot, run `d980a658bbad` (root GO 1801), was
  accepted in round 1. The real Claude CLI artifact
  `bd0365095ef7a317b82f5f0ce986290373970799` changes only `delivery.ts`:
  `verifyStored` requires the identity to be an object carrying the five keys. The
  runner's verifier passed all four steps on fresh dependencies: the 17 frozen oracle
  cases, typecheck, the full suite and the documentation check, with no failure lines
  (bridge message 1808). ChatAgent Claude reviewed the source and scope independently.
  The integration carries the artifact's `delivery.ts` blob unchanged
  (`07eb59c3f6c993c14500588835f6720e09942c53`), both frozen oracle files byte-identical
  to the v2 base, and the matching update to the verification contract in
  doc 13.

### CA-ISSUE-014 — Identity rotation can fail on Windows with EPERM

- **Real rehearsal reference recurrence (2026-10-09):** first immutable rehearsal
  package passed 2,866 cases, skipped ten explicit cases and failed the existing
  recurrence test on native Windows replacement `EPERM/rename`. The package
  remains rejected and unpinned, with exact artifact `9569fb7854a03e23690ba54dcd1002088566cca3`
  and full evidence under external `authoring/integrated-rehearsal-001`. No test
  was skipped or relaxed. This confirms the broader issue remains open; it does
  not identify the handle holder. The new package also corrects an independently
  found rehearsal-helper acceptance-pin error and adds six pure projection cases,
  with an actual old-helper negative check and restored exact bytes.

- **Replacement refusal classification (2026-10-08):** full integrated launch
  verification reproduced raw `EPERM/rename` in the concurrent case: 2,761 pass,
  one failure. Follow-up Hekate task `810925e8-96b2-5b4f-a2f7-e5b5ede4fc50` is accepted at
  `ca688d04988ddc5c5706f5a75e6e4167fb234204` and integrated. Only the rotation
  boundary converts the exact owned Windows native refusal to `LocalIdentityError`
  with its native cause. The replacement helper, bounds, uncertain retention and
  concurrent test remain unchanged. Real permanent-holder verification checks
  cause, old bytes, private permissions, cleanup and later retry; the original
  source fails the updated domain fixture. Twenty focused cases and 2,753 full
  worktree cases pass (nine existing opt-in skips), plus lint/docs. Integrated main passed all 2,762 cases, including its Windows opt-in fixtures,
  plus lint/docs. Evidence: external `identity-rename-refusal-001`
  and `ui-native-observation-001/integrated-dispatch-full.log`. The original field
  holder remains unknown; this is scoped classification repair, not broad closure.

- **Contention mechanism repaired (2026-10-08):** `cf9d1a4`, accepted managed
  task `2e272c20-db6c-576f-8cb7-73e87311c0ed` epoch 2. Real kernel handles
  reproduce delete-pending lock-open `EPERM`. Six bounded waits recover after
  release without stealing a lock; permanent contention and another owner remain
  safe refusals. Independent old-source run fails the new recovery case. Full
  suite: 2,432 passed, 9 existing skips; format/lint/docs pass; frozen POSIX oracle
  unchanged. Evidence: `D:/hekate-coordinator/runs/resolve-both-001/identity-contention/`.
  Initial fixture DWORD binding failure and mistaken artifact correlation were
  rejected/corrected with retained records. The original field syscall/holder is
  still unconfirmed; unrelated permanent denying handles are not bypassed.

- **Recurrence review (2026-10-08):** accepted narrow lock-acquisition refusal fix
  `6cfd9fc` under managed task `c3c70c65-52ea-53e4-9209-d3d39893f927`.
  Windows lock-open `EPERM` now yields `LocalIdentityError` preserving native cause,
  without acquiring or removing another process's lock. Verification passed 39
  focused cases and 2,428 full-suite cases with 9 existing skips; lint and docs
  checks passed. Evidence: `D:/hekate-coordinator/runs/identity-recurrence-001/`.
  The original failing field syscall and holder remain unconfirmed, so the broader
  issue stays reopened; this acceptance does not establish that every Windows
  replacement contention is repaired.

- **Current assignment (2026-10-08):** prepare the next supervised task's safe
  replacement design, frozen tests and reference proof (bridge assignments
  2186, 2199). A deterministic delete-sharing-reader reproduction and native
  POSIX replacement probe pass; this is mechanism evidence, not acceptance of
  a product fix. The identity file must remain readable throughout, with its
  principal, epoch progression and private permissions preserved. Existing
  non-delete-sharing refusal/retry behavior remains required. Helper transport
  uncertainty must be classified only after the helper can no longer mutate.
- **PlanStore reference:** project `ca42c295-08ca-415b-90e2-52abba8fcdd7`, plan
  root `db7d97f5-0756-5b44-b871-c29242b2d45a`, node
  `5e2c005d-b3a2-5dc7-b636-530c74186d13` (`ca014`). PlanStore owns live task,
  attempt and review state. Prepared spec SHA-256
  `2eac3967fafe7b74f4ed5b13f755cddc336d71bafe8dfddc4bc5ad4dfb454e8c`;
  supervised execution authorized by bridge GO 2236 in the new `ca014-001` store
  and run. This entry records the issue and its verification, not another task
  status ledger.

- **Observed problem:** on Windows, `rotateIdentity` (`src/auth/localIdentity.ts`) can
  fail with `EPERM` when it renames the new identity over `identity.json`. The failure
  is safe: the file is left unchanged and the temporary file is removed, so the
  operator sees an error and nothing is half-written. The existing test
  `tests/integration/localIdentity.test.ts` ("rotates authenticators, keeps the
  principal, and the old ones stop working") therefore fails intermittently, and a
  supervised verifier's full-suite step can reject an otherwise correct change (it
  appeared during CA-ISSUE-013 preparation and once in an integration run).
- **Evidence (2026-10-07):** a bounded reproduction (`eperm_repro.mts`) ran the test's
  create-then-rotate sequence against the real module 80 times. Six runs failed (3 in
  each batch of 40). The retry histogram is bimodal: 74 rotations needed no retry and
  6 exhausted all six waits; the existing bounded `EPERM` retry (1,575 ms) did not
  recover any of the 6 observed failures. At each failure the target could still be
  opened for reading and writing, copied and deleted, but renaming onto it kept failing
  for at least 5 to 30 more seconds, also from a separate process. Its ACL was the
  expected private one, and no handle leak was found on the code path. The script,
  log and analysis are preserved locally under `node_modules/.cache/ca014-evidence/`
  (`eperm_repro.mts` SHA-256 `4ef88f3a…`, `eperm2.log` `33c2c3c6…`, analysis
  `30450383…`) and summarized in bridge message 1812.
- **Cause (inference, not proven):** another process holds `identity.json` open with
  delete sharing, consistent with an on-access scanner or indexer opening the freshly
  written file. Node's delete uses POSIX semantics and succeeds despite such a handle;
  rename-over-target does not. Naming the holder would need a handle tool.
- **Known limitation:** the behaviour is accepted for now. A longer retry is not
  selected without a bounded product fix (it might eventually outlast a long hold, but
  that is unproven), and moving the real-file test out of the default suite would hide
  a material platform failure, so neither is done. Replacing the file non-atomically (moving the
  current file aside first) is rejected: it opens a window in which
  `loadOrCreateIdentity`, which does not take the rotation lock, could mint a new
  identity.
- **Bounded follow-up:** design a safe atomic replacement on Windows that keeps the
  identity readable throughout and never lets a loader mint a new identity mid-rotation,
  with deterministic tests only for any contract that is genuinely missing (the existing
  tests already cover transient and persistent `EPERM` and cleanup).
- **Closure criteria:** rotation on Windows succeeds despite a reader or scanner
  holding the target with delete sharing, or the defect is otherwise resolved, with
  the identity never absent or re-minted during rotation; independently verified.
- **Closed 2026-10-08:** run `22ac83497795` (root GO 2236) was accepted in round 1.
  The real Claude CLI artifact `89432e9a7c6c08b0639184a41683a19054418543` changes only
  `localIdentity.ts`. After a plain rename fails with `EPERM` on Windows, the same
  attempt tries a POSIX-semantics rename (`SetFileInformationByHandle`,
  `FileRenameInfoEx`, `REPLACE_IF_EXISTS | POSIX_SEMANTICS`) through a fixed PowerShell
  helper that receives only paths, in its environment. The outcome is decided by
  reading both files back after the helper has exited:
  - replaced: done;
  - unchanged: the existing bounded retry and the original `EPERM`;
  - anything else: `IdentityReplaceUncertain`, which keeps the temporary file and the
    rotation lock.

  The runner's verifier passed all four steps: the 19 frozen oracle cases, typecheck,
  the full suite (2,240 passed / nine skipped) and the documentation check. ChatAgent
  Claude reviewed the source independently and reran the oracle and the existing
  identity tests on the artifact. CLI-reported usage (not metered): $0.37, 20 turns.

- **Integration corrections:** the lead's review of the immutable artifact found two
  helper-transport defects, which were fixed in a separate commit on top of the
  unchanged artifact and frozen oracle:
  - a helper killed at its deadline could still yield a result it had printed before
    closing cleanly;
  - an oversized output chunk was kept whole, past the 256-character cap.

  `tests/unit/localIdentityHelper.test.ts` fails on the artifact as accepted and
  passes with the correction.

- **Remaining limit:** the fix covers holders that share delete access. A holder
  without delete sharing, an older Windows or a filesystem without POSIX rename keeps
  the bounded retry and the safe `EPERM` failure. The field holder's share mode is
  indicated by the 2026-10-07 evidence (deletion succeeded while rename failed) but
  not proven. If `EPERM` recurs in the real-file rotation test, that is the case to
  investigate.

**2026-10-08 recurrence:** reference proof
`D:/hekate-coordinator/authoring/plan-status-api-003/` failed
`tests/integration/localIdentity.test.ts` in “serializes concurrent rotations and
refuses to rotate past the largest epoch”: expected a `LocalIdentityError`, received
a native `EPERM` rename failure. Reopened for diagnosis; the precise holder and
relationship to the earlier fix are not established. Preserve the failed proof
and require the focused real-file case plus the full reference suite before closure.
Hekate task: `c3c70c65-52ea-53e4-9209-d3d39893f927`.

## Findings from supervised application work (2026-10-08)

These findings are recorded as work proceeds. Their Hekate node references below
own live execution state. A workaround is not closure; closure requires the named
verification. Feature backlog and intentionally deferred limitations stay distinct
from defects.

**2026-10-09 checkpoint-attention recurrence:** source `17ebec2` full gate
passed 3,229 cases and skipped ten explicit capabilities, but
`tests/unit/localIdentityRecurrence.test.ts` / "still rotates once the lock can be
created" failed with native `EPERM` at rename. Identity source and its test are
unchanged from the prior integrated baseline. The holder/cause is unknown; no
model retry or source-failure attribution was made. Retain
`checkpoint-recovery-implementation-001/final-full-exit.json`,
`identity-recurrence-assessment.json` and the isolated recheck. The isolated recheck passed, followed by a fresh serial full gate with 3,230
passing cases and ten explicit capability skips. The failed original proof is
retained; the holder remains unidentified and this issue remains reopened.

### CA-ISSUE-015 — Background coordinator launches can interrupt desktop focus

- **Hekate task:** `fe089f06-235b-5c28-8ad7-b469f42a5153` in plan
  `9edb606e-59ff-536b-b1f2-541a2683c51e`.

- **Kind / priority:** defect, supervised-workflow usability; address before
  repeated interactive runs. Owner: ChatAgent coordination launcher; Hekate child
  launch changes require their own scoped implementation review.
- **Observed:** the user reported Windows taking focus during launches. The local
  viewer launcher used detached Node spawn without `windowsHide`; Hekate's Python
  worker/check launchers set `CREATE_NEW_PROCESS_GROUP` without `CREATE_NO_WINDOW`,
  and API/helper launches also lack a consistent hidden-window policy. These are
  source observations, not proof that each path caused a focus change.
- **Reproduce:** with another application focused, launch the viewer, a worker and
  its verifier on Windows; record foreground-window identity before/during/after
  and console visibility. Preserve process-tree and command evidence without
  credentials. Repeat independently after the fix.
- **Expected:** supervised background work leaves the foreground application
  focused, retains logs and permits bounded process-tree cancellation.
- **Current mitigation:** `D:/hekate-coordinator/plans/chatagent-app-20261008/start-viewer.mjs`
  now sets `windowsHide: true`; new controlled Node helper launches do too. No
  claim of end-to-end closure. The running service was not restarted for that edit.
- **Closure:** maintained launch paths use the appropriate no-window controls,
  cancellation and output capture regressions pass, and the Windows foreground
  probe demonstrates no launcher-caused activation for viewer/worker/verifier.

### CA-ISSUE-016 — Formatting acceptance and worker capability disagree

- **Hekate task:** `696aa273-2b34-5933-8f6f-370ff7ab2b92` in plan
  `9edb606e-59ff-536b-b1f2-541a2683c51e`.

- **Kind / priority:** defect in ChatAgent's task profile, supervised integration
  quality. Owner: ChatAgent. Status: open; per-task mitigation prepared.
- **Observed:** Hekate accepted artifact `1b9d2d2` after oracle, typecheck, full
  suite and docs checks, but its new README table was not Prettier formatted.
  Commit `f143a45` is the separate formatting-only correction. The worker correctly
  reported that shell checks were unavailable; no worker test claim was trusted.
- **Reproduce:** compare `git show 1b9d2d2:README.md` against pinned Prettier output,
  and inspect `docs/contracts/hekate-task-profile.json`: its verifier steps omit
  `format:check`/`lint`. Evidence:
  `D:/hekate-coordinator/runs/chatagent-app-20261008/monitor-runbook/pilot-2adf0389b8ab/evidence.json`.
- **Expected:** a candidate that violates mandatory formatting is rejected before
  acceptance, without altering frozen inputs or the candidate during verification.
- **Mitigation:** the next API task's frozen oracle checks every allowed source and
  contract path with pinned Prettier; the maintained profile still checks types,
  the full suite and documentation. An attempted profile using an absolute npm
  entrypoint was refused by the existing spec validator, before execution; its
  input is retained. The validator was not weakened.
- **Native recurrence:** `application-native-001/plan-status-api/pilot-06a62336c3ed`
  ran two real model rounds; both were correctly rejected by the unchanged format
  oracle. The worker's sole permitted Bash command is the frozen oracle, so it
  cannot invoke Prettier. The runner respected the two-round limit and stopped.
  The explicit operator review creates a formatting-only derivative and verifies
  it afresh; TypeScript token equivalence proves no implementation token changed.
  This is a separately attributed review, not an automatic model retry.
- **Capability follow-up:** `db59fb7b-d963-537a-853a-8883601ab757`, root
  `29141a72-9c9a-54f8-a357-fb6db74d84d9`: version a pinned formatter capability
  separate from the frozen oracle, preserve v0 authority and immutable evidence,
  and format before artifact commit. Never normalize the verifier's tree into a
  false pass or grant unrestricted shell as a workaround.
- **Closure:** a supported maintained profile/check command rejects an otherwise
  correct but unformatted candidate, accepts a formatted control, preserves exact
  candidate bytes and runs the existing required checks. Update profile contracts
  and relevant tests; verify a real task. The one-task oracle is not a global fix.

The versioned pinned supervisor formatter follow-up is now accepted in Hekate
(task `db59fb7b-d963-537a-853a-8883601ab757`, epoch 2, source `c200ef7`).
All 44 formatter cases pass. A separate real Node24/Prettier3.9.9 proof retains
pre/post bytes and hashes, reproduces the reviewed UI reference and is byte-idempotent.
V0 history/evidence, worker shell restriction and independent verifier remain
unchanged. The original UI task is now running natively with its frozen v1 package;
its live native run is accepted at epoch 2 after both rounds ran pinned formatting/idempotence checks. Historical v0 behavior remains unchanged; future profile adoption is explicit. Evidence: external
`task-formatter-001` and `task-formatter-real-prettier-001` directories.

### UI observation — Active state and refresh

The 2026-10-08 focused browser run passed 48 existing task/plan/trace cases,
including an `in_progress` task in Active and the In progress board column. A
live read-only check matched zero active database tasks to zero visible Active
tasks, with no page errors. Evidence:
`D:/hekate-coordinator/rechecks/active-ui-20261008/`.
No active-filter defect was reproduced. Refresh is explicitly manual in the
current UI; automatic progress refresh remains a planned feature, not a closed
defect. Check the real active worker during the next run as a separate live case.

### API task authoring finding — route inventory omitted

The first reference proof for `plan-status-api` passed the HTTP oracle and typecheck
but failed the full suite: `authPrimitives.test.ts` expected 46 routes while the
candidate correctly added the 47th. The initial task preparation had omitted this
existing contract. Its base now includes the deliberate 47-route inventory and
operator access expectation; no assertion was removed or weakened. The failed
reference remains in `D:/hekate-coordinator/authoring/plan-status-api-001/`; a new
proof `plan-status-api-002` refused an oracle-membership omission. Corrected proof
`plan-status-api-003` passed all 26 oracle cases and typecheck, then failed the
full suite in the existing concurrent identity-rotation test with `EPERM`.
This reopens CA-ISSUE-014 for investigation; the failure is preserved and the API
task remains unlaunchable until its reference proof passes. This is an authoring defect on Hekate node
`2bea5646-085a-55ba-8043-8c7928711aac`, not a regression integrated into main and
not a reason to bypass the full suite. The route inventory correction passed;
complete reference verification remains blocked by the identity failure.

## External dependencies

Owned and tracked elsewhere. These rows give no status or closure of their own; the
linked owner's register is authoritative. The CA IDs below were issued before the
ownership was clear and remain only as aliases.

| Alias        | Dependency                                                       | Authoritative record                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-ISSUE-005 | Durable execution acknowledgment, progress evidence and wake-ups | Hekate `context-store/plans/037-open-issues-register.md`: HK-ISSUE-008 (who attests a real worker's ACK and progress) and HK-ISSUE-009 (journal storage beyond disposable test databases) |
| CA-ISSUE-006 | A `claude-chatagent` bridge credential                           | The bridge owner's register (link pending, to be provided by the bridge owner)                                                                                                            |
| CA-ISSUE-007 | Reference consumer `RecursionError` and untyped identity errors  | Hekate `context-store/plans/037-open-issues-register.md`: HK-ISSUE-001 and HK-ISSUE-002                                                                                                   |

- **CA-ISSUE-005:** ChatAgent's coordination status reports execution
  acknowledgment as unknown until a Hekate contract exists; the local pilot is
  supervised and does not need a production protocol for it.
- **CA-ISSUE-006:** historical observation, not current verification: the bridge
  agent directory listed `claude-chatagent` with `credentialed: false` on 2026-10-07
  (11:12 and 15:12 local), so the interactive ChatAgent Claude session sent with the
  operator credential, stamped `fenrir`, and the lead correlated its messages by
  session ID (bridge messages 1121, 1167). Bridge-owner confirmation is pending;
  no gate is assigned from this observation.
- **CA-ISSUE-007:** the ChatAgent port already refuses both inputs with typed codes
  (doc 13, host differences); only the reference differs.

### CA-ISSUE-017 — Role observer candidate loses native trace and exposes raw AI text

- **Kind / status:** defect / closed for the bounded shared observation collector at `2f3d6df`.
- **Observed:** candidate `0cc1d73` passed its worker-authored selection (89 cases),
  but five of six independent cases failed. The first trace request used cursor
  zero and the record schema refused native sequence zero. Normal subsequent-page
  prompt omission falsely changed consistency and lost the first prompt. The AI
  projection retained arbitrary trace credentials/instructions; unknown statuses
  passed validation, and UTF-8 decoding silently stripped BOM bytes before hashing.
- **Expected:** match the maintained native trace API, retain exact validated bytes,
  distinguish partial/stale evidence, and expose only allowlisted metadata to AI.
  Raw human evidence remains explicitly restricted local data.
- **Owner / task:** codex-chatagent lead and supervised Odin worker; Hekate node
  `9f18907d-ef1e-5288-a31f-b78d27ef1920`, root
  `29141a72-9c9a-54f8-a357-fb6db74d84d9`. Epoch 1 was rejected; repair attempt
  `managed-role-observation-002-r1` was accepted at epoch 2.
- **Evidence:** `D:/hekate-coordinator/runs/role-observation-001/independent-first.log`,
  `review-rejected.txt`, rejected candidate and exact live API fixtures. The copied
  rejection driver's history refers to `managed-role-observation-001/`; that path
  holds the same review/readback, with the correction recorded and no mutation retried.
- **Closure evidence:** 106 selected cases passed, including independent regressions
  and maintained coordination tests; format/lint/docs checks passed. Three live
  observations matched native task/attempt identity, captured sequence zero and
  verified trace; all response hashes independently recomputed. Reviewed artifact
  `2f3d6df` integrated and accepted. Failure/harness-correction logs retained.

### CA-ISSUE-018 — Review worker cannot read its required source and evidence

- **Kind / status:** launch defect / closed; review completeness blocker.
- **Observed:** Mimir's first report was incomplete: the restricted CLI read tools
  could read the ChatAgent worktree, but refused Hekate source and retained evidence
  outside it. The prompt named those inputs without configuring their allowed paths.
- **Expected:** every assigned review input is readable within the declared tool
  scope; refused inputs stay explicit gaps and cannot support acceptance.
- **Owner / task:** codex-chatagent lead; Hekate task
  `efb428c9-5e44-5326-b856-0909efed76e1`. Epoch 1 report rejected; epoch 2 reviewer read the required native evidence with zero permission denials.
  The corrected launcher uses `--add-dir` for the exact source and evidence
  directories while exposing only Read/Grep/Glob tools.
- **Evidence:** `D:/hekate-coordinator/runs/role-review-001/public-report.txt`,
  `review-rejected.txt` and `role-review-002/launch.json`. Local CLI help confirms
  restricted mode confines file tools to working directories including `--add-dir`.
- **Closure:** reviewer demonstrates reads of the required files and reports on
  actual native Active/completion and fail-closed evidence; lead verifies the report.

- **Closure evidence:** the second report read native source and live Active/finished
  observations; lead supplied direct browser assertions, exact manifest verification
  and the 138 passing backend cases (one Windows symlink capability skip). Report
  recommendations were triaged separately from verified failures. Its claim-binding
  gap prompted CA-ISSUE-019 and a reviewed fix; no incomplete report was accepted.

### CA-ISSUE-019 — Observer does not compare current event and trace claim keys

- **Kind / status:** audit gap / closed at `4b00df6`.
- **Observed:** Mimir source review found that node/attempt/epoch were validated,
  but the current `attempt_started` event's claim key was not compared with the
  trace's claim key. Existing live evidence agreed; this was a missing invariant,
  not an observed live identity conflict.
- **Fix:** compare current-attempt start keys and refuse conflicts, retain older
  attempt history separately, expose matched/unavailable claim linkage and bounded
  stop facts in the AI metadata. The policy explicitly limits source-reported trace
  integrity and does not claim manifest verification or actor authentication.
- **Owner / task:** Codex lead, within Mimir task
  `efb428c9-5e44-5326-b856-0909efed76e1`. Its report and corrections are retained at
  `D:/hekate-coordinator/runs/role-review-002/`.
- **Closure evidence:** three additional independent cases, 109 total selected tests,
  format/lint checks, and the native live observer's matched claim key. A historical
  attempt does not bind the current claim; stop reason text is excluded from AI.

### CA-ISSUE-020 — Cancelled tasks lose historical traces in shared observation

- **Kind / status:** defect / closed at `9d408b9`; failure rehearsal fix verified.
- **Observed:** native cancellation clears the node's current attempt ID. The
  observer then returned no trace, even though the human viewer could select the
  failed attempt through its event history. Seven cancelled fault cases omitted
  their traces from the AI projection; current/historical identities need to stay
  separate. Two independent reproductions fail on the accepted observer source.
- **Expected:** select an explicitly historical recorded attempt when current ID is
  absent, bind its trace and claim to exact node/event/epoch, preserve current work
  and review separately, and show pinned content independently from current content.
  Truncated history and unknown pins remain explicit; liveness stays unknown.
- **Owner / task:** supervised Hermes worker and Codex lead; existing role plan node
  `248e4707-3124-59a2-abf8-0eba1b069fc7`, attempt `observation-history-001-r1`.
  The audit task requires this defect task's accepted artifact before completion.
- **Evidence:** `D:/hekate-coordinator/runs/supervision-audit-002/observer-matrix.json`,
  all native case traces/plan states, and `role-observation-001/history-independent-first.log`.
- **Closure evidence:** 124 selected tests, format/lint/docs checks passed. All eight
  native cases retain matching historical/current identities and trace facts in both
  projections. The browser compared all eight with 51 GETs, no writes/page errors,
  and verified stopped fixtures absent Active. Current and pinned content revisions
  remain distinct. Reviewed source `9d408b9` integrated and accepted at epoch 1.
  Two worker fixtures used an invalid work enum and were corrected without changing
  production validation; failed logs retained.

### Role planning review findings (2026-10-08)

Tracked under Hekate plan `29141a72-9c9a-54f8-a357-fb6db74d84d9`:

- Experimental Mimir returns `passed` on verifier exceptions
  (`Hekate/Odin/langgraph_engine/nodes/mimir.py`). Task
  `83375f7c-8878-5649-9d68-c7a95280ca80` requires unavailable/awaiting-review
  behavior and a regression proving no acceptance. This is an experimental runner
  blocker, not an observed failure of the managed verifier.
- Planning CLI received `--max-turns 24`, but its successful result reports
  `num_turns: 41`. Task `aebbb930-4c66-578a-8a06-335fda70dafd` investigates
  counting semantics and enforcement. Retained launch/stream/result files are in
  `D:/hekate-coordinator/plans/gods-managed-planning-20261008/`; host timeout and
  output limits were not reached. Do not claim the CLI turn limit was proven.
- Experimental graph state is projected into legacy `orchestration.db` with
  best-effort writes. Managed integration task
  `c2fd26d1-4643-561d-9601-6866e3810727` must use PlanStore attempt fences and
  authoritative state, with failed-persistence and duplicate-launch tests.

### CA-ISSUE-021 — Operator evidence exporter selected the wrong repository

- **Kind:** audit evidence defect; closed for the scoped exporter correction.
- **Task:** `2e272c20-db6c-576f-8cb7-73e87311c0ed`.
- **Observed:** the first completion exporter invoked `git rev-parse HEAD` from
  the Hekate Python working directory, attaching Hekate `7fa394f` to the reviewed
  ChatAgent Windows repair. No source change was caused by this metadata error.
- **Correction:** explicit `git -C D:/Git/ChatAgent`, assert expected source commit,
  reject the mistaken decision and reopen an independently reviewed attempt with
  exact `cf9d1a4` source. Original review/decision remain retained. Future exporters
  must bind the intended repository explicitly before publishing an artifact ref.
- **Evidence:** `D:/hekate-coordinator/runs/resolve-both-001/identity-contention/review-artifact-correction.txt`
  and `review-corrected.txt`; PlanStore rejected/accepted decisions at distinct epochs.

### CA-ISSUE-022 — Hidden launch acknowledgement used the virtualenv launcher PID

- **Kind:** dispatch observation defect; closed after corrected live acknowledgement. Task `3764990e-b4ba-530f-91ad-6d107c4571e0`.
- **Observed:** Windows virtualenv `Popen.pid` was 51048 while its runtime interpreter
  was 35124. Native API task was Active and its trace was visible, but acknowledgement
  timed out as `unconfirmed`. Neither timeout nor task state was treated as proof
  that no worker existed; the host did not launch another worker.
- **Repair:** Hekate `24404af` adds a host-generated launch ID; acknowledgement
  requires that ID plus matching native process creation identity and fresh heartbeat,
  and reports runtime/launcher PIDs separately. No authentication claim is made.
- **Evidence:** `D:/hekate-coordinator/runs/resolve-both-001/execution-gap/background-launch.log`,
  `app-active-browser.json`, native owner status and independent wrapper-PID regression.

Corrected native launch reported `launched:true`, runtime PID 76996, launcher PID
55704 and launch ID `f67884194f5e425c99bd15bb5f16af2a`; status is explicitly
`blocked/spec_pending` for `plan-status-ui` with an advancing heartbeat. The first
shared launcher log path was reused; its `unconfirmed` result is reconstructed from
the preserved tool result in `first-launch-result.json`, and native append-only
dispatch events and rejected worker journals remain the execution evidence.

### CA-ISSUE-023 — Full-suite CLI deadline under concurrent verification

Status: open. Hekate task `4187c30e-86f7-5fc5-8ceb-1acb168a4e3f`.
The unchanged saved-delivery CLI test in `tests/unit/evidenceComparison.test.ts`
exceeded its 5-second deadline during the UI reference full suite with concurrent
Python harness verification: 2,504 pass, one timeout, nine existing skips.
Evidence: `D:/hekate-coordinator/runs/ui-prepare-001/reference-full.log`.
The unchanged full suite passes with two workers (2,506 cases, nine existing skips).
The timeout and assertions remain unchanged.
Determine the maintained verification resource/parallelism contract before closing.

### CA-ISSUE-024 — Adapter workspace selection and journal validation gaps

Status: open. Hekate defect `dde302a4-5b05-5663-a050-8d3081f47760`;
preparation `3221839c-1b48-55b8-bb36-c9e425f13d9f` rejected at epoch 1,
correction Active at epoch 2. The candidate passed 189 cases and lint, but sanitized
child environment discarded the explicit trusted workspace selector needed by an
isolated source worktree targeting the existing container label. Canonical matching
source can use its default; this is a configured-worktree binding gap. Journal
validation/replay also accepted incompletely checked task/result fields and loaded
whole files before checking size. Require bounded strict identity/projection/pin
checks and meaningful real-boundary tests. Evidence is retained under external
`launch-adapter-prepare-001` and `002`.

### CA-ISSUE-025 — UI oracle constrains variable spelling

Status: open. Hekate defect `b90a0bbc-c6b3-5977-8334-3f887419bd4c`.
Native UI attempt 1 passed 67 of 68 cases; a static source assertion demanded
literal URL concatenation with a variable named `value`. Attempt 2 repaired that
and passed all checks. Frozen tests remained unchanged during execution. Retain
artifact `7d154a5e54b5e0eb68dfe6efc227824168720b77` and native evidence; verify
the intended URL/method/count property through semantic tests and negative controls
before changing a future oracle. First candidate was never fully verified. Record
this rework separately from product defects and preserve the rejected attempt.

### CA-ISSUE-026 — Stop request can target a replacement dispatcher

Status: closed for the controlled local owner-handoff scope (2026-10-09).
Actual paired product UI delivered an exactly targeted graceful stop to A and
launched B; a delayed exact A packet was retained and ignored while B heartbeat
advanced. Source fencing remains adopted at Hekate10163d9. Evidence is external
conversation-rehearsal-001/rehearsal-preflight.json. Arbitrary filesystem mutation
races remain outside this proof. Previous preparation history follows. Hekate task
`93a81ce6-a7c2-5acb-a135-e2eca3195353`; owner `codex-chatagent`, native repair
assigned to the supervised Mimir worker. The adapter records the observed launch
ID, but its stop command does not pass that identity to the native owner. If owner
A is replaced by B between observation and request handling, the unfenced request
can stop B. The old existence-only stop guard reproduces this in the retained
negative-control test. Expected: a request for A cannot stop B.

Candidate native repair adds `--expected-launch-id`, a target-labelled request and
an owner-side check. It passes 76 focused cases with one Windows symlink capability
skip. A live wrong-owner request was refused `owner_changed` and left the stop file
unchanged. Native source is accepted at `f5a7a6b` and the hidden host has adopted it. A real
foreign-target request was ignored and retained while its heartbeat advanced. The
corrected adapter passes 228 unit cases and the focused HTTP/auth selection; its
unfenced mutation fails a stop assertion. Original bounded-launch task is accepted and integrated at `8ed9e86`, and conversation controls at `49bab0c`. End-to-end adapter stop delivery remains unproved.
Close only after reviewed native integration, adapter identity/response checks,
replacement-owner and graceful-stop verification, and a controlled runtime handoff.
Evidence: `D:/hekate-coordinator/runs/stop-fence-001/`; the candidate's behavior
contract is Hekate plan 053. Preserve all failed and negative-control evidence.

### CA-ISSUE-027 — Launch adapter omits the trusted observer trace root

Status: closed for local product trace-root delivery (2026-10-09). The real
paired maintained product read the accepted native progress artifact and verified
current attempt after its own UI launch, through the actual configured C# API.
Evidence: external conversation-rehearsal-001/rehearsal-preflight.json. Prior
Hekate controls-preparation task
`2ef9442c-3425-5a2b-953c-fc6a18e73207`. Source-reviewed integration gap: maintained
C# `PlanContractEndpoints.Trace` reads `HEKATE_TRACE_ROOT` and refuses an
unconfigured root. Accepted adapter `dc5c501` strips ambient environment, including
that variable, and offers no explicitly approved trace-root input. A host started
through that adapter would therefore lack the viewer setting supplied by the
current lead launcher. Existing live trace proof remains valid under that launcher;
this finding is not a claimed live adapter-launch reproduction.

Require an explicit trusted bounded root containing the configured run roots,
preserve ambient-variable filtering, reject unsafe containment before effects,
and pass only the approved value. Keep legacy direct-adapter configuration behavior
explicit. The new startup-config/controls slice must test the setting and demonstrate
actual trace access after a product launch before closure. Evidence:
`D:/hekate-coordinator/runs/dispatch-native-observation-001/lead-review.txt` and
`conversation-controls-prepare-001/prompt.txt`. The first bounded-launch task remains
accepted within its scoped launch/stop contract; conversation trace integration is
still pending.

### CA-ISSUE-028 — Generated observer helper shadows Python stdlib queue

Status: closed within controls preparation
`2ef9442c-3425-5a2b-953c-fc6a18e73207`. The generated `queue.py` helper shadowed
stdlib `queue` when the adjacent observer imported `psycopg`; the observer failed
before producing its first sample. Its guarded helper read the already-existing
queued task during import; no new task/attempt or worker was created.

The lead renamed the helper to `queue-task.py`, preserving its bytes, and restarted
only the observer from accepted native source. The original failure log is retained;
the corrected monitor records worker PID 62288, exact native birth identity and
matching PlanStore attempt. Worker execution continued throughout. Avoid stdlib
module names for generated helpers and use inert imports/main guards in future
helpers. Evidence: external `conversation-controls-prepare-001/monitor-corrected.log`,
`monitor-launch-defect.txt`, `queue-task.py`, `monitor-restarted.log` and timestamped
`monitor-events.jsonl`. This was supervision tooling, not a product-runtime failure.

### CA-ISSUE-029 — Controls compare a native plan key with a canonical task ID

Status: closed for native GUID/current-attempt correlation (2026-10-09).
Actual paired UI progress matched original node9bc28ff4, current epoch1 and exact
accepted artifact15528e5ac76634220ad4de69bb504350b6f82a8d through the maintained
API. Evidence: conversation-rehearsal-001/rehearsal-preflight.json. Correction is accepted in native controls artifact `5c0ccb5`, integrated at `49bab0c`, following preparation
`2ef9442c-3425-5a2b-953c-fc6a18e73207`. Native owned status records both
`current.node` (the plan key, such as `bounded-plan-launch`) and `current.nodeId`
(the canonical GUID). The accepted host projection retained only the key. Initial
controls preparation compared that key with the plan status panel's task GUID,
while its browser fixture used `n1` for both fields and therefore passed. Actual
native correlation could never match.

Accepted repair preserves optional validated `current.nodeId` separately from the
key, matches only that canonical ID, excludes stale panel correlation and labels
separate observations. A producer test and browser fixture use distinct keys/GUIDs;
substituting the key for the GUID fails the new assertion. This proves node identity,
not current attempt/epoch freshness. Require the native controls/progress task and
real conversation observation before closure. Evidence: external
`conversation-controls-prepare-001/lead-correlation-review.txt`,
`native-metadata.log`, `node-identity-negative.json` and `corrected-browser.log`.

Progress preparation additionally used only `scheme:token` artifact fixtures,
withholding native Git SHA40 identifiers. Its first UI candidate also missed
immediate user/conversation input cleanup and displayed attempt/epoch changes.
These are unaccepted preparation gaps under the same correlation task, not a
regression claim against integrated controls. Require native-shaped artifact
fixtures and held-response input/attempt-change negative controls before freeze.

### CA-ISSUE-030 — Attempt-progress preparation cannot parse

Status: closed (2026-10-09). Corrected preparation epoch2 is accepted; original
native progress node is accepted at15528e5 and integrated atcc84238. Maintained
product public progress passed after actual UI owner launch. First rejected bytes,
failed checks and timeout remain retained. Previous failed preparation follows. Hekate preparation
`b0be34f0-1932-5c20-bfad-9d9d9406885c` epoch1 is rejected; correction epoch2
`attempt-progress-prepare-002-r2` is Active with an actual CLI worker and observer.
The first worker reached its 600-second bound without finishing the browser helper
or behavioral contract. Independent formatting/lint refused an unterminated regular
expression containing literal Unicode line separators. Focused verification had
two import failures and an incorrect synthetic operator principal in its route-policy
test: three test files failed, with six individual cases passing and one failing.
The generated UI syntax test passed; the earlier lead description of that failure
was mistaken. Auth policy remains unchanged.

Expected: supported source and emitted scripts parse, meaningful unit/HTTP/browser
checks pass, and the reference package is independently verified before native
execution. Preserve exact failed source bundle
`preparation:sha256:823c074443a40087d88bbff8572180c2b59402d4c231679fd3b534fd3ca11406`,
worker exit, checks and review findings under external
`attempt-progress-prepare-001`. No accepted product source was changed by this
failure. The 600-second timeout is an operational bound, not a model-speed SLO.

### CA-ISSUE-031 — Maintained startup omits attempt progress

Status: closed (2026-10-09). Maintained startup forwarding and the strict
51-route authorization inventory are integrated atcc84238. Real configured
startServer and paired browser exercised the actual C# collector and public
progress after UI launch; startup defaults remain disabled without plan API.
Evidence: conversation-rehearsal-001/rehearsal-preflight.json. Previous progress preparation task
`b0be34f0-1932-5c20-bfad-9d9d9406885c` epoch2. Direct test-server fixtures enabled
the new progress option, but maintained `startServer` did not forward it. The
assembled-startup regression reproduced a missing panel before any progress request;
the source remains unaccepted preparation, not a regression against integrated controls.

Require trusted configured plan-API startup to expose the operator-only panel and
real collector route, while an unconfigured startup stays disabled. The new tests
use actual startup/auth/collector and only fixture loopback Hekate responses; no
model or dispatcher runs. Evidence: external
`attempt-progress-prepare-002/startup-unwired-negative.log`. Keep open until the
corrected startup is verified, integrated and exercised with the live product API.
The first reference package remained unpinned after its full suite passed 2,848
cases, skipped ten explicit cases and failed the existing 50-route inventory.
Its correction adds the new operator-only GET to that strict inventory and checks
all 51 routes exactly once, including client/operator authorization; it does not
relax or skip the assertion. Preserve authoring `attempt-progress-view-001` and
prepare a new immutable package before execution.

### CA-ISSUE-032 — Unconfirmed launch loses recovery identity

Status: closed for retained unconfirmed launch identity and exact-exit recovery
(2026-10-09). Hekate taskd95f8f72-e281-5233-9556-1f0852bfeffe is accepted at
repair bundle56168a2e, with exact ChatAgent06d0269/Hekate10163d9 integrated and
adopted. Actual forced one-second UI launch retained C identity; a fenced CLI stop
and exact exited C status automatically reconciled its uncertain record before
UI replacement D, preserving the original result and using no inspection override.
The same browser correctly blocked mutations during uncertainty. Evidence:
conversation-rehearsal-001/unconfirmed-recovery.json. Original reproduction follows. Native owner
A started after the confirmation window, but the native unconfirmed response omitted
its allocated launch ID and the adapter discarded IDs on that outcome. After an
exactly fenced clean stop, a replacement was refused with
`PREVIOUS_LAUNCH_UNCERTAIN`. The conservative refusal is correct; the lost
identity prevents the existing exact-exited-owner recovery path.

The historical uncertain record was resolved through the supported
`operator_inspected` journal field only after inspecting the retained single UI
launch, observed owner birth/launch, exact stop packet/receipt, clean exited status
and absent process. Its original uncertain result is unchanged, with before/after
hashes and inspection evidence retained outside Git. The real UI then launched B;
duplicate start was refused and a delayed exact A packet was ignored and retained
while B's heartbeat advanced. This does not establish an arbitrary filesystem race.

An actual Hekate repair task now requires the native unconfirmed response to include
its allocated launch ID and the adapter to validate and retain it without claiming
successful startup. Automatic reconciliation must remain limited to the exact
matching exited native owner. Missing, malformed or foreign IDs remain blocked.
Evidence: external `conversation-rehearsal-001/operator-inspection.json`,
`rehearsal-preflight.json` and `launch-identity-repair-001`.

### CA-ISSUE-033 — Prepared UI launch omits the required dependency cache

Status: closed for trusted cache forwarding (2026-10-09). Actual repair task
`7ec9091d-4248-5c73-a447-52ed423508ab` accepted artifact `117337f`, integrated
at `6e97ebb`; the real UI-created owner subsequently claimed and ran prepared
work. The final task is now accepted at epoch 4. Original reproduction: The UI-created
owner D attempted the ready package but refused preflight with
npm_cache_required, before any claim or worker launch. The adapter's restricted
child environment drops the maintained task runner's explicit warm-cache setting.
A running host and successful status-only launch proof did not test this execution
prerequisite. The failed owner exited cleanly, and its immutable plan-run6,
task preflight, binding and journal remain retained under application-native-001.

Require an optional absolute operator-owned npmCacheDir in the trusted startup
configuration, forwarded only as npm_config_cache. Never inherit ambient npm
configuration, registry/proxy credentials or a request-supplied path. The native
task runner retains its directory validation and offline dependency checks before claim; no default guess
or download bypass is allowed. The actual Hekate CLI repair is accepted and integrated.
The existing genuine reliability backlog now owns the sole API in the same retained
store during repair. Afterwards perform a controlled ready-plan handoff with new
state/run-root, preserving all original task IDs, six accepted predecessors and
the refused attempt evidence; prove useful prepared work from the real product UI.

### CA-ISSUE-034 — Generated runbook conflates configuration layers

Status: closed for reviewed operator facts (2026-10-09). Accepted Mimir task
`b52068c6-649f-5804-b42a-47064e804987`, artifact `9d87850`, supplied the reviewed
facts prefix, applied separately after exact accepted native artifact `0d18529`
was merged. The lead delivery checklist and stronger prefix contract are separately
attributed; package 004 was never pinned or executed. Original lead review of native
final candidate5b65cda26fe15073d98a3ab1245348214b19d9c9
found factual gaps that the keyword/format oracle does not detect. The draft labels
Node/npm/Git TaskSpec pins as dispatch-host configuration, omits the launcher's
Python and maintained-source hash distinction, says approved cache reaches the
worker rather than native preparation, and understates the armed finite poll loop.
The actual runtime is unchanged; this is operator documentation accuracy.

An actual Mimir correction task derives from that exact native artifact and edits
only the runbook. Require correct launcher versus prepared-task pin descriptions,
manual page actions versus finite native polling/dispatch, preserved credential
exclusions and unknown/stop semantics, and no duplicated session-result narrative.
Native automatic acceptance is separate from lead source review and integration.
Integrate only after native verification and this exact independently reviewed
correction both pass. Evidence: external runbook-facts-repair-001 and
ready-rehearsal-native-observation-002. No oracle was weakened to hide the gap.

### CA-ISSUE-035 — Observer rejects a valid large native trace record

Status: closed for bounded native-record compatibility (2026-10-09). Actual repair
task `523cb7d0-782b-5b6f-b5ee-c5deba3becc0`, artifact `3a0aa32`, is integrated
at `d749b1a`. The retained 125334-character private record now validates through
the real API and remains absent from public activity; the final native real-product
verifier passes. Total bytes, pages, deadlines, claim checks and privacy projection
remain bounded. Broader verifier-availability retry routing remains recovery work.
Original reproduction through the actual maintained API:
Original final task21dcea12 native rounds1/2 passed source/full gates but the real
product progress verifier failed. Both rejected attempts are retained; no extra
original model round is launched against those inputs. A real API200 recordseq12
in r2 has125334 UTF16 characters, cutfalse. The consumer's undocumented65536
character schema cap rejects it as INVALID_RESPONSE. Native AttemptTrace instead
uses a4MiB serialized response budget; ChatAgent already enforces its own4MiB
streamed observation budget. A large private tool-result record must not make the
entire legitimate attempt unavailable.

An actual Hekate repair task aligns supported record/prompt field bounds with that
whole-observation budget while preserving shape/type/sequence/identity checks,
page/deadline bounds and public privacy projection. Require >64KiB valid-record
and private-envelope tests, unchanged total-budget refusals, old-source negative
and real retained-trace readback. Exact source/schema diagnostic contains only
metadata, hashes, field lengths and validation paths, never worker payload.
Evidence: ready-plan-handoff-001/observer-schema-diagnostic.json,
application-ready-native-001/integrated-rehearsal/pilot-3abd5bd5a497 and
trace-record-repair-001. Upstream observation failure is a verifier-availability
problem, not evidence that rewriting the worker's Markdown will fix it. Broader
availability-aware retry routing belongs in the recovery follow-up.

### CA-ISSUE-036 — Lead preparation wrapper hides failed pinning

- **Kind / status:** orchestration defect / corrected locally; no product-runtime
  change (2026-10-09).
- **Observed:** the preparation wrapper wrote child exit 1 to retained evidence but
  itself returned 0. Subsequent stop/launch operations proceeded after package 004
  pinning failed. The native guard correctly refuses `pin_spec` for previously
  attempted tasks, even after release to TODO. Final acceptance actually used
  package 003, content revision 3, epoch 4; it is not package 004 evidence.
- **Expected:** failed prerequisite commands stop dependent operations. Inspect
  both exit status and exact pin readback before changing ownership or launching.
  Revisions after attempted work must use supported content/state CAS; do not
  weaken the native initial-pin guard.
- **Resolution / owner:** lead wrapper now propagates nonzero child exits, and a
  deliberate failing-child check verifies that behavior. Retain original wrapper,
  failed pin log and accepted task's exact package identities. No additional model
  retry is required to relabel the completed run.
- **Evidence:** external `conversation-rehearsal-prepare-001/pin-v4-exit.json`,
  `rehearsal-rework-001/lead-integration-review.json` and
  `rehearsal-rework-001/fail-closed-wrapper-negative.json`.

### CA-ISSUE-037 — Observer rejects valid null empty event history

Status: closed for nullable event-history compatibility (2026-10-09). Actual
paired product reads untouched existing task e5a948bc at TODO/epoch0 with current
consistency, no selected attempt, trace or activity, and no mutation. The real
observer preserves the valid null marker. Combined main verification passes
2,896 cases, with one explicit Windows capability skip. Evidence:
empty-history-repair-001/live-ui-proof.json and live-input-readback.json. Actual Hekate
repair task `f35dca33-4e1e-5819-ac95-997429e542c6`, source `9522ea8`, aligns the
observer with the maintained C# EventPage nullable first-record marker. Independent
review passed 106 focused cases, lint, formatting and documentation checks; exact
old source failed three new behavioral cases and was restored. One worker test
expected INVALID_RESPONSE for a float; strict JSON correctly returns INVALID_NUMBER,
and lead review corrected that specific expectation without changing runtime behavior.

Reproduction: the untouched recovery backlog task af690ee2 returns API200 with
empty events, nextAfterSeq null, historyStartsAtSeq null and historyBackfilled false.
Its plan validates, but the numeric-only event schema returns INVALID_RESPONSE.
Expected: preserve null as no recorded history/unknown earlier history, not seq0 or
proof of complete history or worker startup. Numeric/type, sequence, cross-page
metadata stability, total byte/page/deadline and privacy checks remain intact.
Evidence: external recovery-planning-001/backlog-schema-diagnostic.json and
empty-history-repair-001/negative-proof.json, reviewed-bundle.json and live-ui-proof.json.

### CA-ISSUE-038 — Checkpoint turn budgets lack an auditable counter

- **Observed / priority:** P1 checkpoint-management audit defect. The supervised
  recovery CLI was configured with `--max-turns 60`; its successful result reports
  `num_turns: 97`. The planning CLI configured at 24 reports 22. Streaming assistant
  record counts and distinct message IDs also differ. These observations do not
  establish whether the provider limit failed or uses another unit, but a management
  layer cannot treat these numbers as interchangeable verified hard-budget evidence.
- **Expected:** define the counter and source for each expected/hard budget, enforce
  the selected tripwire against attributable current execution, and emit a typed
  receipt with the exact attempt, budget unit and consumed count. Missing counters
  remain unavailable; wall time, messages, tool calls and model turns are distinct.
- **Reproduce / evidence:** compare retained `recovery-assessment-001/launch.json`
  and result metadata (no worker text) against `exit.json`; metadata-only extraction
  is retained in `executive-mvp-001/turn-counter-assessment.json`.
- **Owner / task:** codex-chatagent; real Hekate checkpoint execution task
  `94438651-ed00-5656-803d-d6097d4a4e40`, gated after live executive MVP delivery.
  It must produce maintained enforcement/observability, not only a private script.
- **Resolution / scoped closure:** accepted maintained enforcement `ff9230d`,
  integrated at `6f9f288`, defines `assistant_message_ids_distinct/v1` and enforces
  unit, monotonic wall, combined output and uncertain-counter tripwires against its
  owned worker. Meaningful tests stop actual fixture trees, deduplicate IDs and
  retain typed exact-claim receipts; unavailable authority never implies source
  failure. A real CLI run records two IDs and a clean exit in 17.924 seconds;
  paired maintained UI shows current budget and lead-supplied exact gate inline.
  Evidence: `checkpoint-execution-001/reviewed-bundle.json`,
  `checkpoint-maintained-smoke-001/maintained-run-proof.json` and
  `maintained-ui-proof.json`. 3,183 full cases pass with ten explicit capability
  skips. This closes the undefined/unverified management-counter defect, not the
  provider's undocumented turn semantics, authenticated telemetry, automatic
  escalation delivery, unattended supervision or CA-ISSUE-004. Provider counters
  and costs remain labelled unverified. Bounds are not performance SLOs.

### CA-ISSUE-039 — Generated executive source fails syntax/type gate

- **Observed:** Hermes candidate `3811486` contains actual Unicode line separators
  in two regex literals. Prettier and TypeScript transformation refuse them, so five
  focused suites cannot load. After syntax repair, the compiler also finds an
  unreachable `stale` branch; two test fixtures incorrectly use an all-numeric GUID
  as an uppercase rejection case and omit the HTML's initial note from a fake DOM.
- **Expected:** the source parses and type-checks; acceptance cases exercise real
  uppercase hex letters and the actual initial markup without weakening assertions.
- **Owner / real task:** codex-chatagent, non-model operator repair task
  `07e83553-b777-5c47-b8bd-2a119410cb7d`. The original model proposal and failed gate
  evidence are retained; there was no whole-feature model retry.
- **Resolution:** accepted repair `61308a3` changes seven lines, preserving behavior
  and correcting the fixtures. It passes 139 focused cases and lint; the browser gate
  passes eight cases. The final MVP artifact `98acbb0` integrates at `a52c1d5` with
  3,108 full cases passing and ten explicit worktree capability skips.
- **Evidence:** `executive-mvp-implementation-001/gate-format-exit.json`,
  `gate-focused-exit.json`; `executive-source-repair-001/reviewed-bundle.json` and
  `accepted-readback.json`. Closure is for this specific generated candidate's source
  and fixture repairs, not a claim that future generated source cannot fail a gate.

### CA-ISSUE-040 — Executive evidence selection and decision linkage are insufficiently fenced

- **Observed:** source `61308a3` passes the worker's focused/browser gates but three
  independent behavioral cases fail. A conflicting selected attempt can be displayed
  as current despite the task-envelope fence; the evidence pane does not label the
  decision's linkage to the current attempt, epoch, content and artifact.
- **Expected:** refuse contradictory current selection and historical selection
  attached to a current task. Classify a current decision only when selected scope,
  work/effective acceptance, attempt/epoch/content and artifact identities agree.
  Historical or unmatched linkage is explicit; missing selected evidence cannot
  erase a recorded task claim.
- **Owner / real task:** codex-chatagent, non-model operator audit repair task
  `8338ca01-6e69-5967-bac0-383bb826c01f`.
- **Resolution:** accepted final source `98acbb0`, integrated at `a52c1d5`; three
  retained old-source negative cases now pass. The focused gate passes 142 cases,
  eight browser cases pass, and the full artifact gate passes 3,108 with ten explicit
  worktree capability skips. Actual paired candidate and maintained product UI verify
  the original native task's exact accepted artifact, current linkage and trace
  integrity inline, with no navigation or development mutation/load-time execution.
- **Evidence:** `executive-evidence-repair-001/negative-current-evidence-exit.json`,
  `reviewed-bundle.json`; `executive-mvp-live-001/native-inline-proof.json`,
  `maintained-inline-proof.json` and `delivery-bundle.json`.

### CA-ISSUE-041 — Checkpoint launch profile, duplicate-start fence and cleanup gate gaps

- **Observed / priority:** P1 acceptance blocker in candidate `ff00e94`. The fixed
  profile omitted confirmed restricted/noninteractive/empty-MCP/no-session/no-slash
  flags; prompt reads allocated an unbounded file; final cleanup could precede owned
  termination. A different run ID could start another worker against the same claim.
  Two meaningful fixtures also failed (last-good stale display and Windows teardown).
- **Expected:** confirmed fixed tool scope, bounded regular prompt, monotonic worker
  wall clock, awaited owned cleanup with uncertainty retained, exclusive attempt
  lease in the configured namespace, and tests aligned with actual stale behavior.
- **Owner / real task:** explicit non-model operator repair
  `9354466c-f0bc-5a10-aba3-4440abc7d94c`. No whole-feature model retry.
- **Resolution:** accepted `015fae3`; independent old-source profile and duplicate
  run negatives now pass, with 132 focused checks plus format/lint/docs. Rework needs
  a new fenced attempt; changing/deleting the fixed namespace is operator recovery,
  not a cross-namespace global lock. Final source `ff9230d` is integrated at `6f9f288`.
- **Evidence:** `checkpoint-gate-repair-001/negative-profile-exit.json`,
  `negative-second-run-exit.json`, `reviewed-bundle.json`, `accepted-readback.json`.

### CA-ISSUE-042 — Generic gate failures imply source cause and valid monetary tokens are rejected

- **Observed / priority:** P1 audit defect in `015fae3`. Any failed check without an
  unavailable check derived `source_failed`, without establishing cause. The local
  parser also refused valid integral decimals in provider cost/cap fields (1.0/5.0).
- **Expected:** failures remain `partial`/unattributed until explicit lead source
  attribution plus retained evidence; unavailable verification cannot be a clean
  source verdict. Admit finite monetary representations without relaxing strict
  integer identity/budget tokens or the shared PlanStore parser.
- **Owner / real task:** explicit non-model operator repair
  `78d510d4-911f-52cc-aa7f-6c671dbe516d`.
- **Resolution:** accepted `ff9230d`, integrated `6f9f288`. Two independent old-source
  regression cases now pass; closed schema and inline validator use the same outcome
  contract. Supplied evidence remains unauthenticated, with no automated retry or
  acceptance. 146 focused cases, eight browser cases and 3,183 full cases pass,
  with ten explicit capability skips; format/lint/docs pass.
- **Evidence:** `checkpoint-causality-repair-001/negative-causality-source-exit.json`,
  `reviewed-bundle.json`, `accepted-readback.json` and maintained delivery evidence
  under `checkpoint-maintained-smoke-001`.

### CA-ISSUE-043 — Checkpoint attention evidence and publication gates are incomplete

- **Observed / priority:** P1 acceptance blocker in candidate `4d3d65f`. A raw
  backtick in a generated script comment prevents parsing. After the syntax fix
  and separate pinned formatting (`229fe4b`, `2bb03bc`), five independent cases
  fail: stale stop/state/PID linkage still offers detail, cleanup plus unavailable
  verification is rejected, passed/historical gates can offer verification detail,
  late temporary-file sync can still publish, and an impossible response cap can
  return oversized JSON.
- **Expected:** in-place controls must match current record and gate evidence;
  cleanup and verifier outage can coexist without cause attribution. Refuse an
  envelope that cannot fit. Recheck the monotonic deadline immediately before
  atomic no-overwrite publication and retain late-I/O cleanup limitations.
- **Owner / real task:** explicit non-model operator repair
  `118fbf75-04e0-50fd-9dcf-e5170f618109`; no whole-feature model retry.
- **Resolution / scope:** accepted repair `17ebec2`; all five regression cases now
  pass, with 136 focused cases, nine browser cases, format/lint/docs checks and real
  candidate attention drill-down/local handoff proof. Whole feature `17ebec2` is accepted and integrated at `2b4289e` after a fresh
  full gate passed 3,230 with ten explicit capability skips. The prior CA-ISSUE-014
  host failure remains preserved and open; maintained paired UI and local handoff
  delivery are independently accepted.
- **Evidence:** `checkpoint-recovery-implementation-001/gate-lint-exit.json`,
  `gate-focused-exit.json`; `checkpoint-attention-repair-001/negative-evidence-deadline-cap-exit.json`,
  `reviewed-bundle.json`; `checkpoint-attention-live-001/candidate-ui-proof.json`,
  `handoff-live-proof.json`. Failed source and gates are retained.

### CA-ISSUE-044 — Checkpoint ledger deadline and ownership publication gates are incomplete

- **Observed / priority:** P1 acceptance blocker in generated candidate `5a5f8ec`.
  Four independent negative cases show a pending manifest read has no wait bound,
  elapsed manifest loading receives a fresh evaluation budget, a replaced lock
  still publishes over the original ledger, and a ready projection with unmet
  gates is reported ready. The original failing history fixture advanced a
  heartbeat-free running record by two hours: overdue was correct; the fixture
  now uses times within its declared wall bound.
- **Expected:** share the CLI deadline across manifest loading and observation;
  refuse observed loss of lock ownership before publication and preserve original
  bytes; show unmet dependency gates as blocked. Late I/O cleanup remains bounded
  by settlement; no automatic takeover, dispatch, retry or acceptance.
- **Owner / task:** explicit operator repair recorded in
  `7b61f2c8-1291-5eed-93de-400ee8a126f0`, recorded in
  `checkpoint-review-ledger-001/repair-start-readback.json`.
- **Resolution:** four independent negatives now pass; 62 focused cases, full
  suite 3,263 passes with ten explicit skips, pinned format/lint/docs checks,
  actual retained-store CLI evaluation and fresh-process show, and real paired
  review-state/fence proof pass. Acceptance receipts remain external. Completed
  PlanStore artifacts cannot be amended: final source completion uses a separate
  explicit operator attempt, preserving the model proposal and its old fence.
  No model retry was run.
- **Evidence:** retained raw candidate, `gate-focused-exit.json`,
  `negative-independent-exit.json` (four failures, 28 passes) and separate
  formatting-only commit `1a3f1f4` under `checkpoint-review-ledger-001`.

### CA-ISSUE-046 — Continuation authority and publication checks are incomplete

- **Observed / priority:** P1 acceptance blocker in candidate `66d7d0e`.
  Three independently prepared subprocess cases fail: changed dependency gates
  and changed upstream authority after worker exit still create a candidate and
  finish it; a changed executor on finish confirmation still receives checks and
  a gate. Existing process tests also contain two fixture errors: a preserved
  preexisting gate is asserted absent and cleanup kills an already-exited child.
- **Expected:** recheck current task, executor, dependency gates and upstream
  authority before snapshot/finish and after finish; stop before later phases on
  any mismatch. Check deadline and cooperative lease immediately before record
  and gate publication, after awaited preparation. Preserve ambiguous effects,
  old evidence and fixed commands; never replay a finish or auto-accept.
- **Owner / real task:** Hermes repair `d2284986-61fc-5433-a66f-3dd41d17c5c8`,
  `checkpoint-continuation-repair-001-r1`, epoch 1, ended cleanly after 125.033 seconds and 13 distinct message IDs
  within its five-minute/30-message hard bounds. Original implementation is completed and rejected;
  its ended worker budget and exact candidate are preserved.
- **Evidence:** `checkpoint-continuation-implementation-001/independent-negative-oldsource-exit.json`
  (three failures), `candidate-focus-r3-exit.json` (33 passed, two fixture
  failures), `rejected-readback.json`; repair `start-readback.json` and budget
  under `checkpoint-continuation-repair-001`.
- **Resolution:** exact repair `7aa55f5` is accepted after all 38 focused
  cases, 3,301 full-suite cases with ten existing skips, format/type/docs checks
  and independent source review. The first full-suite gate failed because the
  lead launcher omitted PowerShell from PATH; the unchanged candidate passed
  after that harness correction. That failed gate and diagnosis remain retained.
  Whole-feature delivery is independently verified and accepted at operator
  epoch 2/content 3, source `7aa55f5`, integrated `69ce8f3`. The toy proof
  source is excluded from integration. Persistent supervision remains separate.

### CA-ISSUE-045 — Export file identity cannot detect a same-inode replacement on Linux

- **Kind:** gap.
- **Observed:** `readExport` records each listed file as device plus inode and
  `readBounded` refuses an opened file whose identity differs. On the Linux CI
  runner and in a Node 24.21.0 container, the unit case that unlinks and recreates
  `policy.json` with identical bytes between listing and reading composes with
  exit 0: ext4 and overlayfs hand the freed inode straight back, so the replacement
  carries the listed identity. Windows assigns a new file identity and refuses it.
- **Expected:** a file replaced after listing is refused on every platform, or the
  window is removed by opening each listed file once and reading from that
  descriptor, with no second lookup by path.
- **Owner / task:** unassigned. The case runs on Windows only
  (`tests/unit/handoffCliPublish.test.ts`) until the identity or the read path
  changes; the skip names this issue.
- **Resolution:** open.
- **Evidence:** Verify run on `3b0d160` (ubuntu job, `handoffCliPublish`), and
  the same failure reproduced in a `node:24.21.0` container on 2026-10-09.

### CA-ISSUE-047 — Phase visibility fixtures and contract claims fail independent gates

- **Observed:** finite continuation candidate `becf03a` finished its exact Hekate
  attempt, then independently failed Prettier, TypeScript and focused Vitest.
  Its durable phase is `needs_operator`; clean worker exit is not acceptance.
- **Attribution:** type failure TS2783 is a duplicate `phase` fixture property;
  the one focused assertion failure checks the entire overview for a base SHA
  that the existing budget contract intentionally exposes. The new continuation
  privacy boundary needs its own assertion, preserving whole-response path and
  output-hash checks. Doc24 also contradicts its reserved/missing-budget case
  and overstates closed validation of legacy overview fields.
- **Repair:** explicit operator task corrects those fixtures/claims. Formatting
  stays in its own commit. Production execution semantics stay unchanged;
  record readers and UI behavior still require focused/full/browser checks.
- **Independent source recurrence:** a same-run continuation with a contradictory
  `baseRef` was still presented as current. The external negative reproduces this
  in `independent-base-negative`; the reader now requires source-base agreement
  with its matched budget record and reports `stale_source` otherwise.
- **Full-gate harness recurrence:** one existing test grouped eight real-worktree
  refusal scenarios under a shared five-second timeout. It timed out in both the
  full run and a focused reproduction. Cases now retain their refusal/no-worker
  assertions with separate test budgets; no production bound or global test
  timeout is increased. The initial 3,368-pass/one-timeout run is preserved.
- **Acceptance:** the original epoch 1 remains rejected with its raw commit,
  budget and automatic gate. Only a new explicit delivery attempt can accept the
  repaired artifact after external checks and real paired same-page UI proof.
- **Evidence:** `checkpoint-phase-implementation-001/candidate-defects.json`,
  original continuation/gate records, `rejected-readback.json` and repair receipts.

Status: closed for this phase-view increment. Actual operator repair and original
feature delivery epoch 2 are accepted at `94e2488`. Final source requires matched
budget/continuation bases; all eight refusal cases have separate test budgets.
External checks pass **3,376 full cases** with ten capability skips, ten browser
cases, lint/docs and real paired same-page phase proof. Original Claude epoch 1,
its automatic failed checks, source negative and first full timeout remain history.
CA-ISSUE-004 unattended supervision is separate and remains open.

### CA-ISSUE-048 — Bounded checkpoint queue candidate cannot complete and has admission, review, slot and stop gaps

- **Observed / priority:** P1 acceptance blocker. Candidate `13598a97c30a759638aee11cfb5e9b67e8eca209`
  of the bounded checkpoint queue service is rejected. Its raw gate failed Prettier,
  passed TypeScript and failed focused Vitest: 29 passed and 4 failed, where the
  success, duplicate-owner, resume and graceful-stop success paths each expected exit
  0 and received 4.
- **Defects:**
  1. Final completion: the last acceptance committed `index == items.length` while the
     phase stayed `running`; the record schema correctly requires `completed` exactly
     then, so serialization threw `RECORD_INVALID` and completion never succeeded.
  2. Conservative cap: `providerCapMicros` applied `toPrecision(12)` before the ceiling,
     so USD 5.0000000000001 admitted 5,000,000 micros instead of 5,000,001.
  3. Historical review: a current `review_pending` leaf at the exact source and fence
     with an older attempt's decision (`acceptanceHistorical`) was treated as moved and
     ended the wait.
  4. Fresh run slot: the pre-start check omitted the unchanged runner's
     `.claim-<key>.lease`.
  5. Stop boundary: the stop sentinel was checked only before the long authority and
     source preflight, not again before the durable start intent.
- **Expected:** publish the final acceptance, `completed` and `all_accepted` as one
  record with a single terminal transition; never round declared worst-case admission
  down; keep waiting on an exact current pending review while an older decision can
  never grant acceptance; refuse a fresh start when the runner claim lease exists
  without removing it; recheck stop, wall and signal after preflight and before the
  intent. No atomic filesystem-to-HTTP guarantee is claimed for the stop boundary.
- **Owner / real task:** Hermes repair `6001b7b8-2556-51a7-96eb-b05f5d0cf70d`,
  with independent Codex source review and operator finalization. Whole-feature
  task: `f61d7c6e-6bd3-5c9b-979c-12f449863c9f`.
- **Resolution / evidence:** functional repair `a1e6c2` and separate formatting
  commit `de518fc` fix all five gaps. Six regression assertions fail on unchanged
  original production source. TypeScript, focused cases, the full suite (3,413
  passes / ten explicit skips), lint and documentation checks pass. The real
  retained-store two-worker proof completes in one invocation with one terminal
  publication, one start/finish/acceptance per task and A acceptance before B start.
  Independent lead review checks exact artifact bytes and disjoint scope; unrelated
  task nodes remain unchanged. Evidence: `cleanup-loop-001/queue-reviewed-bundle.json`
  and `queue-live-001/reviewed-proof.json`.
- **Status:** closed for this bounded queue scope. Original rejected candidate,
  failed gates and model counters remain history. Operator finalization is a new
  attempt rather than a relabelled model run. No atomic filesystem-to-HTTP stop
  guarantee, authenticated actor or power-loss durability claim is added.
  CA-ISSUE-004 (independent wake, delivery, unattended recovery) remains open.

### CA-ISSUE-049 — Formatter planning contradictions

- **Observed:** proposal `0a7643e` forbids required root config/package files and
  claims unsupported-file success while leaving the independent Prettier check
  over unsupported paths. Its broad UI schema expansion also exceeds the runtime MVP.
- **Resolution:** rejected original task/queue retained. Repair `66fea48` allows
  pinned required root files, uses the same eligible set and pinned flags for opt-in
  write/check, retains legacy behavior, and defers UI enrichment. Lead `18bde4d`
  clarifies no-op raw=final and requires the two failure-reason enum additions.
- **Status:** closed for contract review only. The runtime is an implementation
  candidate (task `2c9aa7ef-c42a-5927-9212-24edb08ed585`) under external verification
  and lead review; it is not accepted, pushed or live-proved.
  Real repair task: `313f2fab-8f89-523c-b746-22f9c5361e23`.
  Evidence: `cleanup-loop-001/format-plan-001/lead-rejection.json`,
  `format-plan-repair-001/lead-review.json` and exact finalization receipts.

### CA-ISSUE-050 — Hosted Windows CI failures hidden by advisory job

- **Observed:** workflow `38011515598` reports success for `c7402cc`, while
  `windows-tests` job `114092355915` fails 38 cases. Thirty-six identity/privacy cases
  supplied `RUNNER~1` temp aliases that differ from the canonical path, which the
  existing privacy guard rejects; two continuation refusal tests exceed a shared
  five-second limit across multiple Git fixtures. The required Linux job passes.
- **Expected repair:** use the canonical native temp directory in the hosted CI
  harness; keep production alias/link/privacy refusal unchanged. Split the two
  multi-fixture tests into independently bounded cases retaining exact refusal and
  zero-worker assertions. Make Windows CI required and prove both real jobs green.
  Do not repair fixture ACLs to hide a guard failure, skip failures or widen global
  test timeouts.
- **Status / owner:** closed for this harness repair only. Verified and accepted at
  operator epoch 2, source `26169e321cf0446889ea48797374e74cb3f81114`, with both real
  hosted jobs successful in run `38012851847`. Windows: 3,414 passes and 13 existing
  host-capability skips; Linux: 3,404 passes and 23 existing platform skips; no skips
  were added. Production privacy is unchanged and the Windows job is now required.
  Bounded Mimir task `2cfc6fba-56bd-510d-a901-1dc39062631e`.
- **Evidence:** `cleanup-loop-001/queue-github-ci.json`,
  `queue-ci-windows-failure.log` and corrected `queue-final-delivery-bundle.json`;
  repair evidence `cleanup-loop-001/windows-ci-001/reviewed-delivery.json` and
  `hosted-ci.json`. The initial workflow-only success classification is retained
  separately.

### CA-ISSUE-051 — Operator source mutation overlapped independent verification

- **Observed:** operator workflow commit `db87e93` at 01:18:36 UTC preceded the
  terminal verification of worker candidate `9d6ac40` at 01:18:53 UTC. All three
  independent checks passed, but the final source guard correctly stopped with
  `source_changed` and withheld the gate. This is an operator sequencing defect,
  not a worker source failure.
- **Immediate handling:** preserve the old candidate, counters and invalidated
  gate; use an explicitly fenced operator attempt for the complete workflow source
  and real CI. Wait for terminal verification before later source mutations.
- **Next guard / status:** open, task `4071b736-67ef-5f87-b180-d357356d15b5`: freeze and verify a
  cooperative operator handoff that refuses nonterminal or stale verification and
  requires current ownership/source fences. No global filesystem lock or automatic
  gate adoption is claimed. Do not call the product guard defective for refusing
  the changed source.
- **Evidence:** `cleanup-loop-001/windows-ci-001/operator-ordering-defect.json`
  and original continuation record. A second operator sequencing failure treated a
  yielded Git invocation as completed and raced the index lock; readback confirmed
  the isolated integration copy stayed clean before the sequential owner repaired
  ordering. Its evidence is `operator-integration-async-defect.json`.
- **Reviewed plan:** [document 29](implementation/29-operator-source-handoff.md)
  requires an actual-invocation in-process completion handle; supplied prior files
  and exit assertions cannot authorize mutation. Completion evidence and the fixed
  mutator are separate checkpoints. Neither the plan nor wrapper acceptance closes
  this defect without the real mutation and retained-store proof.
- **Candidate unit 1 (pending lead acceptance and independent checks):**
  `src/checkpoint/operatorHandoff.ts` adds only the owner wrapper and one-use
  provenance consume. It authorizes no source write; the fenced operator leaf,
  fresh source checks, worktree conflict lease and mutator remain open (unit 2).

### CA-ISSUE-052 — Formatter generation stopped at the hard output budget

- **Observed:** the original formatter generation (36 role IDs, 385.669 s,
  4,259,400 bytes) hit the fixed 4 MiB source budget without a finite candidate,
  finish or gate. The operator preserved, restored and fsck-checked 7 partial files
  at `1e2ead6`. The original task is rejected as incomplete generation, not accepted
  code. The partial source also failed type checking: `ContinuationRecord` still
  aliased the v1 record while the parser returned the v1/v2 union, the state producer
  built v2, and the queue and view readers used v2 fields or passed the union to
  v1-typed consumers. No formatter tests existed. A second generation also stopped
  (37 role IDs, 298.936 s, hard unit budget of 36) at `539af6f` with no finite
  candidate or finish; both raw snapshots are preserved, restored and fsck-checked.
  TypeScript failed on the first partial source and passed on the second; the
  focused run of the second partial source was 163 cases, 160 passing and 3 failing.
- **Diagnosed defects:** two unit tests still used `checkpoint-continuation/v2` as
  the unknown schema although v2 is now supported; one integration test sliced the
  recorded formatter argv (`process.argv.slice(2)`) one index too far. An independent
  source finding showed the pre-`git add` fence checked only that each changed entry
  was a regular file, so bytes appended to an eligible file after the formatter and
  before `git add` could be committed as formatter output.
- **Verified repair:** `ContinuationRecord` is now the union and run-state updates
  narrow on the `schema` literal without casts. The strict v1 wire schema, old
  manifests and v1 output are unchanged. Unknown-schema tests use v3 and keep the
  `unsupported_schema` guards; argv assertions use the corrected indices with the
  same exact lists. The changed files' bigint size, mtime, inode and device are
  captured before the leaf check and `git add` and rechecked after staging; a mismatch
  stops with `scope_violation` before the commit, retaining raw, dirty and index data
  with no POST, gate or rollback. The current claim is re-read immediately before the
  formatter spawn and before the formatting commit. This is cooperative detection, not
  an atomic filesystem lock. A real Git/process regression injects bytes through the
  `fetchStatus` seam, and a second test supersedes the claim after staging. The repair
  passes independent gates at `e0d7aa1`: 3,456 full tests / ten existing skips,
  109 browser cases, lint and documentation checks. The two new assertions fail
  against unchanged older production source `539af6f`.
- **Live proof / status:** closed for this bounded formatter scope. A real model
  worker's raw commit `5f299b0` fails the actual pinned Prettier check; final commit
  `9bdd796` has that raw parent and passes all three checks. The retained store shows
  one start and one finish against only the final artifact, then separate lead
  acceptance. The one-invocation queue completes and the paired UI matches the
  source/gate without navigation or mutations. Final functional candidate `b87fcec`
  is followed by separate formatting commit `e0d7aa1`. Original stopped counters,
  snapshots and failed gates remain history; operator finalization is newly fenced.
  Repair task `8666b9f3-a9c8-5cb0-8c71-37c91cb7f314`; whole feature
  `2c9aa7ef-c42a-5927-9212-24edb08ed585`. Evidence is external under
  `cleanup-loop-001/formatter-live-001` and retained source/check bundles.
  CA-ISSUE-051 (handoff guard) and CA-ISSUE-004 (wake, unattended recovery) remain open.

### CA-ISSUE-053 — Handoff proposal confused supplied exits with owned completion

- **Observed:** proposal `9ab5bfd` passed external checks but allowed a standalone
  mutator to trust an operator-asserted exit and supplied terminal record. Its plain
  `deps.prior` result was also forgeable, and its single commit mixed functional and
  formatting changes. This contradicted its ownership and repository contracts.
- **Disposition:** the lead rejected that exact artifact; its gate and counters
  remain unchanged (11 message IDs, 133.811 s, 368,216 output bytes). A separate
  actual Hekate repair produced `9913adf` (7 IDs, 43.027 s, 128,578 bytes), passed
  external checks and independent semantic review. No runtime is claimed.
- **Repair:** the reviewed contract excludes standalone prior-file adoption, uses
  an owner-created in-process handle, separates raw/format commits and requires
  fresh source, scope, lease and current-claim checks. CA-ISSUE-051 stays open until
  implementation and the live gates pass.
- **Evidence:** `cleanup-loop-001/handoff-contract-002/lead-review.json` and
  `handoff-contract-repair-001/lead-review.json`, plus their preserved records.

### CA-ISSUE-054 — Owner-wrapper test seam failed the TypeScript gate

- **Observed:** candidate `93c21f65d4dda92e71e19172430fed37ec5416f0` failed the external
  TypeScript gate at `tests/integration/operatorHandoff.test.ts` line 36 (TS2322):
  `ContinuationDeps` is not assignable to `Record<string, unknown>` because it has no
  string index signature. Prettier and all focused Vitest runs passed.
- **Repair:** the `vi.hoisted` `seam.deps` is typed as the maintained
  `ContinuationDeps` through an erased import type. No production type or factory
  change, no added production index signature or suppression; module-mock delegation and the
  actual coordinator/process assertions are unchanged.
- **Status:** the original failed gate is preserved and not relabelled. The repair
  passes TypeScript and the full local suite (3,490 passes, ten existing skips),
  lint, formatting and documentation checks. Foundation source delivery still
  requires its exact hosted gates; this does not deliver a mutator or close
  CA-ISSUE-051.
  The narrow model repair hit its 512 KiB output tripwire after editing (3 IDs,
  14.589 s, 613,284 observed bytes, including the final overshooting chunk). All
  three declared edits were byte-preserved, bundled and restore/fsck-verified at
  `9cc3f67`. A separate operator epoch 2 performs verification; it does not inherit
  that model budget or claim a model finish/gate.
  CA-ISSUE-051 and CA-ISSUE-004 remain open.

### CA-ISSUE-055 — Remaining combined refusal fixtures timed out on hosted Windows

- **Observed:** required Windows run `38017847007` at `9f0a88e` failed the
  existing-instance/runner-claim refusal group at its default 5,000 ms. The group
  created an extra fixture for a key and two actual Git fixtures. The existing
  record/budget/gate group also shared that short allowance across three fixtures.
- **Repair:** `dcbd795` uses independent parameterized cases, one actual fixture
  per case and the existing 30-second Git-test allowance. The exact refusal helper
  and all no-worker/no-POST/no-tool/no-new-gate/existing-gate-byte assertions are
  unchanged. No production deadline or skips changed.
- **Gate:** both real required jobs passed at that source in `38019266115` and
  main run `38019994391`. The temporary remote was retired only after exact main
  readback; local source remains preserved.
- **Evidence:** `cleanup-loop-001/windows-lease-refusals-001/hosted-ci.json`,
  `lead-review.json`, `events.json` and `published-main.json`.

### CA-ISSUE-056 — Operator validation launch profile was incomplete

- **Observed:** an npm child resolved refused Node 24.15.0; a 300-second launch
  stopped without a terminal full-suite result; a direct wrapper treated the
  maintained terminator object as a factory; and missing Windows `PATHEXT` caused
  six fixture imports to fail before running their tests. These were operator
  launch errors, not model-source failures. Every failed attempt is preserved.
- **Repair and gate:** direct pinned Node 24.21.0 through the maintained
  `runOwned`, explicit Windows PATH/PATHEXT, a 600-second allowance, 16 MiB
  output ceiling and awaited cleanup. The corrected full run passed 3,490 tests
  with ten existing skips in 316.515 seconds; no timeout, output stop or cleanup
  failure. A separate negative probe proves `where git` fails without PATHEXT and
  succeeds with it. Old runs are not adopted as passes or model budget evidence.
- **Evidence:** `cleanup-loop-001/owner-validation-profile-defect.json` and
  `owner-repair-full-owned-3-exit.json`. CA-ISSUE-051 and CA-ISSUE-004 stay open.
