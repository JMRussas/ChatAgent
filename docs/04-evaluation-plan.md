# Evaluation Plan

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

## Acceptance additions for the active plan

- Direct payload correctness, declared scope, coverage, provenance and rendering.
- Payload content excluded from model input on initial and subsequent turns unless
  explicitly requested as evidence. Compare small/large fixtures; context growth
  should follow bounded metadata, not payload rows.
- Owned/versioned result handles, expired references, follow-up selection and retrieval.
- Topic browsing does not silently rescope an existing conversation or imply a preference.
- Actual context/settings/tool activity observable separately from displayed payloads.
- Manual review off/self/other-model and supported thinking configurations recorded;
  compare draft versus revised quality, usage and latency. Keep production review
  distinct from independent grading and do not treat reviewer agreement as truth.
- Later semantic retrieval: relevant/irrelevant memories, freshness, user isolation,
  manually selected evidence and avoidance of unsupported inferred profile facts.

These are new acceptance requirements, not implemented tests or measured scores.

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


## Next evaluation: named team to sourced game answer — 2026-09-30

Apply evaluation to the richer tool work in the [sports plan](18-nba-briefing-demo.md).
Target: “What happened in the Patriots' last football game?” Assess tool correctness,
conversation behavior and factual answer quality separately.

Deterministic cases: unique and ambiguous team matches, unknown names, unavailable
team directory, expired caches, cross-league identity collisions, exact as-of bounds,
completed versus in-progress/scheduled/postponed/cancelled games, unordered pages,
missing scores, insufficient pagination/coverage, offseason search exhaustion, shared
quota across directory/game calls, cancellation and reload during work. Verify bounded
requests and explicit partial/unavailable outcomes. Exhausted budgets do not prove absence.

Model/session cases: equivalent wording and typos, already-specified team names,
follow-up references, changed team preferences, latest-completed versus last-night
intent, useful versus unnecessary clarification, unsupported leagues, and continued
chat while retrieval runs. Internal IDs must not be requested for resolvable names;
missing MLB capability must not trigger an unsolicited NFL substitution.

Grade final answers against fixture/provider evidence: correct team and game,
completion status, score, source links, and explicit coverage limitations. Narrative
claims need supporting evidence beyond a score. Keep code checks and calibrated
human/model rubric judgments separate. Repeat live model cases and retain versioned
plans, tool traces, latency and request counts; do not treat a few smoke checks or a
passing runtime suite as a factual-quality benchmark. These are planned evaluations.


## Current application: NBA briefings

The [NBA demo](18-nba-briefing-demo.md) is the selected workflow for multitask
measurement. Test useful foreground interaction during league/team work, grounded
follow-ups, temporal ambiguity, preference overrides and partial-source failures.
Keep the coordination and deep-quality measures below; implement them alongside
bounded sports slices rather than an abstract benchmark first. No live comparison
or memory accuracy claim follows from the initial offline planner.


## Current priority: multitask sessions (2026-09-30)

Evaluate layer 1 as the ongoing user-interaction and coordination layer while deep
calls perform substantive work. The next slice is the
[multitask session design](17-multitask-evaluation.md): overlapping requests, task
status, corrections, cancellation, isolation and results arriving during continued
interaction. Grade coordination separately from substantive task quality. Single-
answer latency and the original prompt dataset below remain supporting measures.

Implement a deterministic session runner first. Current live scenario execution is
sequential and the deep worker runs one job at a time; neither establishes multiple
active deep calls. A blocking baseline measures concurrency benefits, while a
background-capable single agent is needed to assess layered specialization fairly.
The new design is not yet an executed or preregistered live experiment.

## Dataset shape

Build a seed set of 60 prompts split evenly:

1. Direct-answer prompts
2. Retrieval-required prompts
3. Ambiguous prompts requiring clarification

## Metrics

1. Routing accuracy
- Did router pick expected route?

2. User-perceived latency
- Time to first meaningful response

3. Deep-answer quality
- Relevance (1-5)
- Factuality (1-5)
- Citation quality (binary + spot-check)

4. Cost efficiency
- Average tokens/request by route
- Provider cost estimate per 1K conversations

## Test protocol

1. Run fixed prompt set through each provider configuration
2. Capture route decision, latency, and outputs
3. Score via rubric (human + optional evaluator model)
4. Compare configurations:
- Azure-fast + Azure-deep
- Azure-fast + Bedrock-deep
- Bedrock-fast + Bedrock-deep

## Output artifact

Produce `reports/prototype-eval.md` with:

1. Metric table
2. Strengths and failure modes
3. Recommendation for default provider profile

## Evaluation mode (planned, 2026-09-29)

Updated 2026-09-30: the passive recorder is available; setup and current limitations
are documented in [06B](implementation/06b-recording.md).

The opt-in passive recorder and annotation contracts are implemented in
[06B](implementation/06b-recording.md). Broader comparison/measurement work remains
in [spec 06](implementation/06-verification.md#evaluation-mode).
Recording and orchestration strategy are separate settings. Enabling recording must
preserve prompts, model selection, tool permissions, budgets, retry policy and
scheduling policy. Recording can affect elapsed time and deadline outcomes; measure
that overhead rather than promising identical live timing. Matched overhead
measurement and experiment compatibility are still planned.

Persist a versioned manifest, correlated event trace, scored results and summary in
`reports/evaluations/<run-id>/`. Capture:

- Configuration: run ID, dataset/version and fixture digest, repetition, code revision
  and dirty state (plus a digest of evaluated source when dirty), prompt/configuration
  digests, actual model bindings/revisions,
  generation settings, tools, orchestration strategy, resource budgets, hardware,
  concurrency and warm/cold conditions.
- Execution: turn/task/attempt and parent-child call IDs, model/tool/sub-agent
  start/end events where supported, result references, errors, retries,
  cancellations and terminal outcomes. Correlate using IDs rather than text.
- Performance: wall time, queue/admission wait, model/tool durations, first answer
  and annotated first useful answer, per-attempt and aggregate token usage, and
  measured/estimated/unknown costs. Parallel durations are not elapsed wall time;
  include child usage without double counting. Unavailable values remain null.
- Outcomes: answer artifacts/hashes, task/test results, versioned rubric,
  evaluator identity/configuration, human annotations and missing observations.
  Keep synthetic and live evidence explicitly separate.
- Decision checkpoints: existing structured action/reason codes and evidence IDs,
  such as a failed test leading to parser inspection. Do not store private internal
  reasoning or add model calls to explain decisions. Additional model-generated
  explanations, if studied, constitute a separate experimental intervention.

Redact credentials and sensitive payload fields before persistence. Default to
allowlisted metadata and hashes/references; full prompt/tool payload capture requires
explicit configuration for an appropriate dataset. Record capture/redaction policy,
retention duration, size limits, dropped events and recorder failures. Keep private
payloads out of committed reports. Flush on completion/cancellation and identify
incomplete traces explicitly.

For quality scoring, reference retained, access-controlled answer artifacts from the
runner, or explicitly enable answer capture for the evaluation dataset. A hash alone
cannot support review. Key annotations to the exact scored answer hash; if redaction
changes a saved answer, record its separate artifact hash and transformation status.
If the scored answer is unavailable or redaction prevents assessment, mark the
required rating unavailable rather than inferring a pass. Retention applies to these
referenced artifacts as well as traces; record expiry so it is clear when a run can
no longer be independently reviewed.

## Grader design (planned)

See the [code and model grader learning guide](15-evaluation-graders.md) for
worked examples. Separate deterministic facts/policy checks from model-judged
clarity, completeness and evidence support. A factual or policy failure cannot be
averaged away by style scores. Model judgments must use supplied reference evidence,
not remembered temporal facts; synthetic and live cases remain separate.

Version each grader/rubric and record judge model/settings, reference digest,
structured verdict, short evidence-based rationale, grading errors and human
adjudication. Measure judge cost/latency separately from candidate execution.
Calibrate on human-reviewed correct/wrong/borderline examples, then measure
agreement on held-out cases. Balance pairwise answer order, allow ties, and retain
disagreement. Missing evidence or invalid judge output is ungradable, not a pass.
Multi-judge consensus is optional and does not replace a reliable reference.

## Orchestration comparison

### Claude reasoning conditions

Treat interleaved thinking as a declared experimental variable separate from
orchestration strategy and passive recording. Record resolved model/version,
transport, thinking mode, effort, budgets and supported controls. API support does
not establish CLI support. Adaptive thinking may already interleave automatically;
unsupported disabled conditions are unavailable, not fabricated controls. Verify
against [Claude thinking guidance](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)
and the installed interface before running.

Use identical held-out tasks, evidence, tools and aggregate budgets, repeated runs
and counterbalanced order. Hold the judge configuration constant and blind it to
condition labels. Measure task/factual success, tool arguments, recovery, redundant
calls, latency and usage. Count all work, including failures and budget exhaustion.
The current answer-only bridge cannot test thinking between tool results: that
comparison starts with the scoped sports tools. Answer-generation effort tests are
labelled separately. Retain observable actions/results, not private reasoning.

### Optional tool-use LoRA experiment

After evaluation mode and the sports tool baseline, consider the
[local-model tool-use training design](16-tool-use-lora.md). Establish unchanged
model and improved-prompt/schema baselines first. Use curated tool trajectories,
held-out games/templates and execution-based scoring to decide whether adaptation
helps. Keep reasoning settings fixed in the initial LoRA comparison to avoid
confounding two interventions. This is a proposed follow-on, not a training run
or a change to runtime sequencing.

### Execution strategies

When the execution capabilities exist, compare:

1. One agent making sequential calls with reassessment between results.
2. One agent batching independent calls and reassessing at dependency boundaries.
3. A main agent delegating bounded independent work and assessing child results.

Use identical held-out tasks, initial context, tools, model configuration, rubric
and aggregate token/time budgets, counting all child work. Record strategy-specific
instructions separately and vary only the intended strategy. Before execution,
declare the allowed comparison dimensions in a versioned experiment manifest;
validate that every other configuration field matches. Preserve each run's full
configuration digest rather than pretending the configurations are identical. Include dependent tasks
and tasks with independent branches. Run at least three repetitions, counterbalance
run order, and record seeds where supported and shared-resource load.

Compare paired task success, quality, latency distributions, total usage/cost,
retries, redundant calls and coordination overhead. Retain failed, timed-out and
cancelled runs in the denominator. Measure recorder overhead with matched on/off
controls. Select based on quality/cost/latency tradeoffs without assuming a winning
strategy. Unsupported conditions are not run; this experiment does not reactivate
the parked doc-agent track or require sub-agent implementation in spec 06.
