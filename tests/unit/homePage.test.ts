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

describe("home page plan status panel", () => {
  const scripts = (html: string) =>
    [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("is absent unless the server enables it", () => {
    for (const html of [renderHomePageHtml(), renderHomePageHtml(undefined, true, false)]) {
      expect(html).not.toContain("planStatusPanel");
      expect(html).not.toContain("planRoot");
      expect(html).not.toContain("/development/plans");
    }
    expect(renderHomePageHtml(undefined, false, false)).toBe(renderHomePageHtml());
  });

  it("ships the panel, its script and an unchanged chat script when enabled", () => {
    const off = renderHomePageHtml({ mode: "unknown" }, false, false);
    const on = renderHomePageHtml({ mode: "unknown" }, false, true);
    expect(on).toContain('id="planStatusPanel"');
    expect(on).toContain('id="planRoot"');
    expect(on).toContain("/development/plans/");
    expect(scripts(on)).toHaveLength(scripts(off).length + 1);
    expect(scripts(on)[0]).toBe(scripts(off)[0]);
    for (const script of scripts(on)) expect(() => new Function(script)).not.toThrow();
    // The panel markup sits outside the chat form so Enter cannot send a turn.
    const form = on.slice(on.indexOf("<form"), on.indexOf("</form>"));
    expect(form).not.toContain("planStatusPanel");
  });

  it("keeps the previous page unless both plan status and the run controls are enabled", () => {
    const previous = renderHomePageHtml({ mode: "unknown" }, false, true);
    expect(renderHomePageHtml({ mode: "unknown" }, false, true, false)).toBe(previous);
    expect(renderHomePageHtml({ mode: "unknown" }, false, false, true)).toBe(
      renderHomePageHtml({ mode: "unknown" }, false, false)
    );
    expect(renderHomePageHtml()).toBe(renderHomePageHtml(undefined, false, false, false));
    expect(previous).not.toContain("planRunControls");
    expect(previous).not.toContain("/dispatch");
  });

  it("adds the run controls and one script after the unchanged status script", () => {
    const status = renderHomePageHtml({ mode: "unknown" }, false, true);
    const on = renderHomePageHtml({ mode: "unknown" }, false, true, true);
    for (const label of ["Check host", "Start prepared plan", "Request stop"])
      expect(on).toContain(label);
    expect(scripts(on)).toHaveLength(scripts(status).length + 1);
    for (let i = 0; i < scripts(status).length; i++)
      expect(scripts(on)[i]).toBe(scripts(status)[i]);
    for (const script of scripts(on)) expect(() => new Function(script)).not.toThrow();
    const form = on.slice(on.indexOf("<form"), on.indexOf("</form>"));
    expect(form).not.toContain("planRunControls");
  });

  it("can be combined with documentation tasks", () => {
    const html = renderHomePageHtml(undefined, true, true);
    expect(html).toContain('id="documentTaskStart"');
    expect(html).toContain('id="planStatusPanel"');
    for (const script of scripts(html)) expect(() => new Function(script)).not.toThrow();
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

describe("pinned formatting for conversation controls task outputs", () => {
  it("keeps each allowlisted module byte-identical to pinned Prettier", async () => {
    const { readFileSync } = await import("node:fs");
    const prettier = await import("prettier");
    const config = JSON.parse(readFileSync(".prettierrc.json", "utf8"));
    for (const file of [
      "src/ui/planRunControls.ts",
      "src/integrations/hekate/dispatchHostConfig.ts"
    ]) {
      const raw = readFileSync(file, "utf8");
      expect(raw, file).toBe(await prettier.format(raw, { ...config, filepath: file }));
    }
  });
});
