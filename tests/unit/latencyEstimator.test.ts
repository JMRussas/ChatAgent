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

  it("keeps only recent samples per bucket when window limit is reached", () => {
    const estimator = new InMemoryLatencyEstimator({ maxSamplesPerBucket: 3 });
    const bucket = {
      provider: "azure",
      model: "gpt-fast",
      route: "direct" as const,
      sizeBand: "small" as const
    };

    estimator.recordLatency(bucket, 100);
    estimator.recordLatency(bucket, 200);
    estimator.recordLatency(bucket, 300);
    estimator.recordLatency(bucket, 400);

    const snapshot = estimator.snapshot();
    expect(snapshot.samples[0]?.values).toEqual([200, 300, 400]);

    const estimate = estimator.estimate(bucket);
    expect(estimate.sampleCount).toBe(3);
    expect(estimate.p95).toBeGreaterThan(0);
  });

  it("ignores non-finite and non-positive latency values", () => {
    const estimator = new InMemoryLatencyEstimator();
    const bucket = {
      provider: "bedrock",
      model: "claude-sonnet",
      route: "clarify" as const,
      sizeBand: "medium" as const
    };

    estimator.recordLatency(bucket, NaN);
    estimator.recordLatency(bucket, Number.POSITIVE_INFINITY);
    estimator.recordLatency(bucket, 0);
    estimator.recordLatency(bucket, -5);

    const estimate = estimator.estimate(bucket);
    expect(estimate.sampleCount).toBe(0);
  });

  it("trims hydrated samples to window and drops invalid values", () => {
    const estimator = new InMemoryLatencyEstimator({ maxSamplesPerBucket: 2 });
    const bucket = {
      provider: "ollama",
      model: "llama3.1:8b",
      route: "deep" as const,
      sizeBand: "large" as const
    };

    estimator.hydrate({
      priors: [],
      samples: [
        {
          bucket,
          values: [100, 200, NaN, 300]
        }
      ]
    });

    const snapshot = estimator.snapshot();
    expect(snapshot.samples[0]?.values).toEqual([200, 300]);

    const estimate = estimator.estimate(bucket);
    expect(estimate.sampleCount).toBe(2);
  });
});
