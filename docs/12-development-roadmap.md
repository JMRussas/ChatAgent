# Development roadmap

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

Later UI decisions are now specified in [02 activity sub-bubbles](implementation/02-activity-ui.md):
attached per-turn progress, expandable step history, observable model/activity labels,
elapsed time and preserved substantive answers with separate updates. These do not
change Claude's in-progress context scope. Persistence, natural-language task
supersession and aggregate budget enforcement are explicitly separate follow-ups.

## Current status and next implementation order

Reconciled through implementation commit `8afce48` on 2026-09-25, plus 01A below.
The latest implementation check passed **140 tests across 31 files and TypeScript
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
(`CONTEXT_SUMMARY_*`) — all 01B. Streaming stays off per spec (spec 02).

| Area | Implemented | Still needed |
|---|---|---|
| Runtime reliability | Message correlation, worker concurrency guard, body timeouts, serialized telemetry writes, truthful startup errors | Graceful shutdown, backpressure, Bedrock deadlines |
| Chat progress | Per-bubble queued/thinking/retrying/failure states, model label, terminal spinner removal | Actual model-token streaming, browser smoke coverage |
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
   per-bubble activity and terminal states. These controls are not implemented yet.
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
streaming are planned work—not capabilities delivered by the catalog commits.

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
  its answer arrives. Model token streaming remains separate future work.
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

01A is committed, but review corrections CTX-01–04 remain open; see
[boundary invariants](implementation/01a-review-followup.md). Acceptance now
requires named regression-test evidence, not just a green suite.

Specs 03–06 also require [resource policy](implementation/08-resource-policy.md):
execution location, billing mode, quota and compute capacity are independent of
transport. RES-01–08 are future acceptance requirements, not implemented controls.
Complete the bounded context corrections, then honor the cross-repository reuse
checkpoint before adding overlapping provider or memory implementations.
