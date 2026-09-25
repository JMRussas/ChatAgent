import { describe, expect, it } from "vitest";
import { compareBenchmarkFiles, computeDeltas, evaluateDeltas, renderCompareMarkdown } from "../../src/bench/compareCore";

const baseline = {
  generatedAtIso: "2026-09-25T00:00:00.000Z",
  mode: "simulate",
  runContext: {
    simulationSeed: "seed-a",
    promptsDigestSha256: "p1",
    profilesDigestSha256: "prof1"
  },
  summaries: [
    {
      profile: {
        name: "azure-balanced",
        fastProvider: "azure",
        fastModel: "gpt-4o-mini",
        deepProvider: "azure",
        deepModel: "gpt-4.1"
      },
      recordCount: 6,
      firstResponseP50: 500,
      firstResponseP95: 900,
      finalLatencyP95: 3000,
      avgQuality: 4.3,
      deepRouteRate: 0.4,
      avgRetriesDeep: 0.1,
      deadLetterRateDeep: 0
    }
  ]
};

describe("benchmark compare core", () => {
  it("computes profile deltas", () => {
    const candidate = {
      ...baseline,
      summaries: [
        {
          ...baseline.summaries[0],
          firstResponseP95: 980,
          finalLatencyP95: 3100,
          avgQuality: 4.28,
          avgRetriesDeep: 0.2,
          deadLetterRateDeep: 0.01
        }
      ]
    };

    const deltas = computeDeltas(baseline, candidate);
    expect(deltas.length).toBe(1);
    expect(deltas[0].firstResponseP95DeltaMs).toBe(80);
    expect(deltas[0].avgQualityDelta).toBeCloseTo(-0.02, 4);
  });

  it("fails gates when regression thresholds are exceeded", () => {
    const candidate = {
      ...baseline,
      summaries: [
        {
          ...baseline.summaries[0],
          firstResponseP95: 1200,
          finalLatencyP95: 3600,
          avgQuality: 4.0,
          deadLetterRateDeep: 0.2
        }
      ]
    };

    const report = evaluateDeltas(computeDeltas(baseline, candidate), {
      maxFirstResponseP95RegressionMs: 100,
      maxFinalLatencyP95RegressionMs: 200,
      maxDeadLetterRateRegression: 0.05,
      minQualityDelta: -0.05
    });

    expect(report.passed).toBe(false);
    expect(report.gates.some((g) => !g.passed)).toBe(true);
  });

  it("renders markdown report", () => {
    const report = evaluateDeltas(computeDeltas(baseline, baseline), {
      maxFirstResponseP95RegressionMs: 100,
      maxFinalLatencyP95RegressionMs: 200,
      maxDeadLetterRateRegression: 0.05,
      minQualityDelta: -0.05
    });

    const markdown = renderCompareMarkdown(report);
    expect(markdown).toContain("# Benchmark Comparison Report");
    expect(markdown).toContain("Overall: PASS");
  });

  it("fails compare when benchmark contexts are incompatible", () => {
    const candidate = {
      ...baseline,
      runContext: {
        ...baseline.runContext,
        simulationSeed: "seed-b"
      }
    };

    const report = compareBenchmarkFiles(baseline, candidate, {
      maxFirstResponseP95RegressionMs: 100,
      maxFinalLatencyP95RegressionMs: 200,
      maxDeadLetterRateRegression: 0.05,
      minQualityDelta: -0.05
    });

    expect(report.passed).toBe(false);
    expect(report.compatibilityIssues.some((issue) => issue.includes("simulation seed mismatch"))).toBe(true);
  });
});
