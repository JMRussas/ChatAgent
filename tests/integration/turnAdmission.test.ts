import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import type { OrchestratorResponse, UserMessage } from "../../src/domain/types";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";
import { allowAllTestAuth } from "../helpers/testAuth";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

interface Held {
  message: UserMessage;
  finish: (outcome?: Error) => void;
  /** Resolves once the turn's response has returned but its inline work still runs. */
  detach: () => void;
}

/**
 * An orchestrator whose turns settle only when the test says so. `detached` turns
 * mirror `CapabilityChat.pending`: the HTTP response has returned, inline work is
 * still running and the turn still occupies its admission slot.
 */
function buildRuntime(maxConcurrentTurns?: number) {
  const held: Held[] = [];
  const detached = new Set<Held>();
  const orchestrator = {
    handleUserMessage: (message: UserMessage) =>
      new Promise<OrchestratorResponse>((resolve, reject) => {
        const entry: Held = {
          message,
          finish: (outcome) => {
            detached.delete(entry);
            if (outcome) reject(outcome);
            else resolve(response(message));
          },
          detach: () => {
            detached.add(entry);
            resolve(response(message));
          }
        };
        held.push(entry);
      }),
    cancel: async () => undefined,
    detachedTurns: () => detached.size
  };
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    orchestrator,
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue,
    undefined,
    undefined,
    maxConcurrentTurns === undefined ? {} : { maxConcurrentTurns }
  );
  const submit = (conversationId: string, userId = "u", messageId = randomUUID()) =>
    service.submitMessage({
      conversationId,
      userId,
      messageId,
      text: "hello",
      timestampIso: new Date().toISOString()
    });
  const settled = (promise: Promise<unknown>) =>
    promise.then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
  const started = (count: number) => vi.waitFor(() => expect(held).toHaveLength(count));
  return { service, timeline, held, submit, settled, started };
}

function response(message: UserMessage): OrchestratorResponse {
  return {
    messageId: message.messageId,
    fastResponse: {
      provisionalReply: "ok",
      processingStatus: "complete",
      analysis: {
        correctedText: message.text,
        needsExternalData: false,
        needsClarification: false,
        routeDecision: "direct",
        confidence: null,
        reasons: []
      }
    }
  };
}

async function listen(service: ChatService) {
  const server = createChatServer(service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return {
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      json: await res.json()
    };
  };
  return { server, post };
}

it("refuses the turn past the limit before claiming anything and admits again once one settles", async () => {
  const { service, timeline, held, submit, settled, started } = buildRuntime(2);
  const first = submit("a");
  const second = submit("b");
  await started(2);
  expect(service.retentionStats()).toMatchObject({ activeTurns: 2, maxConcurrentTurns: 2 });

  const refusedId = randomUUID();
  await expect(submit("c", "owner-c", refusedId)).rejects.toMatchObject({
    code: "TURN_CAPACITY",
    retryable: true
  });
  // Nothing was claimed: no owner, no history, no identity and no message ID.
  expect(service.hasConversationIdentity("c")).toBe(false);
  expect(service.conversationRetentionStats().owners).toBe(2);
  expect(await timeline.getEvents("c")).toEqual([]);
  await started(2);
  expect(service.retentionStats().activeTurns).toBe(2);

  held[0].finish();
  await expect(settled(first)).resolves.toBe("fulfilled");
  expect(service.retentionStats().activeTurns).toBe(1);
  const third = submit("c", "owner-c", refusedId);
  await started(3);
  expect(service.hasConversationIdentity("c")).toBe(true);
  held[1].finish();
  held[2].finish();
  await expect(settled(second)).resolves.toBe("fulfilled");
  await expect(settled(third)).resolves.toBe("fulfilled");
  expect(service.retentionStats()).toMatchObject({ activeTurns: 0, detachedTurns: 0 });
});

it("releases the slot when an admitted turn fails", async () => {
  const { service, held, submit, settled, started } = buildRuntime(1);
  const failing = submit("a");
  await started(1);
  await expect(submit("b")).rejects.toMatchObject({ code: "TURN_CAPACITY" });
  held[0].finish(new Error("provider down"));
  await expect(settled(failing)).resolves.toBe("rejected");
  expect(service.retentionStats().activeTurns).toBe(0);
  const next = submit("b");
  await started(2);
  held[1].finish();
  await expect(settled(next)).resolves.toBe("fulfilled");
});

it("keeps a turn's slot while its inline work runs after the response returned", async () => {
  const { service, held, submit, settled, started } = buildRuntime(1);
  const first = submit("a");
  await started(1);
  held[0].detach();
  await expect(settled(first)).resolves.toBe("fulfilled");
  expect(service.retentionStats()).toMatchObject({ activeTurns: 0, detachedTurns: 1 });
  await expect(submit("b")).rejects.toMatchObject({ code: "TURN_CAPACITY" });
  held[0].finish();
  expect(service.retentionStats().detachedTurns).toBe(0);
  const next = submit("b");
  await started(2);
  held[1].finish();
  await expect(settled(next)).resolves.toBe("fulfilled");
});

it("answers 429 TURN_CAPACITY on both HTTP protocols without consuming identities", async () => {
  const { service, held, submit, settled, timeline, started } = buildRuntime(1);
  const { server, post } = await listen(service);
  const occupant = submit("occupant");
  await started(1);

  const messageId = randomUUID();
  const legacy = await post("/messages", {
    conversationId: "web",
    userId: "u",
    messageId,
    text: "hello"
  });
  expect(legacy).toMatchObject({ status: 429, retryAfter: "1" });
  expect(legacy.json).toMatchObject({ code: "TURN_CAPACITY" });
  expect(legacy.json.error).toMatch(/already running 1 turn/);

  const wireConversation = randomUUID();
  const v1 = await post(`/v1/conversations/${wireConversation}/messages`, {
    accountId: "acct",
    projectId: "proj",
    protocolVersion: "1.0",
    messageId: randomUUID(),
    text: "hello",
    clientTimestampIso: new Date().toISOString()
  });
  expect(v1.status).toBe(429);
  expect(v1.json).toMatchObject({ code: "TURN_CAPACITY" });
  expect(server.retentionStats().wireConversations).toBe(0);
  expect(service.conversationRetentionStats().owners).toBe(1);
  expect(await timeline.getEvents("web")).toEqual([]);

  held[0].finish();
  await expect(settled(occupant)).resolves.toBe("fulfilled");
  // The refused body, message ID included, is accepted unchanged afterwards.
  const retried = post("/messages", {
    conversationId: "web",
    userId: "u",
    messageId,
    text: "hello"
  });
  await started(2);
  held[1].finish();
  expect((await retried).status).toBe(200);
});

it("reads the default limit from the environment and validates explicit limits", () => {
  vi.stubEnv("CHAT_MAX_CONCURRENT_TURNS", "3");
  expect(buildRuntime().service.maxConcurrentTurns).toBe(3);
  vi.stubEnv("CHAT_MAX_CONCURRENT_TURNS", "zero");
  expect(() => buildRuntime()).toThrow(/CHAT_MAX_CONCURRENT_TURNS/);
  expect(() => buildRuntime(0)).toThrow(/maxConcurrentTurns/);
});
