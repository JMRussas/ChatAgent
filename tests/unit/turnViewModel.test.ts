import { describe, expect, it } from "vitest";
import { deriveTurns } from "../../src/ui/turnViewModel";
import { renderHomePageHtml } from "../../src/ui/homePage";
import type { ChatTimelineEvent } from "../../src/domain/types";
const at = "2026-09-25T00:00:00Z";
function event(
  type: ChatTimelineEvent["type"],
  fields: Partial<ChatTimelineEvent> = {}
): ChatTimelineEvent {
  return { type, messageId: "a", text: "", createdAtIso: at, ...fields };
}
describe("turn activity projection", () => {
  it("keeps Stop available before the first activity and orders late fast answers before deep updates", () => {
    expect(deriveTurns([event("user")])[0]).toMatchObject({ active: true, answers: [] });
    const turn = deriveTurns([
      event("user"),
      event("refined", { phase: "deep", text: "deep answer" }),
      event("provisional", { phase: "fast", text: "late fast answer" })
    ])[0];
    expect(turn.answers.map((a) => [a.label, a.text])).toEqual([
      ["Answer", "late fast answer"],
      ["Update", "deep answer"]
    ]);
  });
  it.each(["stop", "length", "cancelled", "error"] as const)(
    "freezes %s attempts against late answers and terminals",
    (finishReason) => {
      const prefix = [
        event("user"),
        event("delta", { phase: "fast", attemptId: "f", text: "original" }),
        event("terminal", { phase: "fast", attemptId: "f", finishReason })
      ];
      const before = deriveTurns(prefix);
      expect(
        deriveTurns([
          ...prefix,
          event("provisional", { phase: "fast", attemptId: "f", text: "late replacement" }),
          event("terminal", {
            phase: "fast",
            attemptId: "f",
            finishReason: "stop",
            createdAtIso: "2026-09-25T00:00:10Z"
          })
        ])
      ).toEqual(before);
    }
  );
  it("still admits the application fallback acknowledgment after an empty fast failure", () => {
    const turn = deriveTurns([
      event("user"),
      event("terminal", { phase: "fast", attemptId: "f", finishReason: "error" }),
      event("provisional", {
        phase: "fast",
        attemptId: "f",
        text: "Queued for deeper analysis",
        answerKind: "acknowledgment"
      })
    ])[0];
    expect(turn.answers[0].text).toBe("Queued for deeper analysis");
    expect(turn.attempts[0].state).toBe("Failed");
  });
  it("keeps concurrent placeholders, models and timestamps attached by messageId", () => {
    const turns = deriveTurns([
      event("user", { text: "A" }),
      event("user", { messageId: "b", text: "B" }),
      event("activity", { phase: "deep", attemptId: "ad", activity: "queued" }),
      event("activity", {
        phase: "deep",
        attemptId: "ad",
        activity: "running",
        createdAtIso: "2026-09-25T00:00:02Z",
        model: { provider: "mock", model: "deep" }
      }),
      event("activity", {
        messageId: "b",
        phase: "fast",
        attemptId: "bf",
        activity: "running",
        model: { provider: "mock", model: "fast", reasoningEnabled: true }
      })
    ]);
    expect(turns[0]).toMatchObject({
      userText: "A",
      answers: [],
      active: true,
      current: {
        model: "deep",
        queuedAt: at,
        startedAt: "2026-09-25T00:00:02Z",
        reasoningEnabled: false
      }
    });
    expect(turns[1]).toMatchObject({
      userText: "B",
      answers: [],
      active: true,
      current: { model: "fast", reasoningEnabled: true }
    });
  });
  it.each(["substantive", "acknowledgment"] as const)(
    "preserves or replaces fast %s appropriately",
    (answerKind) => {
      const turns = deriveTurns([
        event("user"),
        event("provisional", { phase: "fast", attemptId: "f", text: "initial", answerKind }),
        event("terminal", { phase: "fast", attemptId: "f", finishReason: "stop" }),
        event("delta", { phase: "deep", attemptId: "d", text: "updated" }),
        event("delta", { phase: "fast", attemptId: "f", text: "late ignored" }),
        event("refined", { phase: "deep", attemptId: "d", text: "updated final" }),
        event("terminal", { phase: "deep", attemptId: "d", finishReason: "stop" })
      ]);
      expect(turns[0].answers.map((a) => a.text)).toEqual(
        answerKind === "substantive" ? ["initial", "updated final"] : ["updated final"]
      );
      expect(turns[0].answers.at(-1)?.label).toBe(
        answerKind === "substantive" ? "Update" : "Answer"
      );
      expect(turns[0].active).toBe(false);
    }
  );
  it("reconstructs retry history and drafts exactly once across snapshots", () => {
    const events = [
      event("user"),
      event("activity", { phase: "deep", attemptId: "d1", activity: "running" }),
      event("terminal", { phase: "deep", attemptId: "d1", finishReason: "error", retrying: true }),
      event("activity", { phase: "deep", attemptId: "d2", activity: "retrying" }),
      event("activity", {
        phase: "deep",
        attemptId: "d2",
        activity: "running",
        createdAtIso: "2026-09-25T00:00:03Z"
      }),
      event("delta", { phase: "deep", attemptId: "d2", text: "partial" }),
      event("terminal", {
        phase: "deep",
        attemptId: "d2",
        finishReason: "error",
        createdAtIso: "2026-09-25T00:00:04Z"
      })
    ].map((e, i) => ({ ...e, sequence: i + 1 }));
    const original = deriveTurns(events);
    expect(deriveTurns([...events, ...events])).toEqual(original);
    expect(original[0]).toMatchObject({
      active: false,
      status: "Failed",
      current: { startedAt: "2026-09-25T00:00:03Z", endedAt: "2026-09-25T00:00:04Z" }
    });
    expect(original[0].answers.map((a) => a.text)).toEqual(["partial"]);
    expect(original[0].attempts).toHaveLength(2);
  });
  it("uses terminal length/cancellation states without inventing successful steps", () => {
    for (const finishReason of ["length", "cancelled"] as const) {
      const turn = deriveTurns([
        event("user"),
        event("terminal", { phase: "fast", finishReason })
      ])[0];
      expect(turn.active).toBe(false);
      expect(turn.status).toContain(finishReason === "length" ? "Incomplete" : "Cancelled");
      expect(turn.attempts[0].steps).not.toContain("Complete");
    }
  });
});

function createUi(state: { events: ChatTimelineEvent[]; reconnecting: boolean }) {
  class Element {
    children: Element[] = [];
    parent?: Element;
    className = "";
    textContent = "";
    open = false;
    hidden = false;
    type = "";
    onclick?: () => void;
    attributes: Record<string, string> = {};
    dataset: Record<string, string> = {};
    value = "";
    appendChild(child: Element) {
      child.parent = this;
      this.children.push(child);
    }
    insertBefore(child: Element, before: Element | null) {
      child.remove();
      child.parent = this;
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    }
    replaceChildren() {
      this.children = [];
    }
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((e) => e !== this);
    }
  }
  const html = renderHomePageHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const thread = new Element(),
    target = new Element();
  const ui = new Function(
    "state",
    "thread",
    "document",
    "$",
    script.slice(
      script.indexOf("    const deriveTurns ="),
      script.indexOf("    function renderTelemetry")
    ) + "return { renderThread, updateActivityTimers, turnNodes };"
  )(state, thread, { createElement: () => new Element() }, () => target);
  return { ...ui, html };
}

it("preserves answer DOM, disclosure and Stop focus during activity timer ticks and reconnect", () => {
  const state = {
    events: [
      event("user"),
      event("activity", { phase: "fast", attemptId: "f", activity: "running" }),
      event("delta", { phase: "fast", attemptId: "f", text: "hello" })
    ],
    reconnecting: false
  };
  const ui = createUi(state);
  const html = ui.html;
  ui.renderThread();
  const node = ui.turnNodes.get("a");
  const content = node.answerNodes.get("f").content;
  node.details.open = true;
  const stop = node.stop;
  ui.updateActivityTimers();
  expect(node.answerNodes.get("f").content).toBe(content);
  expect(node.stop).toBe(stop);
  state.reconnecting = true;
  ui.renderThread();
  expect(node.transport.textContent).toBe("Live updates reconnecting");
  expect(node.details.open).toBe(true);
  expect(node.answerNodes.get("f").content).toBe(content);
  state.events.push(event("terminal", { phase: "fast", attemptId: "f", finishReason: "stop" }));
  ui.renderThread();
  expect(node.details.open).toBe(false);
  expect(node.stop.hidden).toBe(true);
  expect(node.bubble.attributes["aria-busy"]).toBe("false");
  expect(html).toContain("prefers-reduced-motion");
});

it.each(["length", "error", "cancelled"] as const)(
  "keeps %s fast outcomes visible after a successful deep update",
  (finishReason) => {
    for (const text of ["", "partial"]) {
      const state = {
        reconnecting: false,
        events: [
          event("user"),
          event("delta", { phase: "fast", attemptId: "f", text }),
          event("terminal", { phase: "fast", attemptId: "f", finishReason }),
          event("refined", { phase: "deep", attemptId: "d", text: "complete update" }),
          event("terminal", { phase: "deep", attemptId: "d", finishReason: "stop" })
        ]
      };
      const ui = createUi(state);
      ui.renderThread();
      const node = ui.turnNodes.get("a");
      expect(node.outcomes.textContent).toContain(
        finishReason === "length" ? "Incomplete" : finishReason === "error" ? "Failed" : "Cancelled"
      );
      expect(node.outcomes.textContent).toContain("Fast");
      if (text)
        expect(node.answerNodes.get("f").status.textContent).toContain(
          finishReason === "length"
            ? "Incomplete"
            : finishReason === "error"
              ? "Failed"
              : "Cancelled"
        );
      expect(node.answerNodes.get("d").status.textContent).toBe("Complete");
    }
  }
);
