import { describe, expect, it } from "vitest";
import { normalizeBenchmarkMode, shouldRunBenchmarkCli, validateBenchmarkPrompts } from "../../src/bench/runBenchmark";
import { pathToFileURL } from "node:url";

describe("run benchmark config validation", () => {
  it("normalizes supported benchmark mode values", () => {
    expect(normalizeBenchmarkMode(undefined)).toBe("simulate");
    expect(normalizeBenchmarkMode("LIVE")).toBe("live");
    expect(normalizeBenchmarkMode("simulate")).toBe("simulate");
  });

  it("throws for unsupported benchmark mode values", () => {
    expect(() => normalizeBenchmarkMode("sim")).toThrow(/Invalid BENCH_MODE/);
  });

  it("accepts valid prompt arrays", () => {
    const prompts = validateBenchmarkPrompts([
      { id: "p1", text: "Explain event loops" },
      { id: "p2", text: "Find latest inflation" }
    ]);

    expect(prompts.length).toBe(2);
  });

  it("rejects prompt arrays with duplicate ids", () => {
    expect(() =>
      validateBenchmarkPrompts([
        { id: "p1", text: "Explain event loops" },
        { id: "p1", text: "Find latest inflation" }
      ])
    ).toThrow(/duplicate prompt id/);
  });

  it("rejects empty or malformed prompt data", () => {
    expect(() => validateBenchmarkPrompts([])).toThrow();
    expect(() => validateBenchmarkPrompts([{ id: "", text: "ok" }])).toThrow();
    expect(() => validateBenchmarkPrompts([{ id: "p3", text: "" }])).toThrow();
  });

  it("runs benchmark CLI only when module is the entrypoint", () => {
    const moduleUrl = "file:///repo/src/bench/runBenchmark.ts";
    expect(shouldRunBenchmarkCli(undefined, moduleUrl)).toBe(false);
    expect(shouldRunBenchmarkCli("C:/repo/src/bench/other.ts", moduleUrl)).toBe(false);
    expect(shouldRunBenchmarkCli("C:/repo/src/bench/runBenchmark.ts", pathToFileURL("C:/repo/src/bench/runBenchmark.ts").href)).toBe(
      true
    );
  });
});
