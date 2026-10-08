import { lstat, open } from "node:fs/promises";
import type { TranscriptExtract, TranscriptRecord } from "./activity";

/**
 * Reads the tail of one Claude Code session transcript (doc 15) as metadata only.
 * Only the explicit path is read, and only when lstat and the opened handle both show a
 * regular file: its last
 * MAX_TAIL_BYTES, at most MAX_LINES lines, each at most MAX_LINE_BYTES. Each JSON line
 * keeps its timestamp, type, session id, message role and stop reason, the ids of
 * tool-use and tool-result blocks, and whether a user text block is the interruption
 * marker. Text, tool inputs and results, paths and every other field are dropped as
 * the line is parsed. A line that cannot be interpreted becomes a `malformed`
 * placeholder rather than disappearing; only records of another valid session are
 * dropped.
 *
 * The optional deadline signal is checked between filesystem steps. Filesystem I/O
 * itself cannot be interrupted here: a read already in progress runs to completion
 * (and its handle is then closed) even after the deadline. A caller that must stop
 * at the deadline has to stop the process, as scripts/agentStalls.ts does.
 */

export const MAX_TAIL_BYTES = 1024 * 1024;
export const MAX_LINES = 4000;
export const MAX_LINE_BYTES = 256 * 1024;
export const INTERRUPTION_MARKER = "[Request interrupted by user for tool use]";
const MAX_ID = 128;
const CONVERSATIONAL = new Set(["user", "assistant"]);

export type TranscriptReadErrorCode =
  "TRANSCRIPT_UNREADABLE" | "TRANSCRIPT_NOT_A_FILE" | "DEADLINE";

/** The explicit transcript could not be read at all. */
export class TranscriptReadError extends Error {
  constructor(readonly code: TranscriptReadErrorCode) {
    super(code);
    this.name = "TranscriptReadError";
  }
}

/** @internal Test seam: the filesystem calls the reader makes. */
export interface TranscriptIo {
  lstat: typeof lstat;
  open: typeof open;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const malformed = (): TranscriptRecord => ({
  ts: null,
  type: "malformed",
  toolUseIds: [],
  toolResultIds: [],
  interruptionMarker: false,
  malformed: true
});

const shortString = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

/**
 * The metadata of one parsed line; null only for a record of another valid session.
 * Anything that claims to be conversational but cannot be interpreted is malformed.
 */
function record(line: unknown, session: string): TranscriptRecord | null {
  if (!isObject(line)) return malformed();
  const sessionId = shortString(line.sessionId, 128);
  if (!sessionId) return malformed();
  if (sessionId !== session) return null;
  const type = shortString(line.type, 64);
  if (!type) return malformed();
  const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  const out: TranscriptRecord = {
    ts: Number.isFinite(ts) ? ts : null,
    type,
    toolUseIds: [],
    toolResultIds: [],
    interruptionMarker: false
  };
  if (!CONVERSATIONAL.has(type)) return out;

  // A user or assistant record must be fully interpretable, or it is malformed.
  const message = line.message;
  if (out.ts === null || !isObject(message) || message.role !== type) return malformed();
  out.role = type as "user" | "assistant";
  if (message.stop_reason !== undefined && message.stop_reason !== null) {
    const stop = shortString(message.stop_reason, 64);
    if (!stop) return malformed();
    out.stopReason = stop;
  }
  const content = message.content;
  if (typeof content === "string") {
    out.interruptionMarker = type === "user" && content === INTERRUPTION_MARKER;
    return out;
  }
  if (!Array.isArray(content)) return malformed();
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== "string") return malformed();
    if (block.type === "tool_use") {
      const id = shortString(block.id, MAX_ID);
      if (!id) return malformed();
      out.toolUseIds.push(id);
    } else if (block.type === "tool_result") {
      const id = shortString(block.tool_use_id, MAX_ID);
      if (!id) return malformed();
      out.toolResultIds.push(id);
    } else if (block.type === "text" && type === "user" && block.text === INTERRUPTION_MARKER) {
      out.interruptionMarker = true;
    }
  }
  return out;
}

/** Reads the transcript tail for one session. Unreadable paths and the deadline refuse. */
export async function readTranscript(
  path: string,
  session: string,
  options: { deadline?: AbortSignal; io?: TranscriptIo } = {}
): Promise<TranscriptExtract> {
  const io = options.io ?? { lstat, open };
  const check = () => {
    if (options.deadline?.aborted) throw new TranscriptReadError("DEADLINE");
  };
  check();
  let bytes: Buffer;
  let truncated = false;
  try {
    // A regular file only: never a directory, link, pipe or device that could block.
    // lstat before open and stat after it narrow, but cannot close, the window in
    // which the path is swapped for a special file between the two calls; an open
    // that blocks there is stopped only by the CLI's hard stop.
    const info = await io.lstat(path);
    if (!info.isFile()) throw new TranscriptReadError("TRANSCRIPT_NOT_A_FILE");
    check();
    const handle = await io.open(path, "r");
    try {
      check();
      const opened = await handle.stat();
      if (!opened.isFile()) throw new TranscriptReadError("TRANSCRIPT_NOT_A_FILE");
      const { size } = opened;
      const length = Math.min(size, MAX_TAIL_BYTES);
      truncated = size > length;
      bytes = Buffer.alloc(length);
      check();
      const { bytesRead } = await handle.read(bytes, 0, length, size - length);
      bytes = bytes.subarray(0, bytesRead);
      check();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof TranscriptReadError) throw error;
    throw new TranscriptReadError("TRANSCRIPT_UNREADABLE");
  }
  let lines = bytes.toString("utf8").split("\n");
  // A window that starts mid-file starts mid-line; that partial line is dropped.
  if (truncated) lines = lines.slice(1);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_LINES) {
    truncated = true;
    lines = lines.slice(lines.length - MAX_LINES);
  }
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      records.push(malformed());
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      records.push(malformed());
      continue;
    }
    const r = record(parsed, session);
    if (r) records.push(r);
  }
  return { records, truncated };
}
