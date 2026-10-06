import { z } from "zod";
import { digest } from "../eval/recording/contract";
import { runLiveBenchmark, type LiveBenchmarkOptions } from "./liveBenchmark";
import type { BenchmarkPrompt } from "./benchmarkCore";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ms = z.number().finite().nonnegative();
export const liveReportSchema = z
  .object({
    schemaVersion: z.literal("chatagent-live-benchmark-v2"),
    mode: z.literal("live"),
    generatedAtIso: z.string().datetime(),
    recorderRunId: z.string().uuid().nullable(),
    promptsDigestSha256: hash,
    requestedPromptCount: z.number().int().positive(),
    executedPromptCount: z.number().int().nonnegative(),
    configurationDigest: z.null(),
    qualityMethod: z.literal("unrated"),
    comparisonEligible: z.literal(false),
    records: z.array(
      z
        .object({
          evidenceMode: z.enum(["live", "synthetic", "mixed", "unknown"]),
          promptId: z.string(),
          messageId: z.string().uuid(),
          conversationId: z.string(),
          routeDecision: z.enum(["direct", "deep", "clarify"]).nullable(),
          requestStartedAtIso: z.string().datetime(),
          responseReceivedMs: ms.nullable(),
          firstAnswerObservedMs: ms.nullable(),
          finalObservedMs: ms.nullable(),
          elapsedMs: ms,
          firstUsefulAnswerMs: z.null(),
          outcome: z.enum(["stop", "length", "cancelled", "error", "deadline", "transport-error"]),
          retryCount: z.number().int().nonnegative(),
          httpStatus: z.number().int().min(100).max(599).nullable(),
          errorCode: z.string().nullable(),
          selectionExclusions: z
            .array(
              z
                .object({
                  bindingId: z.string().max(512),
                  reasons: z.array(z.string().max(80)).max(30)
                })
                .strict()
            )
            .max(100)
            .optional(),
          attempts: z.array(
            z
              .object({
                attemptId: z.string().uuid(),
                phase: z.enum(["fast", "deep"]).nullable(),
                provider: z.string().nullable(),
                model: z.string().nullable(),
                bindingId: z.string().nullable(),
                bindingRevision: z.string().nullable(),
                finishReason: z.enum(["stop", "length", "cancelled", "error"]).nullable(),
                queueMs: z.null(),
                providerMs: z.null()
              })
              .strict()
          ),
          responseHash: hash.nullable(),
          quality: z.null(),
          usage: z.null(),
          costUsd: z.null(),
          cancellation: z.enum(["not-requested", "acknowledged", "unconfirmed"])
        })
        .strict()
    )
  })
  .strict();
const statusSchema = z.object({
  enabled: z.literal(true),
  runId: z.string().uuid(),
  status: z.literal("recording"),
  failureCode: z.null(),
  droppedEvents: z.literal(0)
});
async function recorderIdentity(baseUrl: string, headers?: Readonly<Record<string, string>>) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/telemetry/evaluation`, {
      headers: { ...headers },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const status = statusSchema.safeParse(await response.json());
    return status.success ? status.data.runId : null;
  } catch {
    return null;
  }
}
/** A recorder ID is trusted for linking only if the same healthy recording brackets the batch. */
export async function runLiveReport(
  prompts: BenchmarkPrompt[],
  options: LiveBenchmarkOptions & {
    /** Operator credential, used only to read the recorder status. */
    recorderHeaders?: Readonly<Record<string, string>>;
  }
) {
  const before = await recorderIdentity(options.baseUrl, options.recorderHeaders);
  const records = await runLiveBenchmark(prompts, options);
  const after = await recorderIdentity(options.baseUrl, options.recorderHeaders);
  return liveReportSchema.parse({
    schemaVersion: "chatagent-live-benchmark-v2",
    mode: "live",
    generatedAtIso: new Date().toISOString(),
    recorderRunId: before && before === after ? before : null,
    promptsDigestSha256: digest(JSON.stringify(prompts)),
    requestedPromptCount: prompts.length,
    executedPromptCount: records.length,
    configurationDigest: null,
    qualityMethod: "unrated",
    comparisonEligible: false,
    records
  });
}
