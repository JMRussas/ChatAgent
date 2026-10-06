import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { InMemoryDeadLetterStore } from "../../src/app/deadLetterStore";
import type { DocumentTasks } from "../../src/app/documentTasks";
import { generationLifecycle } from "../../src/app/generationLifecycle";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ToolResultStore } from "../../src/app/toolResult";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import type { DeepTask } from "../../src/domain/types";
import { GenerationError } from "../../src/domain/generation";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { allowAllTestAuth } from "../helpers/testAuth";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});
function setup(overrides = {}) {
  let now = 0;
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({
      maxIdentities: 4,
      maxHistories: 2,
      idleTtlMs: 10,
      ...overrides
    }),
    () => now
  );
  const queue = new InMemoryTaskQueue(),
    dead = new InMemoryDeadLetterStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline, 2, dead),
    timeline,
    queue,
    dead
  );
  const message = (id = "m", conversationId = "c", userId = "u") => ({
    messageId: id,
    conversationId,
    userId,
    text: "Hello",
    timestampIso: new Date().toISOString()
  });
  const expire = async (conversationId = "c") => {
    await service.submitMessage(message("m", conversationId));
    now += 10;
    expect(timeline.conversationState(conversationId)).toBe("expired");
  };
  return {
    timeline,
    queue,
    dead,
    service,
    message,
    expire,
    advance: (n: number) => {
      now += n;
    }
  };
}
const task = (conversationId = "c"): DeepTask => ({
  taskId: "task",
  conversationId,
  messageId: "m",
  normalizedPrompt: "q",
  createdAtIso: new Date().toISOString()
});
async function listen(
  r: ReturnType<typeof setup>,
  options: Omit<Parameters<typeof createChatServer>[1], "auth">
) {
  const server = createChatServer(r.service, { auth: allowAllTestAuth, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

it("releases an expired identity slot together with its owner and execution records", async () => {
  const r = setup({ maxIdentities: 2, maxHistories: 1 });
  await r.service.submitMessage(r.message("m", "old"));
  await r.service.submitMessage(r.message("m", "kept"));
  await expect(r.service.submitMessage(r.message("m", "extra"))).rejects.toMatchObject({
    code: "CONVERSATION_CAPACITY"
  });
  const lifecycle = generationLifecycle(r.queue);
  expect(lifecycle.retentionStats().retained).toBe(2);

  await expect(r.service.retireConversation("old")).resolves.toEqual({ status: "retired" });

  expect(r.timeline.retentionStats()).toMatchObject({ identities: 1, histories: 1, expired: 0 });
  expect(r.service.conversationRetentionStats().owners).toBe(1);
  expect(lifecycle.retentionStats()).toMatchObject({ retained: 1, claimed: 1, turns: 1 });
  expect(r.timeline.conversationState("kept")).toBe("live");
  await expect(r.service.submitMessage(r.message("m", "extra"))).resolves.toBeDefined();
});

it("makes a retired ID unknown: another user may claim it and old message IDs are not deduplicated", async () => {
  const r = setup();
  await r.expire();
  await expect(r.service.submitMessage(r.message("m", "c", "other"))).rejects.toMatchObject({
    code: "CONVERSATION_OWNER_MISMATCH"
  });
  await r.service.retireConversation("c");
  await expect(r.service.submitMessage(r.message("m", "c", "other"))).resolves.toBeDefined();
  expect((await r.timeline.getEvents("c")).filter((e) => e.type === "user")).toHaveLength(1);
  await expect(r.service.submitMessage(r.message("next", "c", "u"))).rejects.toMatchObject({
    code: "CONVERSATION_OWNER_MISMATCH"
  });
});

it("refuses live and unknown conversations without touching them", async () => {
  const r = setup();
  await r.service.submitMessage(r.message());
  const before = await r.timeline.getEvents("c");
  await expect(r.service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["HISTORY_LIVE"]
  });
  await expect(r.service.retireConversation("missing")).resolves.toEqual({ status: "not_found" });
  expect(await r.timeline.getEvents("c")).toEqual(before);
  expect(r.service.conversationRetentionStats().owners).toBe(1);
  expect(() => r.service.claimConversation("c", "intruder", false)).toThrow();
});

it("keeps the identity while a dead letter could still be replayed into it", async () => {
  const r = setup();
  await r.expire();
  await r.dead.add({ task: task(), errorMessage: "failed", failedAtIso: new Date().toISOString() });
  await expect(r.service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["DEAD_LETTERS"]
  });
  // Uncertain work is never discarded on the operator's behalf.
  expect(await r.dead.list()).toHaveLength(1);
  expect(r.timeline.conversationState("c")).toBe("expired");
  await expect(r.service.replayDeadLetter("task")).rejects.toMatchObject({
    code: "CONVERSATION_EXPIRED"
  });
  await expect(r.service.retireConversation("c")).resolves.toMatchObject({ status: "blocked" });
  await r.service.discardDeadLetter("task");
  await expect(r.service.retireConversation("c")).resolves.toEqual({ status: "retired" });
});

it("counts dead-letter reservations and directly queued tasks as references", async () => {
  const r = setup();
  await r.expire();
  r.dead.reserve(task());
  await r.queue.enqueue({ ...task(), taskId: "direct" });
  await r.queue.enqueue({ ...task("unrelated"), taskId: "elsewhere" });
  await expect(r.service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["QUEUED_TASKS", "DEAD_LETTERS"]
  });
  r.dead.release("task");
  await r.queue.dequeue();
  await expect(r.service.retireConversation("c")).resolves.toEqual({ status: "retired" });
});

it("fails closed when a queue or dead-letter store cannot be inspected", async () => {
  const r = setup();
  const queue = {
    enqueue: async () => undefined,
    dequeue: async () => undefined
  };
  const dead = {
    add: async () => undefined,
    list: async () => [],
    remove: async () => undefined
  };
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, r.timeline),
    new DeepWorker(queue, new MockDeepProvider(), r.timeline, 2, dead),
    r.timeline,
    queue,
    dead
  );
  await service.submitMessage(r.message());
  r.advance(10);
  await expect(service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["QUEUE_UNINSPECTABLE", "DEAD_LETTERS_UNINSPECTABLE"]
  });
  expect(service.conversationRetentionStats().owners).toBe(1);
});

it("does not release ownership for a store without the retirement contract", async () => {
  const events = new Map<string, unknown[]>();
  const timeline = {
    appendEvent: async (id: string, event: unknown) => {
      events.set(id, [...(events.get(id) ?? []), event]);
    },
    getEvents: async (id: string) => structuredClone(events.get(id) ?? []) as never
  };
  const queue = new InMemoryTaskQueue();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  service.claimConversation("c", "u");
  await expect(service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["RETIREMENT_UNSUPPORTED"]
  });
  expect(service.conversationRetention().retirementSupported).toBe(false);
  expect(() => service.claimConversation("c", "intruder", false)).toThrow();
});

it("asks participants before forgetting anything and releases ownership last", async () => {
  const r = setup();
  await r.expire();
  const order: string[] = [];
  let blocked = ["EXTERNAL_WORK"];
  r.service.addRetirementParticipant({
    blockers: async (conversationId, owner) => {
      order.push(`ask:${conversationId}:${owner}`);
      return blocked;
    },
    forget: (conversationId) => {
      // Ownership still guards the data while a participant drops it.
      expect(() => r.service.claimConversation(conversationId, "intruder", false)).toThrow();
      order.push(`forget:${conversationId}`);
    }
  });
  await expect(r.service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["EXTERNAL_WORK"]
  });
  expect(order).toEqual(["ask:c:u"]);
  blocked = [];
  await expect(r.service.retireConversation("c")).resolves.toEqual({ status: "retired" });
  expect(order).toEqual(["ask:c:u", "ask:c:u", "forget:c"]);
});

it("treats a failing participant as a blocker and keeps the identity if forgetting throws", async () => {
  const r = setup();
  await r.expire();
  let failing = true;
  r.service.addRetirementParticipant({
    blockers: () => {
      if (failing) throw new Error("bridge down");
      return [];
    },
    forget: () => {
      throw new Error("cleanup failed");
    }
  });
  await expect(r.service.retireConversation("c")).resolves.toEqual({
    status: "blocked",
    blockers: ["PARTICIPANT_UNAVAILABLE"]
  });
  failing = false;
  await expect(r.service.retireConversation("c")).rejects.toThrow("cleanup failed");
  expect(r.timeline.conversationState("c")).toBe("expired");
  expect(r.service.conversationRetentionStats().owners).toBe(1);
});

it("retires once when two requests race through a slow participant", async () => {
  const r = setup();
  await r.expire();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forget = vi.fn();
  r.service.addRetirementParticipant({
    blockers: async () => {
      await held;
      return [];
    },
    forget
  });
  const both = Promise.all([r.service.retireConversation("c"), r.service.retireConversation("c")]);
  release();
  expect((await both).map((result) => result.status).sort()).toEqual(["not_found", "retired"]);
  expect(forget).toHaveBeenCalledTimes(1);
});

it("refuses retirement during shutdown", async () => {
  const r = setup();
  await r.expire();
  r.service.stopAccepting();
  await expect(r.service.retireConversation("c")).rejects.toMatchObject({ code: "SHUTTING_DOWN" });
  expect(r.timeline.conversationState("c")).toBe("expired");
});

it("drops only the retired conversation's evidence", () => {
  const store = new ToolResultStore(() => 0);
  const put = (conversationId: string) =>
    store.put("u", conversationId, {
      version: "tool-result-v1",
      context: {
        status: "ready",
        summary: "s",
        expiresAt: new Date(1000).toISOString(),
        scope: "scope",
        coverage: "partial",
        limitations: []
      },
      payload: null,
      evidence: {
        sourceUrl: "https://example.test/",
        observedAt: new Date(0).toISOString(),
        revision: "r"
      }
    });
  const gone = put("c"),
    kept = put("other");
  expect(store.forgetConversation("c")).toEqual([gone.context.resultId]);
  expect(store.retentionStats()).toMatchObject({ records: 1 });
  expect(() => store.get(gone.context.resultId, "u", "c")).toThrow("RESULT_NOT_FOUND");
  expect(store.get(kept.context.resultId, "u", "other")).toBeDefined();
});

it("lists expired identities and reports retirement outcomes over HTTP", async () => {
  const r = setup();
  const forgetConversation = vi.fn(() => ["result"]),
    forgetResults = vi.fn();
  const { base } = await listen(r, {
    briefings: {
      directory: { forgetConversation },
      gameOperations: { forgetResults },
      close: () => undefined
    } as never
  });
  await r.service.submitMessage(r.message("m", "gone"));
  r.advance(5);
  await r.service.submitMessage(r.message("m", "live"));
  r.advance(5);
  const remove = (id: string) =>
    fetch(`${base}/conversations/${encodeURIComponent(id)}/identity`, { method: "DELETE" });

  const listing = await (await fetch(base + "/conversations/retention")).json();
  expect(listing).toMatchObject({
    maxIdentities: 4,
    owners: 2,
    expiredCount: 1,
    truncated: false,
    retirementSupported: true
  });
  expect(listing.expired).toEqual([
    { conversationId: "gone", expiredAtIso: new Date(10).toISOString() }
  ]);

  const live = await remove("live");
  expect(live.status).toBe(409);
  expect(await live.json()).toMatchObject({
    code: "CONVERSATION_RETIREMENT_BLOCKED",
    blockers: ["HISTORY_LIVE"]
  });
  const missing = await remove("missing");
  expect(missing.status).toBe(404);
  expect((await missing.json()).code).toBe("CONVERSATION_NOT_FOUND");
  const retired = await remove("gone");
  expect(retired.status).toBe(200);
  expect(await retired.json()).toEqual({ retired: true, conversationId: "gone" });
  expect(forgetConversation).toHaveBeenCalledWith("gone");
  expect(forgetResults).toHaveBeenCalledWith(["result"]);
  expect((await (await fetch(base + "/conversations/retention")).json()).expiredCount).toBe(0);
  // The legacy event endpoints no longer report expiry for an ID the process forgot.
  const events = await fetch(base + "/conversations/gone/events");
  expect(events.status).toBe(200);
  expect(await events.json()).toEqual({ events: [] });
});

it("keeps conversations with document tasks, or an unreachable sidecar, unretired", async () => {
  const r = setup();
  await r.expire();
  let answer: () => Promise<unknown> = async () => [{ taskId: "t", status: "completed" }];
  const request = vi.fn((_data: Record<string, unknown>) => answer());
  const documentTasks: DocumentTasks = { request, close: () => undefined };
  const { base } = await listen(r, { documentTasks });
  const remove = async () => {
    const response = await fetch(base + "/conversations/c/identity", { method: "DELETE" });
    return { status: response.status, body: await response.json() };
  };
  expect(await remove()).toMatchObject({ status: 409, body: { blockers: ["DOCUMENT_TASKS"] } });
  expect(request).toHaveBeenCalledWith({ op: "list", conversationId: "c", userId: "u" });
  answer = async () => {
    throw new Error("BRIDGE_UNAVAILABLE");
  };
  expect(await remove()).toMatchObject({
    status: 409,
    body: { blockers: ["DOCUMENT_TASKS_UNKNOWN"] }
  });
  expect(r.timeline.conversationState("c")).toBe("expired");
  answer = async () => [];
  expect(await remove()).toMatchObject({ status: 200, body: { retired: true } });
});

it.each([false, true])(
  "releases the v1 wire mapping and closes its stream (empty history=%s)",
  async (emptyHistory) => {
    const r = setup();
    const { server, base } = await listen(r, {});
    const wireId = randomUUID();
    const path = `${base}/v1/conversations/${wireId}`;
    const submit = async () => {
      const response = await fetch(`${path}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "1.0",
          accountId: "a",
          projectId: "p",
          messageId: randomUUID(),
          text: "hello",
          clientTimestampIso: new Date().toISOString()
        })
      });
      await response.text();
      return response.status;
    };
    if (emptyHistory)
      vi.spyOn(r.service, "submitMessage").mockImplementationOnce(async (message) => {
        r.service.claimConversation(message.conversationId, message.userId);
        throw new GenerationError("DEAD_LETTER_CAPACITY", false);
      });
    expect(await submit()).toBe(emptyHistory ? 503 : 200);
    expect(server.retentionStats().wireConversations).toBe(1);

    const stream = await fetch(`${path}/events/stream?accountId=a&projectId=p`);
    const reader = stream.body!.getReader();
    let received = "";
    while (!received.includes(emptyHistory ? "event: ready" : "event: turn"))
      received += Buffer.from((await reader.read()).value!).toString();

    r.advance(10);
    expect(await submit()).toBe(410);
    const [internalId] = r.timeline.expiredConversations().map((c) => c.conversationId);
    await expect(r.service.retireConversation(internalId)).resolves.toEqual({ status: "retired" });
    expect(server.retentionStats().wireConversations).toBe(0);

    // The same wire ID now starts unrelated work under a new internal identity.
    expect(await submit()).toBe(200);
    expect(r.timeline.conversationState(internalId)).toBeUndefined();
    expect(r.timeline.retentionStats()).toMatchObject({ identities: 1, histories: 1 });
    // The old cursor is void, so the stream ends instead of replaying the new timeline.
    await expect(
      (async () => {
        while (!(await reader.read()).done);
      })()
    ).rejects.toThrow();
  }
);

it("does not apply stale blocker answers to a reused and expired identity", async () => {
  const r = setup();
  await r.expire();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const forget = vi.fn();
  r.service.addRetirementParticipant({
    blockers: async (_id, owner) => {
      if (++calls === 1) await held;
      return owner === "other" ? ["NEW_EXTERNAL_WORK"] : [];
    },
    forget
  });
  const stale = r.service.retireConversation("c");
  expect(await r.service.retireConversation("c")).toEqual({ status: "retired" });
  await r.service.submitMessage(r.message("m", "c", "other"));
  r.advance(10);
  release();
  expect(await stale).toEqual({ status: "not_found" });
  expect(forget).toHaveBeenCalledTimes(1);
  expect(r.service.hasConversationIdentity("c")).toBe(true);
  expect(await r.service.retireConversation("c")).toEqual({
    status: "blocked",
    blockers: ["NEW_EXTERNAL_WORK"]
  });
});

it.each(["teams", "games", "document"] as const)(
  "protects ownership until a pending %s request finishes publishing",
  async (kind) => {
    const r = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let published = false;
    const publish = vi.fn(async () => {
      await held;
      published = true;
      return {};
    });
    const forgetConversation = vi.fn(() => {
      published = false;
      return [];
    });
    const { base } = await listen(r, {
      briefings: {
        directory: { list: publish, forgetConversation },
        gameOperations: { search: publish, forgetResults: () => undefined },
        close: () => undefined
      },
      ...(kind === "document"
        ? {
            documentTasks: {
              request: (body: Record<string, unknown>) =>
                body.op === "start"
                  ? publish()
                  : Promise.resolve(published ? [{ taskId: "t" }] : []),
              close: () => undefined
            }
          }
        : {})
    } as never);
    const body = {
      conversationId: "c",
      userId: "u",
      ...(kind === "teams"
        ? { league: "NFL" }
        : kind === "games"
          ? { operation: "search", input: {} }
          : { op: "start", requestId: randomUUID(), question: "question" })
    };
    const path = kind === "document" ? "/document-tasks" : `/sports/${kind}`;
    const pending = fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      r.advance(10);
      expect(await r.service.retireConversation("c")).toEqual({
        status: "blocked",
        blockers: ["HISTORY_LIVE"]
      });
      expect(r.timeline.retentionStats().pins).toBe(1);
    } finally {
      release();
      const response = await pending;
      expect(response.status).toBe(kind === "document" ? 202 : 200);
      await response.text();
    }
    expect(published).toBe(true);
    expect(r.timeline.retentionStats().pins).toBe(0);
    r.advance(10);
    expect(await r.service.retireConversation("c")).toEqual(
      kind === "document"
        ? { status: "blocked", blockers: ["DOCUMENT_TASKS"] }
        : { status: "retired" }
    );
    expect(published).toBe(kind === "document");
  }
);

it("ends a legacy stream before it can follow a retired ID into another user's history", async () => {
  const r = setup();
  await r.service.submitMessage(r.message());
  const { base } = await listen(r, {});
  const controller = new AbortController();
  const stream = await fetch(base + "/conversations/c/events/stream", {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])
  });
  const reader = stream.body!.getReader();
  let received = Buffer.from((await reader.read()).value!).toString();
  r.advance(10);
  expect(await r.service.retireConversation("c")).toEqual({ status: "retired" });
  await r.service.submitMessage({ ...r.message("m", "c", "other"), text: "new owner secret" });
  try {
    await vi.waitFor(
      async () => {
        const next = await reader.read();
        if (next.value) received += Buffer.from(next.value).toString();
        expect(received).toContain("event: conversation-expired");
      },
      { timeout: 2000 }
    );
    expect(received).not.toContain("new owner secret");
  } finally {
    controller.abort();
  }
});

it("keeps ownership when the timeline refuses its final retirement operation", async () => {
  const r = setup();
  await r.expire();
  vi.spyOn(r.timeline, "retireConversation").mockReturnValue(false);
  expect(await r.service.retireConversation("c")).toEqual({
    status: "blocked",
    blockers: ["RETIREMENT_REFUSED"]
  });
  expect(r.timeline.conversationState("c")).toBe("expired");
  expect(r.service.hasConversationIdentity("c")).toBe(true);
  expect(() => r.service.claimConversation("c", "other", false)).toThrow();
});
