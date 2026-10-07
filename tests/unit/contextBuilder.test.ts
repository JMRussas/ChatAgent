import { describe, expect, it } from "vitest";
import {
  buildContext,
  ContextBudgetError,
  renderActiveTasksBlock,
  type ContextBudget,
  type ConversationContext,
  type SourceRef
} from "../../src/app/contextBuilder";
import { renderContextSystem } from "../../src/domain/contextRendering";
import { buildSystemAndMessages } from "../../src/providers/contextMessages";
import type { ChatTimelineEvent } from "../../src/domain/types";

const GENEROUS_BUDGET: ContextBudget = {
  windowTokens: 8192,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 2048
};

function baseInput(
  events: ChatTimelineEvent[],
  overrides: Partial<Parameters<typeof buildContext>[0]> = {}
) {
  return {
    conversationId: "conv-1",
    events,
    currentMessageId: "current-msg",
    currentUserText: "why?",
    capturedAtIso: "2026-09-25T12:00:00.000Z",
    systemInstruction: "BASE INSTRUCTIONS",
    roleInstructions: { fast: "FAST ROLE", deep: "DEEP ROLE" },
    budget: GENEROUS_BUDGET,
    ...overrides
  };
}

function userEvent(messageId: string, text: string): ChatTimelineEvent {
  return {
    type: "user",
    messageId,
    text,
    createdAtIso: "2026-09-25T11:00:00.000Z",
    eventId: `${messageId}-user`,
    sequence: 1
  };
}

function completeProvisional(messageId: string, text: string): ChatTimelineEvent {
  return {
    type: "provisional",
    messageId,
    text,
    processingStatus: "complete",
    createdAtIso: "2026-09-25T11:00:01.000Z",
    eventId: `${messageId}-provisional`,
    sequence: 2
  };
}

function pendingProvisional(messageId: string, text: string): ChatTimelineEvent {
  return {
    type: "provisional",
    messageId,
    text,
    processingStatus: "provisional",
    createdAtIso: "2026-09-25T11:00:01.000Z",
    eventId: `${messageId}-provisional`,
    sequence: 2
  };
}

function refined(messageId: string, text: string): ChatTimelineEvent {
  return {
    type: "refined",
    messageId,
    text,
    processingStatus: "complete",
    createdAtIso: "2026-09-25T11:00:05.000Z",
    eventId: `${messageId}-refined`,
    sequence: 4
  };
}

function activity(
  messageId: string,
  act: "queued" | "thinking" | "retrying" | "failed",
  text: string = act
): ChatTimelineEvent {
  return {
    type: "activity",
    messageId,
    activity: act,
    text,
    createdAtIso: "2026-09-25T11:00:02.000Z",
    eventId: `${messageId}-activity-${act}`,
    sequence: 3
  };
}

describe("buildContext", () => {
  it("includes a completed direct answer once, followed by the current user turn", () => {
    const events = [
      userEvent("m1", "What is event sourcing?"),
      completeProvisional("m1", "It's a pattern where...")
    ];

    const result = buildContext(baseInput(events));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.messages).toEqual([
      { role: "user", content: "What is event sourcing?", messageId: "m1" },
      { role: "assistant", content: "It's a pattern where...", messageId: "m1" },
      { role: "user", content: "why?", messageId: "current-msg" }
    ]);
    expect(context.includedTurnIds).toEqual(["m1"]);
    expect(context.omittedTurnIds).toEqual([]);
  });

  it("uses only the refined text for a turn that had a provisional-then-refined answer", () => {
    const events = [
      userEvent("a", "Find latest inflation data"),
      activity("a", "queued"),
      completeProvisional("a", "Working on it..."), // superseded provisional (deep-routed)
      activity("a", "thinking"),
      refined("a", "Inflation is 3.1% per the latest report.")
    ];

    const result = buildContext(baseInput(events, { currentUserText: "why?" }));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    const assistantMessage = context.messages.find(
      (m) => m.messageId === "a" && m.role === "assistant"
    );
    expect(assistantMessage?.content).toBe("Inflation is 3.1% per the latest report.");
    expect(context.messages.some((m) => m.content === "Working on it...")).toBe(false);
  });

  it("represents a still-pending turn as an active task, not as a completed answer", () => {
    const events = [
      userEvent("a", "Find latest inflation data"),
      activity("a", "queued"),
      pendingProvisional("a", "Working on it...")
    ];

    const result = buildContext(
      baseInput(events, { currentUserText: "Also check unemployment", currentMessageId: "b" })
    );
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.includedTurnIds).toEqual([]);
    expect(context.messages.map((m) => m.messageId)).toEqual(["b"]);
    expect(context.messages.some((m) => m.content === "Working on it...")).toBe(false);
    expect(context.activeTasks).toEqual([
      {
        messageId: "a",
        requestText: "Find latest inflation data",
        state: "queued",
        source: {
          conversationId: "conv-1",
          eventId: "a-user",
          messageId: "a",
          contentHash: expect.any(String)
        }
      }
    ]);
  });

  it("excludes activity prose and failed-turn noise from model messages", () => {
    const events = [
      userEvent("failed-1", "Do the impossible thing"),
      activity("failed-1", "queued"),
      activity("failed-1", "failed", "Deep analysis failed after retries.")
    ];

    const result = buildContext(baseInput(events));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.messages.map((m) => m.messageId)).toEqual(["current-msg"]);
    expect(context.activeTasks).toHaveLength(1);
    expect(context.activeTasks[0].state).toBe("failed");
    expect(context.messages.some((m) => m.content.includes("Deep analysis failed"))).toBe(false);
  });

  it("drops the oldest completed pair when the turn limit is smaller than eligible history", () => {
    const events = [
      userEvent("p1", "first question"),
      completeProvisional("p1", "first answer"),
      userEvent("p2", "second question"),
      completeProvisional("p2", "second answer"),
      userEvent("p3", "third question"),
      completeProvisional("p3", "third answer")
    ];

    const result = buildContext(
      baseInput(events, { budget: { ...GENEROUS_BUDGET, maxHistoryTurns: 2 } })
    );
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.includedTurnIds).toEqual(["p2", "p3"]);
    expect(context.omittedTurnIds).toEqual(["p1"]);
    expect(context.messages.map((m) => m.messageId)).toEqual([
      "p2",
      "p2",
      "p3",
      "p3",
      "current-msg"
    ]);
  });

  it("accounts for non-ASCII bytes and rejects an oversized request before any provider call would happen", () => {
    const nonAsciiText = "café résumé 日本語のテキスト";
    const events = [userEvent("m1", nonAsciiText), completeProvisional("m1", nonAsciiText)];

    const tightBudget: ContextBudget = {
      ...GENEROUS_BUDGET,
      windowTokens: 40,
      fastOutputTokens: 1,
      deepOutputTokens: 1,
      safetyTokens: 0
    };
    const result = buildContext(
      baseInput(events, {
        budget: tightBudget,
        systemInstruction: "x".repeat(500),
        currentUserText: nonAsciiText
      })
    );

    expect(result).toBeInstanceOf(ContextBudgetError);
    const error = result as ContextBudgetError;
    expect(error.code).toBe("CONTEXT_TOO_LARGE");
    expect(error.estimatedInputTokens).toBeGreaterThan(error.availableInputTokens);
  });

  it("produces a current-message-only context for an empty timeline", () => {
    const result = buildContext(baseInput([]));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.messages).toEqual([{ role: "user", content: "why?", messageId: "current-msg" }]);
    expect(context.activeTasks).toEqual([]);
    expect(context.includedTurnIds).toEqual([]);
    expect(context.omittedTurnIds).toEqual([]);
    expect(context.memory).toBeNull();
    expect(context.resolvedSources).toEqual([]);
    expect(context.unavailableSources).toEqual([]);
  });

  it("ignores orphaned events without a messageId", () => {
    const orphan: ChatTimelineEvent = {
      type: "activity",
      activity: "queued",
      text: "orphan",
      createdAtIso: "2026-09-25T11:00:00.000Z"
    };
    const result = buildContext(baseInput([orphan]));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;
    expect(context.messages).toEqual([{ role: "user", content: "why?", messageId: "current-msg" }]);
  });

  it("caps active tasks at four most recent, omitting older unresolved turns by id", () => {
    const events: ChatTimelineEvent[] = [];
    for (let i = 1; i <= 6; i += 1) {
      events.push(userEvent(`u${i}`, `request ${i}`));
      events.push(activity(`u${i}`, "queued"));
    }

    const result = buildContext(baseInput(events));
    expect(result).not.toBeInstanceOf(ContextBudgetError);
    const context = result as Exclude<typeof result, ContextBudgetError>;

    expect(context.activeTasks.map((t) => t.messageId)).toEqual(["u3", "u4", "u5", "u6"]);
    expect(context.omittedActiveTaskIds).toEqual(["u1", "u2"]);
  });
});

describe("omittedSourceCount", () => {
  // Same-length identifiers, so every single marker costs the same.
  const ref = (id: string): SourceRef => ({
    conversationId: "conv-1",
    eventId: `${id}-user`,
    messageId: id,
    contentHash: "a".repeat(64)
  });
  const [s1, s2] = [ref("s1"), ref("s2")];
  /** The rendered cost of these markers alone, as the builder measures it (fast role). */
  const markerCost = (refs: SourceRef[]) =>
    Buffer.byteLength(renderContextSystem("BASE INSTRUCTIONS", "FAST ROLE", [], null, [], refs)) -
    Buffer.byteLength(renderContextSystem("BASE INSTRUCTIONS", "FAST ROLE", []));
  const built = (input: Parameters<typeof buildContext>[0]) => {
    const result = buildContext(input);
    if (result instanceof ContextBudgetError) throw result;
    return result;
  };
  /** The count is host-only: prompt bytes, allocation and budget match the equivalent input. */
  const expectSamePrompt = (a: ConversationContext, b: ConversationContext) => {
    for (const role of ["fast", "deep"] as const)
      expect(buildSystemAndMessages(a, role)).toEqual(buildSystemAndMessages(b, role));
    expect(a.budgetUsage).toEqual(b.budgetUsage);
    expect(a.estimatedInputTokens).toBe(b.estimatedInputTokens);
    expect(a.includedTurnIds).toEqual(b.includedTurnIds);
  };

  it("is zero when no sources were requested", () => {
    expect(built(baseInput([])).omittedSourceCount).toBe(0);
  });

  it("counts every requested source when the memory allowance has no room", () => {
    const context = built(baseInput([], { summaryMaxTokens: 0, unavailableSources: [s1, s2] }));
    expect(context.unavailableSources).toEqual([]);
    expect(context.omittedSourceCount).toBe(2);
    // The model sees exactly what it would have seen had nothing been requested.
    expectSamePrompt(context, built(baseInput([], { summaryMaxTokens: 0 })));
  });

  it("shows a marker at its exact rendered cost and counts it one byte under", () => {
    const one = markerCost([s1]);
    expect(markerCost([s1, s2])).toBeGreaterThan(one);
    const exact = built(baseInput([], { summaryMaxTokens: one, unavailableSources: [s1, s2] }));
    expect(exact.unavailableSources).toEqual([s1]);
    expect(exact.omittedSourceCount).toBe(1);
    expectSamePrompt(
      exact,
      built(baseInput([], { summaryMaxTokens: one, unavailableSources: [s1] }))
    );

    const under = built(baseInput([], { summaryMaxTokens: one - 1, unavailableSources: [s1, s2] }));
    expect(under.unavailableSources).toEqual([]);
    expect(under.omittedSourceCount).toBe(2);
    expectSamePrompt(under, built(baseInput([], { summaryMaxTokens: one - 1 })));
  });

  it("does not count an oversized excerpt that is shown as its unavailable marker", () => {
    const context = built(
      baseInput([], {
        summaryMaxTokens: markerCost([s1]),
        resolvedSources: [{ source: s1, text: "x".repeat(5000) }]
      })
    );
    expect(context.resolvedSources).toEqual([]);
    expect(context.unavailableSources).toEqual([s1]);
    expect(context.omittedSourceCount).toBe(0);
    expectSamePrompt(
      context,
      built(baseInput([], { summaryMaxTokens: markerCost([s1]), unavailableSources: [s1] }))
    );
  });

  it("counts each distinct requested source once, across duplicates and both lists", () => {
    const context = built(
      baseInput([], {
        summaryMaxTokens: 0,
        resolvedSources: [{ source: s1, text: "quoted" }],
        unavailableSources: [s1, s2, s2]
      })
    );
    expect(context.omittedSourceCount).toBe(2);
    const shown = built(
      baseInput([], { summaryMaxTokens: markerCost([s1]), unavailableSources: [s1, s1] })
    );
    expect(shown.unavailableSources).toEqual([s1]);
    expect(shown.omittedSourceCount).toBe(0);
  });

  it("does not count a source represented by the final exact history, older pairs included", () => {
    const events: ChatTimelineEvent[] = [];
    for (let i = 1; i <= 5; i += 1)
      events.push(userEvent(`o${i}`, `question ${i}`), completeProvisional(`o${i}`, `answer ${i}`));
    // o1's marker does not fit, but o1 is admitted later as an older exact pair;
    // o5 is one of the newest pairs and is never given a marker.
    const refs = [ref("o1"), ref("o5")];
    const admitted = built(baseInput(events, { summaryMaxTokens: 0, unavailableSources: refs }));
    expect(admitted.includedTurnIds).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    expect(admitted.unavailableSources).toEqual([]);
    expect(admitted.omittedSourceCount).toBe(0);
    expectSamePrompt(admitted, built(baseInput(events, { summaryMaxTokens: 0 })));

    // With o1 outside the history limit, nothing represents it.
    const limited = { ...GENEROUS_BUDGET, maxHistoryTurns: 4 };
    const excluded = built(
      baseInput(events, { budget: limited, summaryMaxTokens: 0, unavailableSources: refs })
    );
    expect(excluded.includedTurnIds).toEqual(["o2", "o3", "o4", "o5"]);
    expect(excluded.omittedSourceCount).toBe(1);
    expectSamePrompt(excluded, built(baseInput(events, { budget: limited, summaryMaxTokens: 0 })));
  });
});

describe("renderActiveTasksBlock", () => {
  it("returns null when there are no active tasks", () => {
    expect(renderActiveTasksBlock([])).toBeNull();
  });

  it("renders a delimited, explicitly-untrusted block for pending tasks", () => {
    const block = renderActiveTasksBlock([
      {
        messageId: "a",
        requestText: "check inflation",
        state: "queued",
        source: { conversationId: "c", eventId: "e", messageId: "a", contentHash: "h" }
      }
    ]);

    expect(block).toContain("[UNRESOLVED_REQUESTS");
    expect(block).toContain("untrusted data");
    expect(block).toContain("[queued] check inflation");
    expect(block).toContain("[/UNRESOLVED_REQUESTS]");
  });
});
