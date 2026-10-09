import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  projectPublicActivity,
  ATTEMPT_PROGRESS_LIMITS
} from "../../src/integrations/hekate/attemptProgress";
import { claude, traceRecords, SECRETS } from "../helpers/attemptProgressFixtures";
const modulePath = "src/integrations/hekate/attemptProgress.ts";
describe("native public attempt activity contract", () => {
  it("preserves frozen service, guards and projection outside its one function", () => {
    const raw = readFileSync(modulePath, "utf8");
    const begin = raw.indexOf("export function projectPublicActivity(");
    const end = raw.indexOf("\nfunction projectAiSnapshot(", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(digest(raw.slice(0, begin))).toBe(
      "02e15d778267974b0c887d46ff3e53f77ff1e0800c6e715c0385e207d4c9866a"
    );
    expect(digest(raw.slice(end))).toBe(
      "365df87e532aebf9dcef13328d25bb5958d60bac79159a1036e752792f1a9dbd"
    );
  });
  it("preserves frozen limits and emits pinned formatter bytes", async () => {
    expect(ATTEMPT_PROGRESS_LIMITS.maxItems).toBe(20);
    expect(ATTEMPT_PROGRESS_LIMITS.maxBlocksPerRecord).toBe(50);
    const prettier = await import("prettier");
    const config = JSON.parse(readFileSync(".prettierrc.json", "utf8"));
    const raw = readFileSync(modulePath, "utf8");
    expect(raw).toBe(await prettier.format(raw, { ...config, filepath: modulePath }));
  });
});
