import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authenticator";
import { classifyRoute, decideAccess } from "../../src/auth/routePolicy";
import { planRunControlsHtml, planRunControlsScript } from "../../src/ui/planRunControls";
import { planStatusPanelHtml, planStatusScript } from "../../src/ui/planStatusPanel";
import {
  ATTEMPT_PROGRESS_UI_LIMITS,
  attemptProgressHtml,
  attemptProgressScript
} from "../../src/ui/attemptProgress";
import { renderHomePageHtml } from "../../src/ui/homePage";

const mode = { mode: "mock" as const };
const ROOT = "11111111-2222-4333-8444-555555555555";
const NODE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("attempt progress panel markup and script", () => {
  it("is absent unless explicitly enabled, and the earlier panels keep their bytes", () => {
    const base = renderHomePageHtml(mode, false, true, true);
    expect(renderHomePageHtml(mode, false, true, true, false)).toBe(base);
    expect(base).not.toContain("attemptProgress");
    expect(base).not.toContain("progressTask");
    // Without plan status the panel stays out even if requested.
    const noPlan = renderHomePageHtml(mode, false, false, false);
    expect(renderHomePageHtml(mode, false, false, false, true)).toBe(noPlan);
    expect(noPlan).not.toContain("attemptProgress");
    // The enabled page is the same page with exactly the two fragments inserted.
    const on = renderHomePageHtml(mode, false, true, true, true);
    expect(
      on.replace(`\n      ${attemptProgressHtml()}`, "").replace(`\n${attemptProgressScript()}`, "")
    ).toBe(base);
    expect(on).toContain(planStatusPanelHtml());
    expect(on).toContain(planRunControlsHtml());
    expect(on).toContain(planStatusScript());
    expect(on).toContain(planRunControlsScript());
  });

  it("offers the explicit controls without stored credentials or authentication headers", () => {
    const html = attemptProgressHtml();
    for (const label of ["Read attempt progress", "Watch briefly", "Stop watching"])
      expect(html).toContain(`>${label}</button>`);
    const script = attemptProgressScript();
    expect(script).not.toMatch(/sessionStorage|localStorage|document\.cookie|Authorization/);
  });

  it("renders only through textContent", () => {
    const script = attemptProgressScript();
    expect(script).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/
    );
    expect(script).toContain("textContent");
  });

  it("freezes the watch and response bounds", () => {
    expect(ATTEMPT_PROGRESS_UI_LIMITS).toMatchObject({
      maxWatchCycles: 6,
      maxWatchMs: 60_000,
      watchPauseMs: 5_000,
      deadlineMs: 10_000,
      maxResponseBytes: 1024 * 1024
    });
    expect(ATTEMPT_PROGRESS_UI_LIMITS.watchPauseMs).toBeGreaterThanOrEqual(5_000);
    expect(
      ATTEMPT_PROGRESS_UI_LIMITS.maxWatchCycles * ATTEMPT_PROGRESS_UI_LIMITS.watchPauseMs
    ).toBeLessThanOrEqual(ATTEMPT_PROGRESS_UI_LIMITS.maxWatchMs);
  });

  it("is syntactically valid JavaScript", () => {
    const script = attemptProgressScript()
      .replace(/^<script>/, "")
      .replace(/<\/script>$/, "");
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("attempt progress route policy", () => {
  const path = `/development/plans/${ROOT}/nodes/${NODE}/progress`;
  it("is an operator-only GET and nothing else", () => {
    const rule = classifyRoute("GET", path);
    expect(rule?.access).toBe("operator");
    for (const method of ["POST", "DELETE"] as const)
      expect(classifyRoute(method, path)).toBeUndefined();
    expect(classifyRoute("GET", `${path}/extra`)).toBeUndefined();
    expect(classifyRoute("GET", `/development/plans/${ROOT}/nodes/progress`)).toBeUndefined();
  });

  it("refuses an unauthenticated caller and a client-only principal", () => {
    const rule = classifyRoute("GET", path);
    expect(decideAccess(rule, undefined)).toMatchObject({ allow: false, status: 401 });
    const client: Principal = {
      principalId: "c",
      roles: new Set(["client"] as const),
      via: "bearer"
    };
    expect(decideAccess(rule, client)).toMatchObject({ allow: false, status: 403 });
    const operator: Principal = {
      principalId: "o",
      roles: new Set(["client", "operator"] as const),
      via: "bearer"
    };
    expect(decideAccess(rule, operator)).toEqual({ allow: true });
  });
});
