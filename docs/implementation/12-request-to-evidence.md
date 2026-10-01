# Request-to-evidence contracts and acceptance gates

Status: operation contracts and provider-backed NBA/NFL team resolution are implemented.
Team-list payload/context separation and direct table delivery are now implemented.
Minimal topic browsing with scoped conversations and opt-in team references is
implemented. Bounded game search and snapshot details are implemented. Grounded synthesis and the end-to-end evaluation runner remain pending. The ordering below supersedes earlier
latest-game-first plans. Implementation limits are documented below.


## Bounded game operations — 2026-09-30

`sports:find-games` resolves provider team names or owned candidate selections and
searches an explicit ISO timestamp window (maximum 31 days), optionally filtering
status. `latest_completed` scans configurable backward windows and returns the most
recent final with scores found by start time. Each window reads one provider page;
coverage remains partial, including empty results. This does not establish the actual
latest game, latest completion, or absence of games. Unsupported leagues remain explicit.

`sports:game-details` and the direct UI display basic details from a selected issued
search row. Details are a snapshot, not a fresh request or box score. Results use the
existing owned/expiring payload handles, selected-row attachment and source provenance.
The direct UI needs no model. Shared provider admission/cache remains in force.
`gameSearch` config controls leagues, window days/count, result TTL, row limit and
snapshot count; reload invalidates handles and aborts active operations.

Next: role containers with enforced tool exposure, then manual budget visibility
and the framework comparison below, before broader grounded reporting. Still pending: dependent tool
loops, richer statistics/reporting, pagination/exhaustive temporal selection, user-friendly
ambiguity selection in the game browser and payload-specific quality scoring. The browser
fixture now uses a 16K model context because the full registry exceeds its former 8K
budget after output reservations. Runtime admission remains unchanged; compact registry
exposure is needed for smaller context models.

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
Direct UI browsing does not create model evaluation events. Explicit bounded row attachment is implemented.

Topic UI now derives sport/league choices from configured directories and teams from
provider records. Opening a new conversation freezes its scope; browsing remains
independent. An unchecked checkbox can attach only the selected team record. Server
validation uses owned result handles and matching directory revisions. Expired
reference fields are omitted from subsequent model inputs. This is process-local
state with a 100-conversation cap, not durable topic/profile memory.

Manual per-run model pins, verified Ollama thinking overrides and explicit text
review/revision actions are now implemented. Explicit bounded table-row attachment/detachment and selected-row payload review are
now implemented. Bounded game search and snapshot details are implemented; next is role containers and focused tool exposure. Reference selection now supports three owned table results, up to 20 rows per result
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

## Active plan: role containers and focused execution — 2026-09-30

This order supersedes earlier next-step entries. Team browsing, manual controls,
reference attachment, game search and snapshot details are implemented. Review fixes
for game operations are tested but uncommitted. The first role-catalog/API slice is implemented; the role UI and framework adapter
remain pending. The live TypeScript planner and Python LangGraph experiment remain
separate; the experiment's durable single-task checkpoints do not make live sports
jobs durable.

A role is a versioned execution container: model/provider binding, instructions,
allowed tool IDs, context/reference policy, supported thinking settings, resource
limits and output contract. A task is an invocation of that role with a request and
selected evidence. Model choice is part of the role definition; variants can choose
different models. This is application configuration, not an OS isolation boundary.

### 1. Role contract and enforced tool exposure — implemented first slice

Introduce a validated, server-owned role catalog. Resolve tool/model identifiers
against existing registries; do not place credentials or executable code in role
files. Start with configurable sports-research, evidence-writing and review roles.
No fixed team-name routing. Writing/review roles can have no tools.

Freeze the role version and effective configuration at invocation start. Reloads
apply to new tasks; running tasks retain their captured definitions, subject to
existing service shutdown/cancellation. Make permitted manual overrides explicit;
record both the selected role and final effective configuration. Unknown roles,
models, tool IDs and unsupported thinking settings fail before generation.

Use the same allowed tool set for model exposure, plan validation and execution.
A tool omitted from the model prompt must also be rejected by the executor, including
mixed plans containing allowed and excluded calls. Role limits cannot increase
account-wide allowances. Preserve current local/Ollama cloud/API/CLI admission
policies and shared sports quotas. Direct UI browsing remains independent of model
tool exposure and retains its existing service-side controls.

Acceptance: excluded tools never execute, tool-free roles reject tool calls,
config/model validation fails safely, overrides cannot widen permissions unnoticed,
reload cannot mutate an in-flight role, and payloads remain outside model context
unless explicitly selected. Test unfamiliar synthetic entities, not team keywords.

Implemented interface: set `ROLE_CATALOG_PATH=data/roles/sports.example.json` to load
an opt-in catalog at startup. The example uses `fixed` for the configured provider;
catalog-routing deployments must set valid enabled fast-binding IDs instead. Loading
a role catalog does not make fixture/mock providers factual. The existing unselected
planner remains available when no `roleId` is supplied; this is task configuration,
not an application-wide authorization system.

Send `runControls: {roleId: "sports-researcher"}` through the existing chat APIs.
Optional `toolIds` narrows the role's tools; `bindingId` overrides require an explicit
role allowlist, and thinking overrides require role permission. `configured` uses
the role's thinking default. Role versions/effective configuration are captured on
the timeline; evaluation records hash the snapshot and retain redacted content only
under answer-capture policy. The output contract is currently `capability-plan-v1`;
context policy is currently conversation history plus explicitly selected references.
Limits currently add estimated input tokens and tool-call count to existing provider
admission. Arbitrary output contracts and independent role deadline policies are not
implemented. The role schema does not accept executable code or credentials.

The catalog supports atomic replacement programmatically, and each invocation captures
its role/tool definitions before awaiting work. No role-file reload endpoint or watcher
is exposed yet; changing the configured file requires restart. Service closure can
still cancel tools captured by an existing role. Runtime model/tool IDs are checked
when selecting a role, so a sports config change can invalidate a role for new calls.

### 2. Manual role UI and context-budget visibility — next implementation

Select a role and inspect its model, tools, instructions, evidence policy and limits.
Optional overrides create an explicit effective configuration rather than silently
editing a saved role. Topic navigation may suggest a role, but does not automatically
switch the active role or change conversation scope. Expose individual allowed tools
inside expandable groups; disabling tools narrows the selected invocation.

Show estimated tokens for instructions, tool definitions, history, selected evidence,
output reservations and safety margin. Distinguish estimates from provider-reported
usage. Review the current maximum fast/deep output reservation against the actual
execution path; do not simply remove headroom. Reject requests that cannot fit before
invoking the model and offer explicit scope/history/evidence reductions.

Acceptance: focused roles fit a defined 8K fixture with reserved output and selected
bounded evidence; genuinely oversized input still fails. Add a canary proving unrelated
tool schemas and unselected payload rows never enter the prompt. Record the actual
exposed tool IDs and configuration version for each call.

### 3. Bounded LangChain/LangGraph integration comparison

Inspect installed dependencies and existing Hekate/provider bridges first. Implement
one opt-in execution adapter for the sports-research role in the live application's
language/runtime where practical, using LangChain's agent building blocks and
LangGraph only where workflow control is needed. Preserve the application-owned role
schema so it configures execution rather than becoming tied to one framework API.

Compare against the existing planner with deterministic fixture sources and the same
role/model/evidence contracts. Explicitly bound any new dependent model/tool loop;
account for every call and honor cancellation/deadlines. Adapt the existing CLI bridge
where needed; do not assume standard model integrations cover subscription CLI access.
Use OSS libraries on our own infrastructure. LangSmith/cloud deployment is optional;
no hosted tracing or external evaluation upload is required for this slice.

Deep Agents is a candidate to inspect, not an adopted dependency: its added tools,
prompts and automation must be evaluated against exact role allowlists. Decide whether
to expand framework adoption from parity evidence, rather than replacing the working
runtime wholesale. Required parity includes ownership/expiry, payload separation,
admission, cancellation, model pinning, role/tool enforcement and trace attribution.

### 4. Grounded reporting and role-specific evaluation

Build the selected-game evidence writer and explicit self/cross-model review workflows.
Keep role-level deterministic tests from step 1; add conversational quality measurement
here. Compare role/model variants with identical task inputs and evidence. Record
role version, effective settings, exposed tools, input context, tool results, output,
provider usage, waits and latency under existing capture/redaction policies.

Measure scope/identity resolution, temporal selection, evidence sufficiency, grounded
claims and unsupported requests separately. Include small-model role variants, tool
exclusion attacks, partial/unavailable results and unrelated payload canaries. Use
synthetic provider names/IDs; no production prompt matching against evaluation cases.
Independent grading evaluates the whole workflow, including any production review
and revision. Human-calibrated model grading supplements deterministic checks; it
does not turn successful execution into factual correctness.

The 27-case specification still needs executable fixtures and a session runner.
No end-to-end quality score is claimed. A league news feed alone does not establish a
game recap; preserve partial coverage and source provenance.

### 5. Layer-one coordination and multiple background tasks

Layer one owns the user conversation; selected role instances perform focused work.
Begin with explicit user launch/cancel/review actions and visible task progress. Define
job identity, input snapshots, result handles, cancellation and completion delivery
before automatic delegation. The user must be able to continue a separate conversation
turn while a worker is held, and late results must remain attached to the originating
task. Do not merge complete worker transcripts into the conversation manager's context.

Role execution is not itself a durable scheduler. Add persistence and restart/replay
semantics deliberately after the manual execution path works. Automatic role choice,
complexity classification, reviewer selection and escalation remain deferred.

Framework references for this plan:
- [LangChain agents](https://docs.langchain.com/oss/python/langchain/agents)
- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [Subagent patterns](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)
- [Deep Agents subagents](https://docs.langchain.com/oss/python/deepagents/subagents)

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
