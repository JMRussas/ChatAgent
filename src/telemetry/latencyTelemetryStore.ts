import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LatencyEstimatorSnapshot } from "./latencyEstimator";

export interface LatencyTelemetryStore {
  load(): Promise<LatencyEstimatorSnapshot | undefined>;
  save(snapshot: LatencyEstimatorSnapshot): Promise<void>;
}

export class FileLatencyTelemetryStore implements LatencyTelemetryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<LatencyEstimatorSnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as LatencyEstimatorSnapshot;
    } catch (error) {
      const message = (error as { code?: string }).code;
      if (message === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async save(snapshot: LatencyEstimatorSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
