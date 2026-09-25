import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LatencyEstimatorSnapshot } from "./latencyEstimator";

export interface RoutingTelemetrySnapshot {
  estimator: LatencyEstimatorSnapshot;
  policy: {
    maxFastP95Ms: number;
  };
}

export interface LatencyTelemetryStore {
  load(): Promise<RoutingTelemetrySnapshot | undefined>;
  save(snapshot: RoutingTelemetrySnapshot): Promise<void>;
}

export class FileLatencyTelemetryStore implements LatencyTelemetryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RoutingTelemetrySnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as RoutingTelemetrySnapshot;
    } catch (error) {
      const message = (error as { code?: string }).code;
      if (message === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async save(snapshot: RoutingTelemetrySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
