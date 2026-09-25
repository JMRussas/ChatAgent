# Shared chat runtime: ChatAgent, Hekate, and Iris

Recorded 2026-09-25. Status: consolidation proposal and implementation checkpoint;
no cross-repository migration or live integration validation has occurred.

**Step 2 of the execution sequence below is done:** see
[ADR 0001 — chat runtime ownership](../adr/0001-chat-runtime-ownership.md) for
the cited trace of Hekate's/Iris's actual active chat paths, the runtime/
persistence ownership decision (ChatRuntime hosts request handling; Hekate's
context-store is reused as a durable persistence backend via a new adapter),
protocol v1 schemas/fixtures, and the next vertical slice with named acceptance
tests. Two confirmed findings sharpen this note's earlier assumptions: Hekate's
`/api/chat/stream` and `/api/brain/*` have no auth/project-isolation boundary at
all today, and Iris's `conversation_id` handling has a real, reproducible
collision bug (not a hypothetical one) — both detailed in the ADR.

## Intent and boundary

Converge on one reusable conversation runtime and a versioned HTTP/event protocol.
Keep Iris's WPF presentation, Hekate's application workflows, and the web chat UI
as clients. Share conversation/context behavior, provider selection, execution,
and fast/deep lifecycle semantics. Do not force C#, Python, and TypeScript into
one source library or copy another complete chat stack into each repository.

Hekate is the initial integration candidate, not a settled runtime host. Its
CLAUDE.md identifies the gods pipeline as active and parts of orchestration as
legacy. Trace the current gateway and execution call sites before choosing an
owner. Repository naming does not decide deployment topology or language.

## Existing assets and evidence

- ChatAgent: bounded immutable context snapshots (01A, commit f889b9a), fast/deep
  coordination, latency telemetry, model metadata, and generation/activity specs.
  01B summaries/source lookup remain unimplemented at this checkpoint.
- Iris: `irischat.core/Interfaces/IAgentProvider.cs`, `irischat.hekate`, and
  `iris.agent/LocalAgentProvider.cs` provide reusable contracts/adapters. Actual
  chat consumption also lives in `iris/Services/ChatSessionManager.cs` and
  `iris/Clients/OrchestrationClient.cs`; extraction is not complete.
- Iris: `iris/Services/SessionArchiver.cs` retains source messages alongside
  summaries, but replaces active history with an archive marker. Reuse retention
  ideas while moving compaction ownership into context management.
- Hekate: `orchestration/backend/services/chat_agent.py` streams chat and calls
  context-store resolve/assemble/turn APIs. Related discovery, routing, quota and
  CLI abstractions exist. Audit active use and tests before adopting them.
- Hekate: `context-store/Api/Program.cs` exposes conversation and brain APIs;
  `ContextRouter/ContextAssembler.cs` and `EmbeddingService.cs` are retrieval
  assets to evaluate, not evidence that end-to-end recall is already reliable.

## Gaps to verify before migration

1. Iris receives `conversation_id` in its chat SSE handler without saving it;
   Hekate builds generation history from supplied messages. Test two turns,
   reconnect, and restart before trusting continuity or changing identity mapping.
2. Hekate's chat truncation estimates tokens by characters and drops individual
   messages. Preserve complete exchanges/tool pairs, reserve output capacity,
   and keep the current request plus immutable queued context.
3. Keep raw history authoritative. Derived summaries/facts must retain source IDs,
   versions and attribution; assistant claims must not become verified facts.
   Retrieval supplies evidence; the context manager owns final prompt budgeting.
4. Normalize lifecycle IDs and terminal outcomes. UI activity is not conversation
   content, and observable provider activity is not hidden reasoning.
5. Reconcile catalog capabilities, permission scope, cost/unknown pricing and
   subscription quotas. Existing CLI adapters are candidates, not authorization
   to execute arbitrary shell commands or assume a subscription is available.

## Execution sequence

1. Preserve completed/current 01A work. Review 01B and later specs against this
   reuse checkpoint before implementing overlapping memory/provider/CLI systems.
   This note does not silently replace their acceptance criteria.
2. **Done** — see ADR 0001 above for the cited trace and the runtime owner,
   persistence owner, standalone mode, auth/project isolation boundary, and
   service-failure decisions.
3. **Schemas proposed in ADR 0001** (request/event shapes, example fixture,
   field mapping table); shared fixture *tests* are not written yet — that is
   part of building the vertical slice, not this design step.
4. Build one vertical slice: Iris sends a turn through an adapter to the chosen
   runtime, receives a fast answer and optional deep update attached to that turn.
   Keep an explicit rollback switch and existing clients working during migration.
5. Move context/summary/provider ownership incrementally. Audit and reuse existing
   assets before porting. Add vectors only where measured recall cases justify
   retrieval; source lookup and ordinary conversation continuity come first.
6. Migrate the web client and remaining Hekate consumers, then retire duplicate
   paths after parity tests. Update all three notes with the owner ADR and commits.

## Acceptance and handoff

Carry [CTX-01–04 review regressions](01a-review-followup.md) and
[RES-01–08 resource fixtures](08-resource-policy.md) into the shared contract suite.
Execution locality and billing must not be inferred from Ollama/CLI transports.

Shared fixtures must cover two-turn continuity, concurrent conversations, repeated
requests, reconnect without duplicate text, cancellation, failure after partial
output, late deep updates, complete tool exchanges, budget overflow, and source
lookup after compaction. Run offline contract tests first; separately record live
checks for each adapter. Never present simulation as a live integration pass.

Companion notes: Hekate root `CHAT-CONSOLIDATION.md`; Iris root
`CHAT-CONSOLIDATION.md`. These are repo-relative destinations in sibling projects,
not dependencies on a specific developer's checkout path.
