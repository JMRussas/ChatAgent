import { z } from "zod";
import { validateArtifact, recordingEvidenceValid } from "./storage";
import { digest, canonical, redact } from "./contract";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rating = z.enum(["pass", "fail", "unrated"]);
export const annotationsSchema = z.object({ version: z.literal(1), rubricVersion: z.string().min(1),
  judge: z.object({ kind: z.enum(["human", "code", "model"]), id: z.string().min(1), configurationDigest: hash }).strict(),
  ratings: z.array(z.object({ promptId: z.string(), responseHash: hash, correctness: rating, relevance: rating,
    unsupportedClaims: z.enum(["yes", "no", "unrated"]), firstUsefulEventSequence: z.number().int().positive().optional() }).strict())
}).strict().superRefine((value, ctx) => {
  const keys = value.ratings.map(r => JSON.stringify([r.promptId, r.responseHash]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate annotation key" });
});
export function scoreRecording(value: unknown, annotations: unknown, now = Date.now()) {
  const run = validateArtifact(value, now), grading = annotationsSchema.parse(annotations);
  const results = run.trace.filter(e => e.type === "user").map(turn => {
    const events = run.trace.filter(e => e.turnId === turn.turnId);
    const answer = [...events].reverse().find(e => e.answer && e.phase === (turn.route === "deep" ? "deep" : "fast"));
    const terminal = answer && events.find(e => e.type === "terminal" && e.callId === answer.callId && !e.retrying);
    const reviewable = answer?.answerKind === "substantive" && answer?.answer?.text !== undefined && !answer.answer.transformed && answer.answer.artifactHash === answer.answer.scoredHash;
    const annotation = answer && grading.ratings.find(r => r.promptId === turn.promptId && r.responseHash === answer.answer!.scoredHash);
    const useful = annotation?.firstUsefulEventSequence === undefined ? null : events.find(e => e.sequence === annotation.firstUsefulEventSequence);
    const usefulValid = annotation?.firstUsefulEventSequence === undefined || useful && useful.callId === answer?.callId && useful.elapsedMs >= turn.elapsedMs && useful.elapsedMs <= (terminal?.elapsedMs ?? -1) && ["delta", "provisional", "refined"].includes(useful.type);
    const rated = reviewable && annotation && usefulValid && annotation.correctness !== "unrated" && annotation.relevance !== "unrated" && annotation.unsupportedClaims !== "unrated";
    return { turnId: turn.turnId, promptId: turn.promptId, responseHash: answer?.answer?.scoredHash ?? null,
      outcome: !rated || terminal?.finishReason !== "stop" ? "unavailable" : annotation.correctness === "pass" && annotation.relevance === "pass" && annotation.unsupportedClaims === "no" ? "pass" : "fail",
      firstUsefulMs: rated && useful ? useful.elapsedMs - turn.elapsedMs : null };
  });
  const recordingValid = recordingEvidenceValid(run);
  return { schemaVersion: "chatagent-grading-v1", runId: run.manifest.runId, recordingValid,
    annotationDigest: digest(canonical(grading)), rubricVersion: redact(grading.rubricVersion), judge: { ...grading.judge, id: redact(grading.judge.id) }, results,
    passed: recordingValid && results.length > 0 && results.every(r => r.outcome === "pass") };
}
