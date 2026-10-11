import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { ChatService } from "../../src/app/chatService";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ConversationPersistence } from "../../src/app/conversationPersistence";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { conversationRetentionSchema } from "../../src/config/conversationRetention";
import { scopedOwnerKey } from "../../src/auth/authenticator";

function runtime(clock = Date.now, idleTtlMs = 86400000) {
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore(
    undefined,
    conversationRetentionSchema.parse({ idleTtlMs }),
    clock
  );
  const fast = new MockFastProvider();
  const orchestrator = new ChatOrchestrator(fast, queue, timeline);
  const worker = new DeepWorker(queue, new MockDeepProvider(), timeline);
  const service = new ChatService(orchestrator, worker, timeline);
  return { service, timeline, fast };
}

describe("durable conversation snapshots", () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "chatagent-conversation-"));
    file = join(directory, "state", "conversations.json");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("restores complete history, sequence, ownership and duplicate-message protection", async () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    const messageId = randomUUID();
    await first.service.submitMessage({
      conversationId: "conversation",
      userId: "alice",
      messageId,
      text: "hello",
      timestampIso: new Date().toISOString()
    });
    const events = await first.service.getTimeline("conversation");
    saved.close();
    const second = runtime();
    const restored = new ConversationPersistence(file, second.timeline, second.service);
    expect(await second.service.getTimeline("conversation")).toEqual(events);
    expect(second.service.conversationOwner("conversation")).toBe("alice");
    expect(second.timeline.lastSequence("conversation")).toBe(events.length);
    await expect(
      second.service.submitMessage({
        conversationId: "conversation",
        userId: "bob",
        text: "hello",
        timestampIso: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: "CONVERSATION_OWNER_MISMATCH" });
    await expect(
      second.service.submitMessage({
        conversationId: "conversation",
        userId: "alice",
        messageId,
        text: "again",
        timestampIso: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_MESSAGE_ID" });
    await second.service.submitMessage({
      conversationId: "conversation",
      userId: "alice",
      text: "hello again",
      timestampIso: new Date().toISOString()
    });
    expect(second.timeline.lastSequence("conversation")).toBeGreaterThan(events.length);
    restored.close();
  });

  it("restores selected context and durable authenticated protocol namespaces", () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    const scoped = first.service.openScopedConversation("alice", {
      path: ["Research"],
      entity: { provider: "manual", id: "subject", name: "Subject" },
      reference: null
    });
    const binding = {
      principalId: "principal",
      accountId: "account",
      projectId: "project",
      conversationId: randomUUID(),
      internalId: randomUUID()
    };
    first.service.claimConversation(
      binding.internalId,
      scopedOwnerKey(binding.principalId, [binding.accountId, binding.projectId])
    );
    saved.setProtocolBindings([binding]);
    saved.close();
    const second = runtime();
    const restored = new ConversationPersistence(file, second.timeline, second.service);
    expect(second.service.getSelectedContext(scoped.conversationId, "alice")).toEqual(
      scoped.context
    );
    expect(restored.protocolBindings()).toEqual([binding]);
    expect(second.service.conversationOwner(binding.internalId)).toBe(
      scopedOwnerKey("principal", ["account", "project"])
    );
    expect(() =>
      restored.setProtocolBindings([{ ...binding, accountId: "another-account" }])
    ).toThrow();
    expect(restored.protocolBindings()).toEqual([binding]);
    restored.close();
  });

  it("retains expired identity tombstones across restarts and saves coordinated retirement", async () => {
    let time = Date.now();
    const first = runtime(() => time, 100);
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    first.service.claimConversation("expired", "alice");
    await first.timeline.appendEvent("expired", {
      type: "terminal",
      messageId: "finished",
      phase: "fast",
      text: "done",
      finishReason: "stop",
      createdAtIso: new Date().toISOString()
    });
    time += 101;
    expect(first.timeline.expiredConversations()).toHaveLength(1);
    saved.close();
    const second = runtime(() => time, 100);
    const restored = new ConversationPersistence(file, second.timeline, second.service);
    expect(second.timeline.conversationState("expired")).toBe("expired");
    expect(second.service.conversationOwner("expired")).toBe("alice");
    await expect(second.service.getTimeline("expired")).rejects.toMatchObject({
      code: "CONVERSATION_EXPIRED"
    });
    expect(await second.service.retireConversation("expired")).toEqual({ status: "retired" });
    restored.close();
    const third = runtime(() => time, 100);
    const afterRetirement = new ConversationPersistence(file, third.timeline, third.service);
    expect(third.timeline.conversationState("expired")).toBeUndefined();
    expect(third.service.conversationOwner("expired")).toBeUndefined();
    afterRetirement.close();
  });

  it("marks interrupted generation incomplete once and never replays the model", async () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    first.service.claimConversation("interrupted", "alice");
    await first.timeline.appendEvent("interrupted", {
      type: "user",
      messageId: "unfinished",
      text: "Do work",
      createdAtIso: new Date().toISOString()
    });
    await first.timeline.appendEvent("interrupted", {
      type: "delta",
      messageId: "unfinished",
      phase: "fast",
      attemptId: "attempt",
      text: "Partial",
      createdAtIso: new Date().toISOString()
    });
    saved.close();
    const second = runtime();
    const model = vi.spyOn(second.fast, "createProvisionalReply");
    const restored = new ConversationPersistence(file, second.timeline, second.service);
    expect(model).not.toHaveBeenCalled();
    const recovered = await second.service.getTimeline("interrupted");
    expect(recovered.at(-1)).toMatchObject({
      type: "terminal",
      phase: "fast",
      messageId: "unfinished",
      processingStatus: "incomplete",
      errorCode: "RUNTIME_RESTARTED",
      sequence: 3
    });
    restored.close();
    const third = runtime();
    const repeated = new ConversationPersistence(file, third.timeline, third.service);
    expect(
      (await third.service.getTimeline("interrupted")).filter(
        (event) => event.errorCode === "RUNTIME_RESTARTED"
      )
    ).toHaveLength(1);
    repeated.close();
  });

  it("refuses corrupt or mismatched ownership snapshots without overwriting evidence", () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    const binding = {
      principalId: "principal",
      accountId: "account",
      projectId: "project",
      conversationId: randomUUID(),
      internalId: randomUUID()
    };
    first.service.claimConversation(
      binding.internalId,
      scopedOwnerKey("principal", ["account", "project"])
    );
    saved.setProtocolBindings([binding]);
    saved.close();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.identities.owners[0][1] = "other-owner";
    writeFileSync(file, JSON.stringify(raw));
    const damaged = readFileSync(file);
    const second = runtime();
    expect(() => new ConversationPersistence(file, second.timeline, second.service)).toThrow(
      "Saved conversations could not be restored"
    );
    expect(readFileSync(file)).toEqual(damaged);
    writeFileSync(file, "not json");
    expect(() => new ConversationPersistence(file, second.timeline, second.service)).toThrow(
      "Saved conversations could not be restored"
    );
    expect(readFileSync(file, "utf8")).toBe("not json");
  });

  it("surfaces storage failure before admitting a model call", async () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    const model = vi.spyOn(first.fast, "createProvisionalReply");
    rmSync(file);
    mkdirSync(file);
    await expect(
      first.service.submitMessage({
        conversationId: "cannot-save",
        userId: "alice",
        text: "hello",
        timestampIso: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: "CONVERSATION_PERSISTENCE_UNAVAILABLE" });
    expect(model).not.toHaveBeenCalled();
    rmSync(file, { recursive: true });
    saved.close();
  });

  it("refuses snapshots beyond the configured file bound", () => {
    const first = runtime();
    const saved = new ConversationPersistence(file, first.timeline, first.service);
    saved.close();
    truncateSync(file, 16 * 1024 * 1024 + 1);
    const second = runtime();
    expect(() => new ConversationPersistence(file, second.timeline, second.service)).toThrow(
      "Saved conversations could not be restored"
    );
  });
});
