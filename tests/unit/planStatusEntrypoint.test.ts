import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Frozen acceptance for the operator entrypoint. Runtime exit semantics are
// exercised separately by devcoordCheck.test.ts against a real loopback server.
describe("plan monitoring entrypoint", () => {
  it("documents a copyable status command and its supervision limits", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("npx tsx scripts/devcoord.ts status --root");
    expect(readme).toContain("HEKATE_PLAN_API_URL");
    expect(readme).toContain("--json");
    expect(readme).toContain("--check");
    expect(readme).toMatch(/read.only/i);
    expect(readme).toMatch(/liveness/i);
  });

  it("preserves the existing status implementation and fixtures", () => {
    expect(readFileSync("scripts/devcoord.ts", "utf8")).toContain(
      "execution acknowledgement unknown"
    );
    expect(
      JSON.parse(readFileSync("tests/fixtures/hekate/plan-run-v0/MANIFEST.json", "utf8")).states.S5
    ).toBeDefined();
  });
});
