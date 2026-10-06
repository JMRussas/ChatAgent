import { spawn } from "node:child_process";

export interface DocumentTasks {
  request(data: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export class DocumentTaskError extends Error {
  constructor(
    readonly code: string,
    /** The operation it answers, for errors whose meaning depends on it. */
    readonly op?: string
  ) {
    super(code);
  }
}

const MAX_LINE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const MAX_PENDING = 32;
/** Ids whose request timed out; a reply for one of these is late, not a protocol error. */
const LATE_REPLY_MEMORY = 64;
/**
 * The sidecar refuses an input line longer than 16000 characters (newline included)
 * and cannot say which request it refused. Lines are sent as pure ASCII, so this byte
 * bound equals the character count Python sees whatever its stdin encoding.
 */
const MAX_REQUEST_BYTES = 16_000;
const READ_ONLY_OPS = new Set(["list", "status"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface Pending {
  op: string;
  /** Handed to the child's stdin (a full write buffer still counts as handed off). */
  written: boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** JSON with every non-ASCII UTF-16 unit escaped, so one character is one byte. */
function asciiJson(value: unknown) {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * Settlement for a request whose reply will never come. Unsent and read-only
 * requests are simply unavailable. A sent start, resume or cancel may or may not
 * have taken effect in the sidecar's durable store, so it is uncertain.
 */
function unanswered(entry: Pending, code: "BRIDGE_UNAVAILABLE" | "BRIDGE_TIMEOUT") {
  if (!entry.written) return new DocumentTaskError("BRIDGE_UNAVAILABLE", entry.op);
  if (READ_ONLY_OPS.has(entry.op)) return new DocumentTaskError(code, entry.op);
  return new DocumentTaskError("BRIDGE_UNCERTAIN", entry.op);
}

/**
 * Optional local Python sidecar. Never use a shell to pass user questions.
 *
 * Containment: any protocol violation or child failure settles every pending
 * request at once, stops reading, and terminates the child (stdin closed, then
 * SIGTERM, then SIGKILL after a grace period). The bridge is down from then on;
 * it never spawns a replacement and never re-sends a request.
 */
export class PythonDocumentTasks implements DocumentTasks {
  private readonly child;
  private sequence = 0;
  private state: "up" | "terminating" | "down" = "up";
  private exited = false;
  /** The child's stdin buffer is full; admission reopens on its next drain while up. */
  private blocked = false;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, Pending>();
  private readonly timedOut: number[] = [];
  /** The unfinished line, copied into one growing buffer capped at MAX_LINE_BYTES. */
  private partial = Buffer.alloc(0);
  private partialBytes = 0;
  private readonly counters = { protocolFailures: 0, lateReplies: 0, lastFailureCode: "" };

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
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stdout.on("error", () => this.fail("STDOUT_ERROR"));
    // No reply channel left (possibly with the child still alive, or mid-line): fail
    // now rather than letting pending requests wait out their deadline. Expected
    // closure while terminating or down is ignored by fail().
    this.child.stdout.on("end", () => this.fail("STDOUT_CLOSED"));
    this.child.stdout.on("close", () => this.fail("STDOUT_CLOSED"));
    this.child.stdin.on("error", () => this.fail("STDIN_ERROR"));
    // A failed spawn emits "error" then "close" without "exit"; either end confirms it.
    this.child.on("error", () => this.fail("CHILD_ERROR"));
    this.child.once("exit", () => this.onExited());
    this.child.once("close", () => this.onExited());
  }

  /** Bounded local diagnostics. */
  diagnostics() {
    return { state: this.state, pending: this.pending.size, ...this.counters };
  }

  request(data: Record<string, unknown>): Promise<unknown> {
    const op = typeof data.op === "string" ? data.op : "";
    if (this.state !== "up") return Promise.reject(new DocumentTaskError("BRIDGE_UNAVAILABLE", op));
    // Refused before serializing, numbering or timing anything; safe to retry.
    if (this.blocked) return Promise.reject(new DocumentTaskError("BRIDGE_BUSY", op));
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new DocumentTaskError("CAPACITY_FULL", op));
    const line = asciiJson({ ...data, id: this.sequence + 1 }) + "\n";
    if (line.length > MAX_REQUEST_BYTES)
      return Promise.reject(new DocumentTaskError("REQUEST_TOO_LARGE", op));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        op,
        written: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          this.timedOut.push(id);
          if (this.timedOut.length > LATE_REPLY_MEMORY) this.timedOut.shift();
          reject(unanswered(entry, "BRIDGE_TIMEOUT"));
        }, REQUEST_TIMEOUT_MS)
      };
      this.pending.set(id, entry);
      try {
        if (!this.child.stdin.write(line)) this.block();
        entry.written = true;
      } catch {
        this.fail("STDIN_ERROR");
      }
    });
  }

  /**
   * One drain listener per blocked episode. It is removed before the bridge leaves
   * "up", so only a drain while up can reopen admission.
   */
  private block() {
    if (this.blocked) return;
    this.blocked = true;
    this.child.stdin.once("drain", this.onDrain);
  }

  private readonly onDrain = () => {
    this.blocked = false;
  };

  /** Shutdown: settles what is pending, lets the child exit on end of input, then kills it. */
  close() {
    if (this.state === "down") return;
    this.settleAll();
    this.terminate(false);
  }

  private onData(chunk: Buffer) {
    let start = 0;
    while (this.state === "up") {
      const newline = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      // Bounded before anything is buffered or decoded, for complete lines too.
      if (this.partialBytes + piece.length > MAX_LINE_BYTES) return this.fail("LINE_TOO_LONG");
      if (newline === -1) return this.keepPartial(piece);
      let line = piece;
      if (this.partialBytes) {
        // A completed line is copied out, so no view keeps a received chunk alive.
        this.keepPartial(piece);
        line = Buffer.from(this.partial.subarray(0, this.partialBytes));
        this.partialBytes = 0;
      }
      this.onLine(line);
      start = newline + 1;
    }
  }

  /** Copies bytes into the partial-line buffer, growing it up to MAX_LINE_BYTES. */
  private keepPartial(piece: Buffer) {
    if (!piece.length) return;
    const needed = this.partialBytes + piece.length;
    if (needed > this.partial.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(MAX_LINE_BYTES, Math.max(needed, this.partial.length * 2, 4096))
      );
      this.partial.copy(grown, 0, 0, this.partialBytes);
      this.partial = grown;
    }
    piece.copy(this.partial, this.partialBytes);
    this.partialBytes = needed;
  }

  private onLine(bytes: Buffer) {
    let response: unknown;
    try {
      const end = bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length;
      response = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))
      );
    } catch {
      return this.fail("MALFORMED_RESPONSE");
    }
    const envelope = response as Record<string, unknown>;
    const keys =
      envelope && typeof envelope === "object" && !Array.isArray(envelope)
        ? Object.keys(envelope).sort()
        : [];
    const id = envelope?.id;
    const valid =
      Number.isSafeInteger(id) &&
      (id as number) > 0 &&
      ((keys.length === 2 && keys[0] === "id" && keys[1] === "result") ||
        (keys.length === 2 &&
          keys[0] === "error" &&
          keys[1] === "id" &&
          typeof envelope.error === "string" &&
          ERROR_CODE.test(envelope.error)));
    if (!valid) return this.fail("MALFORMED_RESPONSE");
    const entry = this.pending.get(id as number);
    if (!entry) {
      // A reply after its request timed out is expected and dropped once; any other
      // id, or a second reply, means the two sides no longer agree.
      const late = this.timedOut.indexOf(id as number);
      if (late === -1) return this.fail("UNKNOWN_RESPONSE_ID");
      this.timedOut.splice(late, 1);
      this.counters.lateReplies++;
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id as number);
    if ("error" in envelope)
      entry.reject(new DocumentTaskError(envelope.error as string, entry.op));
    else entry.resolve(envelope.result);
  }

  private fail(code: string) {
    if (this.state !== "up") return;
    this.counters.protocolFailures++;
    this.counters.lastFailureCode = code;
    this.settleAll();
    this.terminate(true);
  }

  private settleAll() {
    this.state = this.exited ? "down" : "terminating";
    // Admission never reopens from here, so the drain listener is not kept.
    this.child.stdin.off("drain", this.onDrain);
    this.partial = Buffer.alloc(0);
    this.partialBytes = 0;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(unanswered(entry, "BRIDGE_UNAVAILABLE"));
    }
    this.pending.clear();
  }

  /** Ends input, then SIGTERM (immediately on failure, after the grace on close), then SIGKILL. */
  private terminate(immediate: boolean) {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* Already closed. */
    }
    const kill = (signal: NodeJS.Signals) => {
      if (!this.exited) this.child.kill(signal);
    };
    if (immediate) kill("SIGTERM");
    this.killTimer ??= setTimeout(() => {
      kill(immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate) {
        this.killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        this.killTimer.unref?.();
      }
    }, KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  private onExited() {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    if (this.state === "up") {
      // Unexpected exit: settle what was pending; nothing is left to terminate.
      this.counters.protocolFailures++;
      this.counters.lastFailureCode = "CHILD_EXITED";
      this.settleAll();
    }
    this.state = "down";
  }
}
