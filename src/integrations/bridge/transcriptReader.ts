import { open } from "node:fs/promises";
import type { TranscriptExtract, TranscriptRecord } from "./activity";

/**
 * Reads the tail of one Claude Code session transcript (doc 15) as metadata only.
 * Only the explicit path is read: its last MAX_TAIL_BYTES, at most MAX_LINES lines,
 * each at most MAX_LINE_BYTES. Each JSON line keeps its timestamp, type, session id,
 * message role and stop reason, the kinds and ids of tool-use and tool-result blocks,
 * and whether a user text block is the interruption marker. Text, tool inputs and
 * results, paths and every other field are dropped as the line is parsed. An oversized
 * or non-object line becomes a `malformed` placeholder; records of other sessions are
 * dropped.
 */

export const MAX_TAIL_BYTES = 1024 * 1024;
export const MAX_LINES = 4000;
export const MAX_LINE_BYTES = 256 * 1024;
export const INTERRUPTION_MARKER = "[Request interrupted by user for tool use]";
const MAX_ID = 128;

/** The explicit transcript could not be read at all. */
export class TranscriptReadError extends Error {
  constructor() {
    super("TRANSCRIPT_UNREADABLE");
    this.name = "TranscriptReadError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MALFORMED: TranscriptRecord = {
  ts: null,
  type: "malformed",
  toolUseIds: [],
  toolResultIds: [],
  interruptionMarker: false,
  malformed: true
};

const shortString = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

/** The metadata of one parsed line, or null when it belongs to another session. */
function record(line: unknown, session: string): TranscriptRecord | null {
  if (!isObject(line)) return { ...MALFORMED };
  if (line.sessionId !== session) return null;
  const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  const out: TranscriptRecord = {
    ts: Number.isFinite(ts) ? ts : null,
    type: shortString(line.type, 64) ?? "unknown",
    toolUseIds: [],
    toolResultIds: [],
    interruptionMarker: false
  };
  const message = line.message;
  if (!isObject(message)) return out;
  if (message.role === "user" || message.role === "assistant") out.role = message.role;
  const stop = shortString(message.stop_reason, 64);
  if (stop) out.stopReason = stop;
  const content = message.content;
  if (typeof content === "string") {
    out.interruptionMarker = out.role === "user" && content === INTERRUPTION_MARKER;
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_use") {
      const id = shortString(block.id, MAX_ID);
      if (id) out.toolUseIds.push(id);
    } else if (block.type === "tool_result") {
      const id = shortString(block.tool_use_id, MAX_ID);
      if (id) out.toolResultIds.push(id);
    } else if (block.type === "text" && out.role === "user" && block.text === INTERRUPTION_MARKER) {
      out.interruptionMarker = true;
    }
  }
  return out;
}

/** Reads the transcript tail for one session. Unreadable paths refuse. */
export async function readTranscript(path: string, session: string): Promise<TranscriptExtract> {
  let bytes: Buffer;
  let truncated = false;
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_TAIL_BYTES);
      truncated = size > length;
      bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, size - length);
    } finally {
      await handle.close();
    }
  } catch {
    throw new TranscriptReadError();
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
      records.push({ ...MALFORMED });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      records.push({ ...MALFORMED });
      continue;
    }
    const r = record(parsed, session);
    if (r) records.push(r);
  }
  return { records, truncated };
}
