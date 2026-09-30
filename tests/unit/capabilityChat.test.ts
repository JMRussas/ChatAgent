import { describe, expect, it, vi } from "vitest";
import { CapabilityChat, validateCapabilityPlan, type CapabilityTool } from "../../src/app/capabilityChat";
import { ContextManager } from "../../src/app/contextManager";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue, type FastModelProvider } from "../../src/providers/interfaces";
const message = { messageId: "one", conversationId: "c", userId: "u", text: "What happened in the Red Sox game last night?", timestampIso: new Date().toISOString() };
function app(output: unknown, tools: CapabilityTool[] = []) {
  const timeline = new InMemoryConversationTimelineStore(), queue = new InMemoryTaskQueue();
  const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async (_input, control) => {
    await control?.onDelta("internal JSON must not leak"); return { text: JSON.stringify(output), finishReason: "stop" };
  });
  const context = new ContextManager(timeline, { windowTokens: 12000, maxHistoryTurns: 12, safetyTokens: 256, fastOutputTokens: 1024, deepOutputTokens: 2048 });
  const chat = new CapabilityChat({ metadata: { provider: "test", model: "planner" }, createProvisionalReply: generate }, queue, timeline, context,
    () => ({ fastProvider: "test", fastModel: "planner", deepProvider: "none", deepModel: "none", generatedAtIso: new Date().toISOString() }), () => tools);
  return { chat, generate, timeline };
}
describe("capability-based conversation", () => {
  it("isolates tool request identities across conversations reusing a message ID", async () => {
    const ids: string[] = [], owners: string[] = [];
    const tool: CapabilityTool = { id: "test:lookup", description: "Test", inputSchema: {}, validate: value => value,
      execute: async (_args, user, id, _signal, conversation) => { ids.push(id); owners.push(`${user}:${conversation}`); return {}; } };
    const a = app({ action: "retrieve", calls: [{ tool: tool.id, arguments: {} }] }, [tool]);
    await a.chat.handleUserMessage(message);
    await a.chat.handleUserMessage({ ...message, conversationId: "other" });
    await a.chat.whenIdle(); expect(new Set(ids).size).toBe(2);
    expect(owners).toEqual(["u:c", "u:other"]);
  });

  it("persists unsupported intent without sports keywords or invented confidence and uses history on follow-up", async () => {
    const a = app({ action: "unsupported", message: "No baseball source is connected.", missingCapability: "baseball results" });
    const response = await a.chat.handleUserMessage(message);
    expect(response.fastResponse.analysis.confidence).toBeNull();
    const events = await a.timeline.getEvents("c");
    expect(events.some(e => e.capabilityPlan)).toBe(true);
    expect(events.some(e => e.type === "delta")).toBe(false);
    expect(events.at(-1)?.text).toBe("No baseball source is connected.");
    await a.chat.handleUserMessage({ ...message, messageId: "two", text: "I meant Boston, and my timezone is America/New_York" });
    expect(a.generate.mock.calls[1][0].context?.messages.some(m => m.content.includes("Red Sox"))).toBe(true);
    expect(a.generate.mock.calls[0][0].context?.systemInstruction).toContain("Tools: []");
  });
  it("validates the whole plan before executing anything", async () => {
    const execute = vi.fn(), tool: CapabilityTool = { id: "generic:lookup", description: "Test lookup", inputSchema: {}, validate: value => value, execute };
    const a = app({ action: "retrieve", calls: [{ tool: tool.id, arguments: {} }, { tool: "invented", arguments: {} }] }, [tool]);
    await expect(a.chat.handleUserMessage(message)).rejects.toThrow("valid executable plan");
    expect(execute).not.toHaveBeenCalled();
    expect((await a.timeline.getEvents("c")).at(-1)?.finishReason).toBe("error");
    expect(() => validateCapabilityPlan({ action: "retrieve", calls: Array.from({ length: 4 }, () => ({ tool: tool.id, arguments: {} })) }, [tool])).toThrow();
  });
  it("starts domain-independent background work and accepts another turn before it finishes", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const tool: CapabilityTool = { id: "documents:read", description: "Read a document", inputSchema: {}, validate: value => value,
      execute: async () => { await gate; return { coverage: "partial", source: "https://example.invalid/doc", text: "Source evidence" }; } };
    const a = app({ action: "retrieve", calls: [{ tool: tool.id, arguments: {} }] }, [tool]);
    const result = await a.chat.handleUserMessage(message);
    expect(result.fastResponse.processingStatus).toBe("provisional");
    a.generate.mockResolvedValueOnce({ text: JSON.stringify({ action: "answer", message: "I am still here." }), finishReason: "stop" });
    expect((await a.chat.handleUserMessage({ ...message, messageId: "two", text: "Hello" })).fastResponse.provisionalReply).toBe("I am still here.");
    release(); await a.chat.whenIdle();
    expect((await a.timeline.getEvents("c")).some(e => e.type === "refined" && e.text.includes("Source evidence"))).toBe(true);
  });
  it("propagates cancellation and suppresses late results", async () => {
    let observed: AbortSignal | undefined, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tool: CapabilityTool = { id: "test:read", description: "Test", inputSchema: {}, validate: value => value,
      execute: async (_args, _user, _request, signal) => { observed = signal; await gate; return "late"; } };
    const a = app({ action: "retrieve", calls: [{ tool: tool.id, arguments: {} }] }, [tool]);
    await a.chat.handleUserMessage(message); await a.chat.cancel("c", "one");
    expect(observed?.aborted).toBe(true); release(); await a.chat.whenIdle();
    expect((await a.timeline.getEvents("c")).some(e => e.type === "refined")).toBe(false);
  });
  it("does not execute truncated or malformed plans", async () => {
    const a = app({ action: "answer", message: "Good" });
    a.generate.mockResolvedValueOnce({ text: '{"action":', finishReason: "length" });
    await expect(a.chat.handleUserMessage(message)).rejects.toThrow();
  });
});
