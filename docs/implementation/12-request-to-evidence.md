# Request-to-evidence contracts and acceptance gates

Status: contract foundation implemented; provider resolution, composite lookup,
reporting, synthesis and end-to-end evaluation execution are still pending.
This specification supersedes earlier Patriots-specific next-step ordering.

## Responsibility and implementation order

1. Define contracts, failure states and evaluation cases before lookup implementation.
   `src/sports/operationContracts.ts` now provides name-based inputs, resolution
   snapshots, selection validation, latest-game outcomes and an admission status vocabulary.
2. Implement sport/league selection from configured capability metadata, plus
   provider-backed team resolution. A missing league is not automatically the profile's
   league. Return ambiguity when evidence cannot uniquely resolve scope. Do not infer
   support from what the model knows about a team. Verify directory access before coding
   against a provider endpoint; cache with versioned evidence and configurable expiry.
3. Implement bounded latest-completed-game retrieval, internally composing resolution,
   pagination and backward searches. Select the correct resource policy for every call.
4. Add game-specific reporting/details and evidence-backed answer generation. Attach
   reports by validated game/team/time evidence, not merely their presence in a league
   feed. When only a score is available, answer that portion and state the recap gap.
5. Execute the frozen evaluations and review stage failures before expanding the UI.
   Independent tests accompany each slice; end-to-end evaluation is not deferred until
   after all product behavior has been implemented.

No runtime keyword list should recognize evaluation prompts. Team names belong in
provider directories and test inputs. Supported scopes come from the tool registry;
contract league/sport fields deliberately accept registry-defined identifiers rather
than baking NBA/NFL into the new abstraction. This does not add new provider adapters.

## Capability operations and results

| Operation | Input | Outcomes |
| --- | --- | --- |
| Discover/select scope | Request context and available capability metadata | Supported scope, candidate scopes, unsupported capability; no unrelated-sport substitution |
| Resolve team | Name/alias, optional sport and league | Matched, ambiguous, partial, not found, unsupported, unavailable |
| Select candidate | Snapshot handle and candidate handle | Server-validated identity, stale selection, inaccessible snapshot, unknown candidate |
| Latest completed game | Team name, optional sport/league/as-of | Found with certainty label, none in searched window, incomplete search, needs resolution, unsupported, unavailable |
| Game evidence | Resolved game identity and requested detail | Score/details/reporting with provenance, partial evidence, unavailable evidence |
| Synthesize answer | User request and returned evidence | Cited supported claims and explicit unanswered parts |

Game-reporting and answer schemas will be finalized against actual provider evidence
in step 4; they are not implemented by the current contract module.

Resolution snapshots contain owner/conversation, registry and directory revisions,
expiry, lookup scope, candidate handles and source evidence. Only server-stored
snapshots may be passed to the selection validator. The model/client supplies handles,
not a replacement snapshot or arbitrary provider ID. A new team correction starts a
new resolution and supersedes the prior conversational selection. Repeated ambiguous
answers preserve the same unexpired choices; stale or revised evidence triggers a
fresh lookup. Snapshot storage and the conversational selection lifecycle are next-step
implementation work; only their contract and selection guard are implemented now.

A partial directory cannot certify unique resolution or absence. Multiple observed
candidates may still justify clarification, with partial coverage retained. A user can
explicitly select a known candidate from a partial snapshot without claiming the
candidate list was exhaustive. Directory outages are unavailable, not no match.

A game must be final, match the resolved team/league and have a score to satisfy this
version of the found-game contract. Missing scores produce incomplete/unavailable
outcomes until a richer partial-game contract is defined. Search windows, page limits,
request limits and deadlines are configuration. “None in window” never asserts that
no game ever occurred. “Latest confirmed” requires complete relevant search coverage
and evidence of completion by as-of. A newer live/scheduled/postponed/cancelled event
must not displace the last completed game. For historical requests, a final status
observed today does not establish that the game was already final at the cutoff.

## Resource-specific admission

Extend the existing resource facts/admission components rather than creating an
alternative billing ledger. Select policy by service/account/endpoint or model binding
and share reservations across operations using the same underlying pool.

| Resource | Policy inputs |
| --- | --- |
| Data API | Account/endpoint rolling windows, provider Retry-After/reset evidence, cache and retry policy |
| Metered inference | Request/token windows, estimated and reported cost, spending allowance, compute/concurrency |
| Local inference | Actual deployment facts, memory/capacity, concurrency and queue pressure |
| Cloud inference through any transport | Account quota, billing and concurrency; Ollama does not imply local or unrestricted |
| Subscription CLI | Subscription/account/model windows, usage-evidence age, extra-usage preference and concurrency |

Expense alone does not determine a rate limit. One binding may have multiple constraints.
Data-provider reservations are separate from inference reservations: changing the model
does not replenish the sports API budget. Unknown usage is an explicit policy case
(deny, bounded wait for refreshed evidence, or explicitly authorized uncertain usage),
not a zero-usage observation. Preserve existing operator authorization; do not silently
change subscription/extra-usage policy or infer it from a transport name.

Shared mechanics report admitted, waiting or denied with policy/pool, reason and
retry time when known. Policies configure waiting versus denial, maximum wait, retries
and deadline accounting. Defaults for the next sports slice: bounded wait when a
request-slot reset is known and fits the operation deadline; otherwise an explicit
retryable admission outcome. Spending/access denials do not auto-retry. Unknown retry
times remain unknown. Never replace a blocked tool result with empty sports data.
Cancellation removes queued work; begun requests keep their reservation. Reload retains
usage history/cooldowns and applies new limits to future admission. Waiting uses no
inference/compute execution slot. Define fairness across conversations and verify that
repeated requests cannot starve older admitted work. Account-wide limits across processes
remain out of scope until shared storage is deliberately added.

The new admission outcome schema is a contract only. Existing runtime admission has
not been replaced, and queued sports retries are not implemented by this step.

## Independent evaluation corpus

`data/evals/request-to-evidence.v1.json` contains 27 scenarios: 12 development and
15 evaluation-only. Fixture names are requirements for future synthetic source
snapshots, not existing datasets or claims about historical games. Build those source
snapshots and the session runner before reporting end-to-end scores. Runtime modules
must not import the corpus or use its text to route requests.

The evaluation-only partition is excluded from prompt tuning. It is committed and
reviewable, not a secret benchmark. If used to tune implementation/prompts, replace it
with newly authored cases before claiming held-out performance. Include new synthetic
league/team identities so success cannot come solely from model recall.

Score these stages independently: intent/scope selection, entity resolution, temporal
selection, tool execution/admission, evidence sufficiency, answer grounding and
conversation continuity. A blocked upstream stage makes downstream stages not executed,
not passed. An unavailable provider is a coverage failure; choosing an absent tool is
a planning failure; returning an invented ID is a resolution/validation failure.

Use deterministic fixture oracles for IDs, game ordering, scores, request counts and
policy outcomes. Human-reviewed rubrics cover whether clarification was useful and
whether narrative claims are supported. Model graders require calibration against
those labels and must not judge correctness from tool-call success alone.

Proposed gate, fixed before implementation evaluation:
- All deterministic contract/resource invariants pass. No fabricated candidate IDs,
  cross-conversation selection, unregistered calls or overspent configured budgets.
- Run each model scenario five times per model/configuration (135 sessions for v1).
  Report counts and rates per stage, model, partition and case; no pooled score that
  hides a failing sport or resource class.
- At least 90% correct applicable intent/resolution/temporal/answer outcomes in each
  stage and partition, with no case below four correct runs out of five. This is a
  provisional demo gate, not evidence of production reliability.
- Zero observed unsupported factual claims, internal-ID requests when lookup can
  resolve the name, cross-user evidence leaks, or unsolicited sport substitutions.
  A failure blocks the demo gate even if aggregate scores pass.
- For held-source tests, another simple conversation turn must complete before release;
  cancellation must prevent later publication. Measure live latency separately and
  report waits by resource rather than assuming local/cloud/API latency rankings.

Retain fixture version, corpus version, registry/config revision, model identity,
input context, validated plans, candidate snapshots, tool arguments/results, request
counts, admission decisions and timings under existing capture/retention controls.
No chain-of-thought capture is required. Review partial answers separately from fully
answered requests. Grammar correction is not a separate gate; meaning-preserving typo
handling and clarification of genuinely ambiguous entities are.

## Validation of this foundation

616 tests / 80 files and TypeScript build passed. Eight new contract tests cover
selection ownership/revisions, chronology, partial results, completed-game semantics
and corpus partition coverage. No live model/provider calls or end-to-end scenario
grading was performed. Runtime wiring and browser behavior are unchanged.
