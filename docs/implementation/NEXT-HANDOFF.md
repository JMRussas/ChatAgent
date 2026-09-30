# Next ChatAgent handoff after 01B

## 2026-09-29: usage reader verified after upgrade

Claude **2.1.285** is installed. Account usage retrieval succeeded through the
undocumented OAuth usage endpoint; the bridge inspection command now reports
safe, timestamped windows and the extra-usage flag. See the
[review follow-up](05-claude-review.md). Shared windows were 0%/3% used at inspection;
model-specific fields were null and extra usage enabled. These are observations,
not persistent allowance grants. Strict generation admission and live acceptance
remain unresolved; no paid or model invocation occurred. Do not repeat the claim
that no account usage can be obtained. Reconcile scoped windows with admission next.

## 2026-09-29: Claude bridge review

Claude and a local bridge to Hekate's unified provider are selected. Bridge and
registry/discovery wiring are implemented; existing OS-profile authentication
passes inspection. [Review](05-claude-review.md) records shared-layer defects,
mitigations and pending quota policy. Do not claim a live answer/cancellation
pass or completion of 05B. A user question about bounded attempts with unknown
quota is pending; the current implementation retains strict blocking.

## 2026-09-29: spec 05A offline milestone

The offline CLI runner and provider registration contract are implemented and
validated: **411 tests / 58 files**, type checking, build, simulated release gate.
See [05 evidence](05-evidence.md) for acceptance mapping and platform limits.
**Next: 05B**, pending the user's CLI product/profile selection; no real product
was selected or invoked implicitly. Production CLI entries still report not
implemented. Evaluation-mode grader design is updated in
[the plan](../04-evaluation-plan.md#grader-design-planned), with a
[learning guide](../15-evaluation-graders.md). Spec 06 and the sports demo follow.

## 2026-09-29: spec 04 dispatch implemented

Catalog-mode selection, captured-context previews, provider registry, resource
admission, frozen retries, explicit bounded fallback and per-turn model labels are
implemented. Fixed mode remains the default. [04 evidence](04-evidence.md) maps
acceptance and resource fixtures: **391 tests / 57 files**, type checking, build and
seeded simulated release gate pass. No live/billed provider or real-browser run was
performed. Cost bounds are declared, usage remains unsettled when unreported, and
reservations are process-local; see the evidence for limits.

**Next bounded task: [spec 05 — CLI execution](05-cli.md)**, starting with its
product/account selection and documented adapter contract. Keep spec 06 evaluation
mode queued and the sports demo after the runtime sequence. Do not reactivate the
parked documentation-agent experiments as the default next task.

## 2026-09-29: spec 04 classification checkpoint

The first step required before dispatch wiring is implemented: deterministic task
classification and a 52-case test suite covering precedence, code/stack traces,
whole-word matching, JSON output requirements and clarification. See
[04A evidence](04a-evidence.md). All 351 tests / 52 files, type checking, build and
the seeded simulated release gate passed. No live-provider checks ran.

Spec 04 remains in progress: model selection, registry, shared-context previews,
resource admission/reservations, fallback, and per-binding telemetry still need
implementation and acceptance coverage. Existing runtime routing is unchanged.
The next implementation step is catalog selection and resource admission, followed
by orchestrator/worker integration. Do not mark spec 04 complete or start 05 yet.

## 2026-09-29: evaluation mode added to the plan

[Evaluation mode and orchestration comparisons](../04-evaluation-plan.md#evaluation-mode-planned-2026-09-29)
now cover passive metadata, correlated traces, quality/cost/latency evidence,
structured decision checkpoints, redaction/retention and recorder overhead.
[Spec 06](06-verification.md#evaluation-mode) owns implementation and EVAL-01–06
acceptance. Recording and orchestration are independent settings; private reasoning
is excluded. Compare sequential, batched and delegated execution when supported,
without reactivating the parked experimental track. This is planning only.
**Spec 04 dispatch remains the next bounded task.** After the runtime sequence
through spec 06 is verified, the [sports-agent demonstration](../12-development-roadmap.md#next-domain-project-temporally-grounded-sports-agent)
is the next domain project, starting with one league and timestamped evidence.

## 2026-09-29: spec 03 (inventory) implemented

[03 evidence](03-evidence.md) records the full acceptance mapping. Real discovery
adapters for Ollama (`/api/tags` + `/api/show`), Azure (ARM management plane,
separate credentials from `AZURE_OPENAI_API_KEY`), and Bedrock
(`@aws-sdk/client-bedrock`'s `ListFoundationModelsCommand`) are implemented and
wired into `GET /models`, which now computes real per-binding readiness instead
of a hardcoded value. Catalog v1 -> v2 migration, connections, and the
RES-01/03/04/08 resource-policy metadata fixtures named as spec 03's scope are
done. 299 tests / 51 files pass; `verify:release` passes. Live cloud discovery
was not run (no Azure ARM or AWS credentials configured here) -- recorded as
not run, not simulated as passing.

**Next bounded task: [spec 04 — dispatch](04-dispatch.md)**, which consumes this
inventory (readiness, resourceFacts) for deterministic task-based model
selection. Do not implement CLI execution (05) incidentally.

## 2026-09-29: canonical direction confirmed — resume the numbered runtime spec

Explicit user decision: the numbered runtime spec (01–06, `docs/implementation/README.md`)
is the canonical plan going forward, not the doc-agent/learning experimental track.
The experimental work below (documentation agent, LangGraph, task lifecycle,
shared-inference scheduling, prompt-contract/prompt-encoding research) is **parked,
not abandoned** — it remains a real, evidenced body of work and its reports stay
as historical record — but it is not the active priority. Do not continue it
as the default next step without a new explicit decision to do so.

**Next bounded task: [spec 03 — inventory](03-inventory.md)**, integrating the
applicable RES-01/03/04/08 fixtures from [08 resource policy](08-resource-policy.md).
This was already named "next" on 2026-09-26 below but was superseded in practice
by the experimental track before being started; it is now confirmed, not merely
carried over by default. Preserve 01A/01B/02 and the protocol v1 surface; do not
re-litigate their acceptance criteria as part of this task.

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

Latest lifecycle review: [edge-case findings](../../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) records
five reproduced fixes and 67 passing offline tests, including a killed worker,
late provider completion, cancellation races and failed persistence. Historical
live-run hashes predate these fixes; old durable tasks still require migration.

Latest evidence: [task-manager validation](../../reports/doc-agent/manager-findings-2026-09-27.md)
records 56 passing offline tests and preserved live success/failure outcomes.

## 2026-09-27: independent task lifecycle

The [local task manager](../../experiments/doc-agent/TASKS.md) adds task IDs, status/list,
resume, and persisted cancellation around per-task checkpoints. Managed tasks
exclude paused time from their execution budget; the standalone durable CLI
retains its wall-clock policy. This supersedes earlier task-management next-step
notes. Conversation integration, admission control and scheduled triggers remain
future work; uncertain in-flight tasks are still refused.

Review checkpoint: [pre-commit review](../../reports/doc-agent/review-2026-09-27.md)
records 50 passing offline tests and two durable-resume validation fixes. Historical
live manifests predate these fixes; their hashes and results are preserved.

## 2026-09-27: durable single-task checkpoint

[SQLite pause/resume](../../experiments/doc-agent/DURABILITY.md) now supports process restarts from confirmed
retrieval pauses, preserving sources, evidence and budgets. 33 offline tests and
a four-process local Gemma4 run passed. This supersedes earlier descriptions of
persistence as entirely future work; the ordinary graph engine remains optional
and nonpersistent. Arbitrary in-flight crash replay is refused. The next increment
is task lifecycle/scheduling around this unit, with explicit long-pause policy.

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

## Current learning milestone: documentation agent

[Spec 10](10-doc-retrieval-agent.md) and the [standalone LangChain/Ollama slice](../../experiments/doc-agent/README.md)
supersede the earlier suggestion to begin with a production provider adapter or
Hekate audit. Learning and completing this project are primary; sibling projects
are references. The agent retrieves documentation on demand with native tools,
bounded host execution and local telemetry. Production TypeScript integration
remains separate. The next learning exercise is expressing this working loop in
LangGraph while preserving the same evidence and resource contracts.

## 2026-09-26 planning update

Latest authorized increment: [Task / Guidelines / Response Framework](09-prompt-contract.md)
and [experiment 2](../../experiments/prompt-contract/README.md). A typed immutable
package and deterministic renderers are implemented outside the application.
Evaluate identical-content controls and new held-out cases before runtime
integration. Scoring is fixed before inference. The next application increment,
after reviewing results, is a TypeScript contract and one LangChain-backed
provider adapter with existing behavior preserved; it is not part of this run.

**Experiment 2 complete:** [600 live calls and findings](../../reports/prompt-contract/findings-2026-09-26.md).
On the new held-out cases TGR scored 40/60, flat identical-content text 38/60,
legacy prose 36/60, JSON 32/60 and XML 35/60. TGR versus flat had four paired wins,
two losses and 54 ties; calibration favored flat by one answer. Keep the package
boundary and configurable rendering, without claiming a universal accuracy gain.
Nine new experiment tests and seven existing pilot tests passed. No production
provider or LangChain integration occurred. Review the report before starting
the separately bounded TypeScript/provider integration.

Prior work: the [prompt-encoding pilot](../../experiments/prompt-encoding/README.md)
and design reconciliation in [ADR 0002](../adr/0002-layered-context-and-orchestration.md)
are complete as experimental/documentation artifacts. Preserve those reports.
Both prompt experiments are independent of the runtime; neither implements a
production translation layer. Layer-specific context policy and a bounded
LangChain integration remain separate follow-up work. The spec 03 inventory scope below remains
queued; it is not the task selected by this latest discussion. Hekate reuse needs
a separately scoped source investigation; do not modify sibling repos here.

Current user direction: **keep work in ChatAgent**. Leave Iris/Hekate changes and
integration validation for sessions working on those repositories. Existing
cross-repository commits are historical context, not authorization to expand scope.

## Prompt-encoding pilot checkpoint (2026-09-26)

The [live pilot findings](../../reports/prompt-encoding/findings-2026-09-26.md)
record 240 scored calls across five installed local models and four formats.
The content score was 81.7% prose, 71.7% concise, 65.0% JSON and 71.7% XML;
this uses an explicitly post-hoc presentation normalization. Exact output-contract
scores, per-model results, token counts and raw records are retained separately.
No universal encoding winner is claimed. Seven experiment tests passed. No
production renderer or framework dependency was added.

## Completed

- 01A bounded context, pending-task awareness, immutable fast/deep snapshots,
  effective model context limits, and CTX-01–04 regression fixes.
- 01B background internal summaries, immutable source identities and bounded
  source checks. Default extractive mode makes no model calls. Optional model mode
  requires explicit fast-binding selection and separate request budgets. See
  [01B evidence](01b-evidence.md) for acceptance coverage and implementation limits.
- Spec 02 streaming/cancellation and preserved fast/deep answers; see
  [02 evidence](02-evidence.md).
- ChatAgent protocol v1 endpoints are present. Prior Iris integration evidence is
  retained in [the slice checkpoint](07-iris-slice-evidence.md); do not continue
  that repo's work as part of the next ChatAgent milestone.

## Next bounded implementation: spec 03 inventory

Read [03 inventory](03-inventory.md) and the applicable metadata requirements in
[08 resource policy](08-resource-policy.md). Implement connections, catalog v2
migration, fresh provider observations and the named RES-01/03/04/08 fixtures in
ChatAgent. Preserve unknown locality, billing, access and health states rather
than inferring them from provider names. Do not implement dispatch/CLI incidentally
or download models, activate subscriptions, or perform billed probes.

## Limits and deferred work

- Runtime timelines, sources, summaries, queues and duplicate claims are in memory;
  restart persistence and durable replay remain deferred.
- Model summary output is structurally validated, not semantically certified.
  Source checks are bounded ID lookup, not semantic retrieval or tool execution.
- Correction/directive detection is conservative lexical handling, not universal
  contradiction or intent detection. Summaries never become verified facts.
- Summary jobs cancel and settle on server shutdown. Full worker/provider draining
  and the broader spec 06 lifecycle remain separate work.
- No live provider, real browser/mobile or desktop quality gate ran for 01B.
- Existing development processes were not restarted. Restart loses runtime state.

Suggested task: "Implement only ChatAgent spec 03 inventory and its resource
metadata fixtures. Preserve completed context/generation work and keep other
repositories out of scope."

## Canonical examples comparison — 2026-09-26

Twelve local Gemma4 runs compared the same tools and schemas with and without
three fictional examples. Structural checks improved from 4/6 to 5/6, while
reported input tokens rose 39.3%; evidence coverage and absence wording remain
limited. Keep examples optional. See the [results](../../reports/doc-agent/examples-findings-2026-09-26.md).
The next framework-learning step remains LangGraph; a separate retrieval-quality
experiment should address missed sections before expanding the tool set.

LangGraph live evidence: [four-case report](../../reports/doc-agent/langgraph-findings-2026-09-27.md).
All structural checks passed. Keep the known uncertainty-wording limitation visible.
