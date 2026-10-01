import { deriveTurns } from "../../src/ui/turnViewModel";
import { expect, it, vi } from "vitest";
import { RoleCatalog } from "../../src/app/roleCatalog";
import {
  CapabilityChat,
  planningInstruction,
  type CapabilityTool
} from "../../src/app/capabilityChat";
import { ContextManager } from "../../src/app/contextManager";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
const role = {
  id: "researcher",
  version: "1",
  bindingId: "fixed",
  instructions: "ROLE_INSTRUCTION",
  toolIds: ["allowed"],
  maxToolCalls: 1,
  maxInputTokens: 5000
};
const msg = {
  messageId: "m",
  conversationId: "c",
  userId: "u",
  text: "Look up evidence",
  timestampIso: new Date().toISOString(),
  runControls: { roleId: "researcher", thinking: "configured" as const, mode: "chat" as const }
};
function setup(
  plan: unknown,
  definition: unknown = role,
  engine: "native" | "langgraph" = "native"
) {
  const execute = vi.fn(async () => ({ status: "done" }));
  const tools: CapabilityTool[] = ["allowed", "excluded"].map((id) => ({
    id,
    description: id + "_SCHEMA_CANARY",
    inputSchema: {},
    validate: (v) => v,
    execute
  }));
  const catalog = new RoleCatalog({ version: "role-catalog-v1", roles: [definition] });
  const timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue();
  const generate = vi.fn(async () => ({
    text: JSON.stringify(plan),
    finishReason: "stop" as const
  }));
  const chat = new CapabilityChat(
    { createProvisionalReply: generate },
    queue,
    timeline,
    new ContextManager(timeline, {
      windowTokens: 8192,
      maxHistoryTurns: 12,
      safetyTokens: 256,
      fastOutputTokens: 512,
      deepOutputTokens: 2048
    }),
    () => ({
      fastProvider: "test",
      fastModel: "test",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date().toISOString()
    }),
    () => tools,
    undefined,
    catalog,
    engine
  );
  return { chat, catalog, generate, execute, timeline, tools };
}
it("exposes only selected tools and records the effective role", async () => {
  const a = setup({ action: "retrieve", calls: [{ tool: "allowed", arguments: {} }] });
  await a.chat.handleUserMessage(msg);
  await a.chat.whenIdle();
  const prompt = JSON.stringify(a.generate.mock.calls);
  expect(prompt).toContain("ROLE_INSTRUCTION");
  expect(prompt).toContain("allowed_SCHEMA_CANARY");
  expect(prompt).not.toContain("excluded_SCHEMA_CANARY");
  expect(a.execute).toHaveBeenCalledTimes(1);
  const event = (await a.timeline.getEvents("c")).find((e) => e.roleExecution);
  expect(event?.roleExecution).toMatchObject({
    definition: { version: "1" },
    bindingId: "fixed",
    toolIds: ["allowed"]
  });
});
it("rejects a mixed allowed/excluded plan before any tool executes", async () => {
  const a = setup({
    action: "retrieve",
    calls: [
      { tool: "allowed", arguments: {} },
      { tool: "excluded", arguments: {} }
    ]
  });
  await expect(a.chat.handleUserMessage(msg)).rejects.toThrow();
  expect(a.execute).not.toHaveBeenCalled();
});
it("enforces tool-free roles and per-role call counts", async () => {
  for (const definition of [{ ...role, toolIds: [], maxToolCalls: 0 }, role]) {
    const a = setup(
      {
        action: "retrieve",
        calls: [
          { tool: "allowed", arguments: {} },
          { tool: "allowed", arguments: {} }
        ]
      },
      definition
    );
    await expect(a.chat.handleUserMessage(msg)).rejects.toThrow();
    expect(a.execute).not.toHaveBeenCalled();
  }
});
it.each([
  [{ roleId: "missing" }, role, "ROLE_NOT_FOUND"],
  [{ toolIds: ["excluded"] }, role, "ROLE_TOOL_OVERRIDE_DENIED"],
  [{ bindingId: "other" }, role, "ROLE_MODEL_OVERRIDE_DENIED"],
  [{ thinking: "on" }, role, "ROLE_THINKING_OVERRIDE_DENIED"],
  [{}, { ...role, bindingId: "absent" }, "ROLE_MODEL_UNAVAILABLE"],
  [{}, { ...role, toolIds: ["absent"] }, "ROLE_TOOL_UNAVAILABLE"],
  [{}, { ...role, maxInputTokens: 256 }, "ROLE_INPUT_LIMIT"],
  [{}, { ...role, thinking: "on" }, "THINKING_CONFIG_UNSUPPORTED"]
])(
  "rejects invalid or unsupported configuration before generation (%j)",
  async (overrides, definition, error) => {
    const a = setup({ action: "answer", message: "unused" }, definition);
    await expect(
      a.chat.handleUserMessage({
        ...msg,
        runControls: { ...msg.runControls, ...overrides } as typeof msg.runControls
      })
    ).rejects.toThrow(error as string);
    expect(a.generate).not.toHaveBeenCalled();
  }
);
it("snapshots role and tool definitions before asynchronous work", async () => {
  const a = setup({ action: "retrieve", calls: [{ tool: "allowed", arguments: {} }] });
  const pending = a.chat.handleUserMessage(msg);
  a.catalog.replace({
    version: "role-catalog-v1",
    roles: [{ ...role, version: "2", toolIds: [], maxToolCalls: 0 }]
  });
  a.tools[0].execute = vi.fn(async () => {
    throw Error("mutated");
  });
  await pending;
  await a.chat.whenIdle();
  expect(a.execute).toHaveBeenCalledTimes(1);
  expect(
    (await a.timeline.getEvents("c")).find((e) => e.roleExecution)?.roleExecution?.definition
      .version
  ).toBe("1");
  await expect(a.chat.handleUserMessage({ ...msg, messageId: "next" })).rejects.toThrow();
});
it("can narrow to no tools without changing the saved role", async () => {
  const a = setup({ action: "answer", message: "Evidence unavailable" });
  await a.chat.handleUserMessage({ ...msg, runControls: { ...msg.runControls, toolIds: [] } });
  expect(JSON.stringify(a.generate.mock.calls)).not.toContain("allowed_SCHEMA_CANARY");
  expect(a.catalog.list()[0].toolIds).toEqual(["allowed"]);
});

it("describes the effective call limit and omits retrieval for tool-free roles", () => {
  const a = setup({ action: "answer", message: "ok" });
  expect(planningInstruction(a.tools, "now", 1)).toContain("up to 1 independent");
  expect(planningInstruction(a.tools, "now", 2)).not.toContain("up to 3");
  expect(planningInstruction([], "now", 0)).not.toContain('"action":"retrieve"');
  expect(planningInstruction([], "now", 0)).toContain("Retrieval is disabled");
});

it("records an additive context budget using the effective tool subset", async () => {
  const a = setup({ action: "answer", message: "ok" });
  await a.chat.handleUserMessage(msg);
  const b = (await a.timeline.getEvents("c")).find((e) => e.contextBudget)?.contextBudget!;
  expect(b.totalInputTokens).toBe(
    b.instructions +
      b.tools +
      b.references +
      b.currentMessage +
      b.history +
      b.activeTasks +
      b.memory
  );
  expect(b.availableInputTokens).toBe(b.windowTokens - b.outputReserve - b.safetyReserve);
  expect(b.totalInputTokens).toBeLessThanOrEqual(b.availableInputTokens);
  expect(b.roleInputLimit).toBe(5000);
  expect(b.tools).toBe(
    Buffer.byteLength(
      JSON.stringify(
        a.tools
          .filter((t) => t.id === "allowed")
          .map(({ id, description, inputSchema }) => ({ id, description, inputSchema }))
      )
    )
  );
});

it.each([true, false])(
  "metadata shares the actual attempt and terminates with it (success=%s)",
  async (success) => {
    const a = setup(
      success
        ? { action: "answer", message: "ok" }
        : { action: "retrieve", calls: [{ tool: "excluded", arguments: {} }] }
    );
    if (success) await a.chat.handleUserMessage(msg);
    else await expect(a.chat.handleUserMessage(msg)).rejects.toThrow();
    const events = await a.timeline.getEvents("c");
    const terminal = events.find((e) => e.type === "terminal")!;
    for (const e of events.filter((e) => e.roleExecution || e.contextBudget))
      expect(e.attemptId).toBe(terminal.attemptId);
    const turn = deriveTurns(events)[0];
    expect(turn.attempts).toHaveLength(1);
    expect(turn.active).toBe(false);
    expect(turn.attempts[0].endedAt).toBeDefined();
  }
);

it.each(["native", "langgraph"] as const)(
  "%s preserves selected-role execution and rejects excluded calls",
  async (engine) => {
    const a = setup(
      { action: "retrieve", calls: [{ tool: "allowed", arguments: {} }] },
      role,
      engine
    );
    await a.chat.handleUserMessage(msg);
    await a.chat.whenIdle();
    expect(a.generate).toHaveBeenCalledTimes(1);
    expect(a.execute).toHaveBeenCalledTimes(1);
    const events = await a.timeline.getEvents("c");
    expect(events.find((e) => e.roleExecution)?.roleExecution?.plannerEngine).toBe(engine);
    expect(events.find((e) => e.type === "refined")?.text).toContain("done");
    const denied = setup(
      {
        action: "retrieve",
        calls: [
          { tool: "allowed", arguments: {} },
          { tool: "excluded", arguments: {} }
        ]
      },
      role,
      engine
    );
    await expect(denied.chat.handleUserMessage(msg)).rejects.toThrow();
    expect(denied.execute).not.toHaveBeenCalled();
  }
);
