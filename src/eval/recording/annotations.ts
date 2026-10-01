import {validateDeliveredAnswer,deliveryDigest} from "../../app/deliveredAnswer";
import { z } from "zod";
import { validateArtifact, recordingEvidenceValid } from "./storage";
import { digest, canonical, redact } from "./contract";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rating = z.enum(["pass", "fail", "unrated"]);
const common = {
  rubricVersion: z.string().min(1),
  judge: z.object({ kind: z.enum(["human", "code", "model"]), id: z.string().min(1), configurationDigest: hash }).strict()
};
const legacyRating = z.object({ promptId: z.string(), responseHash: hash, correctness: rating, relevance: rating,
  unsupportedClaims: z.enum(["yes", "no", "unrated"]), firstUsefulEventSequence: z.number().int().positive().optional() }).strict();
export const annotationsSchema = z.discriminatedUnion("version", [
  z.object({ ...common, version: z.literal(1), ratings: z.array(legacyRating) }).strict(),
  z.object({...common,version:z.literal(3),ratings:z.array(legacyRating.extend({groundedness:rating,taskCompletion:rating,referenceSupport:rating,deliveryHash:hash,rationale:z.string().max(2000).optional()}).strict())}).strict(),
  z.object({ ...common, version: z.literal(2), ratings: z.array(legacyRating.extend({
    groundedness: rating, taskCompletion: rating, rationale: z.string().max(2000).optional()
  }).strict()) }).strict()
]).superRefine((value, ctx) => {
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
    // Existing annotation versions grade text only. Never label a user payload as
    // graded until a payload-bound rubric is supported.
    const payloadGrading = events.some(e => e.payloads?.length) ? "unrated" : "not_applicable";
    let referenceGrading="not_applicable",referenceIntegrity="not_applicable",deliveryHash:string|null=null;
    if(answer?.answerReferences || answer?.groundedAnswer){
      referenceGrading="unrated";referenceIntegrity="unavailable";
      try{
        const refs=answer.answerReferences,grounded=answer.groundedAnswer;
        if(!refs?.text || refs.transformed || !grounded?.text || grounded.transformed || !reviewable)throw Error("UNAVAILABLE_DELIVERY");
        referenceIntegrity="invalid";
        const delivery=validateDeliveredAnswer({version:"delivered-answer-v1",text:answer.answer!.text,references:JSON.parse(refs.text)},JSON.parse(grounded.text));
        referenceIntegrity="valid";
        deliveryHash=deliveryDigest(delivery);
        if(!delivery.references.citations.length)referenceGrading="not_applicable";
        else if(annotation && "deliveryHash" in annotation && "referenceSupport" in annotation && annotation.deliveryHash===deliveryHash)referenceGrading=String(annotation.referenceSupport);
      }catch{referenceGrading="unrated";}
    }
    const finalReviewable = reviewable && terminal?.finishReason === "stop" && payloadGrading === "not_applicable";
    const referencesRated=["pass","fail","not_applicable"].includes(referenceGrading);
    const dimension = (value: unknown) =>
      finalReviewable && (value === "pass" || value === "fail") ? value : "unavailable";
    const groundedness = dimension(annotation && "groundedness" in annotation ? annotation.groundedness : undefined);
    const taskCompletion = dimension(annotation && "taskCompletion" in annotation ? annotation.taskCompletion : undefined);
    const requiredPhases = turn.route === "deep" ? ["fast", "deep"] : ["fast"];
    const terminals = requiredPhases.map(phase => [...events].reverse().find(e => e.phase === phase && e.type === "terminal" && !e.retrying));
    const runtimeOutcome = terminals.some(t => !t) ? "unavailable" : terminals.some(t => t!.finishReason === "error") ? "error"
      : terminals.some(t => t!.finishReason === "cancelled") ? "cancelled" : terminals.some(t => t!.finishReason === "length") ? "length"
      : terminals.every(t => t!.finishReason === "stop") ? "stop" : "unavailable";
    const rated = finalReviewable && referencesRated && groundedness !== "unavailable" && taskCompletion !== "unavailable" && annotation && usefulValid && annotation.correctness !== "unrated" && annotation.relevance !== "unrated" && annotation.unsupportedClaims !== "unrated";
    const knownFailure = finalReviewable && annotation && (referenceGrading==="fail" || annotation.correctness === "fail" || annotation.relevance === "fail" ||
      annotation.unsupportedClaims === "yes" || groundedness === "fail" || taskCompletion === "fail");
    return { runtimeOutcome, groundedness, taskCompletion, payloadGrading, referenceGrading, referenceIntegrity, deliveryHash, gradingComplete: Boolean(rated),
      correctness: dimension(annotation?.correctness), relevance: dimension(annotation?.relevance),
      turnId: turn.turnId, promptId: turn.promptId, responseHash: answer?.answer?.scoredHash ?? null,
      outcome: runtimeOutcome !== "stop" ? "unavailable" : knownFailure ? "fail" : rated ? "pass" : "unavailable",
      firstUsefulMs: rated && useful ? useful.elapsedMs - turn.elapsedMs : null };
  });
  const recordingValid = recordingEvidenceValid(run);
  return { schemaVersion: "chatagent-grading-v2", annotationVersion: grading.version, runId: run.manifest.runId, recordingValid,
    annotationDigest: digest(canonical(grading)), rubricVersion: redact(grading.rubricVersion), judge: { ...grading.judge, id: redact(grading.judge.id) }, results,
    runtimePassed: recordingValid && results.length > 0 && results.every(r => r.runtimeOutcome === "stop"),
    passed: recordingValid && results.length > 0 && results.every(r => r.outcome === "pass") };
}
