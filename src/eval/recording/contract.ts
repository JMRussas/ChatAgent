import { createHash } from "node:crypto";
import { z } from "zod";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/);
export const datasetSchema = z.object({ version: id, prompts: z.array(z.object({ id, text: z.string().min(1).max(100000) }).strict()).min(1).max(10000) }).strict()
  .superRefine((data, ctx) => {
    if (new Set(data.prompts.map(p => p.id)).size !== data.prompts.length || new Set(data.prompts.map(p => p.text)).size !== data.prompts.length)
      ctx.addIssue({ code: "custom", message: "Dataset prompt IDs and texts must be unique" });
  });
export type Dataset = z.infer<typeof datasetSchema>;
export interface RecorderConfig { root: string; capture: "metadata" | "answers"; maxBytes: number; maxEvents: number; retentionMs: number; repetition: number; condition: "warm" | "cold" | "unknown" }
export function recordingConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig | undefined {
  if (env.EVAL_RECORDING === undefined || env.EVAL_RECORDING === "false") return;
  if (env.EVAL_RECORDING !== "true") throw new Error("EVAL_RECORDING must be true or false");
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const capture = env.EVAL_CAPTURE ?? "metadata", condition = env.EVAL_CONDITION ?? "unknown";
  if (capture !== "metadata" && capture !== "answers" || !["warm", "cold", "unknown"].includes(condition)) throw new Error("Invalid evaluation capture/condition");
  return { root: env.EVAL_OUTPUT_ROOT ?? "reports/evaluations", capture,
    maxBytes: integer("EVAL_MAX_BYTES", 10485760, 4096, 67108864), maxEvents: integer("EVAL_MAX_EVENTS", 10000, 1, 100000),
    retentionMs: integer("EVAL_RETENTION_MS", 604800000, 1000, 2147483647), repetition: integer("EVAL_REPETITION", 1, 1, 10000), condition: condition as RecorderConfig["condition"] };
}
export interface RecordedEvent {
  selectedContext?: { contentHash: string; artifactHash: string | null; transformed: boolean; referenceStatus: "attached" | "expired" | "not_attached"; text?: string };
  payloads?: { resultId: string; contentHash: string; artifactHash: string | null; transformed: boolean; text?: string }[];
  sequence: number; timelineSequence: number | null; elapsedMs: number; timestampIso: string;
  conversationId: string; turnId: string; taskId: string | null; callId: string | null; parentCallId: string;
  type: string; phase: "fast" | "deep" | null; activity: string | null; finishReason: string | null; retrying: boolean;
  route: string | null; promptId: string | null; textHash: string; errorCode: string | null;
  model: { provider: string; model: string; bindingId: string | null; bindingRevision: string | null; resolvedModel: null; modelRevision: null; reasoningEnabled: boolean | null } | null;
  answerKind: string | null;
  answer: { scoredHash: string; artifactHash: string | null; transformed: boolean; text?: string } | null;
  usage: null; costUsd: null;
}
export interface RunArtifact {
  schemaVersion: "chatagent-evaluation-v1";
  manifest: {
    runId: string; status: "recording" | "complete" | "incomplete" | "failed"; startedAtIso: string; expiresAtIso: string; endedAtIso: string | null;
    dataset: { version: string; digest: string }; configuration: unknown; configurationDigest: string;
    code: { revision: string | null; dirty: boolean | null; sourceDigest: string | null };
    capture: RecorderConfig["capture"]; redaction: "allowlist-and-common-secrets-v1";
    maxBytes: number; maxEvents: number; repetition: number; condition: RecorderConfig["condition"];
    supportedCalls: ["fast", "deep"]; privateReasoningCaptured: false; droppedEvents: number; failureCode: string | null;
  };
  trace: RecordedEvent[];
  summary: { mode: "live" | "synthetic" | "mixed" | "unknown"; eventCount: number; wallMs: number;
    usage: null; costUsd: null; quality: "unrated"; recorderCpuMs: number; recorderOverheadMs: null };
}
/** No prompts, deltas, raw errors, arbitrary metadata or reasoning are persisted. */
export function redact(text: string): string {
  return text.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sk-ant|ghp|github_pat)[-_][a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, "$1[REDACTED]");
}

export function redactConfiguration(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactConfiguration);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:api[_-]?key|access[_-]?token|password|secret|credentials?|authorization|cookie|headers|reasoning|thinkingText|chainOfThought)$/i.test(key))
    .map(([key, item]) => [key, redactConfiguration(item)]));
  return value;
}
