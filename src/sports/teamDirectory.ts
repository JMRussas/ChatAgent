import { ToolResultStore } from "../app/toolResult";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityTool } from "../app/capabilityChat";
import { SportsRequestBudget } from "./sharedSources";
import { teamLookupRequestSchema, resolutionSnapshotSchema, teamResolutionResultSchema, candidateSelectionSchema, selectTeamCandidate } from "./operationContracts";

export const directoryOptionsSchema = z.object({
  leagues: z.array(z.enum(["NBA", "NFL"])).min(1).max(2).default(["NBA", "NFL"]).refine(v => new Set(v).size === v.length),
  cacheTtlMs: z.number().int().min(1000).max(86400000).default(3600000),
  selectionTtlMs: z.number().int().min(1000).max(3600000).default(600000),
  maxSnapshots: z.number().int().min(1).max(1000).default(100)
}).strict();
const definitions = {
  NBA: { sport: "basketball", league: "NBA", provider: "balldontlie", url: "https://api.balldontlie.io/v1/teams" },
  NFL: { sport: "football", league: "NFL", provider: "balldontlie-nfl", url: "https://api.balldontlie.io/nfl/v1/teams" }
};
const name = z.string().trim().min(1).max(200);
const responseSchema = z.object({ data: z.array(z.object({ id: z.number().int().positive(), full_name: name,
  name, abbreviation: name, city: z.string().optional(), location: z.string().optional() })).min(1).max(1000),
  meta: z.object({ next_cursor: z.union([z.number(), z.string()]).nullable().optional() }).optional() });
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
type Directory = { data: z.infer<typeof responseSchema>["data"]; observedAt: string; expires: number; revision: string };
type Snapshot = z.infer<typeof resolutionSnapshotSchema>;

/** Account budget is shared with game reads. Failed or partial directories never establish absence. */
export class TeamDirectory {
  readonly results: ToolResultStore;
  private cache = new Map<string, Directory>();
  private snapshots = new Map<string, Snapshot>();
  private busy = new Set<string>();
  private closed = false;
  private shutdown = new AbortController();
  private options: z.infer<typeof directoryOptionsSchema>;
  constructor(private key: string | undefined, private budget: SportsRequestBudget, options: unknown,
    private revision: string, private transport: typeof fetch = fetch, private clock = Date.now) {
    this.options = directoryOptionsSchema.parse(options);
    this.results = new ToolResultStore(clock, this.options.maxSnapshots);
  }
  close() { this.closed = true; this.shutdown.abort(); this.results.clear(); this.snapshots.clear(); this.cache.clear(); }
  private directoryRevision() {
    return createHash("sha256").update(JSON.stringify([...this.cache].map(([k,v]) => [k,v.revision]).sort())).digest("hex");
  }
  private async read(league: "NBA" | "NFL", signal: AbortSignal): Promise<Directory> {
    signal.throwIfAborted();
    const cached = this.cache.get(league);
    if (cached && cached.expires > this.clock()) return cached;
    if (!this.key?.trim()) throw new Error("access");
    if (this.busy.has(league)) throw new Error("admission");
    if (!this.budget.reserve()) throw new Error("admission");
    this.busy.add(league);
    const timeout = AbortSignal.timeout(10000), combined = AbortSignal.any([signal, timeout, this.shutdown.signal]);
    try {
      const response = await this.transport(definitions[league].url, { headers: { Authorization: this.key }, signal: combined, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) { this.budget.cooldown(); throw new Error("admission"); }
        throw new Error([401,403].includes(response.status) ? "access" : "transport");
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error("transport");
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { combined.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 1000000) throw new Error("transport"); chunks.push(part.value); }
      } finally { await reader.cancel(); reader.releaseLock(); }
      combined.throwIfAborted();
      const parsed = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (parsed.meta?.next_cursor != null || new Set(parsed.data.map(t => t.id)).size !== parsed.data.length) throw new Error("transport");
      const result = { data: parsed.data, observedAt: new Date(this.clock()).toISOString(), expires: this.clock() + this.options.cacheTtlMs,
        revision: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex") };
      if (this.closed) throw new Error("stale_directory");
      this.cache.set(league, result); return result;
    } catch (error) {
      if (this.closed) throw new Error("stale_directory");
      if (signal.aborted) throw new Error("cancelled");
      if (timeout.aborted) throw new Error("deadline");
      if (error instanceof Error && ["access","admission","transport","stale_directory"].includes(error.message)) throw error;
      throw new Error("transport");
    } finally { this.busy.delete(league); }
  }
  async lookup(input: unknown, userId: string, conversationId: string, signal: AbortSignal) {
    const requested = teamLookupRequestSchema.parse(input);
    if (this.closed) throw new Error("CAPABILITIES_CHANGED");
    const eligible = this.options.leagues.filter(l => (!requested.league || normalize(l) === normalize(requested.league)) &&
      (!requested.sport || normalize(definitions[l].sport) === normalize(requested.sport)));
    if (!eligible.length) return teamResolutionResultSchema.parse({ status: "unsupported", requested, missingCapability: "team-directory" });
    // Canonicalize explicit scope for the contract; preserve the user's query verbatim.
    if (requested.league) requested.league = eligible[0];
    if (requested.sport) requested.sport = definitions[eligible[0]].sport;
    const candidates: Snapshot["candidates"] = [], limitations: string[] = [], expirations: number[] = [];
    for (const league of eligible) {
      try {
        const directory = await this.read(league, signal), def = definitions[league];
        expirations.push(directory.expires);
        for (const team of directory.data) {
          const aliases = [...new Set([team.full_name, team.name, team.abbreviation, team.city, team.location].filter((s): s is string => !!s?.trim()))];
          if (!normalize(requested.query) || !aliases.some(a => normalize(a) === normalize(requested.query))) continue;
          candidates.push({ candidateId: randomUUID(), scope: { sport: def.sport, league }, team: { provider: def.provider, id: String(team.id), name: team.full_name },
            matchedNames: aliases, source: { id: `${def.provider}:teams`, url: def.url, observedAt: directory.observedAt, dataAsOf: null } });
        }
      } catch (error) { limitations.push(`${league}:${error instanceof Error ? error.message : "transport"}`); }
    }
    if (signal.aborted || this.closed) return teamResolutionResultSchema.parse({ status: "unavailable", requested, reason: signal.aborted ? "cancelled" : "stale_directory" });
    if (limitations.length === eligible.length) return teamResolutionResultSchema.parse({ status: "unavailable", requested, reason: limitations[0].split(":")[1] });
    if (candidates.length > 100) { candidates.length = 100; limitations.push("CANDIDATE_LIMIT"); }
    const now = this.clock();
    if (expirations.some(t => t <= now)) return teamResolutionResultSchema.parse({ status: "unavailable", requested, reason: "stale_directory" });
    for (const [id,s] of this.snapshots) if (Date.parse(s.expiresAt) <= now) this.snapshots.delete(id);
    if (this.snapshots.size >= this.options.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value!);
    const snapshot = resolutionSnapshotSchema.parse({ version: "team-resolution-v1", snapshotId: randomUUID(), userId, conversationId,
      registryRevision: this.revision, directoryRevision: this.directoryRevision(), createdAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(now + this.options.selectionTtlMs, ...expirations)).toISOString(),
      request: requested, coverage: limitations.length ? "partial" : "complete", candidates, limitations });
    this.snapshots.set(snapshot.snapshotId, structuredClone(snapshot));
    const status = limitations.length ? "partial" : candidates.length > 1 ? "ambiguous" : candidates.length ? "matched" : "not_found";
    return teamResolutionResultSchema.parse({ status, snapshot, ...(status === "matched" ? { candidateId: candidates[0].candidateId } : {}) });
  }
  select(input: unknown, userId: string, conversationId: string) {
    if (this.closed) throw new Error("CAPABILITIES_CHANGED");
    const choice = candidateSelectionSchema.parse(input), snapshot = this.snapshots.get(choice.snapshotId);
    if (!snapshot) throw new Error("RESOLUTION_NOT_FOUND");
    return selectTeamCandidate(snapshot, choice, { userId, conversationId, registryRevision: this.revision,
      directoryRevision: this.directoryRevision(), now: new Date(this.clock()).toISOString() });
  }
  topics() { return this.options.leagues.map(league => ({sport:definitions[league].sport,league})); }
  selectTopic(resultId: string, row: number, userId: string, conversationId: string, attachReference: boolean) {
    if (this.closed) throw Error("CAPABILITIES_CHANGED");
    const result = this.results.get(resultId,userId,conversationId);
    const league = this.options.leagues.find(l => definitions[l].url === result.evidence.sourceUrl);
    const directory = league && this.cache.get(league);
    if (!league || !directory || directory.revision !== result.evidence.revision || !Number.isInteger(row) || row < 0 || !directory.data[row]) throw Error("REFERENCE_STALE");
    const team = directory.data[row], def = definitions[league];
    return {path:["Sports",def.sport,league,team.full_name],entity:{provider:def.provider,id:String(team.id),name:team.full_name},
      reference:attachReference ? {resultId,sourceUrl:def.url,observedAt:result.evidence.observedAt,expiresAt:result.context.expiresAt,revision:result.evidence.revision,
        fields:{team:team.full_name,abbreviation:team.abbreviation,location:team.city ?? team.location ?? "",limitation:"Historical entries may be included; active status and freshness are not verified"}} : null};
  }
  leagues() { return [...this.options.leagues]; }
  async list(input: unknown, userId: string, conversationId: string, signal: AbortSignal) {
    const { league } = z.object({league:z.enum(["NBA","NFL"])}).strict().parse(input);
    if (this.closed) throw Error("CAPABILITIES_CHANGED");
    if (!this.options.leagues.includes(league)) throw Error("DIRECTORY_UNSUPPORTED");
    const directory = await this.read(league, signal);
    signal.throwIfAborted();
    if (this.closed) throw Error("CAPABILITIES_CHANGED");
    const def = definitions[league];
    return this.results.put(userId, conversationId, {
      version: "tool-result-v1",
      context: { status: "ready", summary: `${league} provider team directory prepared as a table (${directory.data.length} entries). Rows are not in model context.`,
        scope: `${league} provider directory; historical entries may be included`, coverage: "complete",
        limitations: ["Active-team status is not verified", "Provider data freshness is unknown"], expiresAt: new Date(directory.expires).toISOString() },
      payload: {kind:"table",title:`${league} team directory`, columns:["Team", "Abbreviation", "Location"],
        rows:directory.data.map(t => [t.full_name,t.abbreviation,t.city ?? t.location ?? ""])},
      evidence: {sourceUrl:def.url,observedAt:directory.observedAt,revision:directory.revision}
    });
  }
  tools(): CapabilityTool[] {
    return [{ id: "sports:list-teams", description: "Display a provider team directory directly to the user. May include historical teams; does not establish current active membership. Table rows are not model context.",
      inputSchema: {type:"object",additionalProperties:false,required:["league"],properties:{league:{type:"string",enum:this.leagues()}}},
      validate: v => z.object({league:z.enum(["NBA","NFL"])}).strict().parse(v),
      execute: async (v,u,_r,s,c) => { if (!c) throw Error("CONVERSATION_REQUIRED"); return this.list(v,u,c,s); } },
    { id: "sports:resolve-team", description: `Resolve team names, abbreviations or cities from provider directories: ${this.options.leagues.join(", ")}. Omit sport/league if unknown. Exact normalized provider aliases only; no typo inference. Clarify ambiguous candidates using issued handles. Directory support does not imply game/news support. Never ask users for provider IDs.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, sport: { type: "string" }, league: { type: "string" } } },
      validate: v => teamLookupRequestSchema.parse(v), execute: async (v,u,_r,s,c) => { if (!c) throw new Error("CONVERSATION_REQUIRED"); return this.lookup(v,u,c,s); } },
    { id: "sports:select-team", description: "Select a previously issued team candidate after user clarification. Use the snapshotId and candidateId from this conversation's lookup result.",
      inputSchema: { type: "object", additionalProperties: false, required: ["snapshotId","candidateId"], properties: { snapshotId: { type: "string" }, candidateId: { type: "string" } } },
      validate: v => candidateSelectionSchema.parse(v), execute: async (v,u,_r,s,c) => { s.throwIfAborted(); if (!c) throw new Error("CONVERSATION_REQUIRED"); return this.select(v,u,c); } }];
  }
}
