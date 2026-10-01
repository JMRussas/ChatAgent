import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("ADR protocol fixture type-checks against its declared wire interfaces", () => {
  const doc = readFileSync("docs/adr/0001-chat-runtime-ownership.md", "utf8");
  const proposal = doc.slice(doc.indexOf("## Protocol v1 proposal"));
  const interfaces = proposal.match(/```ts\n([\s\S]*?)```/)![1];
  const fixture = proposal.match(/```json\n([\s\S]*?)```/)![1];
  const parsed = JSON.parse(fixture);
  expect(parsed.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3, 4]);
  for (const event of parsed.events) {
    expect(event.conversationId).toBe(parsed.conversationId);
    expect(event.messageId).toBe(parsed.request.messageId);
  }
  const directory = mkdtempSync(join(tmpdir(), "chatruntime-protocol-"));
  try {
    const path = join(directory, "fixture.ts");
    // Compile the actual documentation, so interface and example drift fails CI.
    writeFileSync(
      path,
      `${interfaces}\nconst fixture = ${fixture.trim()} satisfies {
      conversationId: string; request: SubmitTurnRequest;
      response: SubmitTurnResponse; events: TurnEvent[];
    };`
    );
    const program = ts.createProgram([path], {
      noEmit: true,
      strict: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(errors).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
