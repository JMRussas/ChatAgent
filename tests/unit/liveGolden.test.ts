import { expect, it } from "vitest";
import { evaluateLiveGoldens } from "../../src/eval/liveGolden";
import type { RunArtifact } from "../../src/eval/recording/contract";
import type { LiveBenchmarkRecord } from "../../src/bench/liveBenchmark";
const suite = [
  {
    id: "math",
    prompt: "What is 2+2?",
    expectedRoute: "direct" as const,
    expectedPhase: "fast-only" as const,
    expectedFastMustInclude: ["4"],
    maxFastLatencyMs: 25000
  }
];
const record = {
  promptId: "math",
  routeDecision: "direct",
  outcome: "stop",
  responseReceivedMs: 100,
  finalObservedMs: 110,
  responseHash: null
} as LiveBenchmarkRecord;
const artifact = (text: string) =>
  ({
    trace: [
      { type: "user", turnId: "turn", promptId: "math" },
      { type: "provisional", turnId: "turn", phase: "fast", answer: { text } }
    ]
  }) as unknown as RunArtifact;
it("retains original content and latency failures rather than changing the golden limits", () => {
  expect(evaluateLiveGoldens(suite, [record], artifact("4"))[0].passed).toBe(true);
  expect(
    evaluateLiveGoldens(suite, [{ ...record, responseReceivedMs: 30000 }], artifact("5"))[0]
      .failures
  ).toEqual([
    "Fast answer missing required token",
    "Fast latency exceeds original limit or is unavailable"
  ]);
});
it("reports absent execution as unrun with unknown route and latency", () => {
  expect(evaluateLiveGoldens(suite, [], { trace: [] } as unknown as RunArtifact)[0]).toMatchObject({
    passed: false,
    route: null,
    outcome: "unrun",
    fastMs: null
  });
});
it("does not treat a provisional answer as deep completion", () => {
  const cases = [
    {
      ...suite[0],
      expectedRoute: "deep" as const,
      expectedPhase: "deep-required" as const,
      maxEndToEndLatencyMs: 120000
    }
  ];
  const result = evaluateLiveGoldens(
    cases,
    [{ ...record, routeDecision: "deep", outcome: "deadline", finalObservedMs: null }],
    artifact("4")
  )[0];
  expect(result.passed).toBe(false);
  expect(result.failures).toContain("Missing deep answer");
  expect(result.failures).toContain("Generation did not stop normally");
});
