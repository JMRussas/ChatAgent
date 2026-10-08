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

| ID           | Title                                                         | Kind   | Gate               | Status | Owner / assignee                             |
| ------------ | ------------------------------------------------------------- | ------ | ------------------ | ------ | -------------------------------------------- |
| CA-ISSUE-001 | Detached buffer escapes the delivery validator as a TypeError | defect | deferred           | closed | codex-chatagent / claude-chatagent           |
| CA-ISSUE-002 | No handoff composition after delivery verification            | gap    | pilot blocker      | closed | codex-chatagent / claude-chatagent           |
| CA-ISSUE-003 | No host slot for the consumer view                            | gap    | pilot blocker      | closed | codex-chatagent / claude-chatagent           |
| CA-ISSUE-004 | No automatic recovery of an idle lead or worker               | gap    | unattended blocker | open   | codex-chatagent / unassigned                 |
| CA-ISSUE-008 | No provider-authoritative quota reconciliation                | gap    | deferred           | open   | codex-chatagent / unassigned                 |
| CA-ISSUE-009 | Runtime quota-window declarations are not persisted           | gap    | deferred           | open   | codex-chatagent / unassigned                 |
| CA-ISSUE-010 | Coordination status shows an older-attempt decision as stale  | gap    | deferred           | closed | codex-chatagent / claude-chatagent           |
| CA-ISSUE-011 | No cross-repo parity check of a handoff view before use       | gap    | pilot blocker      | closed | codex-chatagent / claude-chatagent           |
| CA-ISSUE-012 | Role catalog changes need a restart                           | gap    | deferred           | closed | codex-chatagent / supervised pipeline worker |
| CA-ISSUE-013 | Missing review identity fields pass TS verification           | defect | deferred           | closed | codex-chatagent / supervised pipeline worker |
| CA-ISSUE-014 | Identity rotation can fail on Windows with EPERM              | defect | deferred           | closed | codex-chatagent / supervised pipeline worker |

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
