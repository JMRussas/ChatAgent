# Observable planning pilot v1

Compare the existing explicit LangChain loop against one preliminary structured
plan call. This is an optional experiment, not a change to the chat worker or
LangGraph lifecycle. No private reasoning is requested or logged.

Each plan contains 1–4 observable actions with expected evidence, not completed
work or an answer. The validated plan is added to the execution question, labeled
as a revisable proposal rather than evidence. Runtime tool-result events form a
separate actual_actions record. There is no automatic claim that a step was
completed and no inference that a model followed the plan internally. Explicit
plan revision events are not implemented in v1; deviations are reviewed afterward.

Fixed before inference: use run.py CASES (restart, memory, routing, unknown), one
pair each, alternating baseline/plan order. These are previously used questions,
not held-out cases. Same pinned corpus, model, temperature, seed, context and
output limits. Six total model calls, eight tool calls, 180 seconds total; planning
uses one call and part of that deadline. Planned execution therefore has five
calls available. No extra examples, thinking off, no plan repair or free retry.
The same per-call input and output caps apply; actual token use is measured, not
forced equal. Plan generation adds a small document-index-only request.

Evaluation:
- Structural: completed, expected answer status, required source cited.
- Manual answer review against pinned passages: factual support, coverage of all
  requested parts, distinction between proposal and implementation, uncertainty
  scoped to retrieved evidence. Record these separately from structural results.
- Manual plan review: actions relevant to the question, evidence checks sufficient,
  observable execution alignment, unnecessary or omitted actions. Do not reward
  matching a flawed plan; source coverage does not certify semantic entailment.
- Cost: total/planning model calls, tool calls, elapsed time and reported input/
  output tokens including the plan call. No p95 or significance claim from 4 pairs.

Inspect raw plan, actual_actions and answer together. This tests the whole planning
intervention (extra call plus explicit plan), not whether structure alone helps.
A larger held-out evaluation needs human/blinded scoring and repeated trials.

Run from the repo root with the existing Python environment:

    python experiments/doc-agent/run_plans.py --out reports/doc-agent/plans-v1-2026-09-28

Only the installed local gemma4:26b model is used. No source files, durable
checkpoint contracts, production routing or runtime prompts are changed.
