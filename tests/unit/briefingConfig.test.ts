import { describe, expect, it } from "vitest";
import { bindBriefingSources, defaultNbaProfile } from "../../src/sports/briefingConfig";
import { planBriefing } from "../../src/sports/briefingPlan";
import type { SportsSource } from "../../src/sports/sources";
const input = { now: "2026-09-30T12:00:00Z", timezone: "UTC" };
describe("briefing configuration", () => {
  it("applies edited windows, task selection and source budgets without requiring a team", () => {
    const profile = defaultNbaProfile();
    profile.initialLookbackHours = 6; profile.maxCatchupHours = 48;
    profile.tasks = [profile.tasks[0]];
    profile.tasks[0].sources = [{ adapterId: "custom-news", kind: "news", limit: 3, maxAgeMs: 5000 }];
    const plan = planBriefing(input, profile);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.questions).toEqual([]);
    expect(plan.tasks[0].window.fromInclusive).toBe("2026-09-30T06:00:00.000Z");
    expect(plan.tasks[0].sources).toEqual(profile.tasks[0].sources);
    const catchup = planBriefing({ ...input, lastSuccessful: { league: "2026-09-01T00:00:00Z" } }, profile);
    expect(catchup.tasks[0].window).toMatchObject({ fromInclusive: "2026-09-28T12:00:00.000Z", truncated: true });
  });
  it("changes the profile digest when budgets change and isolates default instances", () => {
    const profile = defaultNbaProfile(), original = planBriefing(input, profile);
    profile.tasks[0].sources[0].limit = 1;
    expect(planBriefing(input, profile).profileDigest).not.toBe(original.profileDigest);
    expect(planBriefing(input, defaultNbaProfile()).profileDigest).toBe(original.profileDigest);
  });
  it("rejects conflicting windows, duplicate tasks, invalid source kinds and excessive budgets", () => {
    const profile = defaultNbaProfile();
    for (const bad of [
      { ...profile, initialLookbackHours: 200 },
      { ...profile, tasks: [profile.tasks[0], profile.tasks[0]] },
      { ...profile, tasks: [{ ...profile.tasks[0], sources: [{ adapterId: "x", kind: "unknown", limit: 1, maxAgeMs: 1 }] }] },
      { ...profile, tasks: [{ ...profile.tasks[0], sources: [{ adapterId: "x", kind: "news", limit: 101, maxAgeMs: 1 }] }] }
    ]) expect(() => planBriefing(input, bad)).toThrow();
  });
  it("binds caller-supplied sources without reading them and fails before work on missing adapters", () => {
    const adapter: SportsSource = { read: async () => { throw new Error("Should not read during binding"); } };
    const profile = defaultNbaProfile();
    const registry = new Map([ ["games", adapter], ["news", adapter], ["availability", adapter] ]);
    expect(bindBriefingSources(profile, registry)[1].sources[2].adapter).toBe(adapter);
    registry.delete("availability");
    expect(() => bindBriefingSources(profile, registry)).toThrow("SPORTS_ADAPTER_MISSING: availability");
  });
});
