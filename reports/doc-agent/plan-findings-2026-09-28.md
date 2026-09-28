# Explicit observable plans — pilot findings (2026-09-28 UTC)

Eight local Gemma4 runs compared four existing questions with/without a preliminary
structured plan. Both conditions passed 4/4 structural checks. Manual review found
no clear overall answer-quality improvement and exposed weaknesses in plan quality,
citation selection and the wording of missing evidence. Keep planning optional.

## What changed

The experiment wraps the existing LangChain loop without modifying production
chat, LangGraph, durable state or model prompts used outside this experiment.
A plan has 1–4 actions plus expected evidence. The worker receives the validated
plan as a proposal, not evidence. Runtime tool results are recorded separately as
actual_actions; model claims do not establish that work happened.

Planning consumes one of six total model calls and part of the same 180-second
budget. Retrieval limits remain eight calls and 10,000 bytes. Planned execution
has five remaining model calls. Invalid/truncated plans fail without free repair.
No private reasoning is requested or copied into telemetry. This iteration has
no explicit plan-revision events; discrepancies are reviewed from the trace.

[Evaluation rules](../../experiments/doc-agent/PLAN-EVALUATION.md) were written
before inference. Conditions alternate order across the four cases. These are
previously used questions, not a held-out evaluation. Model identity, seed, options,
package versions and implementation hashes are in [metadata](plans-v1-2026-09-28/metadata.json).
The exact corpus is preserved in [sources](plans-v1-2026-09-28/sources.json).

## Results and cost

| Measure | Baseline | Explicit plan |
| --- | ---: | ---: |
| Structural checks passed | 4/4 | 4/4 |
| Total model calls, including planning | 19 | 21 |
| Total tool calls | 10 | 10 |
| Reported input tokens | 36,940 | 38,370 |
| Reported output tokens | 1,321 | 1,503 |
| Sum of run elapsed time | 26.77 s | 18.19 s |

Token usage includes the planning call and repeated context on execution calls.
Input tokens increased 3.9%; output tokens increased 13.8%. The baseline restart
run took 16.68 seconds, dominating the elapsed comparison; later baseline runs
were 2.97–4.08 seconds. With no separate warmup, repeated prompts and one trial
per condition, the elapsed totals do not establish a planning speed advantage.
[Per-case metrics](plans-v1-2026-09-28/summary.json) retain all observations.

## Manual review against retrieved evidence

These are reviewer judgments from this session, not blinded independent scores.
Structural success means valid output, expected status and required source ID;
it does not mean every claim is supported by the cited line range.

| Case | Answer review | Plan versus execution |
| --- | --- | --- |
| Restart | Both correctly describe the implemented Iris slice as losing runtime state on restart. Baseline discusses the superseded fallback with supporting evidence. Planned answer discusses the original in-memory design, but cites ADR E3 (lines 31–60), while the actual in-memory statement is in E2 (lines 1–30), which it read but did not cite. | Plan calls for implementation and ADR checks; execution reads both. Final discrepancy-search step is not executed; it instead reads more ADR lines. This deviation is not inherently wrong, but no revision is recorded. An extra read did not prevent a citation-selection error. |
| Memory | Both correctly say the foreground does not wait for a new background summary and the original transcript is not summarized in place. Both cite the relevant memory evidence. | Plan is one incomplete search step pointing at context/generation documents. Execution searches and reads memory-evidence, producing a better evidence path than the plan specifies. It does not explicitly plan both parts of the question. |
| Routing | Both correctly distinguish catalog eligibility metadata from automatic dispatch and cite the relevant catalog passage. | Search then read broadly matches the two-step plan. No clear answer improvement over baseline. |
| Unknown cost | Both avoid inventing a dollar amount and return insufficient_evidence, but assert absence across the provided documents more broadly than a few keyword searches establish. The planned answer adds date observations without citations or full-document reads. | Plan includes read_doc and a missing-evidence check; execution only searches twice. Skipping a read when no relevant evidence is found can be appropriate, but neither the plan nor execution proves global absence. |

Raw pairs: [restart baseline](plans-v1-2026-09-28/restart-baseline.json) /
[plan](plans-v1-2026-09-28/restart-plan.json),
[memory baseline](plans-v1-2026-09-28/memory-baseline.json) /
[plan](plans-v1-2026-09-28/memory-plan.json),
[routing baseline](plans-v1-2026-09-28/routing-baseline.json) /
[plan](plans-v1-2026-09-28/routing-plan.json),
[unknown baseline](plans-v1-2026-09-28/unknown-baseline.json) /
[plan](plans-v1-2026-09-28/unknown-plan.json).

Several expected_evidence strings end mid-word or mid-phrase near the schema's
120-character ceiling. They passed schema validation and were not reported as
output-token truncations. This suggests the tight field limit constrained useful
expression; schema validity alone is not a good plan-quality score. A follow-up
should request concise complete sentences with a more generous safety limit.

## Validation and next step

All 60 Python agent tests passed, including six new experiment tests covering
planning-call accounting, host-recorded evidence, unchanged baseline behavior,
invalid/duplicate/oversized schema data, truncated generation, timeout and
cancellation. The live pilot completed all eight runs. No TypeScript changed.

Next use new, held-out multi-part questions with human review of answer support
and requirement coverage. Relax the plan field ceiling and test explicit plan
revisions only when evidence changes the approach. Keep the plan, actual actions
and outcome distinct. Do not deploy mandatory planning or reward step-count and
plan-compliance alone based on these four pairs. Shared inference telemetry and
scheduling remain a separate pending application increment.
