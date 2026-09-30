# Personalized NBA briefing demo

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


Current increment (2026-09-30): provider-backed NBA/NFL team directories are wired
into the live tool registry, with configurable cache/selection limits, shared
account admission, and conversation-bound candidate selection. Directory capability
is separate from game/news capability. Next is bounded latest-completed-game
composition; the end-to-end acceptance example is still pending. See the latest
[handoff](implementation/NEXT-HANDOFF.md) for verification and limitations.


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


## Next priority: tools that accept user-level requests — 2026-09-30

User feedback: asking for the Patriots' provider ID exposes unfinished integration
work to the user. Prioritize richer tool contracts before more planner prompting,
topic-specific routing or the task-board UI. This ordering supersedes the next-step
recommendations in earlier journal entries. The following work is planned, not shipped.

Target request: “What happened in the Patriots' last football game?” Resolve the team,
find its latest completed game, retrieve available supporting evidence, and explain
the result with citations. Do not require the user to know provider IDs or supply a
date for an unambiguous latest-completed-game request.

1. **Provider-backed team resolution.** Verify the provider's team-directory access
   and coverage first. Accept league plus a team name/alias and return a unique
   provider-qualified identity, multiple candidates, no match, or source unavailable.
   Cache directory evidence with configurable expiry. Derive matching from provider
   data and validated normalization; do not introduce a Patriots/Sox keyword table or
   let the model invent IDs. Ask a user to choose only when multiple plausible teams
   remain. A failed directory read must not be reported as no matching team.
2. **Latest completed game operation.** Expose a contract such as
   `find_latest_completed_game(league, team, as_of?)`. The tool resolves the name
   internally, defaults as-of to the server clock, and searches backward within
   configurable windows/page/request/deadline limits. Use completed status, timestamps
   and source coverage to select the result; exclude scheduled, in-progress, postponed
   and cancelled games. Include resolution and game provenance, query scope and limits.
   If coverage is insufficient, report the most recent game found with that limitation
   rather than certify it as the latest. Bound offseason searches. A genuine local-date
   request can require timezone context; latest completed ordinarily does not.
3. **Integrate through the existing capability registry.** Keep provider IDs, date
   filters, pagination and request coordination inside tools. Directory and game calls
   must share the account's rolling request budget. Define explicit bounded waiting or
   retryable rate-limit outcomes so quota exhaustion is never confused with no game.
   Preserve cancellation, foreground conversation and configuration reload semantics.
   This composite tool does not require a general dependent-plan engine first.
4. **Evidence-backed answer generation.** After retrieval, produce a readable answer
   with source links. Scores establish the result; narrative claims about what happened
   require supporting evidence. If only a score is available, say so. Preserve partial,
   stale and unavailable states; no invented recap. Do not offer an unrelated supported
   sport as a substitute for an unsupported request.
5. **Evaluate the complete interaction.** Combine deterministic tool tests with
   repeated model evaluations of paraphrases and follow-ups. Gate the demo on resolving
   a named team without asking for an internal ID, retrieving the correct completed
   game within budget, and answering only from returned evidence. Record traces and
   configuration/model versions. Runtime completion and factual quality remain separate.

Division of responsibility: the model interprets intent, chooses operations and
explains evidence; tools implement domain operations; runtime code enforces schemas,
budgets, cancellation and execution limits. Feed URLs, cache expiry, search bounds and
source policies remain configuration. General web search, MLB, persistent memory,
dependent model plans and topic-board UI remain later work. Review and evaluate each
slice as implemented; this plan update changes no runtime behavior.


## Model capability planning replaces live keyword routing — 2026-09-30

Live `startServer` chat now uses `CapabilityChat` through the shared ChatService,
including `/messages` and protocol-v1 submission. Fixed mock-only startup retains the
legacy pipeline for compatibility; old router/classifier modules and their tests remain.
Removed `sports/chat.ts`, canned topic interception and the sports-only confirmation
card. All live requests go to a model with conversation history and an injected tool
registry. Clarification and unavailable responses stay in the ordinary timeline.

The model chooses strict JSON: answer, clarify, unsupported (with missing capability),
or retrieve with at most three independent read-only calls. Registered tools expose
scope/input schemas/limits. Validate the whole plan and every tool argument before
executing any call. No keyword routing, adaptive complexity classification, task regex
selection or fabricated confidence runs on this live path. The planner itself selects
an eligible conversation model through the normal catalog admission path when enabled.
Confidence is null. Raw plan deltas never render as answers; the validated plan is
stored with its user-facing timeline event. Truncated/malformed plans fail explicitly
without tool execution or a fallback answer.

Retrieval runs in background generation attempts, supports cancellation, and allows
another turn before completion. Results retain source data, coverage, freshness and
errors. Display is bounded to 60,000 characters with an explicit truncation notice.
The current result is evidence, not an automatically synthesized narrative. Generic
executor tests also exercise a non-sports tool; only configured sports tools are
currently registered by the application. Registry snapshots become unusable after a
briefing configuration reload rather than silently running under changed source settings.

Planning uses bounded original conversation history and active tasks. Derived summary
memory is deliberately bypassed on this path so the old keyword-based correction and
constraint-conflict rules do not influence planning. This sacrifices older compressed
context until semantic memory handling is designed. Existing heuristic modules are
still used by the legacy/mock pipeline and have not been deleted repository-wide.
Deep model reasoning delegation, dependent tool chains, semantic team-ID resolution,
general web search and authoritative factual grading remain unimplemented.

Live Qwen3:8b checks: Red Sox and email requests selected unsupported; an NFL relative-date
request asked for timezone; an explicit UTC NFL query selected `nfl:league:games` and
returned one game with partial coverage/unknown freshness. The initial retrieval plan
hit the configured fast output limit; no tool executed. Raising the launch's
`OLLAMA_FAST_NUM_PREDICT` to 1024 allowed it to complete. One diagnostic model call
confirmed truncation. The preview remains live Ollama/fixed routing (Claude usage
inspection is unavailable); `.env` was not modified. Six live model calls and one
BALLDONTLIE request were used for these checks. These are smoke checks, not a quality
benchmark. See `reports/capability-planning-smoke-2026-09-30.json`.

Validation: 608 tests / 79 files, nine browser tests and TypeScript build pass.
Next: review/evaluate plan correctness across paraphrases, unavailable capabilities,
ambiguous context and misleading history; then add general retrieval and dependent
workflows through the same registry. Do not add topic-specific routing keyword lists.


## Sports chat safeguard and capability-planning direction — 2026-09-30

Recognized sports questions now bypass mock/model completion. MLB/Sox requests explain
that no baseball source is connected and identify unresolved team/date context.
Configured NFL/NBA requests display an explicit evidence form: league, operation,
optional provider-qualified team, ISO timestamp window and timezone. Confirming calls
`POST /sports/chat`, collecting only the matching configured task scope/source kind;
status/cancel reuse `/briefings`. Source records, links, coverage and errors are shown
without claiming a generated recap. Other chat remains usable during retrieval.
Mock completed turns are labeled simulation complete/facts not verified, with a
runtime notice when mock providers are configured.

This is a deliberately limited keyword safeguard, not general natural-language
routing, team resolution or conversational clarification memory. Unrecognized intents
still use the normal model path. Sports cards currently live only in browser memory,
are separate from the durable conversation timeline and disappear on page reload.
Users must provide explicit ISO timestamps; “last night” is not silently resolved.
No live model or generic search tool was connected by this change.

User direction: avoid a bespoke workflow for every topic. Next architectural step is
capability-based planning: describe tool inputs, supported scope, freshness and limits;
let the model propose work; validate scope, budgets and available tools before running.
Distinguish executable requests, actionable clarification, and missing capabilities.
Use generic web retrieval only when a suitable tool is actually configured, and retain
source evidence. Missing capabilities must not turn into unsupported factual answers.
Then present those plans/tasks and follow-up evidence in the topic-oriented UI.

Validation: full existing 600-test suite plus the new HTTP scenario passed (601 tests
across those runs); TypeScript build and ten browser tests pass. Tests cover the Sox
unsupported response, confirmed evidence retrieval, league mismatch, disabled sources,
mock completion labels and continued composer availability. No live sports API/model
calls were needed.


## Manual live configuration reload — 2026-09-30

Added `POST /briefings/config/reload` with an empty JSON object. It rereads the
startup-configured file only; clients cannot submit paths, keys or configuration.
Reloads are serialized, validated before publication and return `{version, changed}`.
Invalid edits return a safe error and retain the working configuration. Identical
parsed configurations are no-ops. The version is a SHA-256 digest of validated
configuration, including defaults, and is attached to new run snapshots as
`configVersion`; credentials are excluded. Consumers/evaluations can retain this
version with the run. This does not add automatic evaluation recording.

Existing queued/running jobs retain their adapters, profiles and deadlines. Status,
cancel and same-request retries still address old runs after reload. New runs use
new source instances and empty caches, so feed URL changes cannot reuse old evidence.
The same account budget survives all adapter replacements: rolling request history
and provider cooldowns cannot reset. New rate limits constrain admissions immediately.
Coordinator concurrency and retained-run capacity are also global admission settings:
lowering them does not cancel active work or evict retained runs. New task deadlines
apply only to new jobs. Increasing concurrency can release already queued work.

The API key, configuration-file path, listening port and other application settings
remain startup configuration. No `.env` reread, file watcher, UI button or automatic
refresh was added. This endpoint follows the existing local prototype HTTP access
boundary; it is not an authenticated production administration interface. Injected
briefing instances have reload disabled unless explicitly supplied a reload callback.
Closing the runtime prevents reload from reviving it.

Validation: 600 tests / 78 files and TypeScript build pass; browser regression checks
also pass (eight tests). Tests cover file reload/rollback, serialization, no-op,
versions/retries, retained budgets/cooldowns, in-flight source isolation, shutdown,
and HTTP rejection of client overrides. No live provider quota was consumed.
Next: task UI and evidence-backed follow-ups; bounded delayed admission when the
request budget is exhausted remains separate work.


## Live briefing composition — 2026-09-30

`createLiveBriefing` now composes one shared BALLDONTLIE registry, configured RSS
feeds, the coordinator and HTTP boundary. Opt in with
`SPORTS_BRIEFING_CONFIG_PATH=data/sports/nfl-live-briefing.example.json`; restart the
server to load it. No live setting was added to the user's `.env` and the existing
preview was not restarted. Startup validates configuration without fetching data.
The key remains separate in `BALLDONTLIE_API_KEY`. Missing credentials do not disable
news. Explicit dependency injection takes precedence over environment configuration.

The example has independent league-games, league-news and team-games tasks. An
unknown team needs input; ESPN league news is never presented as team-specific news.
Source IDs/kinds/leagues/scopes and games catch-up limits are validated before work.
Task limits and shared budget/cache settings are configurable within existing caps.
RSS requests do not consume the BALLDONTLIE budget. Feed caching is not yet wired.

Per user correction, the default games budget now permits bursts of up to five starts
in a rolling 60-second window. There is no mandatory 12-second spacing; optional
`minIntervalMs` defaults to zero. Each reservation expires at 60 seconds. The same
budget covers NBA/NFL and league/team requests; RSS uses no game reservations.
The sixth request is rejected until capacity returns, while cache hits remain usable.
Provider 429 cooldown is unchanged. The coordinator currently reports rejected
admission as `SOURCE_READ_FAILED`; bounded delayed retry remains future work.
Historical entries below describe the superseded spacing policy.

Validation: 594 tests / 78 files, eight browser tests and TypeScript build pass. New composition tests
cover attributed evidence, idempotency, absent credentials, shared budget behavior,
invalid mappings, opt-in loading and cancellation. No live network/model requests
were needed. Existing HTTP tests cover foreground interaction while tasks run.
The endpoint still uses prototype user IDs and caller-supplied as-of timestamps;
operational server clocks/authentication remain production-boundary work.

Next: task UI with explicit start/status/cancel, evidence links and partial/failure
states; source-backed model follow-ups and bounded delayed admission when the budget is full remain
separate work. No automatic refresh, durable state, ranking or team-news inference
is implemented by this composition.


## RSS news ingestion — 2026-09-30

Adapted the forex application's configurable RSS ingestion pattern into TypeScript's
`RssNewsSource`, using the existing sports evidence contract. The forex repository
is unchanged. Reused article normalization, URL deduplication and time-window
filtering; did not copy currency classification, database coupling, missing-date
fallbacks or neutral-on-error behavior.

Run `npm run sports:news -- data/sports/espn-nfl-rss.example.json 24` explicitly.
Feed URL, publisher, league, optional provider-qualified team, timeout, body size
and item limits are configurable. Configuration is server-owned, not user-supplied
URL fetching. RSS 2.0 is supported; Atom is not. No full article scraping or model
classification is performed. Preserve publisher attribution and original links;
see [ESPN RSS information](https://www.espn.com/espn/news/story?id=3437834).

Missing publication dates stay unknown and are excluded from bounded windows.
Explicit RSS timezone abbreviations use their stated offsets, including EST versus
EDT; the adapter does not guess that a publisher meant a different timezone.
Future-dated entries are excluded and disclosed. Empty successful feeds remain
distinct from unavailable/invalid feeds. Excerpts may be empty, and source content
must be treated as untrusted evidence by downstream models/renderers.

RSS cannot establish exhaustive window coverage or source freshness: results remain
partial/unknown, never advance checkpoints, and the CLI intentionally exits 1.
League feeds cannot answer team-scoped requests unless explicitly configured for
that team. Retrieval is bounded and abortable; redirects and XML entity declarations
are rejected. Shared caching, scheduling and retries are not wired for RSS yet.

Live verification at 2026-09-30T18:45:37.892Z returned 12 articles in the previous
24 hours, with future publication times disclosed. Three public feed requests were
used during debugging/verification; no BALLDONTLIE quota or model calls were used.
Validation: 587 tests / 77 files and TypeScript build pass.

Next: compose the games/news adapters into a live briefing registry and profile,
then expose task progress and evidence in the UI. Team relevance and significant-news
ranking remain separate work; this adapter does not claim either.


## Shared request admission and cache — 2026-09-30

`createBalldontlieSources(key, options)` returns `nba-games` and `nfl-games` adapters
sharing one process-local account budget. Reuse this registry across league/team
coordinators; creating a second registry or CLI process creates a separate budget.
The explicit games CLIs now use this composition. Server activation remains opt-in.

Defaults enforce at most five starts per rolling 60 seconds plus 12-second spacing.
The boundary is conservative: a start exactly 60 seconds old still counts. Failed
and cancelled admitted reads consume their reservation. Denied admission throws
`SPORTS_SHARED_RATE_LIMIT` immediately; it does not wait, retry or silently refresh.
A provider rate-limit response adds a shared 60-second cooldown. The coordinator
currently represents thrown admission errors as `SOURCE_READ_FAILED`; richer retry
scheduling/UX remains future work. This does not coordinate other applications or
processes using the key.

Successful available evidence is cached for 15 seconds by exact league, operation,
team, window and limit. Reuse does not rewrite retrieval or source update times;
freshness is re-evaluated using current/read time and the caller's age budget. Unknown
freshness remains unknown. Partial evidence may be cached but stays partial; errors
and unavailable responses are not cached. Entries default to a cap of 20 per adapter.
Different team queries cannot borrow an incomplete league page. Moving time windows
are different scopes and miss this cache; no approximate query widening is implied.

Concurrent identical reads share one underlying operation. A caller cancelling stops
its wait; only the last departing waiter aborts the underlying signal. Late results
from an abandoned operation cannot enter cache. Noncooperative operations retain
pending slots until settlement (default cap four per adapter), preventing unbounded
pending work. Pending-capacity errors are explicit. The existing adapter timeout
still bounds cooperative transport operations.

Limits/TTL/cache/pending capacities are validated configuration. Rate settings can
be made stricter, not raised beyond this free-tier ceiling. Tests use controlled
clocks and synthetic transport; this slice made no live requests or account changes.
Next: news ingestion, then task UI and source-backed model follow-ups. Automatic
refresh should not be enabled until admission-denied work has an explicit scheduling
policy and the required sources are available.


## 2026-09-30: NFL is the first active-season live target

NBA remains supported. The user requested NFL access using the existing account.
The [account documentation](https://www.balldontlie.io/account/) says one account
starts with free access to NBA/NFL/MLB/EPL; per-sport paid tiers do not require separate
accounts. A single authenticated NFL games request succeeded and normalized 16 games
in a seven-day window. [Recorded access evidence](../reports/nfl-access-check-2026-09-30.json)
contains timestamps, scope, counts and limitations without credentials. No account,
subscription or key changes occurred. This corrects earlier uncertainty about whether
the same key could access NFL.

The shared bounded games adapter accepts `league: "NFL"`; it uses the documented
`/nfl/v1/games`, `dates[]` filter and `date` timestamp field rather than NBA's fields.
See [NFL source contract](https://nfl.balldontlie.io/#get-all-games). NFL team identities
use `balldontlie-nfl`; NBA retains `balldontlie`. Queries carry an optional league
(default NBA for compatibility), and coordinator queries explicitly carry the profile
league. Cross-league adapter requests and NBA fixture reuse for NFL are rejected.

```bash
npm run sports:nfl -- 168
npm run sports:plan -- data/nba-briefing-request.example.json data/sports/nfl-games-profile.example.json
```

The first command uses the server clock and the existing `BALLDONTLIE_API_KEY`.
The second is an offline plan with a fixed example clock and no selected team.
`nfl-games-profile.example.json` configures a seven-day initial lookback and two
explicitly games-only tasks; it does not pretend games replace news/availability.
Register an NFL-configured adapter as `nfl-games` when composing that profile.
Do not use the NBA fixture registry for it.

Existing one-page, unknown-freshness and preseason-exclusion limits remain. The live
CLI's nonzero exit reports incomplete coverage, not failed authentication. Local
request spacing is per adapter instance, not account-wide or shared between separate
CLI runs. Keep combined traffic within the user's five-per-minute allowance.
Next: news ingestion, bounded shared caching/request admission, and task UI/model
follow-ups. No further access prerequisite is needed for the verified NFL games path.


Decision journal — 2026-09-30. The user selected sports as the concrete workflow
for ongoing interaction, background work, relevant memory and fresh evidence.
This supersedes waiting for every spec 06 comparison before starting domain work.
Outstanding runtime/evaluation gates remain open; sports is not proof they passed.

## Product scope

On app launch or explicit Start briefing, prepare a league briefing and a selected
team briefing. Layer 1 remains available for questions while work is queued or
running. Publish each section independently with its coverage period, source links,
retrieval times and limitations. No scheduled refresh or email integration yet.
Do not equate app refresh with permission to duplicate work: launch integration
must deduplicate requests and offer explicit Refresh.

Remember an explicitly selected NBA team and timezone first. Do not infer that
Boston is the user's preference from earlier Sox examples. Until selected, league
work can proceed while the team task asks for input. Store preferences separately
from scores/news. Memory frameworks are reuse candidates, not dependencies selected
or installed: [Mem0 Node](https://docs.mem0.ai/open-source/node-quickstart) for the
main runtime, [LangMem profiles](https://langchain-ai.github.io/langmem/guides/manage_user_profile/)
for the separate Python experiment. Start with explicit settings; automatic memory
extraction and a comprehensive profile editor are unnecessary for this milestone.

Task discussions belong in a forum-like topic/thread workspace: NBA league, chosen
team, and substantial follow-up investigations. Quick follow-ups stay in the existing
thread. Surface current state, unread results and requests for input. Historical
latency buckets move to optional diagnostics. This UI is planned, not implemented.
A durable conversation index and storage decision precede a claim of persistent
threads. Existing runtime history remains process-local.

## Sources and tools

Source reconnaissance on 2026-09-30:

- [BALLDONTLIE NBA documentation](https://docs.balldontlie.io/) describes structured
  games and player-injury endpoints with API-key authentication. It is a candidate
  for game data, not an adapter already connected here. Verify chosen endpoint
  entitlements, limits, freshness and usage terms before live integration; do not
  assume every endpoint is free or that an existing account/key is available.
- [NBA news](https://www.nba.com/news) is a primary news source. A public website is
  not a documented ingestion API or a completeness guarantee. Choose and test the
  ingestion method separately; retain links and concise supported summaries.
- Keep news and structured game data as separate adapters. Official team/league
  announcements can support roster/availability statements; label other reporting
  and conflicts. A games feed alone cannot produce a complete news briefing.

Initial adapter operations: resolve team identity, list games, list news and obtain
availability evidence. No GraphQL requirement. Each operation accepts explicit
scope/window and bounded limits and returns source identity/URL, retrieval time,
source publication/update time when known, and explicit coverage/error state.
Game records need provider-qualified team/game IDs, start time and status; a score
must not be presented as final unless the source says final. Unknown update time
remains null. No invented live data or claims that a search covered all NBA news.

Context resolution uses the message, active thread and explicit preferences.
Retrieve current evidence after resolving identity/timeframe; ask only for material
ambiguities. Check schedule ambiguity and timezone boundaries. A remembered team
helps interpret shorthand but current explicit intent overrides it. External news
prominence does not establish user intent. Follow-ups reuse suitable evidence or
refresh it; they must disclose unavailable or stale support.

## Implemented first slice: deterministic briefing planner

`npm run sports:plan -- data/nba-briefing-request.example.json` outputs a versioned
plan. The example is a fixed-time fixture, not a request for today's live briefing.
Inputs are an explicit timestamp/timezone, optional provider-qualified team, and
independent last-success coverage timestamps for league and team. Callers must load
checkpoints for the selected user/team/source configuration, never reuse a previous
team's checkpoint after a preference change.

Two independently addressable tasks are produced. League planning remains ready
when the team is unknown; the team task is `needs-input`. Ready means ready for
execution, not fetched or completed. Time windows are UTC instants with the user's
IANA timezone retained for interpretation/display. Initial lookback is 24 hours;
catch-up is capped at seven days with explicit truncation. Bounds are inclusive
start/exclusive end. Invalid or future timestamps and invalid timezones are rejected.

The caller supplies `now` from its clock in a live invocation. Only advance a
checkpoint to the covered-through bound after the corresponding sources complete
successfully; never to completion wall time, which would create a gap. Partial
coverage must not advance a full-section checkpoint. A live adapter also needs a
bounded overlap/deduplication strategy for delayed publications and corrections.
An upcoming-game query uses a separate forward window; this retrospective planner
does not yet plan it. Task IDs are local to a plan; execution must namespace them
under a unique briefing run ID.

No network fetching, worker scheduling, persistent writes, model calls or UI launch
hook is introduced by this slice. It is the testable entry contract for the demo.

## Implemented source slice — 2026-09-30

`src/sports/sources.ts` defines validated game, news and availability evidence,
bounded queries and an asynchronous source interface with cancellation support.
`FixtureSportsSource` reads the three explicitly fictional datasets in `data/sports/`.
No NBA news or real game results are represented by these fixtures. Team selection
uses a provider-qualified identity and an explicit supported-team catalog; unknown
identities fail instead of producing a misleading empty result.

Results keep coverage (complete/partial/unavailable) separate from freshness
(fresh/stale/unknown). Complete describes only the configured source and query.
Unknown source update times stay null; fixture replay retains the original capture
time. Freshness uses the source's explicit data-as-of time and the caller's age
budget, not a new timestamp assigned at read time. Result limits and uncovered
windows mark coverage partial. Checkpoint eligibility additionally requires fresh,
complete evidence covering the requested end bound; this adapter never writes a
checkpoint. Failed sources have an error and no records. A covered empty result
is distinct from unavailable or incomplete evidence; none establishes that nothing
happened across the league.

Window semantics are explicit: games by scheduled start, news by publication and
availability by report timestamp, inclusive start/exclusive end. This does not yet
resolve historical revisions, delayed reports, latest availability snapshots or
upcoming games; live adapters must define those behaviors before claiming complete
briefings. Scores retain game status, final games require scores, and pregame/
postponed/cancelled fixtures cannot carry scores. Provider boundaries validate data;
returned records are copied to prevent consumer mutation of stored evidence.

Next is the bounded coordinator below, using these fixtures before live integration.
The UI and active preview server are unchanged. No model or external source calls
were needed for this slice.

## Configurable profiles — 2026-09-30

The planner now emits `chatagent-briefing-plan-v2`. Its task list, task titles,
source adapter IDs/kinds, per-source result/freshness limits, initial lookback and
catch-up cap come from a validated profile. Defaults live in
`data/sports/nba-profile.example.json`, not planner logic. For a custom configuration:

```bash
npm run sports:plan -- data/nba-briefing-request.example.json path/to/profile.json
```

Omitting the second argument uses the NBA example. `planBriefing(request, profile)`
is the configurable entrypoint; `planNbaBriefing(request)` remains a convenience
wrapper and also returns v2. V2 replaces `requiredSources` with full `sources`
configuration and changes the window basis to `initial-lookback`. Profile ID and
SHA-256 digest of the validated profile accompany every plan. Unknown fields,
duplicate task/adapter IDs, empty task/source lists, reversed window settings and
out-of-range budgets fail validation. A league-only profile does not ask for a team.

`bindBriefingSources(profile, registry)` accepts a caller-supplied map of adapters
implementing `SportsSource`, validates all required bindings before execution and
performs no reads. It has no dependency on the fixture adapter. The upcoming
coordinator must use these validated settings instead of rebuilding source defaults.

Deliberate limits: this is NBA configuration, not automatic support for other leagues
or arbitrary workflows. Available operations remain games/news/availability; scopes
remain league/team. Schema safety bounds are fixed. Checkpoint callers must namespace
state by user, team identity and profile digest. The current request supplies one
checkpoint per scope: advance it only after every configured task/source in that
scope covers the interval successfully. Independent task checkpoints will belong to
the coordinator's state. No persistence, coordinator, live connection or UI settings
editor is added by this configuration slice.

## Implemented coordinator slice — 2026-09-30

`BriefingCoordinator` starts configured tasks using injected sources and exposes
copied snapshots, bounded logical completion, task/run cancellation and close.
Each run and task gets a unique ID; plan task IDs retain their configuration identity.
Duplicate `(userId, requestId)` starts with the same resolved plan return the existing
run without new reads; changed inputs conflict. An explicit refresh requires a new
request ID. Every lookup/cancellation checks the caller's user ID. This is ownership
scoping for a future authenticated boundary, not authentication by itself.

Tasks publish source evidence independently and read their configured sources
sequentially. Coordinator options validate `maxConcurrentTasks` (default 2),
`taskTimeoutMs` (30 seconds including queue time) and `maxRuns` (20 retained runs).
Results distinguish complete, partial, failed, cancelled, deadline and needs-input.
Settled means no queued/running work, not successful completion. A missing team can
settle as needs-input while league work completes; restart with a new request after
selection. This is evidence collection, not generated briefing prose or model quality.

Cancellation/deadlines abort the source signal and settle the caller's task promptly.
Late evidence is discarded. An adapter ignoring abort retains its physical execution
slot until it actually settles, preventing timed-out requests from creating unbounded
new work. Close stops admission and cancels active/queued logical tasks; it cannot
force a noncooperative adapter to terminate. Retained runs are capped and there is
no eviction, durable storage or resume API yet. Reaching the cap fails admission.

Errors contain safe codes rather than arbitrary provider exception text. Results
are checked against the requested query; injected adapters remain responsible for
validating their evidence contracts. Checkpoint candidates require all configured
sources eligible and no truncated catch-up window. Candidates are returned per task,
never persisted or silently promoted to a successful scope checkpoint. Evidence
queries use the plan's explicit as-of timestamp; live freshness at display time will
need re-evaluation. No retry or synthesis policy is added here.

Run the synthetic example:

```bash
npm run sports:fixture -- data/sports/briefing-request.fixture.json
```

This file deliberately selects a fictional fixture team, not a user preference.
The CLI exits nonzero unless every task completes, including when a team needs input.
It uses the fixture registry explicitly; production coordinator code has no fixture
fallback. No external calls are made. The existing UI/HTTP chat is unchanged.

Next: expose bounded briefing start/status/cancel operations in the runtime and add
HTTP tests proving quick chat remains usable while fixture collection is held, with
correct ownership and cancellation. This source-task concurrency does not change
the one-active-job limit of the existing deep model worker. Then integrate verified
live sources and the planned task UI. Current tests establish coordinator behavior,
not live multitask quality or browser acceptance.

## Implemented HTTP slice — 2026-09-30

The optional `BriefingHttp` boundary supplies start/status/cancel commands at
`POST /briefings`. Profiles and adapters are injected by server composition; requests
cannot override them. Strict command validation rejects extra/missing fields and
invalid IDs. Errors map to bounded HTTP codes without exposing raw provider details.
`startServer(port, { briefings })` integrates coordinator closure into runtime shutdown
and port-bind failure; `createChatServer` also closes it on direct server close.
Without injection the route is disabled. The current preview/UI is unchanged.

Real HTTP fixture tests hold source work active while `/messages` completes a quick
mock response, cancel a separate queued task, and verify the remaining result keeps
its source attribution. Further tests cover duplicate/conflicting requests, ownership,
capacity, invalid input, disabled routes, shutdown admission and late-result suppression.
This demonstrates foreground transport responsiveness during synthetic collection;
it does not establish live model quality or teach the model to access briefing data.

The [runtime reference](runtime-reference.md#optional-nba-briefing-http-boundary)
describes commands, setup and limitations. Next: verify and connect live data sources
with server-controlled operational time, then task UI and source-backed model
follow-ups. Source access remains unconfigured; fixture clocks and user IDs are
explicit prototype inputs, not production identity or trusted wall-clock sources.

## BALLDONTLIE preparation — 2026-09-30

User selected preparing BALLDONTLIE integration and has no existing provider account.
No account, subscription, trial or key was created. Local sports credentials are absent.
The [provider documentation](https://docs.balldontlie.io/) describes key-authenticated
games, cursor pagination, lifecycle states and date/team filters; news is not supplied
by this games operation. Entitlements and terms still need review for the chosen
account before live use. This adapter has not been verified against an authenticated
live response.

`BalldontlieGamesSource` implements the injected source interface. It uses a fixed
HTTPS origin, Authorization header, disallowed redirects, timeout/body-size limits,
and one page per read with no retries. Share an instance across tasks to share the
local request budget (default minimum interval 12 seconds). Calls within the budget
window return an explicit local rate-limit result; there is no implicit waiting or
cross-process/account-wide quota coordination. Constructor options configure timeout,
byte bound and minimum interval. Missing credentials make no network request.

Team filters require provider `balldontlie` and a positive numeric ID; this does not
resolve a user's ambiguous team name or validate account team access. Requests use
padded calendar-date bounds and then exact timestamp/team filtering. Games with no
usable timestamp or unsupported lifecycle state are omitted with an explicit limitation,
not guessed. Final scores require both values; pregame zeros are not scores. Source
update time and data-as-of remain unknown because this adapter has no verified
freshness evidence. Retrieval time comes from its clock, never the request's `now`.

Coverage is deliberately partial: the default games endpoint excludes preseason,
only one page is fetched, and unknown/unsupported records may be present. Pagination
and result-limit truncation are disclosed. No checkpoint advances or successful full
briefing can result from this adapter yet. Address complete season-type coverage,
validated freshness semantics and pagination before broadening those claims.

To run explicitly after configuring `BALLDONTLIE_API_KEY` in the ignored local `.env`:

```bash
npm run sports:games -- 24
# Optional second argument is a provider team ID, not a saved user preference.
```

The CLI uses the current server clock for its retrospective window. It exits nonzero
for partial, unknown or unavailable evidence; inspect the JSON to distinguish useful
partial results from transport errors. Missing-key behavior was exercised locally
without a network call. Adapter tests use synthetic HTTP responses; they are not
provider accuracy evidence. No news/availability adapter, default server activation,
UI wiring or profile selection changed.

Next: authenticated read-only verification when a key is available, plus an explicit
news ingestion adapter. Avoid blocking independent fixture/UI development on access,
but do not claim a live sourced briefing until the required sources are connected.

## Next implementation and acceptance

1. Implemented: normalized source/evidence contracts and fixture adapters for games, news
   and availability. Exercise current, stale, empty, partial and failed coverage;
   confirm source-backed results and no unsupported “nothing happened” claims.
2. Coordinator core implemented; integrate it with HTTP and overlap evaluation, preserving unique run/task identities, cancellation,
   duplicate-start handling and independent section results. Reuse the existing
   runtime where appropriate; the current deep worker permits one active deep job.
   Add the overlapping HTTP fixture checks from the multitask plan as part of this
   sports slice: quick follow-up during held background work, targeted cancellation
   and correct result attribution. Do not claim concurrent deep execution yet.
3. Connect a verified live source configuration and recorded evidence. Keep fixture
   grading separate from live coverage. Select actual model bindings only when
   source access and execution budgets are concrete.
4. Add explicit preference storage and the minimal topic/thread UI, start/refresh
   controls and sourced follow-ups. Preserve existing chat behavior and validate in
   the browser. Email becomes a subsequent domain adapter, initially read-only;
   sending/drafting actions are separately scoped.

Use sports sessions to evaluate layer 1 coordination separately from substantive
work: ambiguous teams/dates, preference override, factual grounding, freshness,
corrections, interruption, failed feeds and task isolation. Grade all visible phases.
Keep baseline fairness, aggregate budgets, three repetitions and failed-run coverage
from [the multitask design](17-multitask-evaluation.md). Comparative claims still
require session linkage and a declared experiment; the existing sequential runner
cannot supply that evidence. Spec 06 and independent factual review remain open.
