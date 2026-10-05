import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { LatencyEstimatorSnapshot } from "./latencyEstimator";

export interface RoutingTelemetrySnapshot {
  dispatch?: ReturnType<import("../routing/catalogDispatch").CatalogDispatch["telemetry"]>;
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

// Null denotes overflow only when accompanied by its flag and exact decimal value.
const overflowDecimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/)
  .refine((value) => Number(value) === Infinity, "Expected an overflowing nonnegative decimal");
const spendProjection = z.union([
  z.object({
    completedUsd: z.number().finite().nonnegative(),
    completedUsdOverflow: z.never().optional(),
    completedUsdExact: z.never().optional()
  }),
  z.object({
    completedUsd: z.null(),
    completedUsdOverflow: z.literal(true),
    completedUsdExact: overflowDecimal
  })
]);
const quotaProjection = z.union([
  z.object({
    poolId: z.string(),
    units: z.number().finite().nonnegative(),
    unitsOverflow: z.never().optional(),
    unitsExact: z.never().optional()
  }),
  z.object({
    poolId: z.string(),
    units: z.null(),
    unitsOverflow: z.literal(true),
    unitsExact: overflowDecimal
  })
]);

const RoutingTelemetrySnapshotSchema = z.object({
  dispatch: z
    .object({
      attempts: z.array(
        z.object({
          bindingId: z.string(),
          phase: z.enum(["fast", "deep"]),
          task: z.enum(["conversation", "coding", "summarization", "extraction", "reasoning"]),
          size: z.string(),
          attemptId: z.string(),
          result: z.string(),
          elapsedMs: z.number().finite().nonnegative()
        })
      ),
      accounting: z
        .intersection(
          spendProjection,
          z.object({
            unsettledCount: z.number().int().nonnegative(),
            reportedCount: z.number().int().nonnegative(),
            unpricedCount: z.number().int().nonnegative(),
            quotaPools: z.array(quotaProjection)
          })
        )
        .optional(),
      reservations: z.array(
        z.object({
          id: z.string(),
          status: z.enum(["reserved", "unsettled", "released", "reported"]),
          reservedUsd: z.number().finite().nonnegative().nullable(),
          reportedUsd: z.number().finite().nonnegative().nullable(),
          quotaUnits: z.number().finite().nonnegative().nullable(),
          started: z.boolean()
        })
      )
    })
    .optional(),
  estimator: LatencyEstimatorSnapshotSchema,
  policy: z.object({
    maxFastP95Ms: z.number().finite().positive()
  })
});

export function validateRoutingTelemetrySnapshot(input: unknown): RoutingTelemetrySnapshot {
  return RoutingTelemetrySnapshotSchema.parse(input) as RoutingTelemetrySnapshot;
}

export class FileLatencyTelemetryStore implements LatencyTelemetryStore {
  private writing = false;
  private pending?: {
    serialized: string;
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  };
  private activeBytes = 0;
  retentionStats() {
    return {
      writing: this.writing ? 1 : 0,
      queued: this.pending ? 1 : 0,
      bytes: this.activeBytes + Buffer.byteLength(this.pending?.serialized ?? "")
    };
  }
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
        console.warn(
          `Ignoring invalid telemetry snapshot at ${this.filePath}: ${typed.message ?? "unknown error"}`
        );
        return undefined;
      }

      throw error;
    }
  }

  /** A superseded pending save resolves when its replacement is persisted.
   * At most one physical write and one latest replacement snapshot are retained.
   * A failure rejects that batch's callers, without poisoning the next batch. */
  save(snapshot: RoutingTelemetrySnapshot): Promise<void> {
    const serialized = JSON.stringify(validateRoutingTelemetrySnapshot(snapshot), null, 2);
    if (this.pending) {
      this.pending.serialized = serialized;
      return this.pending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending = { serialized, promise, resolve, reject };
    if (!this.writing) void this.drain();
    return promise;
  }
  private async drain() {
    this.writing = true;
    try {
      while (this.pending) {
        const batch = this.pending;
        this.pending = undefined;
        this.activeBytes = Buffer.byteLength(batch.serialized);
        try {
          await this.writeSnapshot(batch.serialized);
          batch.resolve();
        } catch (error) {
          batch.reject(error);
        }
        this.activeBytes = 0;
      }
    } finally {
      this.writing = false;
    }
  }
  protected async writeSnapshot(serialized: string) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, serialized, "utf8");
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }
}
