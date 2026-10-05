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

describe("home page conversation expiry", () => {
  it("ships the expiry notice, the stream event handler and the 410 probe", () => {
    const html = renderHomePageHtml();
    expect(html).toContain('id="conversationNotice"');
    expect(html).toContain('id="newConversation"');
    const script = extractInlineScript(html);
    expect(script).toContain('addEventListener("conversation-expired"');
    expect(script).toContain("res.status === 410");
    expect(script).toContain("CONVERSATION_HISTORY_CAPACITY");
  });
});
