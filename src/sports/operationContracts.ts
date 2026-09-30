import { z } from "zod";
import { teamIdentitySchema } from "./sources";

const id = z.string().trim().min(1).max(200);
const time = z.string().datetime({ offset: true });
const source = z.object({ id, url: z.string().url().refine(value => ["https:", "http:"].includes(new URL(value).protocol)),
  observedAt: time, dataAsOf: time.nullable() }).strict();

/** League identifiers come from the capability registry, not a fixed list of sports. */
export const sportScopeSchema = z.object({ sport: id, league: id }).strict();
export const teamLookupRequestSchema = z.object({ query: id, sport: id.optional(), league: id.optional() }).strict();
export const latestGameRequestSchema = z.object({ teamQuery: id, sport: id.optional(), league: id.optional(), asOf: time.optional() }).strict();
export const teamCandidateSchema = z.object({ candidateId: id, scope: sportScopeSchema, team: teamIdentitySchema,
  matchedNames: z.array(id).min(1).max(30), source }).strict();

/** Returned candidates are evidence-backed suggestions, not permission to accept a model-invented ID. */
export const resolutionSnapshotSchema = z.object({
  version: z.literal("team-resolution-v1"), snapshotId: id, userId: id, conversationId: id,
  registryRevision: id, directoryRevision: id, createdAt: time, expiresAt: time,
  request: teamLookupRequestSchema, coverage: z.enum(["complete", "partial"]),
  candidates: z.array(teamCandidateSchema).max(100), limitations: z.array(id).max(30)
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) invalid("Snapshot must have a positive lifetime");
  if (new Set(value.candidates.map(c => c.candidateId)).size !== value.candidates.length) invalid("Duplicate candidate handle");
  const identities = value.candidates.map(c => JSON.stringify([c.scope.sport, c.scope.league, c.team.provider, c.team.id]));
  if (new Set(identities).size !== identities.length) invalid("Duplicate candidate identity");
  for (const candidate of value.candidates) {
    if (value.request.league && candidate.scope.league !== value.request.league ||
      value.request.sport && candidate.scope.sport !== value.request.sport) invalid("Candidate violates explicit scope");
    if (Date.parse(candidate.source.observedAt) > Date.parse(value.createdAt) ||
      candidate.source.dataAsOf && Date.parse(candidate.source.dataAsOf) > Date.parse(candidate.source.observedAt)) invalid("Invalid evidence chronology");
  }
});

export const teamResolutionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("matched"), snapshot: resolutionSnapshotSchema, candidateId: id }).strict(),
  z.object({ status: z.literal("ambiguous"), snapshot: resolutionSnapshotSchema }).strict(),
  z.object({ status: z.literal("not_found"), snapshot: resolutionSnapshotSchema }).strict(),
  z.object({ status: z.literal("partial"), snapshot: resolutionSnapshotSchema }).strict(),
  z.object({ status: z.literal("unsupported"), requested: teamLookupRequestSchema, missingCapability: id }).strict(),
  z.object({ status: z.literal("unavailable"), requested: teamLookupRequestSchema,
    reason: z.enum(["access", "transport", "stale_directory", "admission", "deadline", "cancelled"]) }).strict()
]).superRefine((result, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (result.status === "matched" && (result.snapshot.coverage !== "complete" || result.snapshot.candidates.length !== 1 ||
    result.snapshot.candidates[0].candidateId !== result.candidateId)) invalid("Unique match requires complete lookup evidence and its candidate handle");
  if (result.status === "ambiguous" && result.snapshot.candidates.length < 2) invalid("Ambiguity requires multiple candidates");
  if (result.status === "not_found" && (result.snapshot.coverage !== "complete" || result.snapshot.candidates.length)) invalid("Absence requires complete lookup evidence");
  if (result.status === "partial" && result.snapshot.coverage !== "partial") invalid("Partial result must retain partial coverage");
});

export const candidateSelectionSchema = z.object({ snapshotId: id, candidateId: id }).strict();
const completedGame = z.object({ id, scope: sportScopeSchema, startsAt: time, completedAt: time.nullable(),
  status: z.literal("final"), home: teamIdentitySchema, away: teamIdentitySchema,
  score: z.object({ home: z.number().int().nonnegative(), away: z.number().int().nonnegative() }).strict(), source }).strict();
const searchEvidence = z.object({ from: time, asOf: time, coverage: z.enum(["complete", "partial"]),
  stopReason: z.enum(["coverage_complete", "window_limit", "page_limit", "request_limit", "deadline", "source_failure"]),
  requests: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), limitations: z.array(id).max(30)
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.from) >= Date.parse(value.asOf) || (value.coverage === "complete") !== (value.stopReason === "coverage_complete"))
    ctx.addIssue({ code: "custom", message: "Inconsistent search scope/coverage" });
});
export const latestGameResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), selection: z.enum(["latest_confirmed", "most_recent_found"]),
    team: teamCandidateSchema, game: completedGame, search: searchEvidence }).strict(),
  z.object({ status: z.literal("none_in_window"), search: searchEvidence }).strict(),
  z.object({ status: z.literal("incomplete"), search: searchEvidence }).strict(),
  z.object({ status: z.literal("needs_resolution"), resolution: teamResolutionResultSchema }).strict(),
  z.object({ status: z.literal("unsupported"), missingCapability: id }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.enum(["access", "transport", "admission", "deadline", "cancelled"]) }).strict()
]).superRefine((result, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (result.status === "none_in_window" && result.search.coverage !== "complete") invalid("Absence requires complete window coverage");
  if (result.status === "incomplete" && result.search.coverage !== "partial") invalid("Incomplete search must retain partial coverage");
  if (result.status === "needs_resolution" && !["ambiguous", "partial"].includes(result.resolution.status)) invalid("Only unresolved candidates can request selection");
  if (result.status !== "found") return;
  const { game, team, search } = result;
  if (game.scope.league !== team.scope.league || game.scope.sport !== team.scope.sport ||
    ![game.home, game.away].some(t => t.provider === team.team.provider && t.id === team.team.id)) invalid("Game does not match resolved team and scope");
  if (game.home.provider === game.away.provider && game.home.id === game.away.id) invalid("Game requires distinct opponents");
  if (Date.parse(game.startsAt) < Date.parse(search.from) || Date.parse(game.startsAt) >= Date.parse(search.asOf)) invalid("Game outside search window");
  if (game.completedAt && (Date.parse(game.completedAt) < Date.parse(game.startsAt) || Date.parse(game.completedAt) > Date.parse(search.asOf))) invalid("Game not completed within as-of scope");
  if (result.selection === "latest_confirmed" && (search.coverage !== "complete" ||
    !game.completedAt && Date.parse(game.source.observedAt) > Date.parse(search.asOf))) invalid("Latest requires complete search and evidence of completion by as-of");
});

/** The snapshot must come from the server store; never accept it from the model/client. */
export function selectTeamCandidate(storedSnapshot: unknown, selection: unknown, owner: {
  userId: string; conversationId: string; registryRevision: string; directoryRevision: string; now: string;
}) {
  const snapshot = resolutionSnapshotSchema.parse(storedSnapshot), choice = candidateSelectionSchema.parse(selection);
  const now = Date.parse(time.parse(owner.now));
  if (snapshot.userId !== owner.userId || snapshot.conversationId !== owner.conversationId || snapshot.snapshotId !== choice.snapshotId)
    throw new Error("RESOLUTION_NOT_FOUND");
  if (now < Date.parse(snapshot.createdAt) || now >= Date.parse(snapshot.expiresAt) || snapshot.registryRevision !== owner.registryRevision ||
    snapshot.directoryRevision !== owner.directoryRevision) throw new Error("RESOLUTION_STALE");
  const candidate = snapshot.candidates.find(candidate => candidate.candidateId === choice.candidateId);
  if (!candidate) throw new Error("RESOLUTION_CANDIDATE_UNKNOWN");
  return structuredClone(candidate);
}

/** Planned cross-resource status vocabulary; this does not implement admission or billing. */
export const resourceAdmissionOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted"), policyId: id, poolId: id }).strict(),
  z.object({ status: z.literal("waiting"), policyId: id, poolId: id,
    reason: z.enum(["request_window", "token_window", "compute", "subscription_window"]), retryAt: time.nullable(), deadline: time }).strict(),
  z.object({ status: z.literal("denied"), policyId: id, poolId: id,
    reason: z.enum(["spend", "quota", "unknown_usage", "access", "deadline", "cancelled", "policy"]), retryAt: time.nullable() }).strict()
]);
