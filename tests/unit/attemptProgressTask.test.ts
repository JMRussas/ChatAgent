import { describe, expect, it } from "vitest";
import {
  projectPublicActivity,
  ATTEMPT_PROGRESS_LIMITS
} from "../../src/integrations/hekate/attemptProgress";
import { claude, traceRecords, SECRETS } from "../helpers/attemptProgressFixtures";
describe("native public attempt activity contract", () => {
  it("preserves the public activity limits", () => {
    expect(ATTEMPT_PROGRESS_LIMITS.maxItems).toBe(20);
    expect(ATTEMPT_PROGRESS_LIMITS.maxBlocksPerRecord).toBe(50);
  });
  it("shows public assistant text and fixed tool names without private envelopes", () => {
    const records = traceRecords([
      {
        text: claude.assistant([
          { type: "thinking", thinking: SECRETS.thinking },
          claude.text("Public step."),
          claude.tool("Read")
        ])
      },
      {
        text: JSON.stringify({
          type: "assistant",
          message: { role: "user", content: [claude.text(SECRETS.user)] }
        })
      },
      { text: claude.assistant([claude.tool(SECRETS.toolName)]) },
      { text: claude.assistant([claude.text(SECRETS.cut)]), cut: true },
      { stream: "stderr", text: SECRETS.stderr }
    ]);
    const observed = projectPublicActivity(records, true);
    expect(observed.items).toEqual([
      { traceSeq: 0, index: 1, kind: "text", text: "Public step.", textClipped: false },
      { traceSeq: 0, index: 2, kind: "tool_use", tool: "Read" }
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/SECRET_/);
    expect(observed.complete).toBe(false);
    expect(observed.counts).toMatchObject({
      stdoutRecords: 4,
      assistantRecords: 2,
      otherRecords: 1,
      unavailableRecords: 1,
      withheldItems: 1
    });
  });
  it("bounds newest public items and reports content-inspection limits honestly", () => {
    const observed = projectPublicActivity(
      traceRecords(
        Array.from({ length: 30 }, (_, i) => ({
          text: claude.assistant([claude.text("step " + i)])
        }))
      ),
      true
    );
    expect(observed.items).toHaveLength(20);
    expect(observed.items[0]).toMatchObject({ traceSeq: 10, text: "step 10" });
    expect(observed).toMatchObject({ totalItems: 30, omittedItems: 10 });
    const capped = projectPublicActivity(
      traceRecords([
        { text: claude.assistant(Array.from({ length: 80 }, () => claude.text("item"))) }
      ]),
      true
    );
    expect(capped.totalItems).toBe(50);
    expect(capped.complete).toBe(false);
  });
});
