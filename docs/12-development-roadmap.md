# Development roadmap

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
