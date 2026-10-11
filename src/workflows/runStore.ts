import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { taskStateSchema } from "../tasks/types";
import { WorkflowError, workflowDefinitionSchema, type WorkflowRun } from "./types";

export const MAX_RUN_RECORD_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stepStatus = z.enum([
  "pending",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "stopped",
  "uncertain"
]);
const runSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(UUID),
    planId: z.string().regex(UUID),
    ownerId: z.string().min(1).max(500),
    definition: workflowDefinitionSchema,
    revision: z.number().int().min(0),
    attemptEpoch: z.number().int().min(0),
    status: z.enum(["running", "waiting_input", "completed", "failed", "stopped", "uncertain"]),
    steps: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          status: stepStatus,
          agent: taskStateSchema.optional(),
          inputs: z.unknown().optional(),
          output: z.unknown().optional(),
          error: z.string().optional(),
          startedAt: z.string().optional(),
          endedAt: z.string().optional()
        })
        .strict()
    ),
    startedAt: z.string(),
    updatedAt: z.string(),
    endedAt: z.string().optional(),
    error: z.string().optional(),
    conversationId: z.string().optional()
  })
  .strict();

export interface RunClaim {
  release(): Promise<void>;
}

/**
 * Durable workflow execution artifacts, one JSON file per run UUID. Task and plan state
 * lives in the plan store; this only holds what a run produced. Cross-instance exclusion
 * uses an O_EXCL lock file. Existing locks fail closed and require explicit recovery;
 * automatically deleting a stale-looking lock can race another claimant.
 */
export class WorkflowRunStore {
  constructor(private readonly dir: string) {}

  pathFor(id: string, suffix = ".json"): string {
    if (!UUID.test(id)) throw new WorkflowError("invalid_run_id", "Run ID must be a UUID", 400);
    return join(this.dir, `${id.toLowerCase()}${suffix}`);
  }

  /** Atomically publishes a new record; fails if the run already exists. */
  async create(run: WorkflowRun): Promise<void> {
    const text = this.serialize(run);
    const final = this.pathFor(run.id);
    const temp = await this.writeTemp(run.id, text);
    try {
      await link(temp, final);
    } catch (error) {
      if (code(error) === "EEXIST")
        throw new WorkflowError("run_exists", "Workflow run already exists", 409);
      throw ioError(error);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Replaces an existing record via same-directory temp file and rename. */
  async write(run: WorkflowRun): Promise<void> {
    const text = this.serialize(run);
    const temp = await this.writeTemp(run.id, text);
    const deadline = Date.now() + 1000;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await rename(temp, this.pathFor(run.id));
        } catch (error) {
          if (Date.now() >= deadline || !["EPERM", "EBUSY", "EACCES"].includes(code(error) ?? ""))
            throw error;
          // Windows readers and security scanners can briefly hold the destination.
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(50, 10 * (attempt + 1), deadline - Date.now()))
          );
        }
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw ioError(error);
    }
  }

  async read(ownerId: string, id: string): Promise<WorkflowRun> {
    const path = this.pathFor(id);
    let text: string;
    try {
      if ((await stat(path)).size > MAX_RUN_RECORD_BYTES)
        throw corrupt("Workflow run record exceeds the size limit");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if (code(error) === "ENOENT") throw notFound();
      throw ioError(error);
    }
    if (Buffer.byteLength(text) > MAX_RUN_RECORD_BYTES)
      throw corrupt("Workflow run record exceeds the size limit");
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof runSchema>>;
    try {
      parsed = runSchema.safeParse(JSON.parse(text));
    } catch {
      throw corrupt("Workflow run record is not valid JSON");
    }
    if (!parsed.success) throw corrupt("Workflow run record failed validation");
    const run = parsed.data as WorkflowRun;
    if (run.id.toLowerCase() !== id.toLowerCase())
      throw corrupt("Workflow run record does not match its file");
    if (
      run.steps.length !== run.definition.steps.length ||
      run.steps.some((step, index) => step.id !== run.definition.steps[index].id)
    )
      throw corrupt("Workflow run steps do not match its definition");
    if (run.ownerId !== ownerId) throw notFound();
    return run;
  }

  /** One bounded scan supplies latest artifacts for a caller's plans, including released runs. */
  async latest(ownerId: string, planIds: readonly string[]): Promise<Map<string, string>> {
    const wanted = new Set(planIds);
    const newest = new Map<string, WorkflowRun>();
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter(
        (name) => name.endsWith(".json") && UUID.test(name.slice(0, -5))
      );
    } catch (error) {
      if (code(error) === "ENOENT") return new Map();
      throw ioError(error);
    }
    if (names.length > 1000)
      throw new WorkflowError(
        "run_history_limit",
        "Run history exceeds the lookup limit; archive older artifacts before continuing",
        503
      );
    for (const name of names) {
      let run: WorkflowRun;
      try {
        run = await this.read(ownerId, name.slice(0, -5));
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "run_not_found") continue;
        throw error;
      }
      if (!wanted.has(run.planId)) continue;
      const previous = newest.get(run.planId);
      if (
        !previous ||
        run.startedAt > previous.startedAt ||
        (run.startedAt === previous.startedAt && run.attemptEpoch > previous.attemptEpoch)
      )
        newest.set(run.planId, run);
    }
    return new Map([...newest].map(([id, run]) => [id, run.id]));
  }

  /** Exclusive cross-instance claim on a run; throws run_busy while a live holder exists. */
  async claim(id: string): Promise<RunClaim> {
    const path = this.pathFor(id, ".lock");
    await mkdir(this.dir, { recursive: true });
    const token = randomUUID();
    try {
      await writeFile(path, JSON.stringify({ token, pid: process.pid, at: Date.now() }), {
        flag: "wx"
      });
    } catch (error) {
      if (code(error) === "EEXIST")
        throw new WorkflowError(
          "run_busy",
          "Workflow run has an existing claim; inspect it before explicit recovery",
          409
        );
      throw ioError(error);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const holder = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (holder.token === token) await unlink(path);
        } catch {
          // Missing, replaced or unreadable claims are never removed by this holder.
        }
      }
    };
  }

  private serialize(run: WorkflowRun): string {
    const text = JSON.stringify(run);
    if (Buffer.byteLength(text) > MAX_RUN_RECORD_BYTES)
      throw new WorkflowError(
        "record_too_large",
        "Workflow run record exceeds the size limit",
        413
      );
    return text;
  }

  private async writeTemp(id: string, text: string): Promise<string> {
    const temp = this.pathFor(id, `.${randomUUID()}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temp, text, { flag: "wx" });
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw ioError(error);
    }
    return temp;
  }
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;
const ioError = (cause?: unknown) =>
  Object.assign(new WorkflowError("run_store_io", "Workflow run storage is unavailable", 500), {
    cause
  });
const corrupt = (message: string) => new WorkflowError("run_corrupt", message, 500);
const notFound = () => new WorkflowError("run_not_found", "Workflow run not found", 404);
