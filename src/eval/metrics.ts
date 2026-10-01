export interface EvalRecord {
  promptId: string;
  routeDecision: "direct" | "deep" | "clarify";
  responseLatencyMs: number;
  usedCitation: boolean;
  evaluatorScore: number;
  retryCount?: number;
  deadLettered?: boolean;
}

export interface EvalSummary {
  avgLatency: number;
  avgScore: number;
  citationRateAll: number;
  deepCitationRate: number;
  deepRouteRate: number;
  avgRetriesDeep: number;
  deadLetterRateDeep: number;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarizeRecords(records: EvalRecord[]): EvalSummary {
  const deepRecords = records.filter((r) => r.routeDecision === "deep");
  const deepRetries = deepRecords.map((r) => r.retryCount ?? 0);
  const deepDeadLetters = deepRecords.filter((r) => r.deadLettered === true).length;

  return {
    avgLatency: avg(records.map((r) => r.responseLatencyMs)),
    avgScore: avg(records.map((r) => r.evaluatorScore)),
    citationRateAll:
      records.length === 0 ? 0 : records.filter((r) => r.usedCitation).length / records.length,
    deepCitationRate:
      deepRecords.length === 0
        ? 1
        : deepRecords.filter((r) => r.usedCitation).length / deepRecords.length,
    deepRouteRate:
      records.length === 0
        ? 0
        : records.filter((r) => r.routeDecision === "deep").length / records.length,
    avgRetriesDeep: deepRecords.length === 0 ? 0 : avg(deepRetries),
    deadLetterRateDeep: deepRecords.length === 0 ? 0 : deepDeadLetters / deepRecords.length
  };
}
