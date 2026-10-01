import { z } from "zod";

export const goldenRouteSchema = z.enum(["direct", "deep", "clarify"]);
export const goldenPhaseSchema = z.enum(["fast-only", "deep-required"]);

export const goldenCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expectedRoute: goldenRouteSchema,
  expectedPhase: goldenPhaseSchema,
  expectedFastMustInclude: z.array(z.string().min(1)).optional(),
  expectedFastMustNotInclude: z.array(z.string().min(1)).optional(),
  expectedRefinedMustInclude: z.array(z.string().min(1)).optional(),
  maxFastLatencyMs: z.number().positive().optional(),
  maxEndToEndLatencyMs: z.number().positive().optional()
});

export const goldenSuiteSchema = z.array(goldenCaseSchema).min(1);

export type GoldenCase = z.infer<typeof goldenCaseSchema>;

export interface GoldenCaseResult {
  id: string;
  prompt: string;
  expectedRoute: "direct" | "deep" | "clarify";
  actualRoute: "direct" | "deep" | "clarify";
  expectedPhase: "fast-only" | "deep-required";
  fastReply: string;
  refinedReply?: string;
  fastLatencyMs: number;
  endToEndLatencyMs?: number;
  passed: boolean;
  failures: string[];
}

export interface GoldenReport {
  generatedAtIso: string;
  baseUrl: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: GoldenCaseResult[];
}

export function buildGoldenReport(baseUrl: string, results: GoldenCaseResult[]): GoldenReport {
  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  const failed = total - passed;

  return {
    generatedAtIso: new Date().toISOString(),
    baseUrl,
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : passed / total,
    results
  };
}

export function renderGoldenReportMarkdown(report: GoldenReport): string {
  const lines = [
    "# Golden Route Evaluation",
    "",
    `Generated: ${report.generatedAtIso}`,
    `Base URL: ${report.baseUrl}`,
    `Overall: ${report.failed === 0 ? "PASS" : "FAIL"}`,
    `Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passed}/${report.total})`,
    "",
    "## Case Results"
  ];

  for (const result of report.results) {
    lines.push("");
    lines.push(`### ${result.id} - ${result.passed ? "PASS" : "FAIL"}`);
    lines.push(`- prompt: ${result.prompt}`);
    lines.push(`- route: expected=${result.expectedRoute}, actual=${result.actualRoute}`);
    lines.push(`- phase: ${result.expectedPhase}`);
    lines.push(`- fastLatencyMs: ${result.fastLatencyMs.toFixed(1)}`);
    if (typeof result.endToEndLatencyMs === "number") {
      lines.push(`- endToEndLatencyMs: ${result.endToEndLatencyMs.toFixed(1)}`);
    }
    lines.push(`- fastReply: ${result.fastReply}`);
    if (result.refinedReply) {
      lines.push(`- refinedReply: ${result.refinedReply}`);
    }

    if (result.failures.length > 0) {
      lines.push("- failures:");
      for (const failure of result.failures) {
        lines.push(`  - ${failure}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
