import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureRecorderOverhead } from "../../src/eval/recording/overhead";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const code = { revision: "a".repeat(40), sourceDigest: "b".repeat(64), dirty: false };
async function options() {
  const root = await mkdtemp(join(tmpdir(), "chatagent-overhead-test-"));
  roots.push(root);
  return { root, pairs: 2, warmupPairs: 1, turns: 2, capture: "metadata" as const };
}
it.each(["metadata", "answers"] as const)(
  "measures matched %s capture with real writes and equal timeline output",
  async (capture) => {
    const config = { ...(await options()), capture };
    const report = await measureRecorderOverhead(config, code);
    expect(report).toMatchObject({
      mode: "synthetic",
      liveOverheadMs: null,
      costUsd: null,
      warmupPairs: 1
    });
    expect(report.pairs.map((p) => p.order)).toEqual(["off-on", "on-off"]);
    for (const pair of report.pairs) {
      expect(pair.on.outputDigest).toBe(pair.off.outputDigest);
      expect(pair.off.writes).toBe(0);
      expect(pair.on.writes).toBeGreaterThan(1);
      expect(pair.on.artifactBytes).toBeGreaterThan(0);
      expect(pair.deltaMs.total).toBe(pair.on.totalMs - pair.off.totalMs);
      expect(pair.on.totalMs).toBeGreaterThanOrEqual(pair.on.feedMs + pair.on.flushMs);
    }
    expect(await readdir(config.root)).toEqual([]);
  }
);
it("fails on recording storage failure and cleans up owned temporary artifacts", async () => {
  const config = await options();
  await expect(
    measureRecorderOverhead(config, code, async () => {
      throw new Error("disk full");
    })
  ).rejects.toThrow("EVAL_WRITE_FAILED");
  expect(await readdir(config.root)).toEqual([]);
});
it("requires bounded repetitions and source identity", async () => {
  const config = await options();
  await expect(measureRecorderOverhead({ ...config, pairs: 0 }, code)).rejects.toThrow(
    "INVALID_OPTIONS"
  );
  await expect(measureRecorderOverhead(config, { ...code, sourceDigest: null })).rejects.toThrow(
    "MISSING_IDENTITY"
  );
});
it.each(["metadata", "answers"] as const)(
  "measures matched HTTP %s capture through automatic retries and shutdown",
  async (capture) => {
    const config = { ...(await options()), capture, execution: "http" as const };
    const report = await measureRecorderOverhead(config, code);
    expect(report.configuration.method).toBe("mock-http-runtime-v1");
    for (const pair of report.pairs) {
      expect(pair.on.outputDigest).toBe(pair.off.outputDigest);
      expect(pair.on.eventCount).toBe(pair.off.eventCount);
      expect(pair.on.observations).toHaveLength(2);
      expect(pair.on.observations!.every((o) => o.finalObservedMs !== null)).toBe(true);
      expect(pair.on.writes).toBeGreaterThan(1);
    }
    expect(await readdir(config.root)).toEqual([]);
  }
);
it("closes the HTTP runtime and removes temporary artifacts when persistence fails after startup", async () => {
  const config = { ...(await options()), execution: "http" as const };
  const { writeArtifact } = await import("../../src/eval/recording/recorder");
  let writes = 0;
  await expect(
    measureRecorderOverhead(config, code, async (path, data) => {
      if (++writes > 1) throw new Error("disk full after startup");
      await writeArtifact(path, data);
    })
  ).rejects.toThrow();
  expect(writes).toBeGreaterThan(1);
  expect(await readdir(config.root)).toEqual([]);
});
