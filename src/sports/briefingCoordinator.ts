import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { bindBriefingSources, briefingProfileSchema } from "./briefingConfig";
import { planBriefing, type BriefingRequest } from "./briefingPlan";
import type { SourceResult, SportsSource } from "./sources";

type Plan = ReturnType<typeof planBriefing>;
type TaskStatus =
  | "queued"
  | "running"
  | "needs-input"
  | "complete"
  | "partial"
  | "failed"
  | "cancelled"
  | "deadline";
export interface BriefingTaskState {
  id: string;
  planTaskId: string;
  status: TaskStatus;
  results: { adapterId: string; evidence: SourceResult }[];
  errors: { adapterId: string | null; code: string }[];
  checkpointCandidate: string | null;
}
export interface BriefingRun {
  configVersion?: string;
  id: string;
  userId: string;
  requestId: string;
  plan: Plan;
  settled: boolean;
  tasks: BriefingTaskState[];
}
interface Job {
  run: BriefingRun;
  task: BriefingTaskState;
  index: number;
  sources: ReturnType<typeof bindBriefingSources>[number]["sources"];
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
export const briefingCoordinatorOptionsSchema = z
  .object({
    maxConcurrentTasks: z.number().int().min(1).max(10).default(2),
    taskTimeoutMs: z.number().int().min(1).max(300000).default(30000),
    maxRuns: z.number().int().min(1).max(100).default(20),
    settledRunTtlMs: z.number().int().min(1).max(86400000).default(300000)
  })
  .strict();
const keySchema = z.string().trim().min(1).max(200);
const terminal = (status: TaskStatus) => !["queued", "running"].includes(status);

/**
 * Process-local evidence collection only. Never invokes models or writes checkpoints.
 *
 * @lifetime A run is created by start() with its source bindings and per-task
 * deadlines fixed at that moment. It settles when every task is terminal, and is
 * kept for the settled-run TTL or until capacity pressure, but never while one of
 * its jobs is still draining. Its request, profile and waiter indexes go with it;
 * reads and retries do not extend its retention.
 *
 * @invariant bindings-captured-at-start — A run keeps the source bindings, profile
 * and configuration version it started with; a later reload cannot change those.
 * Shared request budgets and the coordinator's concurrency and retention policy are
 * not captured and may change.
 * @test tests/unit/liveBriefing.test.ts :: keeps an in-flight feed attached to its original configuration
 * @test tests/unit/liveBriefing.test.ts :: versions new runs, preserves old runs and retries, and rolls back invalid configuration
 *
 * @invariant retry-identity-is-bounded — Repeating a start with the same request
 * returns the same run while it is retained; that identity expires with the run and
 * is not extended by reads.
 * @test tests/unit/briefingCoordinator.test.ts :: deduplicates identical starts, rejects conflicting reuse and isolates users
 * @test tests/unit/briefingCoordinator.test.ts :: expires retry identity without extending it on reads, and cleans all indexes
 *
 * @invariant settled-runs-are-reclaimed — Settled runs and all their indexes are
 * removed under sustained use, so retained state stays within the run cap.
 * @test tests/unit/briefingCoordinator.test.ts :: reclaims settled runs and all associated indexes under sustained use
 *
 * @decision docs/18-nba-briefing-demo.md#implemented-coordinator-slice--2026-09-30
 */
export class BriefingCoordinator {
  get version() {
    return this.configVersion;
  }
  private options: z.infer<typeof briefingCoordinatorOptionsSchema>;
  private registry: ReadonlyMap<string, SportsSource>;
  private configVersion?: string;
  private readonly profiles = new Map<string, unknown>();
  private readonly runs = new Map<string, BriefingRun>();
  private readonly requests = new Map<string, string>();
  private readonly jobs = new Set<Job>();
  private readonly settledAt = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private active = 0;
  private closed = false;
  constructor(
    registry: ReadonlyMap<string, SportsSource>,
    options: z.input<typeof briefingCoordinatorOptionsSchema> = {},
    private readonly clock = Date.now
  ) {
    this.registry = new Map(registry);
    this.options = briefingCoordinatorOptionsSchema.parse(options);
  }
  start(
    userId: string,
    requestId: string,
    request: BriefingRequest,
    configuration: unknown
  ): BriefingRun {
    if (this.closed) throw new Error("BRIEFING_CLOSED");
    userId = keySchema.parse(userId);
    requestId = keySchema.parse(requestId);
    const profile = briefingProfileSchema.parse(configuration),
      plan = planBriefing(request, profile);
    this.prune();
    const key = JSON.stringify([userId, requestId]);
    const previous = this.requests.get(key);
    if (previous) {
      const run = this.runs.get(previous)!;
      const retryPlan =
        this.configVersion !== run.configVersion
          ? planBriefing(request, this.profiles.get(run.id))
          : plan;
      if (!isDeepStrictEqual(run.plan, retryPlan)) throw new Error("BRIEFING_REQUEST_CONFLICT");
      return structuredClone(run);
    }
    const bindings = bindBriefingSources(profile, this.registry);
    this.prune(this.options.maxRuns - 1);
    if (this.runs.size >= this.options.maxRuns) throw new Error("BRIEFING_CAPACITY");
    const run: BriefingRun = {
      id: randomUUID(),
      userId,
      requestId,
      plan,
      settled: false,
      tasks: [],
      configVersion: this.configVersion
    };
    this.profiles.set(run.id, profile);
    plan.tasks.forEach((task, index) => {
      const state: BriefingTaskState = {
        id: randomUUID(),
        planTaskId: task.id,
        status: task.state === "needs-input" ? "needs-input" : "queued",
        results: [],
        errors: [],
        checkpointCandidate: null
      };
      run.tasks.push(state);
      if (state.status === "needs-input") return;
      const job: Job = {
        run,
        task: state,
        index,
        sources: bindings[index].sources,
        controller: new AbortController()
      };
      // Deadline includes time spent queued, not just source execution.
      job.timer = setTimeout(() => this.stop(job, "deadline"), this.options.taskTimeoutMs);
      this.jobs.add(job);
    });
    this.runs.set(run.id, run);
    this.requests.set(key, run.id);
    this.settle(run);
    this.pump();
    return structuredClone(run);
  }
  snapshot(userId: string, runId: string): BriefingRun {
    return structuredClone(this.owned(userId, runId));
  }
  configure(
    registry: ReadonlyMap<string, SportsSource>,
    options: z.input<typeof briefingCoordinatorOptionsSchema>,
    version: string
  ) {
    if (this.closed) throw new Error("BRIEFING_CLOSED");
    const parsed = briefingCoordinatorOptionsSchema.parse(options);
    this.registry = new Map(registry);
    this.options = parsed;
    this.configVersion = version;
    this.prune();
    this.pump();
  }
  async wait(userId: string, runId: string): Promise<BriefingRun> {
    // Retain this reference: settlement can evict the registry entry before we resume.
    const run = this.owned(userId, runId);
    if (!run.settled)
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(runId) ?? [];
        list.push(resolve);
        this.waiters.set(runId, list);
      });
    return structuredClone(run);
  }
  cancel(userId: string, runId: string, taskId?: string): BriefingRun {
    const run = this.owned(userId, runId);
    if (taskId && !run.tasks.some((task) => task.id === taskId))
      throw new Error("BRIEFING_TASK_NOT_FOUND");
    for (const job of this.jobs)
      if (job.run === run && (!taskId || job.task.id === taskId)) this.stop(job, "cancelled");
    for (const task of run.tasks)
      if (task.status === "needs-input" && (!taskId || task.id === taskId))
        task.status = "cancelled";
    this.settle(run);
    return structuredClone(run);
  }
  close(): void {
    this.closed = true;
    for (const job of this.jobs) this.stop(job, "cancelled");
  }
  /** Counts only; no evidence or user identifiers exposed. Cleanup is lazy on access. */
  retentionStats() {
    this.prune();
    return {
      runs: this.runs.size,
      requests: this.requests.size,
      profiles: this.profiles.size,
      jobs: this.jobs.size,
      waiters: this.waiters.size,
      settled: this.settledAt.size,
      active: this.active
    };
  }
  private prune(target = this.options.maxRuns) {
    const protectedRuns = new Set([...this.jobs].map((job) => job.run.id));
    // Insertion order is settlement order. Reads/retries do not extend retention.
    for (const [id, settledAt] of this.settledAt) {
      if (protectedRuns.has(id)) continue; // A cancelled adapter may still be draining.
      if (this.clock() - settledAt < this.options.settledRunTtlMs && this.runs.size <= target)
        continue;
      const run = this.runs.get(id)!;
      this.runs.delete(id);
      this.requests.delete(JSON.stringify([run.userId, run.requestId]));
      this.profiles.delete(id);
      this.waiters.delete(id);
      this.settledAt.delete(id);
    }
  }
  private owned(userId: string, runId: string): BriefingRun {
    this.prune();
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) throw new Error("BRIEFING_NOT_FOUND");
    return run;
  }
  private settle(run: BriefingRun) {
    run.settled = run.tasks.every((task) => terminal(task.status));
    if (run.settled) {
      if (!this.settledAt.has(run.id)) this.settledAt.set(run.id, this.clock());
      for (const resolve of this.waiters.get(run.id) ?? []) resolve();
      this.waiters.delete(run.id);
    }
  }
  /**
   * Ends a task logically, by cancellation or by its deadline.
   *
   * @lifetime A queued job is removed at once. A running job stays registered, and
   * keeps its concurrency slot and its run's retention, until its adapter actually
   * settles.
   *
   * @invariant logical-cancel-keeps-physical-slot — Cancelling or timing out a running
   * task never frees its slot or its run before the adapter settles, even when the
   * adapter ignores the abort. A queued task holds no slot and is removed at once.
   * @test tests/unit/briefingCoordinator.test.ts :: bounds deadline waiting even when an adapter ignores abort, without freeing its physical slot
   * @test tests/unit/briefingCoordinator.test.ts :: protects running and cancelled-but-draining adapters under retention pressure
   */
  private stop(job: Job, status: "cancelled" | "deadline") {
    if (terminal(job.task.status)) return;
    const queued = job.task.status === "queued";
    job.task.status = status;
    job.task.checkpointCandidate = null;
    if (queued) this.jobs.delete(job);
    clearTimeout(job.timer);
    job.controller.abort();
    this.settle(job.run);
    this.pump();
  }
  private pump() {
    if (this.closed) return;
    for (const job of this.jobs) {
      if (this.active >= this.options.maxConcurrentTasks) break;
      if (job.task.status !== "queued") continue;
      job.task.status = "running";
      this.active++;
      void this.execute(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
  private async execute(job: Job) {
    const { task, run } = job,
      planned = run.plan.tasks[job.index];
    try {
      for (const source of job.sources) {
        if (terminal(task.status)) return;
        const query = {
          league: run.plan.league,
          kind: source.kind,
          team: planned.team,
          window: {
            fromInclusive: planned.window.fromInclusive,
            toExclusive: planned.window.toExclusive
          },
          now: run.plan.plannedAt,
          limit: source.limit,
          maxAgeMs: source.maxAgeMs
        };
        try {
          // Keep the concurrency slot until the adapter actually settles, even after abort.
          const result = await source.adapter.read(structuredClone(query), job.controller.signal);
          if (terminal(task.status)) return;
          if (!isDeepStrictEqual(result.query, query)) throw new Error("SOURCE_QUERY_MISMATCH");
          task.results.push({ adapterId: source.adapterId, evidence: structuredClone(result) });
        } catch {
          if (terminal(task.status)) return;
          task.errors.push({ adapterId: source.adapterId, code: "SOURCE_READ_FAILED" });
        }
      }
      const usable = task.results.filter((result) => result.evidence.coverage !== "unavailable");
      const complete =
        task.errors.length === 0 &&
        task.results.length === job.sources.length &&
        task.results.every(
          (result) =>
            result.evidence.coverage === "complete" && result.evidence.freshness === "fresh"
        );
      task.status = complete ? "complete" : usable.length ? "partial" : "failed";
      if (
        complete &&
        !planned.window.truncated &&
        task.results.every((result) => result.evidence.canAdvanceCheckpoint)
      ) {
        task.checkpointCandidate = planned.window.toExclusive;
      }
    } finally {
      clearTimeout(job.timer);
      this.jobs.delete(job);
      this.settle(run);
    }
  }
}
