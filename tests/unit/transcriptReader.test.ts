import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERRUPTION_MARKER,
  MAX_LINE_BYTES,
  MAX_LINES,
  MAX_TAIL_BYTES,
  TranscriptReadError,
  readTranscript
} from "../../src/integrations/bridge/transcriptReader";

// The transcript reader (doc 15) keeps metadata only. SENTINEL stands in for user text,
// assistant text, tool inputs and tool results; it must never appear in the extract.
const SENTINEL = "SENTINEL-8d21-do-not-leak";
const SESSION = "d8e91971-d796-45eb-8da3-f3058dcce173";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function file(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "transcript-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}
const line = (r: Record<string, unknown>) =>
  JSON.stringify({ sessionId: SESSION, cwd: SENTINEL, ...r });

describe("transcript reader", () => {
  it("keeps metadata only and never any text, tool input or result", async () => {
    const path = await file([
      line({
        type: "user",
        timestamp: "2026-10-08T06:00:00Z",
        message: { role: "user", content: `${SENTINEL} please` }
      }),
      line({
        type: "assistant",
        timestamp: "2026-10-08T06:01:00Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: SENTINEL },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: SENTINEL } }
          ]
        }
      }),
      line({
        type: "user",
        timestamp: "2026-10-08T06:01:30Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: SENTINEL }]
        }
      }),
      line({
        type: "user",
        timestamp: "2026-10-08T06:02:10Z",
        message: { role: "user", content: [{ type: "text", text: INTERRUPTION_MARKER }] }
      })
    ]);
    const out = await readTranscript(path, SESSION);
    expect(out).toEqual({
      truncated: false,
      records: [
        {
          ts: Date.parse("2026-10-08T06:00:00Z"),
          type: "user",
          role: "user",
          toolUseIds: [],
          toolResultIds: [],
          interruptionMarker: false
        },
        {
          ts: Date.parse("2026-10-08T06:01:00Z"),
          type: "assistant",
          role: "assistant",
          stopReason: "tool_use",
          toolUseIds: ["tu-1"],
          toolResultIds: [],
          interruptionMarker: false
        },
        {
          ts: Date.parse("2026-10-08T06:01:30Z"),
          type: "user",
          role: "user",
          toolUseIds: [],
          toolResultIds: ["tu-1"],
          interruptionMarker: false
        },
        {
          ts: Date.parse("2026-10-08T06:02:10Z"),
          type: "user",
          role: "user",
          toolUseIds: [],
          toolResultIds: [],
          interruptionMarker: true
        }
      ]
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("recognizes the marker only as the whole text of a user record", async () => {
    const path = await file([
      line({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: INTERRUPTION_MARKER }] }
      }),
      line({ type: "user", message: { role: "user", content: `${INTERRUPTION_MARKER} and more` } }),
      line({ type: "user", message: { role: "user", content: INTERRUPTION_MARKER } })
    ]);
    expect((await readTranscript(path, SESSION)).records.map((r) => r.interruptionMarker)).toEqual([
      false,
      false,
      true
    ]);
  });

  it("drops other sessions and turns oversized or non-object lines into placeholders", async () => {
    const path = await file([
      line({
        type: "user",
        sessionId: "other-session",
        message: { role: "user", content: SENTINEL }
      }),
      "{not json",
      "[1,2]",
      JSON.stringify({ sessionId: SESSION, type: "user", pad: "x".repeat(MAX_LINE_BYTES) }),
      line({ type: "queue-operation" })
    ]);
    const out = await readTranscript(path, SESSION);
    expect(out.records.map((r) => (r.malformed ? "malformed" : r.type))).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "queue-operation"
    ]);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("reads only the tail, dropping its partial first line and flagging the truncation", async () => {
    const filler = line({ type: "attachment", pad: "y".repeat(1000) });
    const lines = Array.from(
      { length: Math.ceil((MAX_TAIL_BYTES * 1.5) / filler.length) },
      () => filler
    );
    lines.push(
      line({
        type: "assistant",
        timestamp: "2026-10-08T07:00:00Z",
        message: { role: "assistant", stop_reason: "end_turn", content: [] }
      })
    );
    const out = await readTranscript(await file(lines), SESSION);
    expect(out.truncated).toBe(true);
    expect(out.records.some((r) => r.malformed)).toBe(false);
    expect(out.records.at(-1)).toMatchObject({ role: "assistant", stopReason: "end_turn" });
  });

  it("keeps at most the last MAX_LINES lines", async () => {
    const lines = Array.from({ length: MAX_LINES + 10 }, (_, i) =>
      line({ type: "attachment", n: i })
    );
    const out = await readTranscript(await file(lines), SESSION);
    expect(out.truncated).toBe(true);
    expect(out.records).toHaveLength(MAX_LINES);
  });

  it("refuses a path it cannot read", async () => {
    await expect(
      readTranscript(join(tmpdir(), "no-such-dir-1f2e", "x.jsonl"), SESSION)
    ).rejects.toBeInstanceOf(TranscriptReadError);
  });
});
