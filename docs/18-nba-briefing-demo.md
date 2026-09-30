# Personalized NBA briefing demo

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
