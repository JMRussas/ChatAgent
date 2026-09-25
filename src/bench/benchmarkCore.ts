import { classifyPrompt } from "../routing/classifier";

export interface BenchmarkPrompt {
  id: string;
  text: string;
}

export interface BenchmarkProfile {
  name: string;
  fastProvider: string;
  fastModel: string;
  deepProvider: string;
  deepModel: string;
}

export interface BenchmarkRunRecord {
  promptId: string;
  routeDecision: "direct" | "deep" | "clarify";
  firstResponseLatencyMs: number;
  finalLatencyMs: number;
  qualityScore: number;
  retryCount: number;
  deadLettered: boolean;
}

export interface BenchmarkSummary {
  profile: BenchmarkProfile;
  recordCount: number;
  firstResponseP50: number;
  firstResponseP95: number;
  finalLatencyP95: number;
  avgQuality: number;
  deepRouteRate: number;
  avgRetriesDeep: number;
  deadLetterRateDeep: number;
}

function q(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1));
  return sorted[idx];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function hash01(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return Math.abs(hash % 10000) / 10000;
}

function providerBaseFastP95(provider: string): number {
  if (provider === "ollama") return 1300;
  if (provider === "bedrock") return 1050;
  if (provider === "azure") return 950;
  return 1000;
}

function providerBaseDeepP95(provider: string): number {
  if (provider === "ollama") return 4200;
  if (provider === "bedrock") return 3600;
  if (provider === "azure") return 3200;
  return 3500;
}

function routePrompt(text: string): "direct" | "deep" | "clarify" {
  const c = classifyPrompt(text);
  if (c.ambiguity === "high") return "clarify";
  if (c.externalDataNeeded || c.complexity === "complex") return "deep";
  return "direct";
}

export function runProfileBenchmark(profile: BenchmarkProfile, prompts: BenchmarkPrompt[]): BenchmarkRunRecord[] {
  const records: BenchmarkRunRecord[] = [];

  for (const prompt of prompts) {
    const routeDecision = routePrompt(prompt.text);
    const c = classifyPrompt(prompt.text);
    const routeFactor = c.sizeBand === "small" ? 0.85 : c.sizeBand === "large" ? 1.25 : 1;
    const jitter = 0.9 + hash01(`${profile.name}:${prompt.id}`) * 0.2;

    const fastP95 = providerBaseFastP95(profile.fastProvider) * routeFactor;
    const deepP95 = providerBaseDeepP95(profile.deepProvider) * routeFactor;

    const firstResponseLatencyMs = Math.round((fastP95 * 0.65 + 120) * jitter);
    const deepLatencyMs = Math.round((deepP95 * 0.7 + 300) * jitter);
    const finalLatencyMs = routeDecision === "deep" ? firstResponseLatencyMs + deepLatencyMs : firstResponseLatencyMs;

    const qualityBase = routeDecision === "deep" ? 4.5 : routeDecision === "clarify" ? 4.0 : 4.2;
    const qualityScore = Math.min(5, Math.max(1, qualityBase + (hash01(`${prompt.id}:${profile.fastModel}`) - 0.5) * 0.4));

    const retryCount = routeDecision === "deep" ? (hash01(`${prompt.id}:${profile.deepModel}:retry`) > 0.82 ? 1 : 0) : 0;
    const deadLettered = routeDecision === "deep" ? hash01(`${prompt.id}:${profile.deepProvider}:dlq`) > 0.97 : false;

    records.push({
      promptId: prompt.id,
      routeDecision,
      firstResponseLatencyMs,
      finalLatencyMs,
      qualityScore,
      retryCount,
      deadLettered
    });
  }

  return records;
}

export function summarizeBenchmark(profile: BenchmarkProfile, records: BenchmarkRunRecord[]): BenchmarkSummary {
  const deep = records.filter((r) => r.routeDecision === "deep");

  return {
    profile,
    recordCount: records.length,
    firstResponseP50: q(
      records.map((r) => r.firstResponseLatencyMs),
      0.5
    ),
    firstResponseP95: q(
      records.map((r) => r.firstResponseLatencyMs),
      0.95
    ),
    finalLatencyP95: q(
      records.map((r) => r.finalLatencyMs),
      0.95
    ),
    avgQuality: avg(records.map((r) => r.qualityScore)),
    deepRouteRate: records.length === 0 ? 0 : deep.length / records.length,
    avgRetriesDeep: deep.length === 0 ? 0 : avg(deep.map((r) => r.retryCount)),
    deadLetterRateDeep: deep.length === 0 ? 0 : deep.filter((r) => r.deadLettered).length / deep.length
  };
}

export function renderBenchmarkMarkdown(summaries: BenchmarkSummary[]): string {
  const lines = summaries.map((s) => {
    return `| ${s.profile.name} | ${s.firstResponseP50} | ${s.firstResponseP95} | ${s.finalLatencyP95} | ${s.avgQuality.toFixed(2)} | ${s.deepRouteRate.toFixed(2)} | ${s.avgRetriesDeep.toFixed(2)} | ${s.deadLetterRateDeep.toFixed(2)} |`;
  });

  return [
    "# Provider Benchmark Summary",
    "",
    "| Profile | First p50 (ms) | First p95 (ms) | Final p95 (ms) | Avg Quality | Deep Route Rate | Avg Retries (deep) | Dead Letter Rate (deep) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...lines,
    ""
  ].join("\n");
}
