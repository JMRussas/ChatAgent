import { describe, expect, it } from "vitest";
import { renderBenchmarkMarkdown, runProfileBenchmark, summarizeBenchmark } from "../../src/bench/benchmarkCore";

describe("benchmark core", () => {
  it("produces deterministic run records and summary", () => {
    const profile = {
      name: "azure-balanced",
      fastProvider: "azure",
      fastModel: "gpt-4o-mini",
      deepProvider: "azure",
      deepModel: "gpt-4.1"
    };

    const prompts = [
      { id: "p1", text: "Explain event-driven architecture" },
      { id: "p2", text: "Find latest inflation data and cite sources" }
    ];

    const records = runProfileBenchmark(profile, prompts);
    const summary = summarizeBenchmark(profile, records);

    expect(records.length).toBe(2);
    expect(summary.recordCount).toBe(2);
    expect(summary.firstResponseP95).toBeGreaterThan(0);
    expect(summary.finalLatencyP95).toBeGreaterThanOrEqual(summary.firstResponseP95);
  });

  it("renders markdown summary table", () => {
    const markdown = renderBenchmarkMarkdown([
      {
        profile: {
          name: "ollama-local",
          fastProvider: "ollama",
          fastModel: "llama3.1:8b",
          deepProvider: "ollama",
          deepModel: "qwen2.5:14b"
        },
        recordCount: 6,
        firstResponseP50: 600,
        firstResponseP95: 1100,
        finalLatencyP95: 3200,
        avgQuality: 4.2,
        deepRouteRate: 0.5,
        avgRetriesDeep: 0.2,
        deadLetterRateDeep: 0.0
      }
    ]);

    expect(markdown).toContain("# Provider Benchmark Summary");
    expect(markdown).toContain("ollama-local");
  });
});
