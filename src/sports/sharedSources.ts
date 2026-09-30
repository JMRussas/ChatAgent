import { z } from "zod";
import { sourceQuerySchema, type SourceQuery, type SourceResult, type SportsSource } from "./sources";
import { BalldontlieGamesSource } from "./balldontlie";
export const sportsSourceOptionsSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(5).default(5),
  minIntervalMs: z.number().int().min(0).max(60000).default(0),
  cacheTtlMs: z.number().int().min(0).max(60000).default(15000),
  maxPendingReads: z.number().int().min(1).max(20).default(4),
  maxCacheEntries: z.number().int().min(1).max(100).default(20)
}).strict();

/** One account in one process. Fail-fast admission; no hidden retries or queues. */
export class SportsRequestBudget {
  private starts: number[] = [];
  private blockedUntil = 0;
  constructor(private limit = 5, private intervalMs = 0, private readonly clock: () => number = Date.now) {
    sportsSourceOptionsSchema.parse({ requestsPerMinute: limit, minIntervalMs: intervalMs });
  }
  configure(limit: number, intervalMs: number) {
    sportsSourceOptionsSchema.parse({ requestsPerMinute: limit, minIntervalMs: intervalMs });
    this.limit = limit; this.intervalMs = intervalMs;
  }
  reserve(): boolean {
    const now = this.clock();
    this.starts = this.starts.filter(time => now - time < 60000);
    if (now < this.blockedUntil || this.starts.length >= this.limit || this.starts.length && now - this.starts.at(-1)! < this.intervalMs) return false;
    this.starts.push(now); return true;
  }
  cooldown() { this.blockedUntil = Math.max(this.blockedUntil, this.clock() + 60000); }
}
interface Pending { controller: AbortController; waiters: number; promise: Promise<SourceResult> }

/** Cache only exact evidence scopes. Team subsets are not inferred from incomplete league pages. */
export class SharedSportsSource implements SportsSource {
  private readonly config: z.infer<typeof sportsSourceOptionsSchema>;
  private readonly cache = new Map<string, { result: SourceResult; expires: number }>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly source: SportsSource, private readonly budget: SportsRequestBudget,
    options: z.input<typeof sportsSourceOptionsSchema> = {}, private readonly clock: () => number = Date.now) {
    this.config = sportsSourceOptionsSchema.parse(options);
  }
  async read(input: SourceQuery, signal?: AbortSignal): Promise<SourceResult> {
    signal?.throwIfAborted();
    const query = sourceQuerySchema.parse(input);
    // now/age budget affect presentation, not the identity of the requested evidence.
    const key = JSON.stringify({ league: query.league ?? "NBA", kind: query.kind,
      team: query.team, window: query.window, limit: query.limit });
    const present = (value: SourceResult): SourceResult => {
      const result = structuredClone(value); result.query = query;
      const time = result.source.dataAsOf === null ? NaN : Date.parse(result.source.dataAsOf);
      const age = Math.max(this.clock(), Date.parse(query.now)) - time;
      result.freshness = !Number.isFinite(age) || age < 0 ? "unknown" : age > query.maxAgeMs ? "stale" : "fresh";
      result.limitations = result.limitations.filter(item => !["UNKNOWN_FRESHNESS", "STALE_EVIDENCE"].includes(item));
      if (result.freshness !== "fresh") result.limitations.push(result.freshness === "stale" ? "STALE_EVIDENCE" : "UNKNOWN_FRESHNESS");
      result.canAdvanceCheckpoint = value.canAdvanceCheckpoint && result.freshness === "fresh";
      return result;
    };
    for (const [id, entry] of this.cache) if (entry.expires <= this.clock()) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached) return present(cached.result);
    let pending = this.pending.get(key);
    if (pending?.controller.signal.aborted) throw new Error("SPORTS_SOURCE_CANCELLING");
    if (!pending) {
      if (this.pending.size >= this.config.maxPendingReads) throw new Error("SPORTS_PENDING_CAPACITY");
      if (!this.budget.reserve()) throw new Error("SPORTS_SHARED_RATE_LIMIT");
      const controller = new AbortController();
      pending = { controller, waiters: 0, promise: Promise.resolve(null as unknown as SourceResult) };
      const owned = pending;
      pending.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return this.source.read(structuredClone(query), controller.signal);
      }).then(result => {
        if (result.errorCode === "RATE_LIMITED") this.budget.cooldown();
        if (!controller.signal.aborted && result.errorCode === null && result.coverage !== "unavailable") {
          if (this.cache.size >= this.config.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { result: structuredClone(result), expires: this.clock() + this.config.cacheTtlMs });
        }
        return result;
      }).finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    const shared = pending; shared.waiters++;
    return new Promise<SourceResult>((resolve, reject) => {
      let finished = false;
      const finish = (value?: SourceResult, error?: unknown) => {
        if (finished) return; finished = true;
        signal?.removeEventListener("abort", abort);
        if (--shared.waiters === 0) shared.controller.abort();
        if (error !== undefined) reject(error);
        else { try { resolve(present(value!)); } catch (failure) { reject(failure); } }
      };
      const abort = () => finish(undefined, signal?.reason ?? new Error("SPORTS_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
      shared.promise.then(value => finish(value), error => finish(undefined, error));
      if (signal?.aborted) abort();
    });
  }
}

/** Reuse this registry for all league/team tasks with the same account. */
export function createBalldontlieSources(apiKey: string | undefined, options: z.input<typeof sportsSourceOptionsSchema> = {},
  transport: typeof fetch = fetch, clock: () => number = Date.now, sharedBudget?: SportsRequestBudget): ReadonlyMap<string, SportsSource> {
  const config = sportsSourceOptionsSchema.parse(options);
  const budget = sharedBudget ?? new SportsRequestBudget(config.requestsPerMinute, config.minIntervalMs, clock);
  return new Map(["NBA", "NFL"].map(league => {
    const source = new BalldontlieGamesSource(apiKey, { league: league as "NBA" | "NFL", minRequestIntervalMs: 0 }, transport, clock);
    return [league.toLowerCase() + "-games", apiKey?.trim() ? new SharedSportsSource(source, budget, config, clock) : source];
  }));
}
