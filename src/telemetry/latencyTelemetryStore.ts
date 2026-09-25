import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
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

const BucketSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.enum(["direct", "deep", "clarify"]),
  sizeBand: z.enum(["small", "medium", "large"])
});

const LatencyPercentilesSchema = z.object({
  p50: z.number().finite(),
  p90: z.number().finite(),
  p95: z.number().finite(),
  p99: z.number().finite()
});

const LatencyEstimatorSnapshotSchema = z.object({
  priors: z.array(
    z.object({
      bucket: BucketSchema,
      prior: LatencyPercentilesSchema
    })
  ),
  samples: z.array(
    z.object({
      bucket: BucketSchema,
      values: z.array(z.number().finite().positive())
    })
  )
});

const RoutingTelemetrySnapshotSchema = z.object({
  estimator: LatencyEstimatorSnapshotSchema,
  policy: z.object({
    maxFastP95Ms: z.number().finite().positive()
  })
});

export function validateRoutingTelemetrySnapshot(input: unknown): RoutingTelemetrySnapshot {
  return RoutingTelemetrySnapshotSchema.parse(input) as RoutingTelemetrySnapshot;
}

export class FileLatencyTelemetryStore implements LatencyTelemetryStore {
  private pendingSave: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async load(): Promise<RoutingTelemetrySnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return validateRoutingTelemetrySnapshot(JSON.parse(raw));
    } catch (error) {
      const typed = error as { code?: string; name?: string; message?: string };

      if (typed.code === "ENOENT") {
        return undefined;
      }

      if (typed.name === "SyntaxError" || typed.name === "ZodError") {
        console.warn(`Ignoring invalid telemetry snapshot at ${this.filePath}: ${typed.message ?? "unknown error"}`);
        return undefined;
      }

      throw error;
    }
  }

  async save(snapshot: RoutingTelemetrySnapshot): Promise<void> {
    const serialized = JSON.stringify(validateRoutingTelemetrySnapshot(snapshot), null, 2);
    const operation = this.pendingSave.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, serialized, "utf8");
        await rename(tempPath, this.filePath);
      } finally {
        await rm(tempPath, { force: true });
      }
    });
    // A failed write must not poison subsequent saves.
    this.pendingSave = operation.catch(() => undefined);
    return operation;
  }
}
