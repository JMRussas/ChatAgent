import { runControlsSchema } from "../../app/runControls";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonical, digest, type RunArtifact } from "./contract";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().max(512);
const eventSchema = z.object({
  runControls:runControlsSchema.optional(),
  sequence: z.number().int().positive(), timelineSequence: z.number().int().positive().nullable(),
  elapsedMs: z.number().finite().nonnegative(), timestampIso: z.string().datetime(),
  conversationId: hash, turnId: hash, taskId: hash.nullable(), callId: hash.nullable(), parentCallId: hash,
  type: z.enum(["user", "activity", "delta", "provisional", "refined", "terminal"]),
  phase: z.enum(["fast", "deep"]).nullable(), activity: z.enum(["queued", "thinking", "running", "generating", "retrying", "failed"]).nullable(),
  finishReason: z.enum(["stop", "length", "cancelled", "error"]).nullable(), retrying: z.boolean(),
  route: z.enum(["direct", "deep", "clarify"]).nullable(), promptId: z.string().max(120).nullable(), textHash: hash,
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),
  model: z.object({ provider: label, model: label, bindingId: label.nullable(), bindingRevision: label.nullable(),
    resolvedModel: z.null(), modelRevision: z.null(), reasoningEnabled: z.boolean().nullable() }).strict().nullable(),
  answerKind: z.enum(["acknowledgment", "substantive"]).nullable(),
  answer: z.object({ scoredHash: hash, artifactHash: hash.nullable(), transformed: z.boolean(), text: z.string().optional() }).strict().nullable(),
  selectedContext: z.object({contentHash:hash,artifactHash:hash.nullable(),transformed:z.boolean(),referenceStatus:z.enum(["attached","expired","not_attached"]),text:z.string().optional()}).strict().optional(),
  payloads: z.array(z.object({resultId:hash,contentHash:hash,artifactHash:hash.nullable(),transformed:z.boolean(),text:z.string().optional()}).strict()).max(3).optional(),
  usage: z.null(), costUsd: z.null()
}).strict();
const artifactSchema = z.object({ schemaVersion: z.literal("chatagent-evaluation-v1"), manifest: z.object({
  runId: z.string().uuid(), status: z.enum(["recording", "complete", "incomplete", "failed"]),
  startedAtIso: z.string().datetime(), expiresAtIso: z.string().datetime(), endedAtIso: z.string().datetime().nullable(),
  configuration: z.unknown(), configurationDigest: hash, droppedEvents: z.number().int().nonnegative(),
  dataset: z.object({ version: z.string(), digest: hash }).strict(),
  code: z.object({ revision: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean().nullable(), sourceDigest: hash.nullable() }).strict(),
  capture: z.enum(["metadata", "answers"]), redaction: z.literal("allowlist-and-common-secrets-v1"),
  maxBytes: z.number().int().positive(), maxEvents: z.number().int().positive(), repetition: z.number().int().positive(),
  condition: z.enum(["warm", "cold", "unknown"]), supportedCalls: z.tuple([z.literal("fast"), z.literal("deep")]),
  privateReasoningCaptured: z.literal(false), failureCode: z.string().nullable()
}).strict(), trace: z.array(eventSchema), summary: z.object({ eventCount: z.number().int().nonnegative(),
  mode: z.enum(["live", "synthetic", "mixed", "unknown"]), wallMs: z.number().finite().nonnegative(),
  usage: z.null(), costUsd: z.null(), quality: z.literal("unrated"), recorderCpuMs: z.number().finite().nonnegative(), recorderOverheadMs: z.null()
}).strict() }).strict();
export function validateArtifact(value: unknown, now = Date.now(), allowExpired = false): RunArtifact {
  const parsed = artifactSchema.parse(value);
  if (!allowExpired && Date.parse(parsed.manifest.expiresAtIso) <= now) throw new Error("EVAL_ARTIFACT_EXPIRED");
  if (digest(canonical(parsed.manifest.configuration)) !== parsed.manifest.configurationDigest || parsed.summary.eventCount !== parsed.trace.length)
    throw new Error("EVAL_ARTIFACT_INTEGRITY");
  const parents = new Map<string, string>();
  const pending = new Set<string>();
  for (const [i, event] of parsed.trace.entries()) {
    for (const payload of [...(event.payloads ?? []), ...(event.selectedContext ? [event.selectedContext] : [])]) {
      if (parsed.manifest.capture === "metadata" && payload.text !== undefined ||
        payload.text !== undefined && digest(payload.text) !== payload.artifactHash ||
        !payload.transformed && payload.artifactHash !== null && payload.contentHash !== payload.artifactHash)
        throw new Error("EVAL_ARTIFACT_INTEGRITY");
    }
    if (event.type === "user") { pending.add(`${event.turnId}:fast`); if (event.route === "deep") pending.add(`${event.turnId}:deep`); }
    if (event.type === "terminal" && !event.retrying) pending.delete(`${event.turnId}:${event.phase}`);
    if (event.callId) {
      const parent = parents.get(event.callId);
      if (parent && parent !== event.turnId) throw new Error("EVAL_TRACE_PARENT_MISMATCH");
      parents.set(event.callId, event.turnId);
    }
    if (event.sequence !== i + 1 || event.parentCallId !== event.turnId || event.answer &&
      (event.answer.scoredHash !== event.textHash || event.answer.text !== undefined && digest(event.answer.text) !== event.answer.artifactHash ||
        !event.answer.transformed && event.answer.artifactHash !== null && event.answer.scoredHash !== event.answer.artifactHash))
      throw new Error("EVAL_ARTIFACT_INTEGRITY");
  }
  if (parsed.manifest.status === "complete" && (pending.size || parsed.manifest.droppedEvents)) throw new Error("EVAL_ARTIFACT_INCOMPLETE");
  return parsed as RunArtifact;
}
export async function readArtifact(path: string, allowExpired = false) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 67108864) throw new Error("EVAL_ARTIFACT_INVALID_FILE");
  return validateArtifact(JSON.parse(await readFile(path, "utf8")), Date.now(), allowExpired);
}
/** Only our run.json artifacts are removed; unrelated files and symlinks are untouched. */
export async function pruneExpired(root: string, now = Date.now()): Promise<number> {
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/.test(directory.name)) continue;
    const path = join(root, directory.name, "run.json");
    try {
      const artifact = await readArtifact(path, true);
      if (artifact.manifest.runId === directory.name && Date.parse(artifact.manifest.expiresAtIso) <= now) { await rm(path); removed++; }
    } catch { /* Unknown or malformed files are not owned artifacts to delete. */ }
  }
  return removed;
}

export function recordingEvidenceValid(run: RunArtifact) {
  return run.manifest.status === "complete" && run.manifest.droppedEvents === 0 &&
    run.manifest.code.revision !== null && run.manifest.code.sourceDigest !== null && run.trace.some(e => e.type === "user");
}
