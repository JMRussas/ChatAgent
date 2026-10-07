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

| ID           | Title                                                         | Kind   | Gate               | Status      | Owner / assignee                   |
| ------------ | ------------------------------------------------------------- | ------ | ------------------ | ----------- | ---------------------------------- |
| CA-ISSUE-001 | Detached buffer escapes the delivery validator as a TypeError | defect | deferred           | closed      | codex-chatagent / claude-chatagent |
| CA-ISSUE-002 | No handoff composition after delivery verification            | gap    | pilot blocker      | closed      | codex-chatagent / claude-chatagent |
| CA-ISSUE-003 | No host slot for the consumer view                            | gap    | pilot blocker      | closed      | codex-chatagent / claude-chatagent |
| CA-ISSUE-004 | No automatic recovery of an idle lead or worker               | gap    | unattended blocker | open        | codex-chatagent / unassigned       |
| CA-ISSUE-008 | No provider-authoritative quota reconciliation                | gap    | deferred           | open        | codex-chatagent / unassigned       |
| CA-ISSUE-009 | Runtime quota-window declarations are not persisted           | gap    | deferred           | open        | codex-chatagent / unassigned       |
| CA-ISSUE-010 | Coordination status shows an older-attempt decision as stale  | gap    | deferred           | closed      | codex-chatagent / claude-chatagent |
| CA-ISSUE-011 | No cross-repo parity check of a handoff view before use       | gap    | pilot blocker      | implemented | codex-chatagent / claude-chatagent |

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
- **Next action:** design within the roadmap step 6 loop. A supervised pilot can run
  without it; unattended operation cannot.
- **Closure criteria:** a stalled lead or worker is detected from recorded evidence
  and resumed or escalated within a stated bound, demonstrated by the proposed
  review-pending handoff acceptance scenario in doc 13; independently verified.

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
  The issue remains implemented until the end-to-end closure criteria below pass.
- **Depends on:** a Hekate pilot export that writes `handoff-expectation.v0` from its
  consumer run with ChatAgent's real H1 (schema proposed in bridge message 1515 and
  acknowledged unchanged by Hekate's implementer in 1524; the export itself is not
  implemented yet).
- **Closure criteria:** a real pilot handoff export, composed by ChatAgent with
  `--expect`, matches; a deliberately altered expectation is refused; independently
  verified.

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
