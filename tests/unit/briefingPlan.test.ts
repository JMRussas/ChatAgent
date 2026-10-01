import { describe, expect, it } from "vitest";
import { planNbaBriefing } from "../../src/sports/briefingPlan";

const base = { now: "2026-09-30T12:00:00Z", timezone: "America/New_York" };
describe("NBA briefing planning", () => {
  it("leaves league work available while asking for an unknown team", () => {
    const plan = planNbaBriefing(base);
    expect(plan.execution).toBe("not-started");
    expect(plan.tasks.map((t) => t.state)).toEqual(["ready", "needs-input"]);
    expect(plan.tasks[0].window).toEqual({
      fromInclusive: "2026-09-29T12:00:00.000Z",
      toExclusive: "2026-09-30T12:00:00.000Z",
      basis: "initial-lookback",
      truncated: false
    });
    expect(plan.questions).toHaveLength(1);
  });
  it("uses independent successful coverage checkpoints and preserves the selected identity", () => {
    const team = { provider: "fixture", id: "example-team", name: "Fictional test team" };
    const plan = planNbaBriefing({
      ...base,
      team,
      lastSuccessful: { league: "2026-09-30T10:00:00Z", team: "2026-09-29T16:00:00-04:00" }
    });
    expect(plan.tasks[0].window.fromInclusive).toBe("2026-09-30T10:00:00.000Z");
    expect(plan.tasks[1].window.fromInclusive).toBe("2026-09-29T20:00:00.000Z");
    expect(plan.tasks[1].team).toEqual(team);
    expect(plan.tasks[1].state).toBe("ready");
    expect(plan.questions).toEqual([]);
  });
  it("discloses a capped catch-up window rather than silently claiming full coverage", () => {
    const plan = planNbaBriefing({
      ...base,
      lastSuccessful: { league: "2026-08-01T00:00:00Z", team: null }
    });
    expect(plan.tasks[0].window.fromInclusive).toBe("2026-09-23T12:00:00.000Z");
    expect(plan.tasks[0].window.truncated).toBe(true);
    expect(plan.tasks[1].window.truncated).toBe(false);
  });
  it("rejects future checkpoints, invalid dates, ambiguous time and invalid timezones", () => {
    expect(() =>
      planNbaBriefing({ ...base, lastSuccessful: { team: "2026-10-01T00:00:00Z" } })
    ).toThrow();
    expect(() => planNbaBriefing({ ...base, now: "2026-09-30T12:00:00" })).toThrow();
    expect(() => planNbaBriefing({ ...base, now: "2026-02-30T12:00:00Z" })).toThrow();
    expect(() => planNbaBriefing({ ...base, timezone: "Boston" })).toThrow();
  });
});
