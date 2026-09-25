import { describe, expect, it } from "vitest";
import { InMemoryLatencyEstimator } from "../../src/telemetry/latencyEstimator";

describe("latency estimator", () => {
  it("returns seeded priors when no live samples exist", () => {
    const estimator = new InMemoryLatencyEstimator();

    estimator.seedPrior(
      {
        provider: "azure",
        model: "gpt-fast",
        route: "direct",
        sizeBand: "small"
      },
      { p50: 200, p90: 400, p95: 500, p99: 900 }
    );

    const estimate = estimator.estimate({
      provider: "azure",
      model: "gpt-fast",
      route: "direct",
      sizeBand: "small"
    });

    expect(estimate.p95).toBe(500);
    expect(estimate.sampleCount).toBe(0);
    expect(estimate.confidence).toBe("low");
  });

  it("blends priors with live data and reports confidence", () => {
    const estimator = new InMemoryLatencyEstimator();

    estimator.seedPrior(
      {
        provider: "azure",
        model: "gpt-fast",
        route: "direct",
        sizeBand: "small"
      },
      { p50: 200, p90: 400, p95: 500, p99: 900 }
    );

    for (let i = 0; i < 120; i += 1) {
      estimator.recordLatency(
        {
          provider: "azure",
          model: "gpt-fast",
          route: "direct",
          sizeBand: "small"
        },
        800 + (i % 10)
      );
    }

    const estimate = estimator.estimate({
      provider: "azure",
      model: "gpt-fast",
      route: "direct",
      sizeBand: "small"
    });

    expect(estimate.sampleCount).toBe(120);
    expect(estimate.confidence).toBe("medium");
    expect(estimate.p95).toBeGreaterThan(500);
  });

  it("supports snapshot and hydrate round trip", () => {
    const estimator = new InMemoryLatencyEstimator();
    const bucket = {
      provider: "ollama",
      model: "llama3.1:8b",
      route: "deep" as const,
      sizeBand: "medium" as const
    };

    estimator.seedPrior(bucket, { p50: 700, p90: 1100, p95: 1400, p99: 2200 });
    estimator.recordLatency(bucket, 1600);
    estimator.recordLatency(bucket, 1800);

    const snapshot = estimator.snapshot();

    const restored = new InMemoryLatencyEstimator();
    restored.hydrate(snapshot);

    const estimate = restored.estimate(bucket);
    expect(estimate.sampleCount).toBe(2);
    expect(estimate.bucket.provider).toBe("ollama");
  });
});
