import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The reviewed ChatAgent profile for Hekate's single-task authoring command (hekate-task-profile.v0).
// The command composes a supervised-task-spec.v0 from it plus a per-task draft, and refuses when a
// pinned tool on disk or the task base's lockfile does not hash to the pin recorded here. These checks
// keep the profile coherent with this repository; they never read the tools (their paths are local
// to the coordinator machine).
const profile = JSON.parse(readFileSync("docs/contracts/hekate-task-profile.json", "utf8"));
const HEX64 = /^[0-9a-f]{64}$/;

describe("Hekate task profile", () => {
  it("has exactly the agreed shape", () => {
    expect(Object.keys(profile).sort()).toEqual(
      ["deps", "lock", "oracleRunner", "repo", "steps", "tools", "version", "worker"].sort()
    );
    expect(profile.version).toBe("hekate-task-profile.v0");
    expect(Object.keys(profile.tools).sort()).toEqual(["npmCli", "pinnedNodeExe"]);
    expect(Object.keys(profile.lock).sort()).toEqual(["packageLock", "tscEntry", "vitestEntry"]);
  });

  it("pins every tool by path, version and sha256", () => {
    for (const tool of Object.values(profile.tools) as Record<string, string>[]) {
      expect(Object.keys(tool).sort()).toEqual(["path", "sha256", "version"]);
      expect(tool.sha256).toMatch(HEX64);
      expect(tool.path).toMatch(/^[A-Za-z]:\/\S+$/);
    }
    for (const pin of Object.values(profile.lock)) expect(pin).toMatch(HEX64);
  });

  it("pins this repository's current lockfile and Node version", () => {
    const lock = createHash("sha256").update(readFileSync("package-lock.json")).digest("hex");
    expect(profile.lock.packageLock).toBe(lock);
    const declared = readFileSync(".node-version", "utf8").trim();
    expect(profile.tools.pinnedNodeExe.version).toBe(`v${declared}`);
  });

  it("runs every command with the pinned Node, with the oracle placeholder only in the runner", () => {
    const uses = (argv: string[]) => argv.filter((a) => a.includes("{oracle}")).length;
    expect(profile.oracleRunner.argv[0]).toBe(profile.tools.pinnedNodeExe.path);
    expect(uses(profile.oracleRunner.argv)).toBe(1);
    for (const step of profile.steps) {
      expect(step.argv[0]).toBe(profile.tools.pinnedNodeExe.path);
      expect(uses(step.argv)).toBe(0);
    }
  });

  it("keeps the reviewed verify steps after the oracle, offline deps and worker bounds", () => {
    expect(profile.steps.map((s: { name: string }) => s.name)).toEqual([
      "typecheck",
      "full-suite",
      "docs-check"
    ]);
    expect(profile.deps).toMatchObject({ kind: "npm-ci", network: "offline" });
    expect(profile.worker).toEqual({
      model: "sonnet",
      budgetUsd: "1.00",
      maxRounds: 2,
      maxTurns: 40
    });
  });
});
