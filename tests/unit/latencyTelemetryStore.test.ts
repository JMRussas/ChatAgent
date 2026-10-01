import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileLatencyTelemetryStore, validateRoutingTelemetrySnapshot } from "../../src/telemetry/latencyTelemetryStore";

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
  it("serializes overlapping saves and persists the latest snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);
    const store = new FileLatencyTelemetryStore(join(dir, "snapshot.json"));
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({
      estimator: { priors: [], samples: [] }, policy: { maxFastP95Ms: 1000 + index }
    })));
    expect((await store.load())?.policy.maxFastP95Ms).toBe(1019);
  });

  it("recovers after a failed filesystem save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);
    const parent = join(dir, "blocked");
    await writeFile(parent, "not a directory");
    const store = new FileLatencyTelemetryStore(join(parent, "snapshot.json"));
    const snapshot = { estimator: { priors: [], samples: [] }, policy: { maxFastP95Ms: 900 } };
    await expect(store.save(snapshot)).rejects.toThrow();
    await rm(parent);
    await store.save(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });
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

  it("returns undefined when snapshot file has malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);

    const path = join(dir, "snapshot.json");
    await writeFile(path, "{not-json", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = new FileLatencyTelemetryStore(path);
    const loaded = await store.load();
    expect(loaded).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns undefined when snapshot schema is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "latency-store-"));
    dirs.push(dir);

    const path = join(dir, "snapshot.json");
    await writeFile(path, JSON.stringify({ estimator: { priors: [] }, policy: {} }), "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = new FileLatencyTelemetryStore(path);
    const loaded = await store.load();
    expect(loaded).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("throws when attempting to validate invalid snapshot object", () => {
    expect(() =>
      validateRoutingTelemetrySnapshot({
        estimator: { priors: [], samples: [] },
        policy: { maxFastP95Ms: 0 }
      })
    ).toThrow();
  });
});

it("persists separate fast/deep dispatch attempts and unknown reservation usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-telemetry-")); dirs.push(dir);
  const store = new FileLatencyTelemetryStore(join(dir, "snapshot.json"));
  const snapshot = validateRoutingTelemetrySnapshot({ estimator: { priors: [], samples: [] }, policy: { maxFastP95Ms: 1000 },
    dispatch: { attempts: ["fast", "deep"].map((phase, index) => ({ bindingId: "same-binding", phase, task: "coding", size: "small",
      attemptId: `attempt-${index}`, result: "stop", elapsedMs: 10 })),
      reservations: [{ id: "r", status: "unsettled", reservedUsd: 1, reportedUsd: null, quotaUnits: null, started: true }] } });
  await store.save(snapshot);
  expect(await store.load()).toEqual(snapshot);
});

it("preserves compact accounting separately from bounded reservation history",()=>{
 const accounting={completedUsd:12,unsettledCount:4,reportedCount:2,unpricedCount:0,quotaPools:[{poolId:"shared",units:6}]};
 const snapshot={estimator:{priors:[],samples:[]},policy:{maxFastP95Ms:1000},dispatch:{attempts:[],reservations:[],accounting}};
 expect(validateRoutingTelemetrySnapshot(snapshot).dispatch?.accounting).toEqual(accounting);
 expect(validateRoutingTelemetrySnapshot({...snapshot,dispatch:{attempts:[],reservations:[]}}).dispatch?.accounting).toBeUndefined();
});
