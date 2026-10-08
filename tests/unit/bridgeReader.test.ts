import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeReadError,
  MAX_RECORDS,
  MAX_REPLY_READS,
  bridgeApiBase,
  readAssignments
} from "../../src/integrations/bridge/bridgeReader";

// The bridge reader (doc 15) against a loopback server shaped like agent-bridge's
// /api/evidence and /api/links. Every response embeds SENTINEL text where the real
// bridge carries message text, outcome details and references; none may survive.
const SENTINEL = "SENTINEL-3f9a-do-not-leak";
const TOKEN = "token-7c1e-secret";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

type Handler = (
  req: IncomingMessage,
  url: URL
) => {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
};
async function serve(handler: Handler) {
  const seen: { url: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    const r = handler(req, url);
    const send = () => {
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const message = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  uid: `uid-${id}`,
  ts: 1791469587.09,
  sender: "codex-chatagent",
  to: "claude-chatagent",
  thread: "t",
  text: `${SENTINEL} body`,
  meta: { note: SENTINEL },
  ack_required: true,
  authenticated_principal: "codex-chatagent",
  ...extra
});
const evidence = (id: number, extra: Record<string, unknown> = {}) => ({
  result: {
    message: message(id),
    links: [],
    outcomes: [
      {
        id: "o1",
        message_id: `uid-${id}`,
        kind: "completed",
        artifact_ref: SENTINEL,
        evidence_refs: [SENTINEL],
        details: { note: SENTINEL, role: "claude-chatagent", session: "s-1" },
        actor: "claude-chatagent",
        ts: 1791470000
      }
    ],
    events: [
      { id: 1, kind: "sent", ts: 1791469587.09, actor: "codex-chatagent", data: { x: SENTINEL } },
      { id: 2, kind: "offered", ts: 1791470427.54, actor: "fenrir", data: {} }
    ],
    ...extra
  }
});
const reply = (uid: string, principal: string, meta: Record<string, unknown> = {}) => ({
  result: {
    message: message(900, {
      uid,
      sender: principal,
      authenticated_principal: principal,
      meta: { ...meta, note: SENTINEL }
    }),
    links: [],
    outcomes: [],
    events: []
  }
});

/** A bridge with assignment 2153 and one replies_to link from a claude-chatagent message. */
function bridge(
  overrides: Partial<Record<"evidence" | "links" | "reply", ReturnType<Handler>>> = {}
): Handler {
  return (_req, url) => {
    if (url.pathname === "/api/evidence" && url.searchParams.get("message_id") === "2153")
      return overrides.evidence ?? { body: evidence(2153) };
    if (url.pathname === "/api/links")
      return (
        overrides.links ?? {
          body: {
            result: [
              {
                id: "l1",
                message_id: "uid-r1",
                relation: "replies_to",
                target_type: "message",
                target_ref: "uid-2153",
                inferred: false,
                actor: "claude-chatagent",
                ts: 1791470100
              },
              {
                id: "l2",
                message_id: "uid-r2",
                relation: "supports",
                target_type: "message",
                target_ref: "uid-2153",
                inferred: false,
                actor: "claude-chatagent",
                ts: 1791470200
              }
            ]
          }
        }
      );
    if (url.pathname === "/api/evidence" && url.searchParams.get("message_id") === "uid-r1")
      return (
        overrides.reply ?? {
          body: reply("uid-r1", "claude-chatagent", { role: "claude-chatagent", session: "s-1" })
        }
      );
    return { status: 404, body: { error: "unknown" } };
  };
}

describe("bridge reader endpoint", () => {
  it.each([
    ["a name, not a literal address", "http://localhost:8791"],
    ["a non-loopback address", "http://10.0.0.5:8791"],
    ["https", "https://127.0.0.1:8791"],
    ["credentials in the URL", "http://user:pass@127.0.0.1:8791"],
    ["a query", "http://127.0.0.1:8791/?token=x"],
    ["a path", "http://127.0.0.1:8791/api"],
    ["nothing", undefined]
  ])("refuses %s", (_, url) => {
    expect(() => bridgeApiBase(url)).toThrow(BridgeReadError);
  });

  it("refuses a missing token and bad assignment lists before any request", async () => {
    const { url, seen } = await serve(bridge());
    await expect(readAssignments(url, undefined, ["2153"])).rejects.toMatchObject({
      code: "MISSING_TOKEN"
    });
    for (const ids of [
      [],
      ["0"],
      ["12a"],
      ["2153", "2153"],
      Array.from({ length: 33 }, (_, i) => String(i + 1))
    ])
      await expect(readAssignments(url, TOKEN, ids)).rejects.toMatchObject({
        code: "INVALID_ASSIGNMENT"
      });
    expect(seen).toEqual([]);
  });

  it("sends the token only as the Authorization header, never in a URL", async () => {
    const { url, seen } = await serve(bridge());
    await readAssignments(url, TOKEN, ["2153"]);
    expect(seen.length).toBe(3);
    for (const s of seen) {
      expect(s.authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
    }
  });

  it("does not follow a redirect, so the token never reaches its target", async () => {
    const target = await serve(() => ({ body: evidence(2153) }));
    const { url } = await serve(() => ({
      status: 302,
      headers: { location: `${target.url}/api/evidence?message_id=2153` }
    }));
    const [a] = await readAssignments(url, TOKEN, ["2153"]);
    expect(a.incomplete).toBe("UNAVAILABLE");
    expect(target.seen).toEqual([]);
  });
});

describe("bridge reader output", () => {
  it("keeps allowlisted metadata only, including the linking message's principal and declared session", async () => {
    const { url } = await serve(bridge());
    const [a] = await readAssignments(url, TOKEN, ["2153"]);
    expect(a).toEqual({
      id: "2153",
      uid: "uid-2153",
      ts: 1791469587.09,
      to: "claude-chatagent",
      sender: "codex-chatagent",
      principal: "codex-chatagent",
      ackRequired: true,
      events: [
        { kind: "sent", ts: 1791469587.09 },
        { kind: "offered", ts: 1791470427.54 }
      ],
      outcomes: [
        {
          kind: "completed",
          actor: "claude-chatagent",
          ts: 1791470000,
          role: "claude-chatagent",
          session: "s-1"
        }
      ],
      links: [
        {
          relation: "replies_to",
          actor: "claude-chatagent",
          ts: 1791470100,
          from: {
            uid: "uid-r1",
            sender: "claude-chatagent",
            principal: "claude-chatagent",
            role: "claude-chatagent",
            session: "s-1"
          }
        },
        // Only replies_to links have their linking message read.
        { relation: "supports", actor: "claude-chatagent", ts: 1791470200, from: null }
      ]
    });
    expect(JSON.stringify(a)).not.toContain(SENTINEL);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  it.each([
    ["a missing assignment", { evidence: { status: 404, body: {} } }, "NOT_FOUND"],
    ["a refused assignment", { evidence: { status: 403, body: {} } }, "FORBIDDEN"],
    ["a server error", { evidence: { status: 500, body: {} } }, "HTTP_ERROR"],
    ["malformed JSON", { evidence: { raw: "{not json" } }, "INVALID_RESPONSE"],
    [
      "a response without its result",
      { evidence: { body: { message: message(2153) } } },
      "INVALID_RESPONSE"
    ],
    [
      "a non-numeric timestamp",
      { evidence: { body: evidence(2153, { events: [{ kind: "sent", ts: "late" }] }) } },
      "INVALID_RESPONSE"
    ],
    [
      "too many events",
      {
        evidence: {
          body: evidence(2153, {
            events: Array.from({ length: MAX_RECORDS + 1 }, () => ({ kind: "offered", ts: 1 }))
          })
        }
      },
      "OVER_CAP"
    ],
    [
      "too many replies to read",
      {
        links: {
          body: {
            result: Array.from({ length: MAX_REPLY_READS + 1 }, (_, i) => ({
              message_id: `uid-x${i}`,
              relation: "replies_to",
              actor: "claude-chatagent",
              ts: 1
            }))
          }
        }
      },
      "OVER_CAP"
    ],
    ["an unreadable linking message", { reply: { status: 403, body: {} } }, "FORBIDDEN"]
  ])("marks %s incomplete, never as no reply", async (_, overrides, reason) => {
    const { url } = await serve(bridge(overrides as Parameters<typeof bridge>[0]));
    const [a] = await readAssignments(url, TOKEN, ["2153"]);
    expect(a).toMatchObject({
      id: "2153",
      incomplete: reason,
      events: [],
      outcomes: [],
      links: []
    });
  });

  it("caps a response body while reading it", async () => {
    const { url } = await serve(
      bridge({ evidence: { raw: JSON.stringify({ result: { pad: "x".repeat(4096) } }) } })
    );
    const [a] = await readAssignments(url, TOKEN, ["2153"], { maxBytes: 1024 });
    expect(a.incomplete).toBe("TOO_LARGE");
  });

  it("marks a slow request incomplete and keeps reading the other assignments", async () => {
    const { url } = await serve((req, u) =>
      u.searchParams.get("message_id") === "2153"
        ? { body: evidence(2153), delayMs: 2000 }
        : bridge()(req, u)
    );
    const out = await readAssignments(url, TOKEN, ["2153", "2154"], { timeoutMs: 200 });
    expect(out.map((a) => [a.id, a.incomplete])).toEqual([
      ["2153", "TIMEOUT"],
      ["2154", "NOT_FOUND"]
    ]);
  });

  it("refuses the whole read when the run deadline passes", async () => {
    const { url } = await serve(() => ({ body: evidence(2153), delayMs: 2000 }));
    await expect(readAssignments(url, TOKEN, ["2153"], { deadlineMs: 200 })).rejects.toMatchObject({
      code: "DEADLINE"
    });
  });
});
