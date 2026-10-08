import { describe, expect, it } from "vitest";
import {
  classifyActivity,
  type ActivityInput,
  type AssignmentExtract,
  type TranscriptExtract,
  type TranscriptRecord
} from "../../src/integrations/bridge/activity";

// The pure classifier of doc 15 (CA-ISSUE-004), initial-response detection only. Inputs
// are sanitized metadata, never content. The real-instance rows use metadata of retained
// records: bridge assignment 2153 (sent 10:26:27 local, first offered 10:40:27, acknowledged
// the same second) and session d8e91971's records before its 7.06-hour gap from
// 2026-10-08T06:02:10Z. Every case asserts on the returned report.
const R = "claude-chatagent";
const SENT = 1791469587.0987277; // 2153 sent, seconds
const OFFERED = 1791470427.5428011; // 2153 first offered
const ACKED = 1791470427.801763; // 2153 acknowledged
const MIN = 60_000;

function assignment(over: Partial<AssignmentExtract> = {}): AssignmentExtract {
  return {
    id: "2153",
    uid: "uid-2153",
    ts: SENT,
    to: R,
    sender: "codex-chatagent",
    principal: "codex-chatagent",
    ackRequired: true,
    events: [{ kind: "sent", ts: SENT }],
    outcomes: [],
    links: [],
    ...over
  };
}
const fetchedEvents = [
  { kind: "sent", ts: SENT },
  { kind: "offered", ts: OFFERED },
  { kind: "acknowledged", ts: ACKED }
];
/** 10:41 local, after the first offer: 2153 has been fetched. */
const AFTER_FETCH_MS = (OFFERED + 33) * 1000;

function input(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    agent: R,
    assignments: [assignment()],
    nowMs: AFTER_FETCH_MS,
    thresholdMs: 10 * MIN,
    ...over
  };
}
const one = (over: Partial<ActivityInput> = {}) => classifyActivity(input(over)).assignments[0];
const sessionOf = (
  transcript: TranscriptExtract | undefined,
  nowMs: number,
  thresholdMs = 10 * MIN
) =>
  classifyActivity(
    input({ assignments: [], ...(transcript ? { transcript } : {}), nowMs, thresholdMs })
  ).session;

function rec(over: Partial<TranscriptRecord>): TranscriptRecord {
  return {
    ts: null,
    type: "attachment",
    toolUseIds: [],
    toolResultIds: [],
    interruptionMarker: false,
    ...over
  };
}
const user = (iso: string, over: Partial<TranscriptRecord> = {}) =>
  rec({ ts: Date.parse(iso), type: "user", role: "user", ...over });
const assistant = (iso: string, over: Partial<TranscriptRecord> = {}) =>
  rec({ ts: Date.parse(iso), type: "assistant", role: "assistant", ...over });
const MALFORMED = rec({ type: "malformed", malformed: true });
const tail = (records: TranscriptRecord[], truncated = false): TranscriptExtract => ({
  records,
  truncated
});

/**
 * Session d8e91971's last records before its gap (metadata only), as a complete,
 * untruncated extract. Read from the real 22 MB transcript, the 1 MiB tail would be
 * truncated, and a truncated window is session_unknown under doc 15.
 */
const D8E_TAIL = tail(
  [
    rec({ ts: Date.parse("2026-10-08T06:01:59.832Z"), type: "attachment" }),
    rec({ type: "last-prompt" }),
    assistant("2026-10-08T06:02:09.080Z", { stopReason: "tool_use" }),
    assistant("2026-10-08T06:02:09.082Z", { stopReason: "tool_use" }),
    assistant("2026-10-08T06:02:10.176Z", {
      stopReason: "tool_use",
      toolUseIds: ["toolu_01T3BAdrMu4nXeEZzKtBGGh5"]
    }),
    user("2026-10-08T06:02:10.991Z", { toolResultIds: ["toolu_01T3BAdrMu4nXeEZzKtBGGh5"] }),
    user("2026-10-08T06:02:10.992Z", { interruptionMarker: true }),
    rec({ type: "last-prompt" })
  ],
  false
);
const AT = (iso: string) => Date.parse(iso);

describe("assignment state from bridge evidence", () => {
  it("2153 before its first offer is unfetched past the threshold (row 1)", () => {
    expect(one({ nowMs: (SENT + 812.9) * 1000 })).toEqual({
      id: "2153",
      ageS: 812,
      state: "unfetched_past_threshold",
      uncorrelated: 0
    });
  });

  it("2153 after its offer and acknowledgement, with no correlation, is fetched without a correlated reply (row 2)", () => {
    expect(one({ assignments: [assignment({ events: fetchedEvents })] })).toMatchObject({
      state: "fetched_no_correlated_reply",
      uncorrelated: 0
    });
  });

  it.each(["completed", "blocked", "verified"])(
    "an outcome %s recorded by the role is a correlated reply (rows 3, 4)",
    (kind) => {
      const a = assignment({
        events: fetchedEvents,
        outcomes: [{ kind, actor: R, ts: OFFERED + 10 }]
      });
      expect(one({ assignments: [a] })).toMatchObject({
        state: "correlated_reply_observed",
        correlation: { source: "outcome", kind, attribution: "authenticated" }
      });
    }
  );

  it("an accepted or reopened outcome is not a reply from the role", () => {
    for (const kind of ["accepted", "reopened"]) {
      const a = assignment({
        events: fetchedEvents,
        outcomes: [{ kind, actor: R, ts: OFFERED + 10 }]
      });
      expect(one({ assignments: [a] }).state).toBe("fetched_no_correlated_reply");
    }
  });

  it("an outcome recorded by another principal does not correlate (row 5)", () => {
    const a = assignment({
      events: fetchedEvents,
      outcomes: [{ kind: "completed", actor: "codex-hekate", ts: OFFERED + 10 }]
    });
    expect(one({ assignments: [a] }).state).toBe("fetched_no_correlated_reply");
  });

  it("a replies_to link from the role, sent by the role, is a correlated reply (row 6)", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: R,
          ts: OFFERED + 20,
          from: { uid: "uid-r1", sender: R, principal: R }
        }
      ]
    });
    expect(one({ assignments: [a] })).toMatchObject({
      state: "correlated_reply_observed",
      correlation: { source: "link", attribution: "authenticated" },
      uncorrelated: 0
    });
  });

  it("a link of another relation from the role is uncorrelated activity, never a reply (row 7)", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [{ relation: "supports", actor: R, ts: OFFERED + 20, from: null }]
    });
    expect(one({ assignments: [a] })).toMatchObject({
      state: "fetched_no_correlated_reply",
      uncorrelated: 1
    });
  });

  it("an operator-credential reply declaring the role and session is a reported correlation (row 8)", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: "fenrir",
          ts: OFFERED + 20,
          from: { uid: "uid-r1", sender: "fenrir", principal: "fenrir", role: R, session: "s-1" }
        }
      ]
    });
    expect(one({ assignments: [a], session: "s-1" })).toMatchObject({
      state: "correlated_reply_observed",
      correlation: { source: "link", attribution: "reported" }
    });
  });

  it("an operator-credential reply without a declaration, or declaring another session, does not correlate (row 9)", () => {
    for (const from of [
      { uid: "uid-r1", sender: "fenrir", principal: "fenrir" },
      { uid: "uid-r1", sender: "fenrir", principal: "fenrir", role: R, session: "s-other" },
      {
        uid: "uid-r1",
        sender: "fenrir",
        principal: "fenrir",
        role: "claude-hekate",
        session: "s-1"
      }
    ]) {
      const a = assignment({
        events: fetchedEvents,
        links: [{ relation: "replies_to", actor: "fenrir", ts: OFFERED + 20, from }]
      });
      expect(one({ assignments: [a], session: "s-1" }).state).toBe("fetched_no_correlated_reply");
    }
  });

  it("an operator-credential outcome correlates only with a matching declaration", () => {
    const outcome = (role?: string, session?: string) =>
      assignment({
        events: fetchedEvents,
        outcomes: [
          {
            kind: "completed",
            actor: "fenrir",
            ts: OFFERED + 10,
            ...(role ? { role } : {}),
            ...(session ? { session } : {})
          }
        ]
      });
    expect(one({ assignments: [outcome(R, "s-1")], session: "s-1" })).toMatchObject({
      state: "correlated_reply_observed",
      correlation: { source: "outcome", kind: "completed", attribution: "reported" }
    });
    expect(one({ assignments: [outcome(R, "s-2")], session: "s-1" }).state).toBe(
      "fetched_no_correlated_reply"
    );
    expect(one({ assignments: [outcome()], session: "s-1" }).state).toBe(
      "fetched_no_correlated_reply"
    );
  });

  it("without a declared session, a role declaration alone suffices for a reported correlation", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: "fenrir",
          ts: OFFERED + 20,
          from: { uid: "uid-r1", sender: "fenrir", principal: "fenrir", role: R }
        }
      ]
    });
    expect(one({ assignments: [a] }).correlation).toEqual({
      source: "link",
      attribution: "reported"
    });
  });

  it("a linking message whose principal is not the operator never carries a proxy declaration (row 23)", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: "fenrir",
          ts: OFFERED + 20,
          from: {
            uid: "uid-r1",
            sender: "codex-hekate",
            principal: "codex-hekate",
            role: R,
            session: "s-1"
          }
        }
      ]
    });
    expect(one({ assignments: [a], session: "s-1" }).state).toBe("fetched_no_correlated_reply");
  });

  it("an authenticated reply ignores whatever role its message declares (row 24)", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: R,
          ts: OFFERED + 20,
          from: { uid: "uid-r1", sender: R, principal: R, role: "claude-hekate" }
        }
      ]
    });
    expect(one({ assignments: [a] }).correlation).toEqual({
      source: "link",
      attribution: "authenticated"
    });
  });

  it("a replies_to link from the role whose message another principal sent is uncorrelated", () => {
    const a = assignment({
      events: fetchedEvents,
      links: [
        {
          relation: "replies_to",
          actor: R,
          ts: OFFERED + 20,
          from: { uid: "uid-r1", sender: "codex-hekate", principal: "codex-hekate" }
        }
      ]
    });
    expect(one({ assignments: [a] })).toMatchObject({
      state: "fetched_no_correlated_reply",
      uncorrelated: 1
    });
  });

  it("records made before the assignment was sent never correlate (row 22)", () => {
    const a = assignment({
      events: fetchedEvents,
      outcomes: [{ kind: "completed", actor: R, ts: SENT - 1 }],
      links: [
        {
          relation: "replies_to",
          actor: R,
          ts: SENT - 1,
          from: { uid: "uid-r0", sender: R, principal: R }
        }
      ]
    });
    expect(one({ assignments: [a] })).toMatchObject({
      state: "fetched_no_correlated_reply",
      uncorrelated: 0
    });
  });

  it("prefers an authenticated correlation, then an outcome, then the earliest", () => {
    const a = assignment({
      events: fetchedEvents,
      outcomes: [
        { kind: "completed", actor: "fenrir", ts: OFFERED + 5, role: R },
        { kind: "verified", actor: R, ts: OFFERED + 30 },
        { kind: "blocked", actor: R, ts: OFFERED + 20 }
      ],
      links: [
        {
          relation: "replies_to",
          actor: R,
          ts: OFFERED + 10,
          from: { uid: "uid-r1", sender: R, principal: R }
        }
      ]
    });
    expect(one({ assignments: [a] }).correlation).toEqual({
      source: "outcome",
      kind: "blocked",
      attribution: "authenticated"
    });
  });

  it("is within the threshold up to and including T, and past it one millisecond later", () => {
    const T = 10 * MIN;
    expect(one({ nowMs: SENT * 1000 + T, thresholdMs: T }).state).toBe("within_threshold");
    expect(one({ nowMs: SENT * 1000 + T + 1, thresholdMs: T }).state).toBe(
      "unfetched_past_threshold"
    );
  });

  it("reports the age in whole seconds since sending", () => {
    expect(one({ nowMs: (SENT + 61.9) * 1000 })).toMatchObject({
      ageS: 61,
      state: "within_threshold"
    });
  });

  it("an event at or after sending counts as a fetch; a sent event alone does not", () => {
    const only = (kind: string) =>
      assignment({
        events: [
          { kind: "sent", ts: SENT },
          { kind, ts: OFFERED }
        ]
      });
    expect(one({ assignments: [only("consumed")] }).state).toBe("fetched_no_correlated_reply");
    expect(one({ assignments: [only("delivered")] }).state).toBe("unfetched_past_threshold");
  });

  it("judges several assignments independently and in order", () => {
    const report = classifyActivity(
      input({
        assignments: [
          assignment({ id: "2153", events: fetchedEvents }),
          assignment({
            id: "2154",
            uid: "uid-2154",
            ts: SENT - 600,
            events: [{ kind: "sent", ts: SENT - 600 }]
          }),
          assignment({
            id: "2155",
            uid: "uid-2155",
            outcomes: [{ kind: "completed", actor: R, ts: OFFERED }]
          })
        ]
      })
    );
    expect(report.assignments.map((x) => [x.id, x.state])).toEqual([
      ["2153", "fetched_no_correlated_reply"],
      ["2154", "unfetched_past_threshold"],
      ["2155", "correlated_reply_observed"]
    ]);
  });
});

describe("unknown assignment input", () => {
  it("is unknown when the input is incomplete, keeping the reason (row 10)", () => {
    const a = { ...assignment(), incomplete: "TIMEOUT" as const, uid: null, ts: null, events: [] };
    expect(one({ assignments: [a] })).toEqual({
      id: "2153",
      ageS: null,
      state: "unknown",
      uncorrelated: 0,
      incomplete: "TIMEOUT"
    });
  });

  it("is unknown when addressed to another role (row 19)", () => {
    expect(one({ assignments: [assignment({ to: "claude-hekate" })] }).state).toBe("unknown");
  });

  it("is unknown with a missing, invalid or future send time (row 20)", () => {
    for (const ts of [null, Number.NaN, -1, AFTER_FETCH_MS / 1000 + 1])
      expect(one({ assignments: [assignment({ ts })] }).state).toBe("unknown");
  });

  it("is unknown when any of its records is later than now", () => {
    const later = AFTER_FETCH_MS / 1000 + 5;
    expect(
      one({
        assignments: [
          assignment({
            events: [
              { kind: "sent", ts: SENT },
              { kind: "offered", ts: later }
            ]
          })
        ]
      }).state
    ).toBe("unknown");
    expect(
      one({ assignments: [assignment({ outcomes: [{ kind: "completed", actor: R, ts: later }] })] })
        .state
    ).toBe("unknown");
  });

  it("makes everything unknown when now or the threshold is invalid (row 21)", () => {
    for (const bad of [
      { nowMs: Number.NaN },
      { nowMs: -1 },
      { thresholdMs: Number.POSITIVE_INFINITY },
      { thresholdMs: -5 }
    ]) {
      const report = classifyActivity(input({ ...bad, transcript: D8E_TAIL }));
      expect(report.assignments.map((x) => x.state)).toEqual(["unknown"]);
      expect(report.session).toBe("session_unknown");
    }
  });
});

describe("session corroboration from transcript metadata", () => {
  it("session d8e91971 after its interruption shows the interruption marker (row 11)", () => {
    expect(sessionOf(D8E_TAIL, AT("2026-10-08T06:30:00Z"))).toBe("interrupted_marker_observed");
  });

  it("an ended assistant turn followed only by bookkeeping is an ended turn (row 12)", () => {
    const t = tail([
      user("2026-10-08T06:00:00Z"),
      assistant("2026-10-08T06:01:00Z", { stopReason: "end_turn" }),
      rec({ type: "queue-operation", ts: AT("2026-10-08T06:05:00Z") })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("ended_turn_observed");
    const s = tail([assistant("2026-10-08T06:01:00Z", { stopReason: "stop_sequence" })]);
    expect(sessionOf(s, AT("2026-10-08T07:00:00Z"))).toBe("ended_turn_observed");
  });

  it("a tool use with no later result is a pending tool of unknown cause (row 13)", () => {
    const t = tail([
      user("2026-10-08T06:00:00Z"),
      assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("tool_pending_unknown_cause");
  });

  it("any unanswered tool use in the last assistant record is pending, not just its last", () => {
    const t = tail([
      assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t1", "t2", "t3"] }),
      user("2026-10-08T06:01:05Z", { toolResultIds: ["t3"] }),
      user("2026-10-08T06:01:06Z", { toolResultIds: ["t2"] })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("tool_pending_unknown_cause");
  });

  it("answered tool uses followed by an ended turn are an ended turn", () => {
    const t = tail([
      assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t1", "t2"] }),
      user("2026-10-08T06:01:05Z", { toolResultIds: ["t1", "t2"] }),
      assistant("2026-10-08T06:01:30Z", { stopReason: "end_turn" })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("ended_turn_observed");
  });

  it("a recent conversational record takes precedence over every other state (row 14)", () => {
    const t = tail([
      assistant("2026-10-08T06:58:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("observed_recent_record");
    expect(sessionOf(D8E_TAIL, AT("2026-10-08T06:05:00Z"))).toBe("observed_recent_record");
  });

  it("is unknown for a truncated window, before any recent, pending or ended state", () => {
    const now = AT("2026-10-08T07:00:00Z");
    const truncated = (r: TranscriptRecord) => tail([r], true);
    expect(
      sessionOf(truncated(assistant("2026-10-08T06:59:00Z", { stopReason: "end_turn" })), now)
    ).toBe("session_unknown");
    expect(
      sessionOf(truncated(assistant("2026-10-08T06:01:00Z", { stopReason: "end_turn" })), now)
    ).toBe("session_unknown");
    expect(
      sessionOf(
        truncated(
          assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] })
        ),
        now
      )
    ).toBe("session_unknown");
    expect(sessionOf({ ...D8E_TAIL, truncated: true }, AT("2026-10-08T06:30:00Z"))).toBe(
      "session_unknown"
    );
  });

  it("a pending tool use takes precedence over a later interruption marker", () => {
    const t = tail([
      assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t9"] }),
      user("2026-10-08T06:02:00Z", { interruptionMarker: true })
    ]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("tool_pending_unknown_cause");
  });

  it("is unknown with a malformed record among the last 20 or after the last assistant record (row 15)", () => {
    const now = AT("2026-10-08T07:00:00Z");
    const ended = assistant("2026-10-08T06:01:00Z", { stopReason: "end_turn" });
    expect(sessionOf(tail([ended, MALFORMED]), now)).toBe("session_unknown");
    const fill = Array.from({ length: 25 }, () => rec({ type: "attachment" }));
    expect(sessionOf(tail([MALFORMED, ended, ...fill]), now)).toBe("ended_turn_observed");
    expect(sessionOf(tail([ended, MALFORMED, ...fill]), now)).toBe("session_unknown");
  });

  it("is unknown without any conversational record (rows 15, 16)", () => {
    expect(sessionOf(tail([]), AT("2026-10-08T07:00:00Z"))).toBe("session_unknown");
    expect(
      sessionOf(
        tail([rec({ type: "attachment" }), rec({ type: "last-prompt" })], true),
        AT("2026-10-08T07:00:00Z")
      )
    ).toBe("session_unknown");
  });

  it("is unobservable without a transcript (row 17)", () => {
    expect(sessionOf(undefined, AT("2026-10-08T07:00:00Z"))).toBe("session_unobservable");
  });

  it("is unknown when a conversational record has no valid time or one later than now", () => {
    const now = AT("2026-10-08T07:00:00Z");
    expect(
      sessionOf(
        tail([assistant("2026-10-08T06:01:00Z", { stopReason: "end_turn", ts: null })]),
        now
      )
    ).toBe("session_unknown");
    expect(
      sessionOf(tail([assistant("2026-10-08T08:00:00Z", { stopReason: "end_turn" })]), now)
    ).toBe("session_unknown");
  });

  it("is unknown when tool use or tool result ids repeat, rather than guessing a pairing", () => {
    const now = AT("2026-10-08T07:00:00Z");
    const dupUse = tail([
      assistant("2026-10-08T06:00:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] }),
      user("2026-10-08T06:00:05Z", { toolResultIds: ["t1"] }),
      assistant("2026-10-08T06:01:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] })
    ]);
    expect(sessionOf(dupUse, now)).toBe("session_unknown");
    const dupResult = tail([
      assistant("2026-10-08T06:00:00Z", { stopReason: "tool_use", toolUseIds: ["t1"] }),
      user("2026-10-08T06:00:05Z", { toolResultIds: ["t1", "t1"] }),
      assistant("2026-10-08T06:01:00Z", { stopReason: "end_turn" })
    ]);
    expect(sessionOf(dupResult, now)).toBe("session_unknown");
  });

  it("is unknown when the last record fits no state", () => {
    const t = tail([assistant("2026-10-08T06:00:00Z", { stopReason: "max_tokens" })]);
    expect(sessionOf(t, AT("2026-10-08T07:00:00Z"))).toBe("session_unknown");
  });
});

describe("the classifier's contract", () => {
  it("reports metadata only, never a liveness word (row 18)", () => {
    const report = classifyActivity(
      input({
        assignments: [assignment({ events: fetchedEvents })],
        transcript: D8E_TAIL,
        nowMs: AT("2026-10-08T06:30:00Z")
      })
    );
    expect(JSON.stringify(report)).not.toMatch(/\b(answered|alive|idle|stalled)\b/);
    expect(Object.keys(report).sort()).toEqual(["agent", "assignments", "session"]);
  });

  it("is pure and deterministic: the input is unchanged and a second call agrees", () => {
    const value = input({
      assignments: [assignment({ events: fetchedEvents })],
      transcript: D8E_TAIL
    });
    const before = structuredClone(value);
    const first = classifyActivity(value);
    expect(value).toEqual(before);
    expect(classifyActivity(value)).toEqual(first);
  });
});
