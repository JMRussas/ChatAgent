import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface DocumentTasks {
  request(data: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export class DocumentTaskError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Optional local Python sidecar. Never use a shell to pass user questions. */
export class PythonDocumentTasks implements DocumentTasks {
  private readonly child;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    python: string,
    script: string,
    root: string,
    model = "gemma4:26b",
    baseUrl?: string
  ) {
    this.child = spawn(
      python,
      [script, "--root", root, "--model", model, ...(baseUrl ? ["--base-url", baseUrl] : [])],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    // Drain diagnostics without exposing local paths/model errors through HTTP.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(response.id);
        if (response.error) waiter.reject(new DocumentTaskError(response.error));
        else waiter.resolve(response.result);
      } catch {
        this.fail();
      }
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
  }
  private fail() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE"));
    }
    this.pending.clear();
  }
  request(data: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE"));
    if (this.pending.size >= 32) return Promise.reject(new DocumentTaskError("CAPACITY_FULL"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DocumentTaskError("BRIDGE_TIMEOUT"));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...data, id }) + "\n");
    });
  }
  close() {
    this.child.stdin.end();
    this.fail();
    const timer = setTimeout(() => this.child.kill(), 5000);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }
}
