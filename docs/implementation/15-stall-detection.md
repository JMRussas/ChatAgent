# 15. Initial-response detection for bridge assignments (CA-ISSUE-004), proposal

Date: 2026-10-08, revision 4 (root reviews 2271, 2273, 2275, 2278, 2279). Status:
**the readers, the CLI and a conservative classifier stub are implemented (root GO
2278); the classifier itself is not.** Until the prepared classifier task lands, every
assignment reports `unknown` and the session reports `session_unknown`. Nothing wakes,
interrupts, forks, polls in the background or reconfigures an agent.

## Purpose and scope

[CA-ISSUE-004](../open-issues.md#ca-issue-004--no-automatic-recovery-of-an-idle-lead-or-worker)
needs a stalled lead or worker to be detected from recorded evidence and then resumed
or escalated, within stated bounds. This proposal covers only **initial-response
detection**: has the addressed role recorded a response to a given assignment?

The following stay out of scope:

- detecting a stall in ongoing work after a response, which needs modelled checkpoint
  evidence first;
- resumption and escalation;
- supervised Hekate workers, which their supervisor already bounds.

CA-ISSUE-004 stays open.

## Observed instances (2026-10-08)

Both come from retained records.

- **The bridge delivered late.** Assignment 2153 was `sent` at 10:26:27 local. Its
  first `offered` event was at 10:40:27, and it was acknowledged the same second. The
  recipient's watcher had starved.
- **The session stopped.** Session `d8e91971` had a 7.06-hour transcript gap starting
  at 2026-10-08T06:02:10Z. The last record before it was the user interruption marker
  `[Request interrupted by user for tool use]`.

## Bridge APIs used (surveyed at agent-bridge-mcp `src/agent_bridge`)

The tool reads only. It records nothing.

**`GET /api/evidence?message_id=<id>`** (`evidence.inspect`) returns:

- `message`: id, uid, ts, sender, to, thread, `ack_required`,
  `authenticated_principal`, read, `acknowledged_at` and text.
- `events`: id, kind, ts and actor, with kinds `sent`, `offered`, `consumed`,
  `acknowledged` and outcome kinds.
- `outcomes`: id, `message_id` (uid), kind, `artifact_ref`, `evidence_refs`, details,
  actor and ts. The kinds are `blocked`, `completed`, `verified`, `accepted` and
  `reopened`.
- `links`: links made FROM this message.

Access is limited to the message's participants and the operator.

**`GET /api/links?target_type=message&target_ref=<uid>`** (`evidence.find_links`)
returns the links that point AT a message, each with id, `message_id` (the linking
message's uid), relation, `target_type`, `target_ref`, inferred, actor and ts.

- Supported relations: `originated_in`, `replies_to`, `supports`, `contradicts`,
  `followed_up_in`.
- Message targets are stored by uid.

`actor` on outcomes and links is the authenticated principal that recorded them. The
bridge permits `accepted` only from the authenticated assigner or the operator.

## Correlation: what counts as a response to assignment M

Only supported, queryable records count. No invented fields and no history scan are
used.

1. **An outcome on M recorded by the addressed role R.** This is `outcome.actor == R`
   with kind `blocked`, `completed` or `verified`. The state carries the kind:
   `blocked` is a response, not progress, and a reply never means acceptance.
2. **A `replies_to` link at M from a message sent by R.** The link's `actor` must be R,
   and the linking message's `authenticated_principal` must also be R. This is read
   with one bounded `GET /api/evidence` of that message.

**Operator-credential roles (CA-ISSUE-006).**

- An outcome whose actor is `fenrir` counts only if its `details` declare `role` R
  and, when `--session` is given, that `session`.
- A `replies_to` link whose actor is `fenrir` counts only if the linking message's
  `meta` declares `role` R and, when `--session` is given, that `session`.
- `meta` and outcome `details` are supported free-form bridge fields. Declaring the
  role and session there is the reporting convention. No message text is read.
- Its attribution is `reported`, never `authenticated`, and the output always shows
  that.

**Everything else is uncorrelated.** That includes a later message from R in the same
thread without a link, and links with other relations. It never clears M.

**Adoption.** Agents must record a `replies_to` link or an outcome when they respond.
Until they do, assignments correctly stay uncorrelated.

## Contract

### Seam

- **New modules in `src/integrations/bridge/`:**
  - `activity.ts`: the metadata types and the pure classifier;
  - `bridgeReader.ts`: the bridge reader;
  - `transcriptReader.ts`: the transcript reader.
- **A new read-only CLI, `scripts/agentStalls.ts`.**
  - Arguments: `--agent R --assignment <id> [--assignment <id> …] (1 to 32)
[--threshold-min 15] [--deadline-s 30] [--transcript <path> --session <id>]
[--json]`.
  - It is not part of `devcoord` and does not change the runner or verifier.

### Bridge reader (reviewed implementer code)

**URL and token.**

- `BRIDGE_URL` must be http to the literal address `127.0.0.1` or `[::1]`, with no
  credentials, path, query or fragment. Names are not resolved, and anything else is
  refused.
- Redirects are never followed (`redirect: "error"`).
- `BRIDGE_TOKEN` is sent only as the `Authorization` header, to that origin. It is
  never put in a URL, printed or included in an error. Errors carry only the HTTP
  status and an error code.

**Calls.** For each assignment id:

- one `GET /api/evidence`;
- one `GET /api/links` for its uid;
- at most 8 `GET /api/evidence` calls for linking messages.

The total is capped at 32 × 10 calls.

**Caps.**

- Each response is at most 1 MiB; each request times out after 10 s.
- One deadline (`--deadline-s`) is shared by every bridge request and the
  transcript read.
- The events, outcomes and links lists are each capped at 200 entries per message.

**Fields kept.**

- From messages: uid, ts, sender, to, `ack_required` and `authenticated_principal`.
  For linking messages, also the `meta` role and session.
- From events: kind and ts.
- From outcomes: kind, actor and ts, plus the `details` role and session.
- From links: relation, `target_type`, `target_ref`, actor, the linking message's uid
  and ts.

Text, the rest of `meta` and `details`, and artifact and evidence refs are dropped at
parse time. A deadline overrun refuses the whole run (exit 1).

**Binding.** Responses are checked against what was asked:

- the evidence response's `message.id` must equal the requested decimal id;
- every returned link must have `target_type` `message` and `target_ref` equal to the
  assignment's uid;
- a linking message read must have the uid its link names.

A mismatch is `INVALID_RESPONSE`, never a correlation.

**Completeness.** A failed, refused, oversized, timed-out, over-cap, malformed or
mismatched response marks that assignment's input `incomplete`. Its state is then
`unknown`, never `unfetched`.

### Transcript reader (optional; reviewed implementer code)

**Bounds.**

- Only the explicit path is read, and only when `lstat` shows a regular file. A
  directory, link, pipe or device is refused (`TRANSCRIPT_NOT_A_FILE`, exit 1).
- Only the last 1 MiB is read; at most 4,000 lines; each line at most 256 KiB.
- A first line that may be partial is dropped. Any other oversized or non-JSON line
  becomes a `malformed` placeholder.

**Fields kept per JSON line.**

- `timestamp`, `type`, `sessionId`, `message.role` and `message.stop_reason`;
- the kinds of the content blocks;
- `tool_use` ids and `tool_result.tool_use_id`;
- one boolean: whether a user text block equals the interruption marker.

Text, tool arguments and results, paths and credentials are dropped at parse time.

**Strictness.** A line becomes a `malformed` placeholder, never silently dropped or
trusted, when it:

- has a missing or non-string `sessionId`, or a missing `type`;
- is a `user` or `assistant` record whose timestamp is invalid, whose `message` is
  missing or has a different role, whose `stop_reason` is not a string, or whose
  content is neither a string nor a list of typed blocks;
- has a `tool_use` block without an id, or a `tool_result` block without a
  `tool_use_id`.

Only records of another valid session id are dropped.

**Deadline.**

- The readers check the shared deadline between steps: before the first request,
  around each bridge response, and before and after the transcript `lstat`, open,
  stat and read. The transcript handle is closed even when a late read completes
  after the deadline.
- Filesystem I/O itself cannot be interrupted inside the library. So the CLI stops the
  process at the deadline plus one second (`DEADLINE`, exit 1), rather than waiting
  for a read that has not returned.

### Classifier (pure; the supervised worker task)

**Input:** the sanitized extracts, `now`, T and the completeness flags.

**Assignment state.** Exactly one applies, first match first:

| State                         | Rule                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`                     | the assignment's input is incomplete                                                                                                                            |
| `correlated_reply_observed`   | a correlation exists. It is reported with its source (an outcome with its kind, or a link), the attribution (`authenticated` or `reported`) and the record ids. |
| `within_threshold`            | age ≤ T                                                                                                                                                         |
| `unfetched_past_threshold`    | age > T, the input is complete, and there is no `offered`, `consumed` or `acknowledged` event                                                                   |
| `fetched_no_correlated_reply` | age > T, the input is complete, the message was fetched or acknowledged, and there is no correlation                                                            |

**Session corroboration.** At most one per run:

- Conversational records are `user` and `assistant`. Bookkeeping records never decide
  a state.

| State                         | Rule                                                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_unobservable`        | no transcript given, for example a Codex lead                                                                                                                                                                                |
| `session_unknown`             | the input is truncated or incomplete; a `malformed` record is among the last 20, or comes after the last assistant `tool_use` (a dropped tool result may hide behind it); or no conversational record exists for the session |
| `observed_recent_record`      | the last conversational record's age is ≤ T. This is a recent record, not activity now.                                                                                                                                      |
| `tool_pending_unknown_cause`  | the last assistant `tool_use` id has no later `tool_result`                                                                                                                                                                  |
| `interrupted_marker_observed` | the last conversational record is a user record carrying the interruption marker                                                                                                                                             |
| `ended_turn_observed`         | the last conversational record is an assistant record with `stop_reason` `end_turn` or `stop_sequence`. This corroborates; it is not current model status.                                                                   |
| `session_unknown`             | anything else                                                                                                                                                                                                                |

**Output.**

- Per assignment: its id, age, state, record ids and any uncorrelated-activity count.
  The count covers only linking messages already read; there is no history scan.
- Per run: the session state and the completeness flags.
- There is no `alive`, `idle`, `stalled` or `answered` state.
- The output never contains message or transcript text.

**Exit codes.**

- 0: every assignment is `correlated_reply_observed` or `within_threshold`;
- 4: any other state;
- 1: a refusal, such as a non-loopback URL, a missing token, an unreadable explicit
  transcript or the deadline exceeded;
- 2: a usage error, such as zero or more than 32 assignments.

### Detection bound (conditional only)

The CLI is one-shot and polls nothing. A missing initial response becomes visible only
when a caller runs the CLI. If the caller runs it at least every P minutes and each
run completes within its deadline D, a missing response is reported no later than
T + P + D after it was sent. No bound holds otherwise.

## Acceptance matrix (pure classifier; deterministic)

Fixtures are sanitized metadata only, with no message or transcript content. The two
real instances are retained as hashed metadata extracts. `now` is fixed.

| #   | Input                                                                                             | Expected                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 2153's events at 10:40:00, T = 10 min                                                             | `unfetched_past_threshold`                                             |
| 2   | 2153's events at 10:41, acknowledged, with no outcome or link                                     | `fetched_no_correlated_reply`                                          |
| 3   | The same, plus an outcome `completed` with actor R                                                | `correlated_reply_observed` (outcome `completed`, `authenticated`)     |
| 4   | An outcome `blocked` with actor R                                                                 | `correlated_reply_observed` (outcome `blocked`)                        |
| 5   | An outcome with an actor other than R or `fenrir`                                                 | not correlated                                                         |
| 6   | A `replies_to` link at M; the link's actor and the linking message's principal are both R         | `correlated_reply_observed` (link, `authenticated`)                    |
| 7   | A `supports` link at M from R                                                                     | not correlated; uncorrelated count 1                                   |
| 8   | A `replies_to` link with actor `fenrir`; the linking message's `meta` declares R and the session  | `correlated_reply_observed`, attribution `reported`                    |
| 9   | A `replies_to` link with actor `fenrir`, without a `meta` declaration or with another session     | not correlated                                                         |
| 10  | The assignment's input is incomplete (any reader failure flag)                                    | `unknown`, never `unfetched_past_threshold`                            |
| 11  | The d8e91971 tail around 06:02:10Z, evaluated at 06:30Z                                           | `interrupted_marker_observed`                                          |
| 12  | The last conversational record is an `end_turn` assistant record, followed by bookkeeping records | `ended_turn_observed`                                                  |
| 13  | A `tool_use` with no `tool_result`                                                                | `tool_pending_unknown_cause`                                           |
| 14  | A recent assistant record                                                                         | `observed_recent_record`                                               |
| 15  | A malformed record among the last 20, or a truncated input                                        | `session_unknown`                                                      |
| 16  | Only other-session records                                                                        | `session_unknown`                                                      |
| 17  | No transcript                                                                                     | `session_unobservable`                                                 |
| 18  | Output for every case above                                                                       | metadata only; no state named `answered`, `alive`, `idle` or `stalled` |

**Reader tests** belong to the reviewed implementer increment, not the worker oracle:

- loopback-only URLs, refused redirects, and no token in URLs, output or errors;
- every cap and timeout marks the input incomplete;
- the field allowlist, with a sentinel string in message and transcript text that
  never appears;
- a malformed JSON line becomes a placeholder;
- exit codes 0, 4, 1 and 2.

## Implementation path (root decision 2273)

1. **Readers and CLI (this increment).** ChatAgent's implementer built them directly,
   under review: `bridgeReader.ts`, `transcriptReader.ts` and `scripts/agentStalls.ts`.
   Their tests are `tests/unit/bridgeReader.test.ts`, `transcriptReader.test.ts` and
   `agentStalls.test.ts`.
2. **Prep (this increment).** A deliberate commit adds `activity.ts` with the
   exact exported types and a conservative stub classifier that returns `unknown` and
   `session_unknown` for everything. The worker's oracle then fails at the base by
   assertion only.
3. **Worker task.** A frozen oracle (matrix rows 1–18) is authored through Hekate's
   `task_author`. The allow list is `activity.ts` only, with no runner or
   verifier change.

## Relation to closure

This is partial: initial-response detection only. CA-ISSUE-004 stays open.
Ongoing-work stalls, resumption or escalation within a bound, and the doc 13
review-pending handoff scenario all remain.
