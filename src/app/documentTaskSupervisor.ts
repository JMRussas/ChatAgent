import { DocumentTaskError, type DocumentTasks } from "./documentTasks";

/** The part of one sidecar bridge the supervisor relies on. */
export interface DocumentTaskChild extends DocumentTasks {
  abort(code: string): void;
  diagnostics(): { state: "up" | "terminating" | "down"; lastFailureCode: string };
}

export type DocumentTaskPhase = "starting" | "ready" | "stopping" | "failed" | "closed";

/** Bounded operator view: no paths, process ids or raw errors. */
export interface DocumentTaskStatus {
  phase: DocumentTaskPhase;
  generation: number;
  /** Only a failed generation whose child has confirmed its exit may be replaced. */
  restartable: boolean;
  failureCode: string | null;
}

export interface DocumentTaskControl {
  status(): DocumentTaskStatus;
  restart(expectedGeneration: number): Promise<DocumentTaskStatus>;
}

export class DocumentTaskControlError extends Error {
  constructor(
    readonly code: "STALE_GENERATION" | "NOT_FAILED" | "NOT_EXITED" | "CLOSED" | "STARTUP_FAILED",
    readonly status: DocumentTaskStatus
  ) {
    super(code);
  }
}

/** The fixed payload of the sidecar's health command. */
const HEALTH = { service: "chatagent-document-tasks", protocol: 1 } as const;
const isHealth = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 2 &&
  (value as Record<string, unknown>).service === HEALTH.service &&
  (value as Record<string, unknown>).protocol === HEALTH.protocol;

interface Generation {
  number: number;
  /** Absent when the factory itself threw. */
  child?: DocumentTaskChild;
  /** Set once readiness has been decided, either way. */
  settled: boolean;
  healthy: boolean;
  failureCode?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Wakes whoever awaits this generation's readiness. */
  done: Promise<void>;
  finish: () => void;
}

/**
 * One stable document-task service over a sequence of sidecar children. Each
 * generation is its own bridge with its own ids, timers and streams; a failed one is
 * never revived. A replacement is spawned only on an explicit operator restart, only
 * after the failed child's exit is confirmed, and nothing is ever replayed.
 */
export class DocumentTaskSupervisor implements DocumentTasks, DocumentTaskControl {
  private current!: Generation;
  private closed = false;

  constructor(
    private readonly spawnChild: () => DocumentTaskChild,
    private readonly readyTimeoutMs = 5_000
  ) {
    this.begin(1);
  }

  status(): DocumentTaskStatus {
    const g = this.current;
    const state = g.child?.diagnostics().state ?? "down";
    const phase: DocumentTaskPhase = this.closed
      ? "closed"
      : state === "down"
        ? "failed"
        : state === "terminating"
          ? "stopping"
          : !g.settled
            ? "starting"
            : g.healthy
              ? "ready"
              : "stopping";
    return {
      phase,
      generation: g.number,
      restartable: phase === "failed",
      failureCode:
        phase === "ready" || phase === "starting"
          ? null
          : g.failureCode || g.child?.diagnostics().lastFailureCode || null
    };
  }

  request(data: Record<string, unknown>): Promise<unknown> {
    const op = typeof data.op === "string" ? data.op : "";
    if (this.status().phase !== "ready")
      return Promise.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE", op));
    return this.current.child!.request(data);
  }

  async restart(expectedGeneration: number): Promise<DocumentTaskStatus> {
    const status = this.status();
    if (status.phase === "closed") throw new DocumentTaskControlError("CLOSED", status);
    if (expectedGeneration !== status.generation)
      throw new DocumentTaskControlError("STALE_GENERATION", status);
    if (status.phase === "starting" || status.phase === "ready")
      throw new DocumentTaskControlError("NOT_FAILED", status);
    if (status.phase === "stopping") throw new DocumentTaskControlError("NOT_EXITED", status);
    if (status.generation >= Number.MAX_SAFE_INTEGER)
      throw new DocumentTaskControlError("STARTUP_FAILED", status);
    // Synchronous from the checks above to the spawn: a concurrent restart sees the
    // new generation and is stale.
    const g = this.begin(status.generation + 1);
    await g.done;
    const after = this.status();
    if (after.phase === "closed") throw new DocumentTaskControlError("CLOSED", after);
    if (this.current !== g || after.phase !== "ready")
      throw new DocumentTaskControlError("STARTUP_FAILED", after);
    return after;
  }

  /** Permanent: no later spawn or promotion. The child is kept until it exits. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const g = this.current;
    this.settle(g, false);
    g.child?.close();
  }

  private begin(number: number) {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const g: Generation = { number, settled: false, healthy: false, done, finish };
    this.current = g;
    try {
      g.child = this.spawnChild();
    } catch {
      g.failureCode = "SPAWN_FAILED";
      this.settle(g, false);
      return g;
    }
    g.timer = setTimeout(() => this.reject(g, "HEALTH_TIMEOUT"), this.readyTimeoutMs);
    g.timer.unref?.();
    let probe: Promise<unknown>;
    try {
      probe = g.child.request({ op: "health" });
    } catch {
      // Treated as a refusal: a running child is terminated and kept until it exits.
      probe = Promise.reject(new Error("HEALTH_REQUEST_THREW"));
    }
    probe.then(
      (value) => (isHealth(value) ? this.settle(g, true) : this.reject(g, "HEALTH_INVALID")),
      (error) =>
        // A child that already failed (spawn error, exit, closed output) has recorded
        // why; one still running refused or never answered, and is terminated.
        g.child!.diagnostics().state !== "up"
          ? this.settle(g, false)
          : this.reject(
              g,
              error instanceof DocumentTaskError && error.code === "BRIDGE_TIMEOUT"
                ? "HEALTH_TIMEOUT"
                : "HEALTH_REFUSED"
            )
    );
    return g;
  }

  /** Readiness failed: the child is terminated but kept until its exit is confirmed. */
  private reject(g: Generation, code: string) {
    if (g.settled) return;
    g.failureCode = code;
    this.settle(g, false);
    g.child?.abort(code);
  }

  private settle(g: Generation, healthy: boolean) {
    if (g.settled) return;
    // Settled once: close() settles the current generation, so a result arriving
    // after it is never promoted.
    g.settled = true;
    g.healthy = healthy;
    if (g.timer) clearTimeout(g.timer);
    g.timer = undefined;
    g.finish();
  }
}
