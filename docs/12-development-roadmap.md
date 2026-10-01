# Development roadmap

## Current plan — reliability before feature expansion (2026-10-01)

This section is the authoritative execution order. Earlier dated entries below are
historical decisions, not competing instructions for the next step. The sports work
remains a deliberate demonstration of the general role/tool/evidence runtime.

Current state: a manual prototype with configurable roles, selected evidence,
separate display payloads and native/graph execution comparisons. The four delivery,
grading, review and reference-layout fixes are implemented but uncommitted; their
last verification was 740 tests / 95 files, 26 browser tests and TypeScript build.
These results establish covered behavior, not sustained-operation or calibrated
factual-quality guarantees. Review the existing increment separately before a
requested commit; preserve its changes while implementing reliability work.

### 1. Bounded retention and sustained operation — in progress

First slice implemented (uncommitted): coordinator retention. Reproduced capacity
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

Second slice implemented (uncommitted): lifecycle/dispatch retention. Reproduced 12
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

Next slice: admission ledger aggregation/retention audit and sustained-memory
measurement. Started invocation charges were deliberately preserved: execution-cache
cleanup must not refund spend or quota. The ledger, conversation history and dead
letters are not made bounded by this increment, so this is not a claim of bounded
whole-process memory or completion of step 1.

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

Acceptance: execute substantially more than the configured capacity sequentially;
verify new calls continue, active jobs survive pressure, retained state plateaus,
indexes agree, retries obey the retention contract, and cancellation/shutdown still
settle correctly. Include concurrent completion/eviction races. Check registry sizes
and retained contexts deterministically; supplement with a repeated-use memory
measurement rather than relying on a brittle absolute heap assertion.

### 2. Request limits and an explicit deployment boundary

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

### 3. Cancellation, recovery and configuration correctness

- Pass cancellation/deadlines through initial catalog admission; release reservations
  on every aborted preparation path and stop cancelled callers waiting for quota.
- On bridge protocol failure, terminate/drain the child and settle pending requests.
  Define explicit restart behavior without automatically replaying uncertain work.
  Give orphaned document tasks an operator-visible reconciliation/abandon path that
  preserves uncertainty about external execution instead of claiming clean rollback.
- Validate complete discovery batches before publishing inventory changes. Retain
  last good observations without extending freshness, and expose sanitized failure
  reasons without credentials or raw provider responses.
- Define reload compatibility: preserve unaffected result handles/in-flight work;
  invalidate incompatible dependencies explicitly. Scope directory revisions to
  the relevant league/provider so an NFL read cannot invalidate NBA resolutions.
- Make Azure/Bedrock deadlines configurable through the appropriate provider/model
  settings; retain separate workflow bounds. Audit Claude usage inspection and make
  its credential access/undocumented endpoint explicit and opt-in if not already so.

Acceptance: cancellation while quota-blocked leaves no reservation; malformed stdout
and process kills leave no child/promise leaks or automatic duplicate execution;
orphaned tasks can be reconciled. Invalid timestamps cause no partial inventory write.
Unrelated league refresh/reload preserves valid handles, while incompatible changes
fail clearly. Verify configured deadlines and usage-inspection disabled/enabled paths.

### 4. Current-state documentation and maintenance checks

Planned, not implemented. The next reliability slice remains admission-ledger
aggregation/retention and sustained-memory measurement. This documentation rollout
follows steps 1–3; update nearby contracts and regression tests during those changes
without waiting for the generator rollout.

First increment: document `GenerationLifecycle`, `CatalogDispatch` and
`BriefingCoordinator`, then generate a browsable reference for those modules.

- Add one root `AGENTS.md` for shared maintenance conventions; tool-specific
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
- Run Python tests in CI, adding bridge JSON-lines coverage. Introduce consistent
  formatting/lint checks in a separate mechanical change to keep functional diffs
  reviewable. Review abstraction costs against demonstrated uses; do not add durable
  state/retry machinery solely to justify the optional LangGraph dependency.

Acceptance: a reader can find current purpose, setup, supported boundary, evidence
and next work without resolving contradictory journals. Archived commitments remain
accounted for, CI exercises both languages, and formatting changes stay separate
from behavior changes. Expand documentation enforcement only after the pilot proves
useful; Python documentation generation is deferred until there is a demonstrated need.

### 5. Independent quality evidence, then renewed feature work

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

| Plan area | Actual state |
| --- | --- |
| Sports foundation | Provider directories, bounded NBA/NFL search, shared quotas, basic details and configured news retrieval implemented; exhaustive latest-game selection and richer statistics remain incomplete. |
| Payloads and manual evidence | Direct UI tables, owned/expiring references, bounded row attachment and explicit review/revision implemented. |
| 1. Role containers | Implemented and committed: versioned definitions, model/tool enforcement, limits and recording. |
| 2. Manual role UI/budgets | Implemented and committed first slice. Budget is latest admitted-call evidence; unsent preflight, richer grouping and role-file hot reload remain follow-ups. |
| 3. Framework comparison | Started with a one-model-call graph and deterministic parity checks; broader parity/adoption gate remains open. |
| 4. Grounded reporting/evaluation | Runtime/contract tests and manual review exist. Full 27-case session runner, independent payload/answer quality grading and calibrated model comparisons remain pending. |
| 5. Layer-one background roles | Existing background retrieval/document work exists. General role-job coordination, durable multi-task scheduling and restart/replay semantics remain pending. |
| Longer-term profiles/memory | Topic scope and explicit references exist; editable persistent profiles, semantic retrieval and automatic context selection remain pending. |

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

| Area | Implemented | Still needed |
|---|---|---|
| Runtime reliability | Message correlation, worker concurrency guard, body timeouts, serialized telemetry writes, truthful startup errors | Graceful shutdown, backpressure, Bedrock deadlines |
| Chat progress | Answer streaming, cancellation, per-attempt activities/timers, preserved answer updates | Live provider and real-browser/mobile verification |
| Model inventory | Validated catalog, `/models`, capability/task eligibility filtering | Provider discovery, fresh account access/health observations |
| CLI subscriptions | Catalog schema for profiles, authentication, billing and shared quotas | Actual CLI adapters and verified subscription automation support |
| Conversation context | 01A: bounded shared snapshot, grounded runtime facts, active-task awareness, ownership/budget guards | 01B: internal summarization, source-linked memory, `resolveSources()` |
| Model selection | Fixed environment-configured fast/deep pair | Task-based dispatch, measured ranking, explicit fallback |
| Evaluation | Automated regression tests and labeled fixture/simulation reports | Fresh live golden run and measured answer-quality evaluation |

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
