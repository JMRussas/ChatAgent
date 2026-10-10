import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CapabilityChat, type CapabilityTool } from "../../src/app/capabilityChat";
import { ContextManager } from "../../src/app/contextManager";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue, type FastModelProvider } from "../../src/providers/interfaces";
import type { UserMessage } from "../../src/domain/types";

const message: UserMessage = {
  messageId: "create-one",
  conversationId: "work",
  userId: "scoped-owner",
  text: "Create a plan called Prepare the report",
  timestampIso: "2026-10-10T18:00:00.000Z",
  applicationContext: {
    principal: { principalId: "operator", roles: new Set(["client", "operator"]), via: "session" }
  }
};
const input = z.object({ title: z.string().min(1) }).strict();
function app(
  plan: unknown,
  execute: CapabilityTool["execute"] = async () => ({ id: "saved-plan" })
) {
  const tool: CapabilityTool = {
    id: "workflows:create_plan",
    effect: "write",
    description: "Create a saved plan",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    validate: (value) => input.parse(value),
    execute
  };
  const tools = vi.fn((_message?: UserMessage) => [tool]);
  const timeline = new InMemoryConversationTimelineStore();
  const queue = new InMemoryTaskQueue();
  const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
    text: JSON.stringify(plan),
    finishReason: "stop"
  }));
  const context = new ContextManager(timeline, {
    windowTokens: 12000,
    maxHistoryTurns: 12,
    safetyTokens: 256,
    fastOutputTokens: 1024,
    deepOutputTokens: 2048
  });
  const chat = new CapabilityChat(
    { createProvisionalReply: generate },
    queue,
    timeline,
    context,
    () => ({
      fastProvider: "test",
      fastModel: "planner",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: message.timestampIso
    }),
    tools
  );
  return { chat, timeline, generate, tools, tool };
}
const action = {
  action: "act",
  call: { tool: "workflows:create_plan", arguments: { title: "Prepare the report" } }
};

describe("application action dispatch", () => {
  it("performs one validated operation using trusted caller context and returns the saved result", async () => {
    const saved = { id: "saved-plan", title: "Prepare the report", revision: 1 };
    const execute = vi.fn(async () => saved);
    const a = app(action, execute);
    const response = await a.chat.handleUserMessage(message);
    expect(execute).toHaveBeenCalledTimes(1);
    const args = execute.mock.calls[0] as unknown as Parameters<CapabilityTool["execute"]>;
    expect(args[0]).toEqual({ title: "Prepare the report" });
    expect(args[1]).toBe(message.userId);
    expect(args[2]).toBeTruthy();
    expect(args[3]).toBeInstanceOf(AbortSignal);
    expect(args[4]).toBe(message.conversationId);
    expect(args[5]).toEqual(message.applicationContext);
    expect(a.tools.mock.calls[0][0]?.applicationContext).toEqual(message.applicationContext);
    expect(response.fastResponse.processingStatus).toBe("complete");
    expect(response.fastResponse.provisionalReply).toContain(JSON.stringify(saved, null, 2));
    expect((await a.timeline.getEvents(message.conversationId)).at(-1)?.text).toBe(
      response.fastResponse.provisionalReply
    );
  });

  it.each([
    undefined,
    { principal: { principalId: "client", roles: new Set(["client"]), via: "bearer" } }
  ])(
    "does not expose or execute write tools without operator context",
    async (applicationContext) => {
      const execute = vi.fn();
      const a = app(action, execute);
      await expect(
        a.chat.handleUserMessage({
          ...message,
          applicationContext: applicationContext as UserMessage["applicationContext"]
        })
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(a.generate.mock.calls[0][0].context?.systemInstruction).not.toContain(
        "workflows:create_plan"
      );
    }
  );

  it("refuses a mutation disguised as independent retrieval", async () => {
    const execute = vi.fn();
    const a = app({ action: "retrieve", calls: [action.call] }, execute);
    await expect(a.chat.handleUserMessage(message)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...action, call: { ...action.call, arguments: { title: "", principal: "forged" } } },
    { ...action, calls: [action.call, action.call] }
  ])("validates the complete action before any mutation", async (plan) => {
    const execute = vi.fn();
    const a = app(plan, execute);
    await expect(a.chat.handleUserMessage(message)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports failure without inventing a saved result or disclosing private tool errors", async () => {
    const execute = vi.fn(async () => {
      throw Error("private service connection details");
    });
    const a = app(action, execute);
    await expect(a.chat.handleUserMessage(message)).rejects.toThrow("TOOL_EXECUTION_FAILED");
    expect(execute).toHaveBeenCalledTimes(1);
    const terminal = (await a.timeline.getEvents(message.conversationId)).at(-1);
    expect(terminal?.finishReason).toBe("error");
    expect(terminal?.text).not.toContain("private service connection details");
  });

  it("propagates cancellation and does not publish a late successful action", async () => {
    let release!: () => void;
    let started!: () => void;
    let observed: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute: CapabilityTool["execute"] = async (_input, _owner, _id, signal) => {
      observed = signal;
      started();
      await gate;
      return { id: "late-plan" };
    };
    const a = app(action, execute);
    const pending = a.chat.handleUserMessage(message);
    const rejected = expect(pending).rejects.toThrow("CANCELLED");
    await ready;
    await a.chat.cancel(message.conversationId, message.messageId!);
    expect(observed?.aborted).toBe(true);
    release();
    await rejected;
    expect(
      (await a.timeline.getEvents(message.conversationId)).some((event) =>
        event.text.includes("late-plan")
      )
    ).toBe(false);
  });
});
