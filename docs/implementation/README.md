# Implementation handoff

## 2026-09-29: canonical direction confirmed — resume the numbered runtime spec

The numbered spec sequence below (01–06) is the confirmed active plan; the
experimental doc-agent/learning track referenced further down is parked, not
the active priority. **Current task: [spec 03 — inventory](03-inventory.md).**
See [NEXT-HANDOFF](NEXT-HANDOFF.md)'s matching 2026-09-29 entry for the full
reasoning. Entries below this one predate that decision and are preserved as
history, not current sequencing.

## 2026-09-28: shared inference decision

[Controlled contention findings](../../reports/doc-agent/contention-findings-2026-09-28.md)
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

Latest learning experiment: [observable plans versus actual execution](../../reports/doc-agent/plan-findings-2026-09-28.md)
compares eight local runs under shared budgets. Both conditions pass 4/4 structural
checks, but manual review finds citation and uncertainty gaps; planning remains
optional and outside production. Next: held-out requirement/evidence review and
plan readability before considering runtime integration.

Earlier validation: [browser and shared Ollama findings](../../reports/doc-agent/browser-contention-findings-2026-09-27.md)
records a fixed development-browser rendering bug, 248 passing TypeScript tests,
and a small same-model contention probe (295 ms baseline median; 888 ms during
background work). That timing follow-up is now recorded in the 2026-09-28 findings above.

Current integration: [conversation documentation tasks](11-conversation-tasks.md)
adds an optional background action, scoped status/results, cancellation and bounded
admission through a local Python sidecar. Earlier notes describing all Python work
as disconnected from chat are superseded for this opt-in path. Shared GPU priority,
automatic context insertion and scheduled triggers remain future work.

## 2026-09-27: explicit LangGraph learning slice

The [LangGraph workflow](../../experiments/doc-agent/LANGGRAPH.md) is implemented as an optional
engine, with the original loop retained for comparison. 29 offline tests pass,
including contract parity, invocation isolation and cancellation propagation.
This supersedes earlier text proposing graph translation as future work. The next
learning step is designing durable state and pause/resume; neither is implemented
by this invocation-local graph. Production runtime integration remains separate.

2026-09-27: use the [model-specific reference guide](../14-model-reference-guide.md) before
changing model integration or designing local evaluations. Start with official
guidance and published benchmarks, then test the application-specific gaps.

Current learning slice: [10 documentation retrieval agent](10-doc-retrieval-agent.md)
uses the existing sibling course patterns for LangChain/Ollama and bounded
read-only tools. Hekate integration and production provider migration are not
prerequisites. Read the latest section of NEXT-HANDOFF before older sequencing.

Latest prompt work: [spec 09](09-prompt-contract.md) and
[experiment 2](../../experiments/prompt-contract/README.md) define and evaluate
Task / Guidelines / Response Framework. This experimental branch does not mark
the queued numbered runtime milestones as complete.

2026-09-26 priority update: [ADR 0002](../adr/0002-layered-context-and-orchestration.md)
records the latest orchestration/context/telemetry direction. The immediate
experiment is [paired local prompt encoding](../../experiments/prompt-encoding/README.md).
Use [NEXT-HANDOFF](NEXT-HANDOFF.md) for current sequencing; the numbered specs
below remain the queued runtime roadmap, not evidence of implementation.

Specification baseline: `7f03beb` (2026-09-25). These documents describe planned
changes, not existing APIs. Read the current source before editing; do not restore
the baseline over newer work. The spec 02 checkpoint and acceptance results are recorded in [02 evidence](02-evidence.md).
No live quality pass is claimed. Start with [NEXT-HANDOFF](NEXT-HANDOFF.md).

**Context plan revision 2:** read [01's memory extension](01-context-memory.md)
before resuming context work. It supersedes the original “no summaries” and
“drop all pending turns” requirements. Summarization belongs to the context manager,
not the visible chat. Preserve useful work already implemented; see the extension's
safe continuation instructions. No source implementation was changed by this revision.

## Execution order

**Review corrections:** [01A boundary invariants](01a-review-followup.md) records
four corrected regressions against f889b9a and their passing named tests. [Execution and resource policy](08-resource-policy.md)
extends 03–06: transport, execution location, billing, quota and compute are
independent. Ollama and CLI bindings carry no implicit locality or price.

**Cross-repository reuse checkpoint (2026-09-25):** read
[07 Shared chat runtime](07-shared-chat-runtime.md) before starting overlapping
01B/provider/CLI work. 01A is committed at `f889b9a`; preserve it. Audit existing
Hekate and Iris assets and record runtime ownership before migration. This
checkpoint adds a design prerequisite; it does not claim integration is complete.

UI follow-up: [02 activity sub-bubbles](02-activity-ui.md) specifies attached progress,
observable labels and preserved answer versions. Context revision 2 is unchanged;
an agent already implementing 01 should finish that scope, then read this extension
when starting 02. Do not add UI/persistence work to the current context task.

| Spec | Dependency | Deliverable |
|---|---|---|
| [01 Context](01-context.md) + [memory extension](01-context-memory.md) | Existing baseline | 01A snapshots/pending state; 01B internal summaries/source records |
| [02 Generation](02-generation.md) + [activity UI](02-activity-ui.md) | 01A; preserve v2 context fields | Streaming, cancellation, activity sub-bubbles and answer updates |
| [03 Inventory](03-inventory.md) | Existing catalog; integrate after 02 | Connections and fresh provider observations |
| [04 Dispatch](04-dispatch.md) | 01–03 | Deterministic task-based model selection |
| [05 CLI](05-cli.md) | 02–04; product/account selection for live adapter | Subscription execution via a registered adapter |
| [06 Verification](06-verification.md) | 01–04; include 05 when enabled | Shutdown, honest benchmarks, browser and live gates |

The ownership ADR, 01A/01B and spec 02 are implemented. See [01B evidence](01b-evidence.md).
Current user direction: work only in ChatAgent; leave Iris/Hekate follow-up for work in those repos.
Follow NEXT-HANDOFF.md for the next bounded task. Implement one reconciled numbered spec at a time. Do not implement later
milestones as incidental refactoring. Each spec has a scope boundary and named
acceptance cases; completion requires the cases, not merely new types or metadata.
03's interfaces can be designed independently, but this handoff does not require
parallel agents. Production deployment and retrieval are separate future scopes.

## Common contracts and rules

- `messageId` identifies a user turn, `taskId` a queued deep job. Retries retain both;
  each execution attempt receives a separate `attemptId`. Never correlate by text
  or timestamps. Preserve existing HTTP fields during incremental migration.
- Keep UI timeline events separate from provider conversation messages. Activities,
  partial deltas and diagnostic metadata are never assistant conversation content.
- ContextManager owns context preparation, summary lifecycle and source lookup;
  orchestrator captures the prepared context and owns selection. Adapters translate requests and emit
  results; workers execute frozen tasks; the UI displays persisted facts.
- No provider credentials, login tokens, hidden reasoning text, full environment
  dumps, or arbitrary shell command strings in public events/catalog endpoints.
- Use mock/deferred providers for deterministic tests. Network, cloud provisioning,
  subscriptions and billed inference are not requirements of an offline test pass.
- Update `.env.example`, README and the roadmap when behavior/configuration changes.
  Preserve historical reports. Mark checks as run, failed, or not run with a reason.
- Provider-specific protocol facts must be verified against installed versions and
  current official documentation during implementation. Record the source/date in
  adapter notes. Do not guess CLI switches, regional availability or model limits.

## Verification and commits

Every milestone handoff must map acceptance IDs/requirements to test file and test
name, with executed result or explicit outstanding status. Include cross-component
boundary/transition cases, not only isolated request-shape checks. A passing suite
does not by itself establish acceptance coverage.

For each code milestone: run its focused tests, then `npm test`, `npm run lint`,
`npm run build`. Before declaring the integrated handoff complete, run
`npm run verify:release` with `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`. On PowerShell set these with `$env:NAME = 'value'`;
shell `NAME=value command` syntax is not portable to this workspace.

Read existing Git status first and preserve unrelated work. Commit each coherent
milestone with implementation, tests and documentation together. Do not overwrite
benchmark baselines merely to make gates pass. Investigate and explain legitimate
changes before versioning a replacement baseline. No remote is configured.

The development server does not watch source changes. Verify its process/port
before restarting; report that in-memory conversations will reset. Do not kill
unrelated Node/Ollama processes. Keep local secrets out of commits.

## Reusable task prompt

> Read docs/implementation/README.md and the next numbered spec. Check its
> prerequisites against the actual code. Implement only that spec, including its
> failure cases and acceptance tests. Preserve unrelated changes. Run the required
> checks, update the roadmap with evidence and remaining limitations, and commit
> the completed milestone. If an external prerequisite is missing, complete the
> independent offline work and report the exact blocked live acceptance case;
> do not substitute a mock result for live verification.
