import { describe, expect, it } from "vitest";
import { latestGameResultSchema, resolutionSnapshotSchema, selectTeamCandidate, teamResolutionResultSchema,
  latestGameRequestSchema, resourceAdmissionOutcomeSchema } from "../../src/sports/operationContracts";
import corpus from "../../data/evals/request-to-evidence.v1.json";
const candidate = { candidateId: "opaque-choice", scope: { sport: "example-sport", league: "example-league" },
  team: { provider: "directory", id: "1", name: "Fictional team" }, matchedNames: ["Fictional team"],
  source: { id: "directory", url: "https://example.invalid/teams", observedAt: "2026-09-30T12:00:00Z", dataAsOf: null } };
const snapshot = { version: "team-resolution-v1", snapshotId: "snapshot", userId: "u", conversationId: "c", registryRevision: "r1", directoryRevision: "d1",
  createdAt: "2026-09-30T12:00:00Z", expiresAt: "2026-09-30T13:00:00Z", request: { query: "Fictional team" }, coverage: "complete", candidates: [candidate], limitations: [] };
const owner = { userId: "u", conversationId: "c", registryRevision: "r1", directoryRevision: "d1", now: "2026-09-30T12:30:00Z" };
const choice = { snapshotId: "snapshot", candidateId: "opaque-choice" };
const search = { from: "2026-09-29T00:00:00Z", asOf: "2026-09-30T12:00:00Z", coverage: "complete", stopReason: "coverage_complete", requests: 2, pages: 1, limitations: [] };
const found = { status: "found", selection: "latest_confirmed", team: candidate, search,
  game: { id: "game", scope: candidate.scope, startsAt: "2026-09-29T15:00:00Z", completedAt: "2026-09-29T18:00:00Z", status: "final", home: candidate.team,
    away: { provider: "directory", id: "2", name: "Other fictional team" }, score: { home: 3, away: 2 }, source: candidate.source } };
describe("user-level sports operation contracts", () => {
  it("accepts registry-defined leagues and name-based requests without IDs", () => {
    expect(latestGameRequestSchema.parse({ teamQuery: "Fictional team", league: "new-league" }).league).toBe("new-league");
    expect(teamResolutionResultSchema.safeParse({ status: "matched", snapshot, candidateId: candidate.candidateId }).success).toBe(true);
  });
  it("cannot certify a unique match or absence from partial directory coverage", () => {
    expect(teamResolutionResultSchema.safeParse({ status: "matched", snapshot: { ...snapshot, coverage: "partial" }, candidateId: candidate.candidateId }).success).toBe(false);
    expect(teamResolutionResultSchema.safeParse({ status: "not_found", snapshot: { ...snapshot, coverage: "partial", candidates: [] } }).success).toBe(false);
    expect(teamResolutionResultSchema.safeParse({ status: "ambiguous", snapshot }).success).toBe(false);
    expect(teamResolutionResultSchema.safeParse({ status: "partial", snapshot: { ...snapshot, coverage: "partial" } }).success).toBe(true);
  });
  it("binds selection to server-issued candidates, owner, conversation and revisions", () => {
    expect(selectTeamCandidate(snapshot, choice, owner).team.id).toBe("1");
    for (const changed of [{ userId: "other" }, { conversationId: "other" }, { registryRevision: "r2" }, { directoryRevision: "d2" }, { now: snapshot.expiresAt }])
      expect(() => selectTeamCandidate(snapshot, choice, { ...owner, ...changed })).toThrow();
    expect(() => selectTeamCandidate(snapshot, { ...choice, candidateId: "invented" }, owner)).toThrow();
    const selected = selectTeamCandidate(snapshot, choice, owner); selected.team.name = "Changed";
    expect(snapshot.candidates[0].team.name).toBe("Fictional team");
  });
  it("rejects duplicate identities, explicit scope violations and future source observations", () => {
    for (const changed of [
      { candidates: [candidate, { ...candidate, candidateId: "another" }] },
      { request: { query: "Fictional team", league: "different" } },
      { candidates: [{ ...candidate, source: { ...candidate.source, observedAt: snapshot.expiresAt } }] }
    ]) expect(resolutionSnapshotSchema.safeParse({ ...snapshot, ...changed }).success).toBe(false);
  });
  it("rejects scheduled games, wrong teams and completion after the requested as-of", () => {
    expect(latestGameResultSchema.safeParse(found).success).toBe(true);
    for (const game of [{ ...found.game, status: "scheduled" }, { ...found.game, home: { ...candidate.team, id: "9" } },
      { ...found.game, completedAt: "2026-10-01T00:00:00Z" }, { ...found.game, score: null }])
      expect(latestGameResultSchema.safeParse({ ...found, game }).success).toBe(false);
  });
  it("keeps search exhaustion separate from proven absence and latest certainty", () => {
    const partial = { ...search, coverage: "partial", stopReason: "request_limit" };
    expect(latestGameResultSchema.safeParse({ ...found, search: partial }).success).toBe(false);
    expect(latestGameResultSchema.safeParse({ ...found, selection: "most_recent_found", search: partial }).success).toBe(true);
    expect(latestGameResultSchema.safeParse({ status: "none_in_window", search: partial }).success).toBe(false);
    expect(latestGameResultSchema.safeParse({ status: "incomplete", search: partial }).success).toBe(true);
  });
  it("represents admission waiting or unknown usage without asserting an empty data result", () => {
    expect(resourceAdmissionOutcomeSchema.parse({ status: "waiting", policyId: "local-compute", poolId: "gpu", reason: "compute", retryAt: null, deadline: owner.now }).status).toBe("waiting");
    expect(resourceAdmissionOutcomeSchema.parse({ status: "denied", policyId: "cli-policy", poolId: "account-model", reason: "unknown_usage", retryAt: null }).status).toBe("denied");
  });
  it("keeps an evaluation-only partition covering unseen entities, domains and admission policies", () => {
    expect(corpus.status).toBe("specification-only");
    expect(new Set(corpus.cases.map(c => c.id)).size).toBe(corpus.cases.length);
    const evaluation = corpus.cases.filter(c => c.partition === "evaluation-only");
    expect(evaluation.length).toBeGreaterThanOrEqual(10);
    expect(new Set(corpus.cases.flatMap(c => c.criteria))).toEqual(new Set(["league_selection", "entity_resolution", "latest_completed", "grounding", "candidate_binding", "context_continuity", "capability_gap", "no_substitution", "temporal_scope", "answer_sufficiency", "resource_admission", "foreground_available", "cancellation"]));
    expect(evaluation.some(c => c.registry === "synthetic-extra-league")).toBe(true);
  });
});
