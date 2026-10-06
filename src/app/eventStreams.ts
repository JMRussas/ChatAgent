import type { ServerResponse } from "node:http";
import type { StreamAdmissionConfig } from "../config/streamAdmission";

export class StreamCapacityError extends Error {
  readonly code = "STREAM_CAPACITY";
  constructor(readonly maxEventStreams: number) {
    super(`The server already has ${maxEventStreams} event streams open. Retry after one closes.`);
  }
}

/**
 * "ok" and "full" mean the frame was accepted; after "full" nothing more should be
 * written until drain. "blocked" and "closed" mean it was NOT written: the caller
 * must not record it as sent.
 */
export type StreamWrite = "ok" | "full" | "blocked" | "closed";

export const sseFrame = (event: string, data: string, id?: number) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`;

/**
 * One admitted event stream. It owns the stream's timers and admission slot.
 *
 * Streams are derived from timeline state, so there is no event queue: while the
 * response cannot take more data the stream neither reads the timeline nor writes,
 * and the next read after drain sends whatever is current. A stream that stays
 * unable to accept writes past the stall timeout is destroyed.
 */
export class EventStream {
  private closed = false;
  private blocked = false;
  private reading = false;
  private kick = false;
  private task?: () => Promise<void>;
  private onTaskError?: (error: unknown) => void;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private readonly timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly res: ServerResponse,
    private readonly stallTimeoutMs: number,
    private readonly settle: (stream: EventStream) => void
  ) {
    // Attached at admission, before any awaited work, so every exit path releases.
    res.once("close", this.close);
    res.once("finish", this.close);
    res.once("error", this.close);
  }

  /** False once the client left, the response ended or the stream was closed. */
  get open() {
    return !this.closed && !this.res.destroyed && !this.res.writableEnded;
  }

  /** Closed, but a timeline read it started has not settled; it still holds its slot. */
  get settling() {
    return this.closed && this.reading;
  }

  /** Writes one complete frame. While blocked nothing is written, so the buffer stays bounded. */
  write(frame: string): StreamWrite {
    if (!this.open) return "closed";
    if (this.blocked) return "blocked";
    if (this.res.write(frame)) return "ok";
    this.blocked = true;
    this.res.once("drain", this.onDrain);
    this.stallTimer = setTimeout(() => this.res.destroy(), this.stallTimeoutMs);
    return "full";
  }

  /**
   * Ends the response with an optional last frame. A blocked stream ends without it:
   * the buffered data still drains, the stall timer still applies, and a reconnecting
   * client learns the outcome from the next request.
   */
  finish(frame?: string) {
    if (!this.open) return;
    if (frame) this.write(frame);
    this.res.end();
    // Until the response flushes ('finish' or 'close' calls close()), the stall
    // deadline bounds how long an ended stream may keep its buffer and slot. A
    // response that finished synchronously inside end() is already closed.
    if (!this.closed) this.stallTimer ??= setTimeout(() => this.res.destroy(), this.stallTimeoutMs);
  }

  /**
   * Awaits a timeline read on the stream's behalf. While it is pending the stream
   * keeps its slot even if the client leaves, so reconnect churn cannot pile up reads.
   */
  async read<T>(work: () => Promise<T>): Promise<T> {
    this.reading = true;
    try {
      return await work();
    } finally {
      this.reading = false;
      if (this.closed) this.settle(this);
    }
  }

  /** Sets the read-and-write step and runs it once. Errors go to onError while open. */
  start(task: () => Promise<void>, onError: (error: unknown) => void) {
    this.task = task;
    this.onTaskError = onError;
    return this.pump();
  }

  /** Runs the step unless one is running, the stream is blocked or it is closed. Never rejects. */
  pump(): Promise<void> {
    const task = this.task;
    if (!task || this.reading || this.blocked || !this.open) return Promise.resolve();
    return this.read(task)
      .catch((error) => {
        if (!this.open) return;
        try {
          this.onTaskError?.(error);
        } catch {
          this.res.destroy();
        }
      })
      .finally(() => {
        // A drain that arrived during the step asked for one more run.
        if (this.kick && !this.blocked && this.open) {
          this.kick = false;
          void this.pump();
        }
      });
  }

  every(ms: number, fn: () => void) {
    if (this.closed) return;
    this.timers.add(setInterval(fn, ms));
  }

  heartbeat(ms: number) {
    this.every(ms, () => {
      if (!this.blocked) this.write(": ping\n\n");
    });
  }

  /** Stops timers and listeners now; the slot is released once no read is in flight. */
  readonly close = () => {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.res.off("drain", this.onDrain);
    if (!this.reading) this.settle(this);
  };

  /** Shutdown: a response with buffered data is destroyed rather than awaited. */
  shutdown() {
    const buffered = this.blocked || this.res.writableLength > 0;
    this.close();
    if (this.res.destroyed) return;
    // An ended response that is still flushing to a stalled client is destroyed too:
    // close() just cleared the stall deadline that would otherwise have done it.
    if (buffered || !this.res.headersSent) this.res.destroy();
    else if (!this.res.writableEnded) this.res.end();
  }

  private readonly onDrain = () => {
    this.blocked = false;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    // At most one deferred run, never a queue.
    if (this.reading) this.kick = true;
    else void this.pump();
  };
}

/** One limit shared by the legacy and protocol v1 event-stream routes. */
export class EventStreamRegistry {
  private readonly streams = new Set<EventStream>();

  constructor(private readonly config: StreamAdmissionConfig) {}

  /** Admits a stream before any timeline read, header or timer. Throws at capacity. */
  open(res: ServerResponse) {
    if (this.streams.size >= this.config.maxEventStreams)
      throw new StreamCapacityError(this.config.maxEventStreams);
    const stream = new EventStream(res, this.config.streamStallTimeoutMs, (s) =>
      this.streams.delete(s)
    );
    this.streams.add(stream);
    return stream;
  }

  closeAll() {
    for (const stream of [...this.streams]) stream.shutdown();
  }

  /** `streams` counts held slots, including closed streams whose read has not settled. */
  stats() {
    let settling = 0;
    for (const stream of this.streams) if (stream.settling) settling++;
    return { streams: this.streams.size, settlingStreams: settling };
  }
}
