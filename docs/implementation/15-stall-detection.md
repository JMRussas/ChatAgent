# 15. Stalled-agent detection (CA-ISSUE-004), proposal

Date: 2026-10-08. Status: **proposal only.** Nothing here is implemented or
authorized, and nothing here wakes, interrupts, forks or reconfigures an agent.

## Purpose and scope

[CA-ISSUE-004](../open-issues.md#ca-issue-004--no-automatic-recovery-of-an-idle-lead-or-worker)
needs a stalled lead or worker to be detected from recorded evidence within a stated
bound. This proposal covers detection only. Resuming or escalating, which the issue's
closure also needs, is a later decision.

- **In scope:** agents that coordinate through the bridge, such as the lead and the
  implementer sessions. This is where the observed stalls happened.
- **Out of scope:** supervised Hekate workers. They are already bounded by their
  supervisor: total timeout, tree kill and journaled acts.

## Observed instances (2026-10-08)

Both instances were read from retained records.

- **The bridge delivered late.** Assignment 2153 was `sent` at 10:26:27 local. Its
  first `offered` event was at 10:40:27, and it was acknowledged the same second.
  The recipient's watcher had starved. The model never saw the message for 14
  minutes, and nothing in the bridge's records would have flagged that as a stall.
- **The session stopped.** Session `d8e91971` had a 7.06-hour gap in its transcript:
  - It began at 2026-10-08T06:02:10Z. The last record was the user-text marker
    `[Request interrupted by user for tool use]`, seconds after a Windows restart
    attempt.
  - The next record was at 13:05:41Z.
  - Meanwhile the bridge kept queueing mail for that role, and nobody answered it.

## Evidence sources and what each can prove

| Source                                                                                                                                                             | Proves                                                                                            | Does not prove                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Bridge message and its events (`sent`, `offered`, `consumed`, `acknowledged`; `bridge_evidence`, `GET /api/evidence`)                                              | When the bridge stored and prepared a message, and when a credential consumed or acknowledged it. | That a model observed it. An acknowledgement from a durable watcher is a transport receipt. |
| A later message authored by the recipient in the same thread                                                                                                       | Model activity after the request.                                                                 | Acceptance or completion of the request.                                                    |
| Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`): per record `timestamp`, `type`, `sessionId`, `message.stop_reason`, content kinds | When the session last did anything, and how its last turn ended.                                  | That the session will continue, or that the process is alive.                               |

Root review (bridge 2271) adds four pitfalls, which the design keeps:

- Presence, heartbeat and directory listings are not execution evidence.
- A session listing may omit supervisor-owned `-p` workers, so absence is not death.
- A process ID alone suffers reuse. This design reads no process IDs.
- A lead that is not observable through the Claude CLI, such as a Codex session, is
  reported `unobservable`. It is never inferred idle.

## Contract

**Seam.** One read-only CLI mode on the existing coordination CLI, plus one pure
classifier:

```
npx tsx scripts/devcoord.ts stalls --agent <role> --lead <role> [--threshold-min 15]
  [--transcript <path> --session <id>] [--json]
```

**Bridge inputs.**

- The URL comes from `BRIDGE_URL`, loopback only; the token comes from `BRIDGE_TOKEN`
  and is never printed.
- Reads only: `GET /api/history?agent=<role>`, then `GET /api/evidence` for each open
  request.

**Requests.** A request is a message to `<role>` from `<lead>`, or any `ack_required`
message to `<role>`.

**Responses.**

- A response is a later message in the same thread whose authenticated principal is
  `<role>`. It is labelled `authenticated`.
- For a role that sends through the operator credential (CA-ISSUE-006), a message
  from `fenrir` whose text starts with `<role> (session <id>)` also counts. It is
  labelled `reported`, never `authenticated`.

**Transcript input.**

- The transcript is optional, and only an explicit path is read; there is no
  discovery.
- Only the last 1 MiB is read. From each record, only `timestamp`, `type`,
  `sessionId`, `stop_reason`, content kinds and tool-use or tool-result ids are kept.
- Message text is never read into the output.
- A record whose `sessionId` differs from `--session` is ignored.

**Request states.** The first matching state applies:

| State              | Rule                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `answered`         | a response exists (evidence: its id and label)                                                |
| `within_bound`     | age ≤ T                                                                                       |
| `unfetched`        | age > T and no `offered`, `consumed` or `acknowledged` event (a transport or watcher problem) |
| `fetched_no_reply` | age > T and fetched or acknowledged, with no response                                         |

**Session corroboration.** This applies only when the transcript is given; the first
matching state applies:

| State                  | Rule                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `session_unobservable` | no transcript for the role, for example a Codex lead                                               |
| `session_unknown`      | unreadable, malformed or empty records, or no record for the session                               |
| `session_active`       | last record age ≤ T                                                                                |
| `session_tool_pending` | the last assistant `tool_use` id has no `tool_result` (a permission prompt or a long-running tool) |
| `session_interrupted`  | the last record is the user interruption marker                                                    |
| `session_ended_turn`   | the last assistant record has `stop_reason` `end_turn` or `stop_sequence`: idle, needs a prompt    |

**Output.** Per request: the message id, its age, its state and its evidence ids,
plus at most one session state. The output never says `alive` or `stalled` as a
fact. A `fetched_no_reply` request with `session_ended_turn` is the actionable case.

**Exit codes.**

- 0: no request is `unfetched` or `fetched_no_reply`;
- 4: at least one request is;
- 1: refusals, such as an unreachable bridge, a non-loopback URL or a missing token;
- 2: usage errors.

**Detection bound.** The CLI is one-shot. Run every P minutes, it reports a stall
within T + P of the request; the defaults are T = 15 and P left to the caller. No
daemon is added.

## Acceptance oracle (deterministic)

The fixtures are metadata-only extracts of the real instances above, retained with
SHA-256 values, plus synthetic edge cases. The cases:

1. The 2153 timeline at T + 1: `unfetched` before 10:40:27, then `answered` once a
   reply record follows.
2. The d8e91971 records around 06:02:10Z with a pending request: `fetched_no_reply`
   and `session_interrupted`.
3. An `end_turn` final record: `session_ended_turn`.
4. A `tool_use` with no `tool_result`: `session_tool_pending`.
5. A `fenrir` message with the `<role> (session …)` prefix: `answered`, labelled
   `reported`.
6. A watcher acknowledgement with no reply: `fetched_no_reply`, never `answered`.
7. No transcript: `session_unobservable`.
8. A malformed record: `session_unknown`, never an inference.
9. Records from another session id are ignored.
10. Output never contains transcript or message text: assert on a fixture containing
    a sentinel string.
11. Exit codes 0, 4, 1 and 2.

## Implementation path (for root decision)

Hekate's task authoring cannot add files, and the classifier is naturally a new module
(`src/integrations/bridge/activity.ts`).

- **Recommended:** ChatAgent's implementer builds the transcript reader and the CLI
  mode directly, under review, because they handle private session files and a token.
  A prep increment adds the classifier module with its types. A supervised worker task
  then implements the pure classifier against the frozen oracle.
- **Alternative:** the implementer builds all of it under review.

## Relation to closure

This meets the "detected from recorded evidence within a stated bound" half of
CA-ISSUE-004's closure criteria. Resumption or escalation within a bound, such as
notifying the user or the lead, and the doc 13 review-pending handoff scenario remain
open.
