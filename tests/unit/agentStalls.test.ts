import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/agentStalls.ts (doc 15) as a subprocess against a loopback bridge. It only
// reads; its output is metadata only and never the token or any message or transcript
// text. Exit codes: 0 all observed-or-within, 4 any other state, 1 refusal, 2 usage.
const SENTINEL = "SENTINEL-c04a-do-not-leak";
const TOKEN = "token-91b2-secret";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function bridge(delayMs = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body =
      url.pathname === "/api/links"
        ? { result: [] }
        : {
            result: {
              message: {
                id: 2153,
                uid: "uid-2153",
                ts: 1791469587.09,
                sender: "codex-chatagent",
                to: "claude-chatagent",
                text: SENTINEL,
                ack_required: true,
                authenticated_principal: "codex-chatagent"
              },
              links: [],
              outcomes: [],
              events: [
                { id: 1, kind: "sent", ts: 1791469587.09, actor: "codex-chatagent", data: {} }
              ]
            }
          };
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }, delayMs);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const run = (args: string[], env: Record<string, string | undefined>) =>
  new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/agentStalls.ts", ...args],
      { env: { ...process.env, BRIDGE_URL: undefined, BRIDGE_TOKEN: undefined, ...env } },
      (error, stdout, stderr) =>
        resolve({ exit: error ? (error.code as number) : 0, stdout, stderr })
    );
  });

const base = ["--agent", "claude-chatagent", "--assignment", "2153"];

describe("agentStalls", () => {
  it.each([
    ["no agent", ["--assignment", "2153"]],
    ["no assignment", ["--agent", "claude-chatagent"]],
    ["a malformed assignment", ["--agent", "claude-chatagent", "--assignment", "21x"]],
    ["a repeated assignment", [...base, "--assignment", "2153"]],
    [
      "33 assignments",
      [
        "--agent",
        "claude-chatagent",
        ...Array.from({ length: 33 }, (_, i) => ["--assignment", String(i + 1)]).flat()
      ]
    ],
    ["a transcript without a session", [...base, "--transcript", "x.jsonl"]],
    ["a session without a transcript", [...base, "--session", "s-1"]],
    ["an out-of-range threshold", [...base, "--threshold-min", "0"]],
    ["an unknown flag", [...base, "--wake"]]
  ])("exits 2 for %s", async (_, args) => {
    const r = await run(args, {});
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/^usage: agentStalls/);
  });

  it("refuses a non-loopback URL and a missing token with code 1, naming only the code", async () => {
    const url = await bridge();
    expect(
      await run(base, { BRIDGE_URL: "http://example.com:8791", BRIDGE_TOKEN: TOKEN })
    ).toMatchObject({ exit: 1, stderr: "agentStalls: INVALID_URL\n" });
    expect(await run(base, { BRIDGE_URL: url })).toMatchObject({
      exit: 1,
      stderr: "agentStalls: MISSING_TOKEN\n"
    });
  });

  it("refuses an unreadable transcript and a passed deadline with code 1", async () => {
    const url = await bridge();
    expect(
      await run(
        [
          ...base,
          "--transcript",
          join(tmpdir(), "no-such-dir-77aa", "x.jsonl"),
          "--session",
          "s-1"
        ],
        { BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN }
      )
    ).toMatchObject({ exit: 1, stderr: "agentStalls: TRANSCRIPT_UNREADABLE\n" });
    const slow = await bridge(3000);
    expect(
      await run([...base, "--deadline-s", "1"], { BRIDGE_URL: slow, BRIDGE_TOKEN: TOKEN })
    ).toMatchObject({ exit: 1, stderr: "agentStalls: DEADLINE\n" });
  });

  it("reports metadata only: no token, no text and no liveness words, exiting 4 while nothing is established", async () => {
    const url = await bridge();
    const dir = await mkdtemp(join(tmpdir(), "stalls-"));
    dirs.push(dir);
    const transcript = join(dir, "t.jsonl");
    await writeFile(
      transcript,
      JSON.stringify({
        sessionId: "s-1",
        type: "user",
        message: { role: "user", content: SENTINEL }
      }) + "\n"
    );
    for (const extra of [[], ["--json"]]) {
      const r = await run([...base, "--transcript", transcript, "--session", "s-1", ...extra], {
        BRIDGE_URL: url,
        BRIDGE_TOKEN: TOKEN
      });
      expect(r.exit).toBe(4);
      expect(r.stderr).toBe("");
      for (const forbidden of [TOKEN, SENTINEL]) expect(r.stdout).not.toContain(forbidden);
      expect(r.stdout).not.toMatch(/\b(answered|alive|idle|stalled)\b/);
      expect(r.stdout).toContain("2153");
    }
  });
});
