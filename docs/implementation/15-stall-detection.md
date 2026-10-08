# 15. Stalled-agent detection (CA-ISSUE-004), proposal

Date: 2026-10-08, revision 2 (root reviews 2271, 2273). Status: **proposal only.**
Nothing here is implemented or authorized. Nothing wakes, interrupts, forks, polls in
the background or reconfigures an agent.

## Purpose and scope

[CA-ISSUE-004](../open-issues.md#ca-issue-004--no-automatic-recovery-of-an-idle-lead-or-worker)
needs a stalled lead or worker to be detected from recorded evidence and then resumed
or escalated, within stated bounds. This proposal is **partial: detection only.**
CA-ISSUE-004 stays open until a bounded escalation or resumption is demonstrated and
independently verified.

- **In scope:** agents that coordinate through the bridge, such as the lead and the
  implementer sessions.
- **Out of scope:** supervised Hekate workers. Their supervisor already bounds them:
  total timeout, tree kill and journaled acts.

## Observed instances (2026-10-08)

Both instances come from retained records.

- **The bridge delivered late.** Assignment 2153 was `sent` at 10:26:27 local. Its
  first `offered` event was at 10:40:27, and it was acknowledged the same second. The
  recipient's watcher had starved; nothing recorded flagged it.
- **The session stopped.** Session `d8e91971` had a 7.06-hour transcript gap. It began
  at 2026-10-08T06:02:10Z, and the last record before it was the user marker
  `[Request interrupted by user for tool use]`. The next record was at 13:05:41Z, and
  the bridge mail queued for that role in the meantime went unanswered.

## What each source can and cannot show

| Source                                                                           | Shows                                                                              | Never shows                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bridge events: `sent`, `offered`, `consumed`, `acknowledged`                     | When the bridge stored a message, and when a credential fetched or acknowledged it | That a model observed it. A durable watcher's acknowledgement is a transport receipt.    |
| Correlated response (below)                                                      | That the role responded to THIS assignment                                         | Acceptance or completion, unless the outcome kind says so                                |
| Any other later message from the role                                            | Activity                                                                           | A response to this assignment. It never clears the assignment.                           |
| Claude Code transcript metadata (`~/.claude/projects/<project>/<session>.jsonl`) | When the session last recorded conversational activity, and how that record ended  | The model's current status, liveness or cause. A transcript can be stale or partial.     |
| Session listings, process IDs, heartbeats, presence                              | Not used                                                                           | Execution. A listing may omit supervisor-owned `-p` workers, and process IDs get reused. |

## Correlation: when an assignment counts as answered

An assignment is a message to role R from the configured lead, or any `ack_required`
message to R. It is answered **only** by an explicit correlation with its id M:

1. **An outcome:** a bridge outcome recorded on M (`blocked`, `completed`, `verified`,
   `accepted` or `reopened`) whose authenticated principal is R.
2. **A link:** a message from R carrying a bridge link with relation `responds_to`,
   target type `message` and target M.
3. **Declared metadata:** a message from R whose `meta.respondsTo` equals M. If R
   declared a session, `meta.session` must also equal R's declared session id.

Rules for every correlation:

- **Attribution:** the principal must be R. For a role that sends through the operator
  credential (CA-ISSUE-006), a `fenrir` message counts only if it also has the
  `<R> (session <id>)` text prefix and a matching `meta.role` and `meta.session`. Its
  attribution is then labelled `reported`, never `authenticated`.
- **Unrelated replies:** a later message from R without a correlation never answers M.
  It is reported only as uncorrelated activity, with a count and ids.
- **Adoption:** today's traffic rarely carries these correlations. Agents adopting
  them is part of the rollout. Until they do, assignments will show as unanswered,
  which is correct.

## Contract

### Seam

- A NEW module, `src/integrations/bridge/activity.ts`, holds the types and the pure
  classifier.
- A NEW read-only CLI, `scripts/agentStalls.ts`:
  - **Arguments:** `--agent R --lead L [--threshold-min 15] [--deadline-s 30]
[--transcript <path> --session <id>] [--json]`.
  - **Separation:** it is not part of `devcoord` and does not change the
    runner/verifier.
  - **Bridge access:** `BRIDGE_URL` must be loopback. `BRIDGE_TOKEN` comes from the
    environment and is never printed or logged.

### Readers (reviewed implementer code)

All bounds are fixed constants. Exceeding any bound marks the affected input
`partial`.

**Bridge reader.**

- Reads only `GET /api/history?agent=R`, at most 500 messages.
- Then makes one `GET /api/evidence` per open assignment, at most 100 calls.
- Bounds:
  - each response is at most 1 MiB;
  - each request times out after 10 s;
  - the whole run must finish within `--deadline-s`.
- It keeps only: id, ts, sender, to, thread, `ack_required`, authenticated principal,
  `meta.respondsTo`, `meta.role` and `meta.session`, the 64-character text prefix
  needed for the operator-credential rule (kept as a boolean match, not text), events
  (kind, ts) and outcomes (kind, principal).

**Transcript reader.**

- Reads only the explicit path, and only its last 1 MiB:
  - at most 4,000 lines;
  - each line at most 256 KiB;
  - a first line that may be partial is dropped.
- From each JSON line it keeps only `timestamp`, `type`, `sessionId`,
  `message.role`, `message.stop_reason`, the kinds of the content blocks, `tool_use`
  ids, `tool_result.tool_use_id`, and one boolean: whether a user text block equals
  the interruption marker.
- Text, tool arguments and results, file paths, credentials and every other field are
  dropped at parse time.
- A malformed line becomes a `malformed` placeholder record. Records for other session
  ids are dropped.

### Classifier (pure; the worker task)

**Input:** the two extracts, `now`, T and the `partial` flags.

**Request state.** Exactly one applies, first match first:

| State                            | Rule                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `unknown`                        | the bridge input is partial for this assignment                                                |
| `correlated_response`            | a correlation exists (reported with its source, outcome kind, attribution label and ids)       |
| `within_threshold`               | age ≤ T                                                                                        |
| `unfetched_past_threshold`       | age > T, and no `offered`, `consumed` or `acknowledged` event (a transport or watcher problem) |
| `fetched_no_correlated_response` | age > T, and fetched or acknowledged, with no correlation                                      |

**Session corroboration.** At most one per run:

- Conversational records are `user` and `assistant`. Bookkeeping types such as
  attachments, queue operations, system and progress records never decide a state.

| State                         | Rule                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_unobservable`        | no transcript given, for example a Codex lead                                                                                                              |
| `session_unknown`             | the input is partial; any `malformed` record is among the last 20; no conversational record exists for the session                                         |
| `observed_recent_record`      | the last conversational record's age is ≤ T. This shows a recent record, not activity now.                                                                 |
| `tool_pending_unknown_cause`  | the last assistant `tool_use` id has no later `tool_result`. It could be a permission prompt, a long-running tool or a crash.                              |
| `interrupted_marker_observed` | the last conversational record is a user record with the interruption marker                                                                               |
| `ended_turn_observed`         | the last conversational record is an assistant record with `stop_reason` `end_turn` or `stop_sequence`. This corroborates; it is not current model status. |
| `session_unknown`             | anything else                                                                                                                                              |

**Output.**

- Per assignment: its id, age, state, evidence ids and any uncorrelated-activity
  count.
- Per run: the session state and the input flags.
- No state is called `alive`, `idle` or `stalled`.
- The output contains no transcript or message text.

**Exit codes.**

- 0: no assignment is `unfetched_past_threshold`, `fetched_no_correlated_response` or
  `unknown`;
- 4: at least one is;
- 1: a refusal, such as a non-loopback URL, a missing token, an unreadable explicit
  transcript or the deadline exceeded;
- 2: a usage error.

### Detection bound (conditional)

The CLI is one-shot and provides no polling. If a caller runs it at least every P
minutes and each run completes within its deadline D, a request becomes reported no
later than T + P + D after it was sent. Otherwise no bound holds. This scope adds no
daemon, watcher or automatic wake.

## Acceptance matrix (deterministic oracle)

Fixtures are metadata-only extracts. The two real instances are retained with SHA-256
values. Every case runs the pure classifier at a fixed `now`.

| #   | Input                                                                                             | Expected                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | The 2153 timeline at 10:40:00, T = 10 min                                                         | `unfetched_past_threshold`                                   |
| 2   | The 2153 timeline at 10:41, acknowledged, no correlation                                          | `fetched_no_correlated_response`                             |
| 3   | The same, plus an outcome on 2153 by R                                                            | `correlated_response` (outcome, authenticated)               |
| 4   | A later message from R in the same thread without `respondsTo`                                    | still `fetched_no_correlated_response`, uncorrelated count 1 |
| 5   | A message from R with `meta.respondsTo` = M but a different `meta.session`                        | not correlated                                               |
| 6   | A `fenrir` message with the prefix and matching `meta.role`/`session`/`respondsTo`                | `correlated_response`, attribution `reported`                |
| 7   | A `fenrir` message with the prefix only                                                           | not correlated                                               |
| 8   | A link `responds_to` M from R                                                                     | `correlated_response` (link)                                 |
| 9   | The bridge input is partial                                                                       | `unknown`, exit 4                                            |
| 10  | The d8e91971 tail around 06:02:10Z, evaluated at 06:30Z                                           | `interrupted_marker_observed`                                |
| 11  | The last conversational record is an `end_turn` assistant record, followed by bookkeeping records | `ended_turn_observed` (bookkeeping ignored)                  |
| 12  | A `tool_use` with no `tool_result`                                                                | `tool_pending_unknown_cause`                                 |
| 13  | A recent assistant record                                                                         | `observed_recent_record`                                     |
| 14  | A malformed line among the last 20                                                                | `session_unknown`                                            |
| 15  | Only other-session records                                                                        | `session_unknown`                                            |
| 16  | No transcript                                                                                     | `session_unobservable`                                       |
| 17  | Fixtures that contain sentinel text in user, assistant and tool content                           | the output (JSON and human) never contains the sentinel      |
| 18  | Exit codes                                                                                        | 0, 4, 1 (deadline and non-loopback) and 2                    |

## Implementation path (root decision 2273)

1. **Readers and CLI.** ChatAgent's implementer builds the bridge and transcript
   readers and `scripts/agentStalls.ts` directly, under review, with reader tests:
   bounds, partial flags, field allowlists, non-leak, loopback and token handling.
2. **Prep increment.** A deliberate, reviewed commit adds
   `src/integrations/bridge/activity.ts` with the exact exported types above and a
   conservative stub classifier. The stub returns `unknown` and `session_unknown` for
   everything, so the oracle fails at the base by assertion, never by a missing
   export.
3. **Worker task.** The frozen oracle (cases 1-17 against the classifier) is authored
   through Hekate's `task_author`. The allow list is the classifier module only.

## Relation to closure

This delivers partial detection. CA-ISSUE-004 stays open: resumption or escalation
within a bound, and the doc 13 review-pending handoff scenario, remain unimplemented.
