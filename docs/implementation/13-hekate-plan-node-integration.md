# 13 — Hekate plan-node integration contract

Date: 2026-10-06. Status: implemented bounded contracts and H1; execution integration remains gated.

This records the ownership split between ChatAgent and Hekate for the
user-directed plan-node workstream and defines the first pilot handoff. Real-worker
activation remains gated. ChatAgent's H1 receipt-to-context seam is
lead-accepted; the Hekate launcher and plan-store/browser implementations are separate increments,
and their checks are reported separately. Roadmap context:
[step 6](../12-development-roadmap.md#6-declarative-role-coordination--planned-2026-10-05).
Hekate's companion plan is `LOCAL-PLANNING-HANDOFF.md` in the Hekate repository
(untracked there at the time of writing).

## Ownership

| Concern                                 | Owner                          | Notes                                                                                                                                                                        |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local startup, status and stop          | Hekate                         | On demand, without the Sisyphus host; separate from that deployment's database/queue                                                                                         |
| Plan nodes, hierarchy and dependencies  | Hekate                         | Existing PostgreSQL/AGE context-store; no ChatAgent plan store                                                                                                               |
| Execution engine                        | Hekate, after inventory        | Choose between the active gods path and the experimental LangGraph engine                                                                                                    |
| Context assembly and the answer runtime | ChatAgent                      | Existing bounded context, provider dispatch, budgets, cancellation and recording                                                                                             |
| Worker contract (assignment/result)     | ChatAgent proposes             | Shared fields below; must be carried by Hekate plan nodes, not a parallel ledger                                                                                             |
| Claim, finish and release calls         | Hekate supervisor              | Caller-held durable keys; ChatAgent receives the raw claim response and has no claim or transition client                                                                    |
| Coding-worker adapter                   | Hekate supervisor adapter      | Sole claim/finish/release mutation owner; independent verifier/lead owns review decisions. Design 023 and bounded E1a/E1b experiments accepted; real execution remains gated |
| Model provider and CLI provider modules | Existing boundary, gated reuse | Hekate's prepared-prompt `CLIProvider` is a later reuse candidate; no live activation or relaxation of ChatAgent's answer-only CLI runner                                    |
| Repository integration (commit/handoff) | Single integration owner       | Local commits only in the pilot; no push, merge or service restart                                                                                                           |

## Corrections to earlier documents

- `Odin/gods` is Hekate's designated engine in its source architecture. That is
  not live verification: the initial inventory found a missing import; subsequent
  source recovery and offline checks are reported in unresolved question 0.
  `Odin/langgraph_engine/` is an
  uncommitted experimental candidate. Its README says it "does not replace
  `Odin/gods/`" and is not deployed. Hekate's `CHATAGENT-INTEGRATION-HANDOFF.md`
  (2026-09-28) describes it as the engine to reconcile with. Treat it as a candidate,
  not the canonical engine.
- ChatAgent step 6 increment 2 proposed a generic LangGraph interpreter in this
  repository. That is deferred until the cross-repository engine decision. Do not
  build a second generic interpreter here before then.
- The roadmap's step 6 table previously said that the mailbox was not located.
  The agent-bridge mailbox is reachable on this machine; it is not part of this
  checkout.

## Transport facts (observed 2026-10-06, updated 2026-10-07)

These are observations of the agent-bridge, not guarantees this project provides.

- Each agent has its own bearer credential. The admin credential may send under
  any agent name, so a sender name is not verified worker identity.
- Updated, observed 2026-10-07 (bridge protocol 1.1, agent-bridge-mcp
  `docs/wire.md` at `7a33328`): ordinary messages are still consumed when a legacy
  inbox, wait or socket consumer delivers them. A message sent with
  `ack_required=true` stays pending until the recipient (or the operator)
  acknowledges it with `bridge_ack` or `POST /api/ack`; receivers opt in with
  `ack_mode=true`, REST `ack=explicit` or `/notify?ack=explicit&format=json`, and
  explicit delivery may repeat a message. The acknowledgement timestamp is durable
  and idempotent. Unread messages replay on connect, and history is retained.
- A bridge acknowledgement records delivery responsibility only: the recipient
  accepted the message. It is not execution, task acceptance, review or completion,
  and it is not Hekate attempt authority.
- Delivery is not durable task acceptance. Assignment ownership, leases, attempt
  fencing and duplicate suppression belong to the workflow layer.

## First pilot handoff

The pilot is manually supervised: one bounded ChatAgent roadmap task, worked
locally, with a human acceptance decision. Fields are proposed, not implemented.

### Assignment

| Field                        | Meaning                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `assignmentId`, `attempt`    | Unique per issued attempt; a new attempt supersedes earlier ones                  |
| `planNodeId`, `planRevision` | Hekate node identity and the plan revision the requirements were snapshotted from |
| `role`                       | Role definition identity and version/hash; logical role, not a model binding      |
| `repository`, `workspace`    | Repository identity and the workspace path, written with forward slashes          |
| `baseRevision`               | Exact commit the work starts from                                                 |
| `requirements`               | Mandatory requirements and acceptance criteria, snapshotted, not referenced live  |
| `rules`                      | Repository rules to apply (for example `AGENTS.md`) and required checks           |
| `inputs`                     | Prerequisite artifacts and earlier review findings, by reference with revision    |
| `capabilities`               | Explicit grants: read, edit, run named checks, local commit. Nothing implied      |
| `limits`                     | Deadline, budget and bounded fix rounds                                           |
| `issuer`                     | Who issued the assignment; see the identity question below                        |

### Result

| Field                     | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `assignmentId`, `attempt` | Must match a current, unsuperseded attempt                                 |
| `outcome`                 | completed, failed, blocked or needs-decision; completion is not acceptance |
| `changes`                 | Changed paths, plus patch or commit hash with its base revision            |
| `checks`                  | Exact commands, runtime version and results; skipped checks are named      |
| `findings`                | Review or self-reported findings, kept separate from verified facts        |
| `context`                 | Sources and hashes of the context actually supplied to the worker          |
| `openQuestions`           | Decisions the worker could not make                                        |

## Receipt-to-context package (H1)

Implemented 2026-10-06 in `src/integrations/hekate/planTask.ts`, tested in
`tests/unit/hekatePlanTask.test.ts` against raw responses captured from Hekate at
`bb2af8b` (`tests/fixtures/hekate/`, with their provenance). Validation and
rendering are pure and deterministic; the context wrapper also creates a random
snapshot ID. Nothing is wired: no network, worker launch, recording or route uses
it yet.

Lead acceptance evidence: raw fixtures are byte-identical to the Hekate `bb2af8b`
captures. The earlier full primary gate passed 1,335 TypeScript tests across 132
files and 34 browser tests before final raw-number/rule-framing corrections.
After those corrections, primary and lead each passed 79 focused tests across
two files (68 H1 and 11 contextBuilder); the lead also previously ran 105 adjacent
tests. Twenty distinct retained mutations were rejected (17 earlier cases minus
the replaced reviver case, plus four new cases). Format, lint and documentation
checks passed. Supplied hashes identify mandatory current-user text and its
sections, not system or role instructions. No runtime wiring, network, worker
activation or recording is established by these checks.

- **Input.** The raw claim-response body exactly as received, the required rule
  texts (`{path, revision, text}`, read once into copies) and optional limits that
  must name every field. Raw size is checked before parsing.
- **Validation.** Every JSON number must be written as an exact safe integer;
  others are refused instead of rounded. The raw text is scanned (skipping
  strings), so a number hidden by a later duplicate key is checked as well. The
  envelope (`contractVersion` exactly `plan-contract/v1`) and receipt are strict.
  A claimed epoch is at least 1;
  nested prerequisite values stay opaque. Content may be null, which stays distinct
  from empty. `no_ready_work` is refused. `replayed` and `stillCurrent` are kept as
  history and never treated as permission to run or relaunch.
- **Output.** A frozen, deterministic text with every variable block length-framed:
  the requirement, attributes in ordinal order, the prerequisite snapshot and each
  rule's path, revision and text as separate blocks. Framing is an unambiguous
  encoding, not protection against instructions inside the content. The pinned
  source keeps Hekate's content and prerequisite
  digests as received (opaque identities) and adds ChatAgent's own SHA-256 of the
  exact supplied text for each section and the whole.
- **Context.** `buildPlanTaskContext` validates its budget and instructions, then
  uses the existing `buildContext` with the whole package as the current message,
  so it is fixed cost: a package that does not fit is `CONTEXT_TOO_LARGE`, never
  truncated. The result has exactly that one message and no history, memory or
  sources. The estimate is the conservative UTF-8 count, not a provider tokenizer
  or a proof of fit. The snapshot ID is random; provenance is the source and hashes.

## Development coordination status (C1a)

Implemented 2026-10-06 in `src/integrations/hekate/devCoordination.ts`, with the
read-only CLI `scripts/devcoord.ts` (`HEKATE_PLAN_API_URL=http://127.0.0.1:<port>
npx tsx scripts/devcoord.ts status --root <plan-root> [--json]`). It reads one managed
plan view (`GET /api/plan-contract/v1/plans/{root}`) and reports each leaf as ready,
blocked, in progress, awaiting review, accepted, rejected, stale or cancelled, with
its exact identities (attempt, executor reference, artifact, decision), readiness
flags and blockers. Tests use a raw response captured from Hekate `d0ed671`
(`tests/fixtures/hekate/`) plus labelled synthetic edits, and run the CLI as a
subprocess against a fake loopback server; nothing in the suite is live. An
independent smoke of the CLI against a disposable Hekate `d0ed671` API returned the
expected states with acknowledgement unknown.

- **Read-only.** There is no claim, finish, decide or content client: those
  mutations belong to the Hekate supervisor and the reviewing lead.
- **No acknowledgement inferred.** A claim or an in-progress state is allocation, not
  proof that a worker started; `executionAcknowledged` is always `unknown`. Bridge
  delivery is never an acknowledgement either.
- **No stale work shown as current.** Attempt pins are `current` only when they exist,
  the content revision is unchanged and nothing upstream changed; an attempt
  without pins is `unknown`. An acceptance whose inputs changed is shown as stale.
- **Fail closed.** Contract version and root must match; every number must be an
  exact safe integer and no object may repeat a key or use `__proto__` (checked on
  the raw text); the hierarchy must be one tree with every node classified once as
  a leaf or container, where a container is the root or a node with children (as
  in Hekate's `IsContainer`), so pending leaf work cannot hide as a container;
  references must stay inside the plan; and a current
  decision must be the recorded decision on the current attempt. Readiness errors
  report the plan as invalid without inferring states.
- **Bounded client.** Literal loopback http only (`127.0.0.1` or `[::1]`), no
  redirects, one deadline covering headers and body, and a 4 MiB body cap enforced
  while reading. Output carries states, identities and refusal codes only.

Durable execution acknowledgement, progress evidence and wake-ups remain
unimplemented; they depend on Hekate's journal and supervisor work.

## Offline handoff delivery verification (E2e consumer, verification stage)

Status: implemented and lead-accepted 2026-10-07 after an independent review by
Hekate's implementer. Pure and offline; not wired to a route, a conversation or the
bridge. Detached `ArrayBuffer` fields receive a typed `strict_json` refusal after
ingress checks. The former untyped exception is fixed and independently verified;
[CA-ISSUE-001](../open-issues.md) retains the reproduction and closure evidence.
`src/integrations/hekate/handoffConsumer/delivery.ts` ports the verification stage
of Hekate's accepted `e1/consumer.py` (plan 034 revision 3, SHA-256
`17273a51…2ab9db`) over the exact accepted v0 bytes of one `handoff-delivery.v0`
wrapper and a host-supplied as-of snapshot. It runs the reference checks in the
reference order, and the first failure refuses the whole delivery with a stable
code that never echoes input:

1. raw ingress caps (whole wrapper 4.5 MiB first, then each field), then the wrapper
   and codec (`ingress_too_large`, `codec_unsupported`);
2. the strict, closed commit receipt, then `sha256(manifest bytes)` equal to the
   wrapper and receipt digests (`strict_json`, `receipt_shape`, `digest_mismatch`);
3. strict reading of the manifest, envelope, task and H1 options, then the closed H1
   option set and caps (`strict_json`, `h1_input`, `ingress_too_large`);
4. the reference `verify_stored`: canonical manifest, envelope and task bytes, the
   envelope bound to exactly this manifest and payload, task, import and note
   digests, and the required manifest shape (`delivery_mismatch`); then receipt
   identities against the transition (`receipt_mismatch`) and 032 delivered caps
   (`delivery_overflow`);
5. the snapshot: its identity must name this candidate, record, review and package
   (`fresh_mismatch`), then `receipt_not_current`, `binding_moved`,
   `review_not_candidate`, `stale_content` and at most 256 uncertainty references
   (`uncertainty_overflow`); finally the H1 option instructions must equal the
   committed task (`task_mismatch`).

Digests are computed over received bytes only. `pyCanon.ts` checks `py-canon.v0`
(Python `json.dumps`, sorted keys, compact, raw UTF-8) token by token against the
decoded values; nothing is re-serialized in JavaScript and no integer becomes a
Number. Keys are ordered by Unicode code point. Strings must carry Python's exact
escapes. Integers are kept exact at any magnitude up to Python's 4,300-digit limit
(longer is `strict_json`). A float must be shaped as Python's repr writes it, or it is
`delivery_mismatch`; within the supported subset (-0.0 and [0, 1e16), which covers
the producer's fake clock and its deadlines) it must also carry the shortest
round-trip digits that ECMAScript `Number::toString` gives. A longer spelling is
`delivery_mismatch`; any other difference, and any float outside the subset, is
`codec_unsupported`, never a guessed mismatch. That digit parity is tested, not
proven: the reviewed byte-compatibility vectors and deliveries plus an independent
Hekate probe of about 2.3 million doubles and 2.4 million lexemes in [0, 1e12] found
no false canonical or false mismatch result. Host capacity limits (depth 64, nodes
and the `__proto__` key) are `codec_unsupported` with a non-echoing reason, not
producer-invalid.

Host differences from the reference, all refusing where it would accept or fail
untyped (reviewed by Hekate's implementer, bridge message 1413):

- Each caller field is read once and text fields are never coerced. Byte fields
  are measured by their intrinsic length, then copied once with the typed-array
  constructor (never a field's own `slice()`, which for a Node `Buffer` is a view),
  and the digest and the parse use only that copy, so a getter, a shared buffer or a
  later change cannot split them.
- The manifest's `transition`, `authority` and `optional` must be objects and its
  `evidenceIndex`, `authority.pending`, `authority.queue`, `optional.evidence` and
  `optional.imports` arrays; the reference only indexes them and takes `len()`.
- A snapshot whose review identity has other than exactly its five fields (as the
  reference's dict equality), a numeric (not exact-integer) attempt epoch, non-array
  `pending` or `queue`, or a manifest identity missing one of the five is
  `fresh_mismatch`; the reference raises an untyped error for the last three. As in
  the reference, the manifest identity's other fields (`lead`, `leadSession`) are
  not compared.
- An unsupported float in the manifest is reported as `codec_unsupported` before the
  envelope and task checks, where the reference could report a later tamper as
  `delivery_mismatch`. No producer-reachable value is unsupported.

The snapshot is trusted in-process data, as in the reference, not an authenticated
proof; the result is as-of that snapshot and narrows, never closes, the window
before a later use. Policy, retrieval, the consumer view, the H1 call and
composition are not implemented here. Tests: `tests/unit/handoffDelivery.test.ts`
(every golden and supplement variant, structural codes and order, no effects) and
`tests/unit/handoffPyCanon.test.ts` (all 34 supplement vectors and Python repr
spellings), over `tests/fixtures/hekate/e2e-consumer-v0/` and
`tests/fixtures/hekate/e2e-byte-compat-v0/`.

## Acceptance and evidence boundaries

- A pilot passes when the task moves through implement, independent review, fixes
  if needed, required checks and a local commit, and a human records acceptance.
  The result must cite the exact revisions, commands and supplied context.
- Approval applies only to the reviewed content. Any later change needs renewed
  review.
- The pilot does not establish unattended execution, crash recovery, remote
  execution, multi-user isolation or model quality. Remote execution still needs
  authenticated ownership and the step 2 deployment boundary. Durable recovery
  still needs the step 3 gates.
- Delivery through the mailbox, or a worker reporting completion, is not evidence
  that the work was done or accepted.

## Accepted fake-worker interop (E1a/E1b)

Hekate E1a (`bf61588`) passed 103 independent tests. E1b (`6f50dac`) is accepted
after independent clean-source validation and ChatAgent consumer review: 113
default supervisor tests, 31 pure H1 interop tests and one live case (145 total,
zero skips). Hekate's `context-store/plans/024-supervisor-e1a-validation.md` and
`025-supervisor-e1b-validation.md` record the evidence. The live seam exercises
real local API receipt → ChatAgent H1 → fake worker → guarded finish, using
ChatAgent `5255daa` and Node 24.21.0 with explicit clean-source/runtime checks.

Structured uncertainty preserves claim/holder evidence instead of retrying or
automatically releasing uncertain work. Result correlation includes the mandatory
supplied-text hash and separate system/fast/deep instruction strings; H1's hash
still covers mandatory user text only. Owned API exit, disposable database deletion
and `.run` cleanup were verified; the container is stopped. These checks establish
no real worker/model activation, process safety or restart recovery. E2 durable
launch/review-pending evidence is queued for design only, not implemented.

## Proposed review-pending handoff acceptance

Status: proposed and unimplemented. E1a/E1b acceptance does not implement restart recovery. The manual workflow exposed a failure in
which the lead ended its turn, the implementer completed, and its bridge reply
remained unread for about 20 minutes until the user prompted the lead. Mailbox
delivery and a running process are insufficient evidence of review progress.

The future handoff mechanism should pass this bounded scenario:

1. Complete an authorized implementation attempt while its responsible lead is
   inactive. Persist a `review-pending` record with assignment and attempt IDs,
   responsible lead, exact result revision and check evidence before sending a
   notification. Message consumption must not erase the pending review.
2. Detect an inactive or stalled lead from recorded acknowledgments and advancing
   review progress against a defined deadline. Transport connectivity, process
   existence and repeated unchanged heartbeats do not count as progress.
3. Wake the responsible lead through a supported session mechanism. Require an
   acknowledgment tied to the pending record and subsequent evidence of resumed
   review, such as a recorded finding or a completed review/check checkpoint.
   Notification delivery alone must not mark the handoff complete.
4. Exercise lost wakeups, duplicate delivery and an acknowledgment followed by
   no progress. Use configured retry limits, deadlines and escalation to an
   authorized operator when recovery is exhausted; never retry indefinitely or
   silently transfer ownership to a second lead.
5. Fence superseded attempts and deduplicate wakeups so only the current owner
   can advance the current review. Preserve in-flight atomic work: do not cancel,
   replay or interrupt an edit, command or commit merely because a progress
   deadline expires. Resume or reconcile its recorded outcome at a safe boundary
   before retrying an uncertain operation.
6. Finish independent review, corrections and required checks, then record the
   authorized local milestone commit and its exact evidence before the next
   implementation increment. Preserve any separately required human acceptance
   gate; a wakeup or commit does not satisfy it.

Tests should establish bounded time to acknowledgment and resumed progress,
durable pending state after restart or consumed notification, rejection of stale
attempts, and bounded escalation without duplicate repository effects. The
current bridge and this documentation provide none of these recovery guarantees.

## Proposed shared agent and task visualization

Status: shared integration proposed; Hekate's read-only plan projection is accepted.
The user identified a task/agent map as a
possible shared interface for Hekate and ChatAgent, with a possible bridge
visualization. The reference shows
a parent-child tree, task names, status, elapsed time, token counts and clickable
details; its product origin is unverified. Hekate's lead accepted local commit
`bb2af8b` after independent checks and ChatAgent consumer review. Hekate's
`context-store/plans/021-local-plan-browser-proposal.md` and
`022-local-plan-browser-validation.md` record managed-plan listing, hierarchy,
dependency map, API-derived leaf/container statuses, detail and paged audit
history, with stale-response guards and GET-only traffic. Lead evidence passed
172 pure, 51 live-store and 66 HTTP checks, and 51 repository browser/parser
tests plus one temporary visual check (52 total). Typecheck, build and scoped
lint passed; full lint retains its disclosed two-error/three-warning baseline.

The accepted browser is a local read-only projection, not a worker launcher,
claim UI or authentication implementation. ChatAgent execution/recovery and bridge
visualizations remain unimplemented. Supervisor/context ownership is agreed in
Hekate design 023 (`68bab95`); ChatAgent H1 and bounded E1a/E1b fake-worker
experiments are lead-accepted. Visualization
query seams remain to be agreed separately from these bounded integration seams.

The proposal is three linked views over existing authoritative state:

| View                | Visible state                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Hekate planning     | Plan tasks, dependencies, owners, review gates and accepted results                         |
| ChatAgent execution | Agents, assignments, last meaningful progress, pending handoffs, wakeups and recovery state |
| Bridge transport    | Sender, recipient, thread, message history and observed delivery/consumption                |

Reuse shared task, assignment-attempt, plan-revision and artifact identifiers to
link these projections. Each field must identify its authoritative source;
missing or stale evidence stays visible as unknown or stale. Reuse the agreed
plan/execution state and transport history rather than adding independent or
conflicting UI ledgers. Query contracts and projection ownership remain to be
agreed between the leads.

Keep edge types distinct: delegation means `spawned-by`, dependency means
`depends-on`, and communication means `message-to`. A parent-child display must
not imply that every message recipient is a delegated worker or that every
delegated worker is a plan dependency.

The bridge's explicit message acknowledgment (protocol 1.1, observed 2026-10-07)
records delivery responsibility only. Delivery, consumption or a bridge
acknowledgment is not workflow acknowledgment, and acknowledgment is not resumed
work. Show these
as separate textual states, backed by progress evidence, so a consumed completion
message cannot hide a stalled review. Elapsed time and token usage should name
their source and scope; unavailable measurements must not appear as zero.

Provide drilldown to assignment scope, review findings, checks and the exact
result or local commit. Allow collapsing completed branches and filtering for
items needing attention, including overdue acknowledgment, stalled progress and
pending review. Status dots may supplement clear textual status; they must not
carry the only indication of blocked or incomplete work.

## Unresolved questions

Source labels: _code_ means read directly from Hekate source for this document.
_Inventory_ means reported by claude-hekate's read-only increment 1 inventory
(2026-10-06, Hekate branch `feat/plan-nodes-migration`) and not re-derived here.
_Spot-checked_ means part of an inventory finding was confirmed from source. These
remaining issues constrain real-worker activation; accepted pure/context seams
and fake-worker experiments do not resolve them.

0. **Gods source recovery and compatibility.** The initial 2026-10-06 inventory
   found that gods did not import on the inspected Hekate branch:
   `Odin/gods/handlers/registration.py:18` imports `gods.handlers.athena_complete`;
   no such module existed in `Odin/gods/handlers/` on that branch. The inventory
   reports it only on `origin/chore/sisyphus-cleanup` (`4e44d3f`). _Spot-checked._
   Later on 2026-10-06, `codex-hekate` reported recovery of `athena_complete` from
   `4e44d3f` and sessions, conversation and gateway tests from `229cac3`.
   The lead independently checked byte provenance and syntax, and reported
   successful `gods.registration` and engine imports, 26 offline gateway tests
   and 16 offline Athena node-tree tests. These later results are reported here,
   not directly re-derived. Integration compatibility remains unverified; no
   live model call or service startup is established by source recovery.
   The lead subsequently reported recovery committed as `a1f8237`, including the
   fixture, with 26 gateway and 30 Odin offline tests passing. This does not
   establish a fully passing Odin suite or live gods integration.
1. **Authoritative task ledger.** The inventory reports that SQLite `tasks` and
   `task_deps` form the active execution ledger. A comment in `Odin/gods/engine.py`
   instead describes Postgres (asyncpg) as primary, with SQLite (aiosqlite) for
   tests (_code_). The configuration actually in use has not been verified here,
   and that conflict needs resolving. Per the inventory, context-store
   PostgreSQL/AGE nodes are a one-way projection written by two title-matching
   writers: `orchestration/backend/services/plan_sync.py` and
   `Odin/gods/handlers/context_bridge.py`. Both files exist (_spot-checked_).
   The two writers replace attributes wholesale and conflict with each other. A
   SQLite `plan_nodes` table (migration 030) is inactive. The records diverge, and
   UI edits to plan nodes never reach execution (_inventory_). The inventory
   proposes context-store nodes as authoritative for plan structure, with `tasks`
   remaining the execution ledger, linked by plan node ID. That is a proposal
   awaiting an execution-ledger decision. Increment 2b1 now makes PostgreSQL
   authoritative for new managed plan roots; it neither enrolls these legacy
   trees nor links their execution ledger.
2. **Revision checks.** `NodeRepository.UpdateNode(id, name, value, modifiedBy)`
   in `context-store/DbLayer/NodeRepository.cs` takes no expected-revision
   parameter (_code_, method signature only). Stale-update rejection is therefore
   not established at that legacy layer. Increment 2b1 implements compare-and-set
   operations and whole-graph validation for new managed roots, with a database
   fence preventing legacy mutation of their protected structure and content.
   This does not retrofit revision checks onto unmanaged legacy plans.
3. **Claims and ownership.** The initial inventory found two mechanisms, neither
   covering context-store plan nodes. Increment 3b1 below adds durable receipts
   for new managed plan leaves, without leases or authenticated ownership.
   `context-store/AgentCoordination/SubtreeLock.cs` is a
   session-scoped advisory lock; its only caller is the console demo in
   `context-store/Program.cs`. The atomic `tasks.claimed_by`/`claimed_at` update is
   the only persisted claim identified in that initial inventory. _Inventory;
   the `claimed_by` column is spot-checked._
4. **Recovery.** According to the comparison table in `Odin/langgraph_engine/README.md`,
   gods durability uses a relay-event table and cursor, and the experimental engine
   uses LangGraph SQLite checkpoints (documentation, not code). Neither, as documented,
   reconciles uncertain external effects such as edits, commands or commits.
   ChatAgent's durable-checkpoint work is a Python experiment, not production
   recovery.
5. **Identity and authority.** ADR 0001 found no authentication on context-store
   routes. Bridge sender names are unverified for admin-sent messages. Who may
   issue assignments, record acceptance or advance plan state is undecided.
   Increment 2b1's opt-in localhost API and integrity fences are not principal
   authentication: a holder of full database credentials remains trusted and can
   open the fence or disable triggers.
6. **Local profile.** `context-store/docker-compose.yml` builds Apache AGE
   `release_PG16_1.6.0` with pgvector `v0.8.0` (`Dockerfile.postgres`). The fixed
   container is `code-storage-db`, published on port 5433, with a named data volume
   and default credentials. It holds the `code_storage` and `orchestration`
   databases and the `code_graph` graph. Existing scripts target deployment.
   Docker was absent at the initial 2026-10-06 inventory. _Inventory; compose
   details and the initial missing Docker were spot-checked._ Later that day,
   `codex-hekate` reported Docker Desktop installed and a Linux amd64 engine and
   Compose verified. That runtime report is not directly re-derived here and
   does not establish live Hekate operation or persistent planning data.

   A plan-only local launcher is committed in Hekate as `b94c276`, as reported by
   `codex-hekate`: `scripts/local/` and `context-store/docker-compose.local.yml`, plus
   readiness, shutdown and dispatcher-switch changes in
   `context-store/Api/Program.cs`. It requires PowerShell 7.5 or later.
   Evidence as of 2026-10-06; source identifiers below are relative to the Hekate
   repository, not this checkout:
   - **Earlier executed evidence:** an independent run of its Pester 3.4 suite passed 45 of 45. The
     tests mock Docker, dotnet, processes and HTTP, except one argument-forwarding
     test against a fake `docker` executable. A separate unmocked probe confirmed
     that Api ownership survives a real state-file round-trip and is rejected
     after a simulated PID reuse.
   - **Live evidence reported by the Hekate lead and read from
     `scripts/local/VALIDATION.md`:** S0–S13 passed after fixes. The lead's final
     independent run passed 49 of 49 Pester tests; start returned in 11.3 seconds
     with the API healthy, and graceful stop returned in 1.3 seconds. Plan
     hierarchy and dependency edges read back identically after restart cycles.
     Backup and a fresh repaired restore matched the archive baseline: six
     relational nodes, six Cypher vertices and one edge. These are Hekate-side
     checks, not a new independent ChatAgent review or execution.
   - **Restore repair:** `scripts/local/README.md` documents the upstream AGE
     logical-restore OID issue (`apache/age#2503`). Repair runs on the new target
     only, atomically, with a single-graph guard and fail-closed outcome. The
     source database was unchanged. A supplementary live multi-graph rejection
     probe was not run; unsupported-shape rejection is covered by mocked tests.
   - **Build and final state:** the API built against a clean committed-source
     archive. The profile is stopped with volume, image and data retained. No
     production service, model call or push is established by these checks.
   - **Limits:** the launcher is Windows-only with PowerShell 7.5 or later;
     validation supplied `rootPath` to avoid an existing project-create API bug.
     Disposable validation projects and restore databases remain for inspection.
     The record reports 18 failures in a partial broader Odin run, outside the
     local-profile gate. Restore's wrapper compares labels with the live source
     and checks Cypher usability; archive-baseline count equality above is
     validation evidence, not an automatic backup-baseline comparison guarantee.
     The state file still stores an unsalted SHA-256 password fingerprint; that
     concern remains separate from successful lifecycle and restore evidence.

7. **Managed plan store and legacy writers.** The earlier pure-contract milestone
   `3fb3663` passed 101 of 101 tests. Increment 2b1 is now accepted by Hekate's lead
   and committed as `9bc2cec`, as reported by `codex-hekate`. Evidence read from
   Hekate's `context-store/plans/014-plan-contract-integration-validation.md`,
   with design and inventory in `012-plan-node-contracts-v1.md` and
   `013-plan-writer-inventory.md` in that same directory, establishes this scope:
   - PostgreSQL is authoritative for **new managed roots**. Each operation holds
     a per-project lock, loads and validates the whole graph, checks contract
     version, applies compare-and-set updates and reconciles AGE in the same
     PostgreSQL transaction. AGE projects identity and tagged dependencies,
     not content; this is not an outbox. AGE failure rolls back the operation,
     deliberately coupling plan-write availability to AGE.
   - Database fences block protected legacy/API/raw-SQL writes to managed trees,
     including structural moves and attribute replacement. The opt-in local
     API is `/api/plan-contract/v1`; flag-off routes are absent and unsafe
     configuration is rejected. Full database credentials remain trusted.
   - **Hekate-side independent evidence:** clean dependency closure passed 132
     pure and 25 live-store tests, with 28 HTTP process tests and 50 launcher
     tests. Concurrent CAS, cycle rejection, key/payload conflicts, AGE rollback,
     projection reconciliation and writer fences were exercised. These are
     reported/read Hekate results, not new ChatAgent execution. Isolated databases
     and owned API processes were cleaned up; no production or model call was used.
   - Legacy enrollment, execution integration, authentication and UI remain
     deferred; managed deletion, reparenting and container review/descope are
     unsupported. The earlier inventory's unmanaged-writer problems below remain
     historical findings requiring migration or retirement before integration:
   - On completion, `context_bridge` replaces the node's name and value and all of
     its attributes, erasing engine identifiers.
   - `ContextStoreClient` sends flat attributes, while the API expects an
     `attributes` object.
   - The edge client's route and DTO do not exist, while the API exposes
     `/api/code/edge`.
8. **Attempt provenance audit.** Increment 3a is accepted by `codex-hekate` and
   committed as `31274bc`, as reported by the lead. Hekate's
   `context-store/plans/016-attempt-provenance-audit.md` defines its semantics;
   `context-store/plans/017-attempt-provenance-validation.md` records independent
   clean-source verification: 146 pure tests, 34 live-store tests, 39 HTTP checks
   and an API build with zero errors. A real schema upgrade on a separate owned
   database preserved existing state and null-reference 2b1 replay fingerprints;
   no history was synthesized. These are read/reported Hekate results, not new
   ChatAgent execution.
   - `plan_node_state` remains the work-state authority. Applied attempt, decision
     and content-revision operations derive append-only audit events in the same
     transaction, with contiguous per-plan sequence numbers and unique node/state
     revisions. Rejected or unchanged operations and structural edits emit no
     events. AGE failure and sequence overflow roll back state and audit together.
   - Optional `executorRef` is opaque correlation: start/reopen binds it, finish
     preserves it, release/cancel records it before clearing, and reopen never
     inherits it. It is neither authenticated identity nor a verified executor
     ledger link. A mismatching finish is a stale attempt.
   - The existing opt-in API adds plan/node event reads with stable plan-sequence
     cursors and bounded pages. `historyStartsAtSeq` identifies only the first
     recorded event, not the earliest work; `historyBackfilled` remains false.
   - Append-only guards reject event updates, deletes and truncation even with
     the store flag set. Sequence guarantees cover store-written transactions;
     full database credentials can bypass guards. This is integrity protection,
     not tamper-proofing or authentication.
   - At the 3a milestone, claim-next and durable receipts remained deferred;
     increment 3b1 below subsequently adds them. Worker launching,
     execution-ledger integration and structural history remain deferred. Tests used disposable
     databases with verified cleanup; no production, model or gods changes were
     involved.
9. **Durable claim receipts and attempt pins.** Increment 3b1 is accepted by
   `codex-hekate` at local commit `979d471`, as reported by the lead. Hekate's
   `context-store/plans/019-durable-claims-and-pins.md` defines the contract and
   `context-store/plans/020-durable-claims-validation.md` records independent
   verification: 172 pure, 48 live PostgreSQL/AGE and 59 HTTP checks. The live
   suites used isolated owned databases with cleanup; no worker, provider,
   production, auth, UI or launcher changes are established by this evidence.
   - A claim chooses the first ready leaf under the project lock and atomically
     writes its attempt state, audit event, append-only receipt and AGE projection.
     The receipt records exact content and prerequisite snapshots. Identical
     `(root, claimKey)` requests replay the original receipt without writes;
     changed actor, attempt or executor payload gives `operation_key_reused`.
     A `no_ready_work` receipt is durable too; new work requires a new key.
   - Start/reopen pins the content revision and canonical prerequisite digest;
     finish preserves them, release/cancel clears them after audit capture.
     Relevant content or prerequisite drift rejects finish or new acceptance
     with `stale_content` or `stale_prerequisites`. Unrelated sibling work and
     bookkeeping do not invalidate these pins. This is strict input provenance,
     not an execution adapter or automatic retry policy.
   - Replay preserves historical correlation; `stillCurrent` separately reports
     current attempt, pins and content-digest agreement. It is not authority or
     proof that external effects are safe. Invalid/unreadable or unsupported
     current plans fail closed for correlation without changing the receipt.
   - A real frozen-3a schema upgrade preserves prior rows and fingerprints, with
     no receipt or pin backfill. Legacy unpinned attempts retain exact replay and
     release/cancel support but cannot finish; historical legacy acceptance is
     preserved while a new Accepted decision fails closed.
   - No leases, heartbeat expiry, reclaim, worker launching, authenticated
     principals or real-worker execution adapter are implemented. ChatAgent H1
     supplies pure context only. Full database credentials
     remain trusted and can bypass integrity guards.
   - **TypeScript integration precondition:** v1 serializes Int64 revisions,
     epochs and sequences as JSON numbers. A future adapter must parse them
     losslessly or reject values outside JavaScript's safe-integer range before
     acting; ordinary rounded `Number` values cannot fence attempts. A future
     decimal-string wire contract is another option, not implemented by 3b1.
10. **Provider ownership.** ChatAgent's `src/providers/cli/hekateClaude.ts` with
    `bridges/hekate/claude_bridge.py`, Hekate's `Odin/gods/providers/` and its
    `llm-gateway` overlap. Which is canonical for each use is undecided.
