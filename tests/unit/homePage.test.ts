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
