# Request-to-evidence contracts and acceptance gates

Status: operation contracts and provider-backed NBA/NFL team resolution are implemented.
Team-list payload/context separation and direct table delivery are now implemented.
Minimal topic browsing with scoped conversations and opt-in team references is
implemented. General game search, synthesis and the end-to-end evaluation runner remain pending. The ordering below supersedes earlier
latest-game-first plans. This is a plan update, not a runtime implementation claim.

## Current implementation and immediate next slice

The live TypeScript capability planner now recognizes `tool-result-v1`: only its
compact context enters answer text/history, while its table payload and evidence
travel in a separate timeline field for UI rendering/replay. Legacy tools still
return their previous text/JSON results; migration is incremental. The Python
LangGraph experiment remains separate from the live sports application.

Implemented slice: `sports:list-teams` plus direct UI directory browsing. The latter
calls no model and does not attach data to the conversation. Model-requested lists
render tables alongside compact result metadata. `POST /sports/results` retrieves an
immutable result by user/conversation-scoped handle. Stores are bounded, process-local,
expire with directory evidence and clear on reload/close. Timeline snapshots already
delivered remain historical records; handle expiry does not erase those records.
Existing development-server caller-supplied identity is used; this is not a new
authentication layer. Production authentication remains a separate concern.

Evaluation recording hashes payloads independently; opt-in answer capture retains
redacted envelope content separately from model answer text under existing byte limits.
Direct UI browsing does not create model evaluation events. Explicit attachment and
bounded model reference reads are still pending with the topic workflow.

Topic UI now derives sport/league choices from configured directories and teams from
provider records. Opening a new conversation freezes its scope; browsing remains
independent. An unchecked checkbox can attach only the selected team record. Server
validation uses owned result handles and matching directory revisions. Expired
reference fields are omitted from subsequent model inputs. This is process-local
state with a 100-conversation cap, not durable topic/profile memory.

Manual per-run model pins, verified Ollama thinking overrides and explicit text
review/revision actions are now implemented. Explicit bounded table-row attachment/detachment and selected-row payload review are
now implemented. Next executable slice: general game search and specific-game details. Reference selection now supports three owned table results, up to 20 rows per result
and 16,000 evidence bytes. Users can detach table rows or the initial team reference.
Other payload types and cross-conversation reference sharing remain pending.
Declare the directory scope honestly: current-team filtering is not established by
NBA's historical directory. Do not label the list current-only without evidence.

Separate result destinations:
- Model context: compact status, scope, coverage, relevant limitations and a result handle.
- User payload: typed table/card/document data delivered directly to the UI.
- Evaluation record: execution inputs/settings, provenance and a versioned payload
  reference sufficient to inspect the actual result without injecting it into prompts.

Handles must be scoped to the authenticated user/conversation, with revision and
expiry semantics. A later turn must not accidentally serialize payloads into model
history. Expose bounded reference views when reasoning actually needs evidence.
Record delivery separately from retrieval success; a produced payload is not proof
that the client displayed it. No automatic second model call for simple display.

## Near-term implementation order

1. Result separation and direct team-list delivery, including follow-up context tests.
2. Minimal topic navigation: configured sports/leagues and provider-backed teams,
   leading to relevant data views and a topic-scoped conversation. The hierarchy is
   a browsing aid, not a requirement to encode every semantic relationship. Existing
   conversations retain their scope when the user browses elsewhere.
3. Explicit reference attachment and manual run controls: supported model/thinking
   settings, user-defined scope/retrieval bounds, review off/self/selected model,
   and an explicit revise-from-feedback action. No automatic complexity classifier,
   reviewer selection or revision loop. Record the effective settings per invocation.
4. General game search and specific-game details. Latest completed is a supported
   selection/composite over this foundation. Tools own identity resolution, pagination,
   completion checks, date filters and bounded search under the applicable resource policy.
5. Game-specific reporting and grounded synthesis when requested. League RSS alone
   does not establish a game's recap. Preserve partial coverage and citation provenance.

Deterministic and conversational evaluations accompany every slice. The larger
27-case specification still needs executable fixtures and a session runner; no
end-to-end quality score is claimed. Existing contracts remain useful and should be
extended rather than replaced with prompt-specific operations.

## Longer-term direction and memory

Layer 1 manages the user while background tasks retrieve, analyze or review evidence.
A conversation activity panel exposes topic/task/reference/model-call identities,
actual model context, tools/cache/admission events, settings, delivery, reviews and
available latency/usage. A separate analytics dashboard is not an initial requirement.

Add editable persistent profiles for exact user-confirmed settings and preferences.
Add semantic retrieval over saved discussions, notes and references to discover
useful context without manually linking every related item. Start with a manual
“Find relevant context” action and selectable results. Topic filters are optional;
semantic similarity is relevance evidence, not proof of a favorite team or other fact.
Retain explicit IDs for ownership, provenance and deliberate attachments.

Inspect Hekate's existing vector/storage implementation before choosing reuse or a
new dependency. LangGraph Store is a candidate cross-thread storage interface where
LangGraph is used; LangMem is a candidate for later optional profile suggestions.
Neither has been selected or integrated into the live TypeScript application. Do not
make the UI depend on a Python memory service merely because the experiment uses Python.

Later, evaluate automatic context selection, profile suggestions, background briefings,
review policies and bounded revision loops. Durable multitask execution and expansion
to email/other domains remain longer-term work. Payload separation and reference
contracts should be domain-neutral. Automation should follow evidence from manual runs.

## Review versus measurement

Production self-review or independent review can improve outputs; it is part of the
workflow being measured. Reviewers receive only the evidence needed for their task,
which may include payload content the conversational model never saw. Record draft,
review findings and explicit revisions. Review agreement is not factual verification.
Compare review-off/self/cross-model and supported thinking configurations on quality,
cost and latency; evaluate the resulting workflow independently. Service quotas,
cancellation and resource-specific policies apply to every configuration.

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
