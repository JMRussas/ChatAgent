import { describe, expect, it } from "vitest";
import { renderHomePageHtml } from "../../src/ui/homePage";

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match || !match[1]) {
    throw new Error("Inline script block not found in home page HTML");
  }

  return match[1];
}

describe("home page HTML", () => {
  it("renders activity inside the matching reply bubble and removes it when complete", () => {
    class Element {
      children: Element[] = [];
      className = "";
      textContent = "";
      attributes: Record<string, string> = {};
      set innerHTML(_value: string) { this.children = []; }
      appendChild(child: Element) { this.children.push(child); }
      setAttribute(name: string, value: string) { this.attributes[name] = value; }
      get lastElementChild() { return this.children.at(-1); }
      scrollIntoView() {}
    }
    const script = extractInlineScript(renderHomePageHtml());
    const render = new Function("state", "thread", "document", "escapeHtml",
      script.slice(script.indexOf("function deriveTurns(events)"), script.indexOf("function renderTelemetry(payload)")) + "renderThread();");
    const thread = new Element();
    const state = {
      events: [
        { type: "user", messageId: "a", text: "question" },
        { type: "activity", messageId: "a", activity: "thinking", routeDecision: "deep" }
      ],
      runtimeInfo: { deepModel: "deep-test" }, previousAssistantStatuses: [], lastThreadRenderKey: ""
    };
    const draw = () => render(state, thread, { createElement: () => new Element() }, (text: string) => text);
    draw();
    const bubble = thread.children[0].children[1];
    expect(bubble.className).toContain("assistant");
    expect(bubble.attributes["aria-busy"]).toBe("true");
    const indicator = bubble.children.find((child) => child.className === "reply-activity")!;
    expect(indicator.children[0].className).toBe("activity-spinner");
    expect(indicator.children[1].textContent).toContain("Thinking · deep-test");
    state.events.push({ type: "refined", messageId: "a", text: "answer" });
    draw();
    const complete = thread.children[0].children[1];
    expect(complete.attributes["aria-busy"]).toBe("false");
    expect(complete.children.some((child) => child.className === "reply-activity")).toBe(false);
  });
  it("keeps deep activity on its own bubble through retries and clears it on completion", () => {
    const script = extractInlineScript(renderHomePageHtml());
    const start = script.indexOf("function deriveTurns(events)");
    const end = script.indexOf("function renderThread()", start);
    const derive = new Function("events", "state", script.slice(start, end) + "return deriveTurns(events).map(turn => ({...turn, label: activityLabel(turn)}));");
    const state = { runtimeInfo: { deepModel: "deep-test", fastModel: "fast-test" } };
    const events = [
      { type: "user", messageId: "a", text: "deep question" },
      { type: "activity", messageId: "a", activity: "queued", routeDecision: "deep" },
      { type: "user", messageId: "b", text: "quick question" },
      { type: "provisional", messageId: "b", text: "done", processingStatus: "complete" },
      { type: "activity", messageId: "a", activity: "thinking" }
    ];
    expect(derive(events, state)).toMatchObject([
      { activity: "thinking", label: "Thinking · deep-test (deep provider)…" },
      { activity: null, label: "" }
    ]);
    events.push({ type: "activity", messageId: "a", activity: "retrying" });
    expect(derive(events, state)[0].label).toContain("Retrying");
    events.push({ type: "activity", messageId: "a", activity: "failed" });
    events.push({ type: "provisional", messageId: "a", text: "late acknowledgment" });
    expect(derive(events, state)[0].activity).toBe("failed");
    events.push({ type: "refined", messageId: "a", text: "replayed successfully" });
    expect(derive(events, state)[0]).toMatchObject({ activity: null, label: "", status: "refined" });
  });
  it("matches overlapping replies by message ID and ignores late provisional replies", () => {
    const script = extractInlineScript(renderHomePageHtml());
    const start = script.indexOf("function deriveTurns(events)");
    const end = script.indexOf("function renderThread()", start);
    const derive = new Function("events", "state", script.slice(start, end) + "return deriveTurns(events);");
    const events = [
      { type: "user", messageId: "a", text: "first" },
      { type: "user", messageId: "b", text: "second" },
      { type: "provisional", messageId: "b", text: "second answer", routeDecision: "direct", processingStatus: "complete" },
      { type: "refined", messageId: "a", text: "first final", routeDecision: "deep" },
      { type: "provisional", messageId: "a", text: "first pending", routeDecision: "deep" }
    ];
    const turns = derive(events, { routeDecision: "clarify" });
    expect(turns).toMatchObject([
      { userText: "first", assistantText: "first final", status: "refined", routeDecision: "deep" },
      { userText: "second", assistantText: "second answer", status: "complete", routeDecision: "direct" }
    ]);
  });
  it("contains required telemetry fields for runtime/provider readout", () => {
    const html = renderHomePageHtml({
      mode: "live",
      fastProvider: "ollama",
      fastModel: "qwen3:8b",
      deepProvider: "ollama",
      deepModel: "qwen3.5:latest"
    });

    expect(html).toContain('id="runtimeMode"');
    expect(html).toContain('id="fastProvider"');
    expect(html).toContain('id="deepProvider"');
    expect(html).toContain("const runtimeInfo =");
  });

  it("emits inline script that parses as valid JavaScript", () => {
    const html = renderHomePageHtml();
    const script = extractInlineScript(html);

    expect(() => {
      void new Function(script);
    }).not.toThrow();
  });
});
