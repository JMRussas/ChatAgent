import {
  GenerationError,
  normalizeGenerationError,
  type GenerationControl,
  type GenerationResult
} from "../domain/generation";
export const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

/** Deadline covers headers and body; abort also releases a stalled reader. */
export async function withGenerationDeadline<T>(
  label: string,
  timeoutMs: number,
  control: GenerationControl | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new GenerationError("CANCELLED", false));
  if (control?.signal.aborted) cancel();
  else control?.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new GenerationError(
          "PROVIDER_TIMEOUT",
          true,
          `${label} request timed out after ${timeoutMs}ms`
        )
      ),
    timeoutMs
  );
  try {
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw normalizeGenerationError(error);
  } finally {
    clearTimeout(timer);
    control?.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

export async function* streamLines(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<string> {
  if (!response.body) throw new GenerationError("INVALID_STREAM", false);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      try {
        buffer += decoder.decode(value, { stream: !done });
      } catch {
        throw new GenerationError("INVALID_STREAM", false);
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
          throw new GenerationError("STREAM_TOO_LARGE", false);
        yield line;
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new GenerationError("STREAM_TOO_LARGE", false);
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function parseFrame(text: string): any {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new GenerationError("INVALID_STREAM", false);
  }
}
export async function* sseData(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  let data: string[] = [];
  let bytes = 0;
  for await (const line of streamLines(response, signal)) {
    if (line === "") {
      if (data.length) yield data.join("\n");
      data = [];
      bytes = 0;
    } else if (line.startsWith("data:")) {
      const part = line.slice(5).replace(/^ /, "");
      bytes += Buffer.byteLength(part) + 1;
      if (bytes > MAX_FRAME_BYTES) throw new GenerationError("STREAM_TOO_LARGE", false);
      data.push(part);
    }
  }
  if (data.length) throw new GenerationError("INVALID_STREAM", false);
}
export class AnswerCollector {
  text = "";
  private bytes = 0;
  constructor(private readonly control?: GenerationControl) {}
  async add(text: unknown) {
    if (typeof text !== "string") throw new GenerationError("INVALID_STREAM", false);
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > MAX_ANSWER_BYTES) throw new GenerationError("ANSWER_TOO_LARGE", false);
    if (!text) return;
    this.control?.signal.throwIfAborted();
    this.text += text;
    await this.control?.onDelta(text);
  }
  finish(reason: unknown): GenerationResult {
    if (reason === "length" || reason === "max_tokens")
      return { text: this.text, finishReason: "length" };
    if (!["stop", "end_turn", "stop_sequence"].includes(String(reason)))
      throw new GenerationError("UNSUPPORTED_FINISH", false);
    if (!this.text.trim()) throw new GenerationError("EMPTY_RESPONSE", false);
    return { text: this.text, finishReason: "stop" };
  }
}
