import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileLatencyTelemetryStore } from "../../src/telemetry/latencyTelemetryStore";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("latency telemetry store", () => {
  it("returns undefined when file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);

    const store = new FileLatencyTelemetryStore(join(dir, "snapshot.json"));
    const value = await store.load();
    expect(value).toBeUndefined();
  });

  it("persists and reloads snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);

    const path = join(dir, "snapshot.json");
    const store = new FileLatencyTelemetryStore(path);

    await store.save({
      estimator: {
        priors: [
          {
            bucket: { provider: "azure", model: "fast", route: "direct", sizeBand: "small" },
            prior: { p50: 200, p90: 400, p95: 500, p99: 800 }
          }
        ],
        samples: [
          {
            bucket: { provider: "azure", model: "fast", route: "direct", sizeBand: "small" },
            values: [350, 410]
          }
        ]
      },
      policy: {
        maxFastP95Ms: 900
      }
    });

    const loaded = await store.load();
    expect(loaded?.estimator.priors.length).toBe(1);
    expect(loaded?.estimator.samples[0].values).toEqual([350, 410]);
    expect(loaded?.policy.maxFastP95Ms).toBe(900);
  });
});
