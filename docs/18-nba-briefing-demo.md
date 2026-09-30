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

## Next implementation and acceptance

1. Add normalized source/evidence contracts and fixture adapters for games, news
   and availability. Exercise current, stale, empty, partial and failed coverage;
   confirm source-backed results and no unsupported “nothing happened” claims.
2. Add a bounded briefing coordinator with unique run/task identities, cancellation,
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
