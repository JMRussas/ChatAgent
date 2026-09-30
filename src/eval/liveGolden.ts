import type { GoldenCase } from "./golden";
import type { LiveBenchmarkRecord } from "../bench/liveBenchmark";
import type { RunArtifact } from "./recording/contract";
/** Existing golden assertions, evaluated against correlated completed recording evidence. */
export function evaluateLiveGoldens(suite: GoldenCase[], records: LiveBenchmarkRecord[], run: RunArtifact) {
  return suite.map((test, i) => {
    const record = records[i], turn = run.trace.filter(e => e.type === "user")[i];
    const events = turn ? run.trace.filter(e => e.turnId === turn.turnId) : [];
    const answer = (phase: string) => [...events].reverse().find(e => e.phase === phase && e.answer)?.answer?.text ?? "";
    const fast = answer("fast"), deep = answer("deep"), failures: string[] = [];
    if (!record || record.promptId !== test.id || turn?.promptId !== test.id) failures.push("Missing or mismatched turn evidence");
    if (record?.routeDecision !== test.expectedRoute) failures.push("Route mismatch");
    if (record?.outcome !== "stop") failures.push("Generation did not stop normally");
    if (!fast.trim()) failures.push("Empty fast answer");
    if (test.expectedFastMustInclude?.some(token => !fast.toLowerCase().includes(token.toLowerCase()))) failures.push("Fast answer missing required token");
    if (test.expectedFastMustNotInclude?.some(token => fast.toLowerCase().includes(token.toLowerCase()))) failures.push("Fast answer contains denied token");
    if (test.expectedRoute === "clarify" && !fast.includes("?")) failures.push("Clarification does not ask a question");
    if (fast.replace(/\s+/g, " ").trim().toLowerCase() === test.prompt.replace(/\s+/g, " ").trim().toLowerCase()) failures.push("Answer echoes prompt");
    if (test.maxFastLatencyMs !== undefined && (record?.responseReceivedMs == null || record.responseReceivedMs > test.maxFastLatencyMs)) failures.push("Fast latency exceeds original limit or is unavailable");
    if (test.expectedPhase === "deep-required" && !deep.trim()) failures.push("Missing deep answer");
    if (test.expectedRefinedMustInclude?.some(token => !deep.toLowerCase().includes(token.toLowerCase()))) failures.push("Deep answer missing required token");
    if (test.maxEndToEndLatencyMs !== undefined && (record?.finalObservedMs == null || record.finalObservedMs > test.maxEndToEndLatencyMs)) failures.push("Final latency exceeds original limit or is unavailable");
    return { promptId: test.id, passed: failures.length === 0, failures, route: record?.routeDecision ?? null,
      outcome: record?.outcome ?? "unrun", fastMs: record?.responseReceivedMs ?? null, finalMs: record?.finalObservedMs ?? null,
      responseHash: record?.responseHash ?? null };
  });
}
