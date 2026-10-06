import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Minimal ServerResponse stand-in whose write() can report a full buffer on demand,
 * so slow-client behavior is deterministic instead of depending on OS socket sizes.
 */
export class FakeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  /** Writes beyond this many return false (buffered, but full). */
  allowance = Number.POSITIVE_INFINITY;
  readonly chunks: string[] = [];
  private readonly headers = new Map<string, unknown>();

  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  write(chunk: string) {
    this.headersSent = true;
    this.chunks.push(String(chunk));
    if (this.allowance <= 0) {
      this.writableLength += String(chunk).length;
      return false;
    }
    this.allowance--;
    return true;
  }
  /** Simulates the client catching up. */
  drain(allowance = Number.POSITIVE_INFINITY) {
    this.allowance = allowance;
    this.writableLength = 0;
    this.emit("drain");
  }
  end(chunk?: string) {
    if (chunk) this.chunks.push(String(chunk));
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  get text() {
    return this.chunks.join("");
  }
  asResponse() {
    return this as unknown as ServerResponse;
  }
}

export function fakeRequest(url: string) {
  const req = new EventEmitter() as IncomingMessage;
  Object.assign(req, { method: "GET", url, headers: { host: "127.0.0.1" } });
  return req;
}

/** Wire frames written so far, as [event, parsed data, id?]. */
export function frames(res: FakeResponse) {
  return res.text
    .split("\n\n")
    .filter((f) => f.includes("event: "))
    .map((f) => {
      const line = (prefix: string) =>
        f
          .split("\n")
          .find((l) => l.startsWith(prefix))
          ?.slice(prefix.length);
      const id = line("id: ");
      return {
        event: line("event: ")!,
        data: JSON.parse(line("data: ")!),
        id: id === undefined ? undefined : Number(id)
      };
    });
}
