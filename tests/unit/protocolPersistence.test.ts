import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { EventStreamRegistry } from "../../src/app/eventStreams";
import { DeepWorker } from "../../src/app/orchestrator";
import {
  createProtocolV1Handler,
  type ProtocolConversationBinding
} from "../../src/app/protocolV1";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { scopedOwnerKey } from "../../src/auth/authenticator";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import type { OrchestratorResponse, UserMessage } from "../../src/domain/types";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider } from "../../src/providers/mockProviders";

function setup(execute?: (message: UserMessage) => Promise<void>) {
  let now = 0;
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ idleTtlMs: 100 }),
    () => now
  );
  const queue = new InMemoryTaskQueue();
  const handleUserMessage = vi.fn(async (message: UserMessage): Promise<OrchestratorResponse> => {
    await execute?.(message);
    return {
      messageId: message.messageId,
      fastResponse: {
        provisionalReply: "Done",
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
  });
  const service = new ChatService(
    { handleUserMessage, cancel: async () => undefined },
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue,
    undefined,
    undefined,
    { maxConcurrentTurns: 1 }
  );
  const streams = new EventStreamRegistry({ maxEventStreams: 1, streamStallTimeoutMs: 1000 });
  return {
    service,
    streams,
    handleUserMessage,
    advance: () => {
      now = 200;
    }
  };
}
const binding = (): ProtocolConversationBinding => ({
  principalId: "operator",
  accountId: "account",
  projectId: "project",
  conversationId: randomUUID(),
  internalId: randomUUID()
});
async function submit(
  handler: ReturnType<typeof createProtocolV1Handler>,
  row: ProtocolConversationBinding
) {
  const request = { method: "POST", headersDistinct: {} } as IncomingMessage;
  const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await handler(
    request,
    response,
    new URL(`http://localhost/v1/conversations/${row.conversationId}/messages`),
    async () => ({
      protocolVersion: "1.0",
      accountId: row.accountId,
      projectId: row.projectId,
      messageId: randomUUID(),
      text: "Continue",
      clientTimestampIso: "2026-10-10T18:00:00.000Z"
    }),
    row.principalId
  );
  return response;
}

describe("protocol conversation binding persistence", () => {
  it("restores the original internal identity and preserves principal/project isolation", async () => {
    const a = setup();
    const row = binding();
    a.service.claimConversation(
      row.internalId,
      scopedOwnerKey(row.principalId, [row.accountId, row.projectId])
    );
    const handler = createProtocolV1Handler(a.service, a.streams, { bindings: [row] });
    await submit(handler, row);
    expect(a.handleUserMessage.mock.calls[0][0].conversationId).toBe(row.internalId);
    expect(handler.isProtocolConversation(row.internalId)).toBe(true);
    await submit(handler, { ...row, projectId: "other-project" });
    await submit(handler, { ...row, principalId: "other-principal" });
    expect(
      new Set(a.handleUserMessage.mock.calls.map(([message]) => message.conversationId)).size
    ).toBe(3);
    expect(handler.snapshotBindings()).toHaveLength(3);
    const snapshot = handler.snapshotBindings();
    snapshot[0].projectId = "tampered";
    expect(handler.snapshotBindings()[0]).toEqual(row);
  });

  it("persists a claimed mapping before generation completes and removes it upon retirement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = setup(async () => gate);
    const row = binding();
    let persisted!: () => void;
    const persistedMapping = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const changed = vi.fn((_rows: ProtocolConversationBinding[]) => persisted());
    const handler = createProtocolV1Handler(a.service, a.streams, { onBindingsChanged: changed });
    const pending = submit(handler, row);
    await persistedMapping;
    expect(changed).toHaveBeenCalledTimes(1);
    const saved = changed.mock.calls[0][0][0] as ProtocolConversationBinding;
    expect(saved).toMatchObject({
      principalId: row.principalId,
      conversationId: row.conversationId
    });
    expect(a.service.conversationOwner(saved.internalId)).toBe(
      scopedOwnerKey(row.principalId, [row.accountId, row.projectId])
    );
    release();
    await pending;
    a.advance();
    expect(await a.service.retireConversation(saved.internalId)).toEqual({ status: "retired" });
    expect(handler.snapshotBindings()).toEqual([]);
    expect(changed.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it("rolls back an unclaimed mapping when admission is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = setup(async () => gate);
    const handler = createProtocolV1Handler(a.service, a.streams);
    const first = submit(handler, binding());
    const second = submit(handler, binding());
    await expect(second).rejects.toThrow("already running");
    expect(handler.snapshotBindings()).toHaveLength(1);
    expect(handler.retentionStats().conversations).toBe(1);
    release();
    await first;
  });

  it("refuses malformed, aliased or incorrectly owned persisted bindings", () => {
    const a = setup();
    const row = binding();
    a.service.claimConversation(
      row.internalId,
      scopedOwnerKey(row.principalId, [row.accountId, row.projectId])
    );
    expect(() =>
      createProtocolV1Handler(a.service, a.streams, {
        bindings: [{ ...row, internalId: "not-a-guid" }]
      })
    ).toThrow();
    expect(() => createProtocolV1Handler(a.service, a.streams, { bindings: [row, row] })).toThrow(
      "PROTOCOL_BINDING_CONFLICT"
    );
    expect(() =>
      createProtocolV1Handler(a.service, a.streams, {
        bindings: [row, { ...row, conversationId: randomUUID() }]
      })
    ).toThrow("PROTOCOL_BINDING_CONFLICT");
    expect(() =>
      createProtocolV1Handler(a.service, a.streams, {
        bindings: [{ ...row, projectId: "wrong-owner" }]
      })
    ).toThrow("PROTOCOL_BINDING_OWNER_MISMATCH");
    expect(() =>
      createProtocolV1Handler(a.service, a.streams, {
        bindings: [{ ...row, internalId: randomUUID() }]
      })
    ).toThrow("PROTOCOL_BINDING_OWNER_MISMATCH");
  });
});
