import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { BriefingCoordinator } from "../../src/sports/briefingCoordinator";
import { BriefingHttp } from "../../src/sports/briefingHttp";
import { defaultNbaProfile } from "../../src/sports/briefingConfig";
import { FixtureSportsSource } from "../../src/sports/sources";
import { DocumentTaskError, type DocumentTasks } from "../../src/app/documentTasks";
import {
  ownerBelongsToPrincipal,
  scopedOwnerKey,
  type Authenticator,
  type Principal
} from "../../src/auth/authenticator";
import games from "../../data/sports/games.fixture.json";

// Two principals over real HTTP. Local mode has one principal; this is the seam a
// second principal type (for example a shared login) would use.
const PRINCIPALS: Record<string, Principal> = {
  "Bearer A": { principalId: "local:A", roles: new Set(["client"]), via: "bearer" },
  "Bearer B": { principalId: "local:B", roles: new Set(["client"]), via: "bearer" },
  "Bearer OPERATOR": {
    principalId: "local:A",
    roles: new Set(["client", "operator"]),
    via: "bearer"
  }
};
const twoPrincipals: Authenticator = {
  resolve: ({ authorization }) => (authorization ? PRINCIPALS[authorization] : undefined)
};
const A = { authorization: "Bearer A" },
  B = { authorization: "Bearer B" },
  OPERATOR = { authorization: "Bearer OPERATOR" };

/** In-memory stand-in with the real sidecar's owner rule (chat_bridge.py scope()). */
function sidecar(legacyOwners: Record<string, string> = {}) {
  const owners = new Map(Object.entries(legacyOwners));
  const seen: Record<string, unknown>[] = [];
  const tasks: DocumentTasks = {
    request: async (data) => {
      seen.push(data);
      const conversation = data.conversationId as string,
        user = data.userId as string;
      if (!(
        conversation?.length > 0 &&
        conversation.length <= 200 &&
        user?.length > 0 &&
        user.length <= 200
      ))
        throw new DocumentTaskError("INVALID_SCOPE");
      const owner = owners.get(conversation);
      if (owner === undefined) {
        if (data.op === "start") owners.set(conversation, user);
      } else if (owner !== user) throw new DocumentTaskError("OWNER_MISMATCH");
      return data.op === "list" ? [] : { taskId: "t", status: "queued" };
    },
    close: () => undefined
  };
  return { tasks, seen, owners };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

async function start(legacyOwners: Record<string, string> = {}) {
  let skewMs = 0;
  const timeline = new InMemoryConversationTimelineStore(
      undefined,
      undefined,
      () => Date.now() + skewMs
    ),
    queue = new InMemoryTaskQueue();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const coordinator = new BriefingCoordinator(
    new Map([["games", { read: async (query) => new FixtureSportsSource(games).read(query) }]]),
    { maxConcurrentTasks: 1, taskTimeoutMs: 3000, maxRuns: 4 }
  );
  const docs = sidecar(legacyOwners);
  // One source per task, as the briefing suite configures the fixture source.
  const profile = defaultNbaProfile();
  profile.tasks.forEach((task) => {
    task.sources = [task.sources[0]];
  });
  const server = createChatServer(service, {
    auth: twoPrincipals,
    briefings: new BriefingHttp(coordinator, profile),
    documentTasks: docs.tasks
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    coordinator.close();
  });
  const post = async (path: string, body: unknown, who: Record<string, string>) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...who },
      body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (path: string, who: Record<string, string>) => {
    const r = await fetch(base + path, { headers: who });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const message = (conversationId: string, userId = "u", text = "Hello") => ({
    conversationId,
    userId,
    messageId: randomUUID(),
    text
  });
  /** Opens a legacy event stream and collects its text until the stream ends. */
  const stream = async (conversationId: string, who: Record<string, string>) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/conversations/${conversationId}/events/stream`, {
      headers: who,
      signal: controller.signal
    });
    cleanups.push(async () => controller.abort());
    let text = "",
      ended = false;
    if (response.ok)
      void (async () => {
        const reader = response.body!.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += Buffer.from(chunk.value).toString();
          }
        } catch {
          /* aborted */
        }
        ended = true;
      })();
    return { status: response.status, text: () => text, ended: () => ended };
  };
  return {
    base,
    service,
    timeline,
    docs,
    post,
    get,
    message,
    stream,
    expireAll: () => (skewMs += 3 * 86400000)
  };
}

describe("owner keys", () => {
  it("are fixed-length, principal-scoped and checkable without a map", () => {
    const owner = scopedOwnerKey("local:A", ["u"]);
    expect(owner).toMatch(/^o1:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/);
    expect(owner).toHaveLength(90);
    expect(scopedOwnerKey("local:B", ["u"])).not.toBe(owner);
    expect(scopedOwnerKey("local:A", ["u", ""])).not.toBe(owner);
    expect(ownerBelongsToPrincipal(owner, "local:A")).toBe(true);
    expect(ownerBelongsToPrincipal(owner, "local:B")).toBe(false);
    for (const bad of [undefined, "u", owner.slice(0, -1), `o2:${owner.slice(3)}`, owner + "x"])
      expect(ownerBelongsToPrincipal(bad, "local:A")).toBe(false);
    for (const label of ["é".repeat(200), 'quote" and \\ slash', "a:b\0c"])
      expect(scopedOwnerKey("local:A", [label])).toHaveLength(90);
    // Distinct unpaired surrogates, and a surrogate versus the replacement character
    // it would become in UTF-8, stay distinct principals.
    const lone = [
      scopedOwnerKey("\ud800", ["u"]),
      scopedOwnerKey("\ud801", ["u"]),
      scopedOwnerKey("�", ["u"])
    ];
    expect(new Set(lone).size).toBe(3);
    expect(ownerBelongsToPrincipal(lone[0], "\ud801")).toBe(false);
    expect(ownerBelongsToPrincipal(lone[0], "�")).toBe(false);
  });
});

describe("conversations are per principal", () => {
  it("keeps A's conversation from B with the same label: read, stream, cancel, post and context", async () => {
    const h = await start();
    expect((await h.post("/messages", h.message("c"), A)).status).toBe(200);
    expect(h.service.conversationOwner("c")).toBe(scopedOwnerKey("local:A", ["u"]));
    expect((await h.get("/conversations/c/events", A)).status).toBe(200);
    expect((await h.get("/conversations/c/events", B)).body).toMatchObject({
      code: "CONVERSATION_NOT_FOUND"
    });
    expect((await h.stream("c", B)).status).toBe(404);
    expect(
      (await h.post(`/conversations/c/messages/${randomUUID()}/cancel`, {}, B)).body
    ).toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    expect((await h.post("/messages", h.message("c"), B)).body).toMatchObject({
      code: "CONVERSATION_OWNER_MISMATCH"
    });
    for (const path of ["/conversation-context", "/conversation-context/detach"])
      expect((await h.post(path, { conversationId: "c", userId: "u" }, B)).status).toBe(409);
  });

  it("lets a principal subscribe before its first message and keeps that stream", async () => {
    const h = await start();
    const own = await h.stream("early", A);
    expect(own.status).toBe(200);
    expect(
      (await h.post("/messages", h.message("early", "u", "own first message"), A)).status
    ).toBe(200);
    await vi.waitFor(() => expect(own.text()).toContain("own first message"), { timeout: 3000 });
    expect(own.ended()).toBe(false);
  });

  it("ends another principal's early stream when the conversation is claimed, before any write", async () => {
    const h = await start();
    const foreign = await h.stream("race", B);
    expect(foreign.status).toBe(200);
    await vi.waitFor(() => expect(foreign.text()).toContain("event: timeline"));
    expect((await h.post("/messages", h.message("race", "u", "A's secret"), A)).status).toBe(200);
    await vi.waitFor(() => expect(foreign.ended()).toBe(true), { timeout: 3000 });
    expect(foreign.text()).not.toContain("A's secret");
  });

  it("checks a claim that lands while a stream's read is pending, before writing", async () => {
    const h = await start();
    const foreign = await h.stream("pending", B);
    await vi.waitFor(() => expect(foreign.text()).toContain("event: timeline"));
    const original = h.service.getTimeline.bind(h.service);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    vi.spyOn(h.service, "getTimeline").mockImplementation(async (id) => {
      if (id === "pending" && !holding) {
        holding = true;
        await held;
      }
      return original(id);
    });
    await vi.waitFor(() => expect(holding).toBe(true));
    // A claims and writes while B's read is in flight.
    await h.service.submitMessage({
      ...h.message("pending", "u", "claimed mid-read"),
      userId: scopedOwnerKey("local:A", ["u"]),
      timestampIso: new Date().toISOString()
    });
    release();
    await vi.waitFor(() => expect(foreign.ended()).toBe(true), { timeout: 3000 });
    expect(foreign.text()).not.toContain("claimed mid-read");
  });

  it("never shows events of a conversation nobody claimed", async () => {
    const h = await start();
    await h.timeline.appendEvent("orphan", {
      type: "user",
      text: "orphaned",
      messageId: randomUUID(),
      createdAtIso: new Date().toISOString()
    } as never);
    for (const who of [A, B, OPERATOR]) {
      expect((await h.get("/conversations/orphan/events", who)).status).toBe(404);
      expect((await h.stream("orphan", who)).status).toBe(404);
    }
    // An empty unclaimed conversation reads as empty, and has nothing to cancel.
    expect((await h.get("/conversations/empty/events", A)).body).toEqual({ events: [] });
    expect(
      (await h.post(`/conversations/empty/messages/${randomUUID()}/cancel`, {}, A)).status
    ).toBe(404);
  });

  it("the operator role grants no extra reach on client routes, only on operator routes", async () => {
    const h = await start();
    expect((await h.post("/messages", h.message("b-conv"), B)).status).toBe(200);
    // OPERATOR is principal A: B's conversation is still not readable on client routes.
    expect((await h.get("/conversations/b-conv/events", OPERATOR)).status).toBe(404);
    // Operator routes are installation-wide: retirement sees B's conversation (in use).
    const retire = await fetch(`${h.base}/conversations/b-conv/identity`, {
      method: "DELETE",
      headers: OPERATOR
    });
    expect(retire.status).toBe(409);
    expect((await retire.json()).blockers).toContain("HISTORY_LIVE");
  });
});

describe("protocol v1 is per principal", () => {
  it("separates the same account, project and conversation under two principals", async () => {
    const h = await start();
    const wire = randomUUID();
    const submit = (who: Record<string, string>, text: string) =>
      h.post(
        `/v1/conversations/${wire}/messages`,
        {
          protocolVersion: "1.0",
          accountId: "acct",
          projectId: "proj",
          messageId: randomUUID(),
          text,
          clientTimestampIso: new Date().toISOString()
        },
        who
      );
    expect((await submit(A, "A's v1 secret")).status).toBe(200);
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());
    const bStream = await fetch(
      `${h.base}/v1/conversations/${wire}/events/stream?accountId=acct&projectId=proj`,
      { headers: B, signal: controller.signal }
    );
    expect(bStream.status).toBe(200);
    const reader = bStream.body!.getReader();
    const first = Buffer.from((await reader.read()).value!).toString();
    await new Promise((r) => setTimeout(r, 300));
    expect(first).toContain("event: ready");
    expect(first).not.toContain("A's v1 secret");
    expect(
      (
        await h.post(
          `/v1/conversations/${wire}/messages/${randomUUID()}/cancel?accountId=acct&projectId=proj`,
          {},
          B
        )
      ).body
    ).toEqual({ code: "MESSAGE_NOT_FOUND" });
    // B's own submission is a separate conversation with its own owner.
    expect((await submit(B, "B's v1 message")).status).toBe(200);
  });
});

describe("briefings and document tasks are per principal", () => {
  it("hides A's briefing run from B with the same label", async () => {
    const h = await start();
    const run = await h.post(
      "/briefings",
      {
        op: "start",
        userId: "u",
        requestId: "r1",
        request: { now: games.capturedAt, timezone: "UTC", team: games.supportedTeams[0] }
      },
      A
    );
    expect(run.status).toBe(202);
    expect(
      (await h.post("/briefings", { op: "status", userId: "u", runId: run.body.id }, A)).status
    ).toBe(200);
    expect(
      (await h.post("/briefings", { op: "status", userId: "u", runId: run.body.id }, B)).status
    ).toBe(404);
  });

  it("sends the sidecar principal-scoped owners and keeps legacy rows unreachable", async () => {
    const h = await start({ legacy: "u" });
    const task = (conversationId: string, who: Record<string, string>) =>
      h.post(
        "/document-tasks",
        { op: "start", conversationId, userId: "u", requestId: randomUUID(), question: "Q" },
        who
      );
    expect((await task("docs", A)).status).toBe(202);
    const sent = h.docs.seen.at(-1)!.userId as string;
    expect(sent).toBe(scopedOwnerKey("local:A", ["u"]));
    expect(sent.length).toBeLessThanOrEqual(200);
    // B with the same label is another owner: refused by the in-memory claim first.
    expect((await task("docs", B)).status).toBe(409);
    // A legacy durable row keyed by the plain label is preserved and unreachable.
    const legacy = await h.post(
      "/document-tasks",
      { op: "list", conversationId: "legacy", userId: "u" },
      A
    );
    expect(legacy.status).toBe(409);
    expect(legacy.body).toMatchObject({ code: "OWNER_MISMATCH" });
    expect(h.docs.owners.get("legacy")).toBe("u");
  });

  it("keeps retirement fail-closed for a conversation whose durable tasks have a legacy owner", async () => {
    const h = await start({ old: "u" });
    // A new principal-scoped owner claims the conversation in memory.
    expect((await h.post("/messages", h.message("old"), A)).status).toBe(200);
    h.expireAll();
    const retire = await fetch(`${h.base}/conversations/old/identity`, {
      method: "DELETE",
      headers: OPERATOR
    });
    expect(retire.status).toBe(409);
    expect((await retire.json()).blockers).toContain("DOCUMENT_TASKS_UNKNOWN");
    expect(h.docs.owners.get("old")).toBe("u");
  });
});

describe("labels follow each route's own contract before becoming owners", () => {
  it("rejects invalid labels exactly as before and scopes valid ones of any accepted length", async () => {
    const h = await start();
    // /messages accepts any non-empty label; a long one is still scoped, never raw.
    const long = "x".repeat(300);
    expect((await h.post("/messages", h.message("long", long), A)).status).toBe(200);
    expect(h.service.conversationOwner("long")).toBe(scopedOwnerKey("local:A", [long]));
    expect((await h.post("/messages", h.message("long", long), B)).body).toMatchObject({
      code: "CONVERSATION_OWNER_MISMATCH"
    });
    for (const userId of ["", 7, null])
      expect((await h.post("/messages", { ...h.message("bad"), userId }, A)).status).toBe(400);
    // Routes limited to 200 characters still refuse 201.
    expect(
      (await h.post("/conversation-context", { conversationId: "c2", userId: "y".repeat(201) }, A))
        .status
    ).toBe(400);
    expect(
      (await h.post("/conversation-context", { conversationId: "c2", userId: "é".repeat(200) }, A))
        .status
    ).toBe(200);
    // Briefings trim: a blank label is refused, not turned into a valid owner.
    for (const userId of ["   ", "", "z".repeat(201)])
      expect(
        (
          await h.post(
            "/briefings",
            {
              op: "start",
              userId,
              requestId: "r",
              request: { now: games.capturedAt, timezone: "UTC" }
            },
            A
          )
        ).status
      ).toBe(400);
    expect(h.service.conversationOwner("bad")).toBeUndefined();
  });
});
