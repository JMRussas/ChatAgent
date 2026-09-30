import { spawn, execFile, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { GenerationError } from "../../domain/generation";
import type { CliAdapter, CliGenerationEvent, CliGenerationRequest, CliReadiness } from "./adapter";

export interface CliLimits { timeoutMs: number; maxOutputBytes: number; maxConcurrency: number; quotaMaxWaitMs: number }
export function cliLimits(env: NodeJS.ProcessEnv = process.env): CliLimits {
  const integer = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_${key}`);
    return value;
  };
  return { timeoutMs: integer("CLI_TIMEOUT_MS", 120000), maxOutputBytes: integer("CLI_MAX_OUTPUT_BYTES", 1048576),
    maxConcurrency: integer("CLI_MAX_CONCURRENCY", 1), quotaMaxWaitMs: integer("CLI_QUOTA_MAX_WAIT_MS", 30000) };
}
export interface ProcessTreeTerminator { terminate(child: ChildProcess): Promise<void> }
export const processTreeTerminator: ProcessTreeTerminator = {
  async terminate(child) {
    if (!child.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, error => {
          if (error && child.exitCode === null) reject(new GenerationError("CLI_CLEANUP_FAILED", false)); else resolve();
        }));
    } else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new GenerationError("CLI_CLEANUP_FAILED", false); }
    }
  }
};

/** All fields are supplied by trusted adapter code, never catalog or request data.
 * The parser must recognize the product's answer-only protocol, not arbitrary logs. */
export interface CliProgram {
  id: string;
  executable: string;
  args: readonly string[];
  allowedWorkingRoot: string;
  answerOnly: boolean;
  inspect(profile: string, signal: AbortSignal): Promise<CliReadiness>;
  encode(request: CliGenerationRequest): string;
  parse(line: string): CliGenerationEvent | undefined;
}
const fail = (code: string) => new GenerationError(code, false);
export class CliQuotaError extends GenerationError {
  readonly resetAt?: string;
  constructor(resetAt?: string) {
    super("QUOTA_EXHAUSTED", false);
    if (resetAt && Number.isFinite(Date.parse(resetAt))) this.resetAt = new Date(resetAt).toISOString();
  }
}

/** Shared across adapter instances, so two models cannot bypass an account limit. */
export class CliRunner {
  private readonly active = new Map<string, number>();
  constructor(readonly limits = cliLimits(), private readonly terminator = processTreeTerminator) {
    if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("INVALID_CLI_LIMITS");
  }
  adapter(program: CliProgram): CliAdapter {
    const frozen = { ...program, args: [...program.args] };
    return { id: frozen.id, inspect: (profile, signal) => frozen.inspect(profile, signal),
      generate: request => this.generate(frozen, request) };
  }
  private async *generate(program: CliProgram, original: CliGenerationRequest): AsyncIterable<CliGenerationEvent> {
    const controller = new AbortController();
    const cancel = () => controller.abort(fail("CANCELLED"));
    original.signal.addEventListener("abort", cancel, { once: true });
    if (original.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(fail("PROVIDER_TIMEOUT")), this.limits.timeoutMs);
    const signal = controller.signal;
    const request = { ...original, context: structuredClone(original.context), signal };
    const pool = request.quotaPoolId ? `pool:${request.quotaPoolId}` : JSON.stringify([program.id, request.accountProfile]);
    let acquired = false;
    try {
      signal.throwIfAborted();
      if (!program.answerOnly) throw fail("CLI_AUTOMATION_UNSUPPORTED");
      if (!Number.isSafeInteger(request.outputBudget) || request.outputBudget <= 0) throw fail("CLI_INVALID_REQUEST");
      const [root, cwd] = await Promise.all([realpath(program.allowedWorkingRoot), realpath(request.workingDirectory)]);
      const rel = relative(root, cwd);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !(await stat(cwd)).isDirectory()) throw fail("CLI_INVALID_WORKING_DIRECTORY");
      request.workingDirectory = cwd;
      if ((this.active.get(pool) ?? 0) >= this.limits.maxConcurrency) yield { type: "queued", reason: "concurrency" };
      while ((this.active.get(pool) ?? 0) >= this.limits.maxConcurrency) await delay(10, undefined, { signal });
      signal.throwIfAborted();
      this.active.set(pool, (this.active.get(pool) ?? 0) + 1); acquired = true;
      let readiness = await program.inspect(request.accountProfile, signal);
      let waited = false;
      while (true) {
        signal.throwIfAborted();
        const observed = Date.parse(readiness.observedAt), expires = Date.parse(readiness.expiresAt);
        if (!Number.isFinite(observed) || observed > Date.now() || !Number.isFinite(expires) || expires <= Date.now() || !readiness.version) throw fail("CLI_READINESS_UNKNOWN");
        if (readiness.authenticated !== "yes") throw fail("AUTH_REQUIRED");
        if (readiness.automation !== "supported") throw fail("CLI_AUTOMATION_UNSUPPORTED");
        if (readiness.blockedReason) throw fail(readiness.blockedReason);
        if (readiness.quota === "unknown") throw fail("CLI_QUOTA_UNKNOWN");
        if (readiness.quota === "available") break;
        const waitMs = readiness.resetAt ? Date.parse(readiness.resetAt) - Date.now() : NaN;
        if (waited || request.exhaustionPolicy !== "wait" || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > this.limits.quotaMaxWaitMs) throw new CliQuotaError(readiness.resetAt);
        yield { type: "queued", reason: "quota", resetAt: readiness.resetAt };
        await delay(waitMs, undefined, { signal }); waited = true;
        readiness = await program.inspect(request.accountProfile, signal);
      }
      yield* this.execute(program, request);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof GenerationError) throw error;
      throw fail("CLI_EXECUTION_FAILED");
    } finally {
      clearTimeout(timer); original.signal.removeEventListener("abort", cancel);
      if (acquired) { const count = this.active.get(pool)! - 1; if (count) this.active.set(pool, count); else this.active.delete(pool); }
    }
  }
  private async *execute(program: CliProgram, request: CliGenerationRequest): AsyncIterable<CliGenerationEvent> {
    request.signal.throwIfAborted();
    const input = program.encode(request);
    const child = spawn(program.executable, [...program.args], { cwd: request.workingDirectory,
      shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const queue: CliGenerationEvent[] = [];
    let wake = () => {}, closed = false, error: GenerationError | undefined, total = 0, buffer = "", answer = "";
    let final: Extract<CliGenerationEvent, { type: "complete" }> | undefined;
    let cleanup: Promise<void> | undefined;
    const decoder = new StringDecoder("utf8");
    const kill = () => cleanup ??= this.terminator.terminate(child).catch(() => { error = fail("CLI_CLEANUP_FAILED"); child.kill("SIGKILL"); });
    const stop = (failure: GenerationError) => { error ??= failure; void kill(); wake(); };
    const abort = () => stop(request.signal.reason instanceof GenerationError ? request.signal.reason : fail("CANCELLED"));
    const parse = (line: string) => {
      if (!line.trim() || error) return;
      try {
        const event = program.parse(line);
        if (!event) return;
        if (final) throw fail("CLI_MALFORMED_OUTPUT");
        if (event.type === "complete") final = event;
        else { if (event.type === "delta") answer += event.text; queue.push(event); }
      } catch (e) { stop(e instanceof GenerationError ? e : fail("CLI_MALFORMED_OUTPUT")); }
    };
    const count = (chunk: Buffer) => { total += chunk.length; if (total > this.limits.maxOutputBytes) stop(fail("OUTPUT_TOO_LARGE")); return !error; };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!count(chunk)) return;
      buffer += decoder.write(chunk);
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0 && !error) { parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      wake();
    });
    child.stderr!.on("data", count); // Count and discard: never persist session diagnostics.
    child.stdin!.on("error", () => { /* Exit status/final frame decide early stdin closure. */ });
    child.on("error", () => { error ??= fail("CLI_START_FAILED"); wake(); });
    const done = new Promise<void>(resolve => child.on("close", code => {
      buffer += decoder.end(); parse(buffer);
      if (code !== 0) error ??= fail("CLI_NONZERO_EXIT");
      closed = true; wake(); resolve();
    }));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort(); else child.stdin!.end(input);
    try {
      while (!closed) {
        if (!error) while (queue.length) yield queue.shift()!;
        if (!closed) await new Promise<void>(resolve => { wake = resolve; });
      }
      await cleanup;
      if (error) throw error;
      while (queue.length) yield queue.shift()!;
      if (!final || !final.text.trim()) throw fail("CLI_EMPTY_OUTPUT");
      if (answer && answer !== final.text) throw fail("CLI_MALFORMED_OUTPUT");
      yield final;
    } finally {
      request.signal.removeEventListener("abort", abort);
      if (!closed) await kill();
      await done; await cleanup;
    }
  }
}
