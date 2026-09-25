import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import cases from "../../data/golden-prompts.json";
import { analyzeFast } from "../../src/domain/router";
import { AdaptiveRoutingCoordinator } from "../../src/routing/adaptiveRouting";
import { InMemoryLatencyEstimator } from "../../src/telemetry/latencyEstimator";

describe("release evaluation gates", () => {
  it("returns a failing exit code when fixture evaluation fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-gate-"));
    const output = join(dir, "report.md");
    try {
      await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "src/eval/generateReport.ts"], {
        env: {
          ...process.env,
          EVAL_INPUT_PATH: resolve("data/eval-records.json"),
          EVAL_OUTPUT_PATH: output,
          EVAL_MAX_AVG_LATENCY_MS: "0"
        }
      })).rejects.toMatchObject({ code: 1 });
      expect(await readFile(output, "utf8")).toContain("Overall: FAIL");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(cases)("keeps golden route expectation aligned: $id", (goldenCase) => {
    const message = { conversationId: "c", userId: "u", text: goldenCase.prompt, timestampIso: new Date().toISOString() };
    const coordinator = new AdaptiveRoutingCoordinator(new InMemoryLatencyEstimator(),
      { provider: "mock", model: "fast" }, { provider: "mock", model: "deep" });
    expect(coordinator.decide(message, analyzeFast(message)).routeDecision).toBe(goldenCase.expectedRoute);
  });
});
