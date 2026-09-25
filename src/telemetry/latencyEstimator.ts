import type { PromptSizeBand } from "../routing/classifier";

export interface LatencyBucket {
  provider: string;
  model: string;
  route: "direct" | "deep" | "clarify";
  sizeBand: PromptSizeBand;
}

export interface LatencyPercentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export type ConfidenceTier = "low" | "medium" | "high";

export interface LatencyEstimate extends LatencyPercentiles {
  bucket: LatencyBucket;
  sampleCount: number;
  confidence: ConfidenceTier;
}

export interface LatencyEstimatorSnapshot {
  priors: Array<{ bucket: LatencyBucket; prior: LatencyPercentiles }>;
  samples: Array<{ bucket: LatencyBucket; values: number[] }>;
}

export interface LatencyEstimatorOptions {
  maxSamplesPerBucket: number;
}

function keyOf(bucket: LatencyBucket): string {
  return `${bucket.provider}|${bucket.model}|${bucket.route}|${bucket.sizeBand}`;
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.max(0, Math.min(sortedValues.length - 1, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[idx];
}

function confidenceTier(sampleCount: number): ConfidenceTier {
  if (sampleCount >= 300) return "high";
  if (sampleCount >= 100) return "medium";
  return "low";
}

function liveWeight(sampleCount: number): number {
  return Math.min(1, sampleCount / 300);
}

export class InMemoryLatencyEstimator {
  private readonly priors = new Map<string, LatencyPercentiles>();
  private readonly samples = new Map<string, number[]>();

  constructor(private readonly options: LatencyEstimatorOptions = { maxSamplesPerBucket: 1000 }) {}

  seedPrior(bucket: LatencyBucket, prior: LatencyPercentiles): void {
    this.priors.set(keyOf(bucket), prior);
  }

  recordLatency(bucket: LatencyBucket, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }

    const key = keyOf(bucket);
    const list = this.samples.get(key) ?? [];
    list.push(latencyMs);

    if (list.length > this.options.maxSamplesPerBucket) {
      const overflow = list.length - this.options.maxSamplesPerBucket;
      list.splice(0, overflow);
    }

    this.samples.set(key, list);
  }

  estimate(bucket: LatencyBucket): LatencyEstimate {
    const key = keyOf(bucket);
    const prior = this.priors.get(key) ?? { p50: 700, p90: 1200, p95: 1500, p99: 2500 };
    const values = [...(this.samples.get(key) ?? [])].sort((a, b) => a - b);

    if (values.length === 0) {
      return {
        bucket,
        ...prior,
        sampleCount: 0,
        confidence: "low"
      };
    }

    const observed: LatencyPercentiles = {
      p50: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      p95: quantile(values, 0.95),
      p99: quantile(values, 0.99)
    };

    const w = liveWeight(values.length);

    return {
      bucket,
      p50: prior.p50 * (1 - w) + observed.p50 * w,
      p90: prior.p90 * (1 - w) + observed.p90 * w,
      p95: prior.p95 * (1 - w) + observed.p95 * w,
      p99: prior.p99 * (1 - w) + observed.p99 * w,
      sampleCount: values.length,
      confidence: confidenceTier(values.length)
    };
  }

  listEstimates(): LatencyEstimate[] {
    const keyBuckets = new Map<string, LatencyBucket>();

    for (const [key, _prior] of this.priors) {
      keyBuckets.set(key, this.bucketFromKey(key));
    }

    for (const [key, _samples] of this.samples) {
      keyBuckets.set(key, this.bucketFromKey(key));
    }

    return [...keyBuckets.values()].map((bucket) => this.estimate(bucket));
  }

  snapshot(): LatencyEstimatorSnapshot {
    const priors = [...this.priors.entries()].map(([key, prior]) => ({
      bucket: this.bucketFromKey(key),
      prior
    }));

    const samples = [...this.samples.entries()].map(([key, values]) => ({
      bucket: this.bucketFromKey(key),
      values: [...values]
    }));

    return { priors, samples };
  }

  hydrate(snapshot: LatencyEstimatorSnapshot): void {
    this.priors.clear();
    this.samples.clear();

    for (const item of snapshot.priors) {
      this.priors.set(keyOf(item.bucket), item.prior);
    }

    for (const item of snapshot.samples) {
      const values = item.values.filter((value) => Number.isFinite(value) && value > 0);
      if (values.length > this.options.maxSamplesPerBucket) {
        const overflow = values.length - this.options.maxSamplesPerBucket;
        values.splice(0, overflow);
      }

      this.samples.set(keyOf(item.bucket), values);
    }
  }

  private bucketFromKey(key: string): LatencyBucket {
    const [provider, model, route, sizeBand] = key.split("|");
    return {
      provider,
      model,
      route: route as LatencyBucket["route"],
      sizeBand: sizeBand as PromptSizeBand
    };
  }
}
