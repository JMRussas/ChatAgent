import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { CapabilityChat, type CapabilityTool } from "../../src/app/capabilityChat";
import { RoleCatalog } from "../../src/app/roleCatalog";
import { ChatService } from "../../src/app/chatService";
import { DeepWorker } from "../../src/app/orchestrator";
import { selectReferences } from "../../src/app/referenceSelection";
import { createLiveBriefing } from "../../src/sports/liveBriefing";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { runtime, entry, message, evidence } from "../helpers/dispatchFixtures";
import type { FastModelProvider } from "../../src/providers/interfaces";
import type { RolePlannerEngine } from "../../src/app/rolePlanner";
const config = JSON.parse(readFileSync("data/sports/nfl-live-briefing.example.json", "utf8"));
const window = { league: "NBA", from: "2026-09-27T00:00:00Z", to: "2026-09-30T00:00:00Z" };
const lookup = { action: "retrieve", calls: [{ tool: "sports:find-games", arguments: window }] };
function setup(engine: RolePlannerEngine, extraTools: CapabilityTool[] = []) {
  let now = Date.parse("2026-09-30T00:00:00Z"),
    plan: unknown = lookup;
  const transport = vi.fn(async () =>
    Response.json({
      data: [
        {
          id: 91,
          datetime: "2026-09-28T20:00:00Z",
          status_state: "final",
          home_team: { id: 7, full_name: "SELECTED_CANARY" },
          visitor_team: { id: 8, full_name: "Visitors" },
          home_team_score: 110,
          visitor_team_score: 99
        },
        {
          id: 92,
          datetime: "2026-09-28T18:00:00Z",
          status_state: "final",
          home_team: { id: 9, full_name: "UNSELECTED_CANARY" },
          visitor_team: { id: 10, full_name: "Others" },
          home_team_score: 80,
          visitor_team_score: 90
        }
      ],
      meta: { next_cursor: null }
    })
  );
  const sports = createLiveBriefing(
    { ...config, games: { requestsPerMinute: 1, cacheTtlMs: 0 } },
    "fixture",
    transport as typeof fetch,
    () => now
  );
  const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
    text: JSON.stringify(plan),
    finishReason: "stop"
  }));
  const other = vi.fn<FastModelProvider["createProvisionalReply"]>();
  const r = runtime([entry("selected"), entry("other")], {
    selected: { fast: { createProvisionalReply: generate } },
    other: { fast: { createProvisionalReply: other } }
  });
  const tools = [...sports.http.tools(), ...extraTools];
  const role = new RoleCatalog({
    version: "role-catalog-v1",
    roles: [
      {
        id: "sports",
        version: "1",
        bindingId: entryBindingId(r.catalog.models[0]),
        instructions: "Retrieve evidence. Preserve partial coverage.",
        toolIds: ["sports:find-games", ...extraTools.map((t) => t.id)],
        maxInputTokens: 6000
      }
    ]
  });
  const chat = new CapabilityChat(
    r.unusedFast,
    r.queue,
    r.timeline,
    r.manager,
    () => ({
      fastProvider: "mock",
      fastModel: "selected",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date(now).toISOString()
    }),
    () => tools,
    r.dispatch,
    role,
    engine
  );
  const service = new ChatService(
    chat,
    new DeepWorker(r.queue, r.unusedDeep, r.timeline),
    r.timeline,
    r.queue
  );
  service.resolveReferences = (selections, user, conversation) =>
    selectReferences(sports.http.directory!.results, selections, user, conversation);
  const submit = (id: string, fields: Partial<Parameters<typeof service.submitMessage>[0]> = {}) =>
    service.submitMessage({
      ...message("Find games", id),
      runControls: { roleId: "sports", mode: "chat", thinking: "configured" },
      ...fields
    });
  return {
    ...r,
    sports,
    chat,
    service,
    generate,
    other,
    transport,
    submit,
    setPlan: (p: unknown) => {
      plan = p;
    },
    expire: () => {
      now += 3600000;
    },
    close: () => sports.http.close()
  };
}
for (const engine of ["native", "langgraph"] as const)
  describe(`${engine} role integration parity`, () => {
    it("delivers sports payloads separately and injects only explicitly selected rows", async () => {
      const a = setup(engine);
      try {
        await a.submit("lookup");
        await a.chat.whenIdle();
        const result = (await a.timeline.getEvents("c")).find((e) => e.type === "refined")!
          .payloadResults![0];
        expect(result.context.coverage).toBe("partial");
        expect(result.payload?.rows).toHaveLength(2);
        a.setPlan({ action: "answer", message: "Evidence received" });
        await a.submit("no-reference");
        expect(JSON.stringify(a.generate.mock.calls.at(-1))).not.toContain("CANARY");
        await a.submit("selected", {
          referenceSelections: [{ resultId: result.context.resultId, rows: [0] }]
        });
        const input = JSON.stringify(a.generate.mock.calls.at(-1));
        expect(input).toContain("SELECTED_CANARY");
        expect(input).not.toContain("UNSELECTED_CANARY");
        expect(a.other).not.toHaveBeenCalled();
        expect(a.unusedFast.createProvisionalReply).not.toHaveBeenCalled();
      } finally {
        a.close();
      }
    });
    it("rejects foreign and expired evidence before model invocation", async () => {
      const a = setup(engine);
      try {
        await a.submit("lookup");
        await a.chat.whenIdle();
        const result = (await a.timeline.getEvents("c")).find((e) => e.type === "refined")!
          .payloadResults![0];
        const referenceSelections = [{ resultId: result.context.resultId, rows: [0] }];
        a.generate.mockClear();
        await expect(
          a.submit("foreign", { conversationId: "foreign", userId: "other", referenceSelections })
        ).rejects.toMatchObject({ code: "REFERENCE_SELECTION_UNAVAILABLE" });
        a.expire();
        await expect(a.submit("expired", { referenceSelections })).rejects.toMatchObject({
          code: "REFERENCE_SELECTION_UNAVAILABLE"
        });
        expect(a.generate).not.toHaveBeenCalled();
      } finally {
        a.close();
      }
    });
    it("honors the shared sports quota without hidden provider retries", async () => {
      const a = setup(engine);
      try {
        await a.submit("first");
        await a.chat.whenIdle();
        a.setPlan({
          action: "retrieve",
          calls: [
            { tool: "sports:find-games", arguments: { ...window, from: "2026-09-26T00:00:00Z" } }
          ]
        });
        await a.submit("second");
        await a.chat.whenIdle();
        const result = (await a.timeline.getEvents("c")).filter((e) => e.type === "refined").at(-1)!
          .payloadResults![0];
        expect(result.context.status).toBe("unavailable");
        expect(result.payload).toBeNull();
        expect(a.transport).toHaveBeenCalledTimes(1);
      } finally {
        a.close();
      }
    });
    it("rejects an inaccessible pinned model instead of substituting another model", async () => {
      const a = setup(engine);
      try {
        a.observations[0].access = "denied";
        await expect(a.submit("denied")).rejects.toThrow();
        expect(a.generate).not.toHaveBeenCalled();
        expect(a.other).not.toHaveBeenCalled();
        expect(a.transport).not.toHaveBeenCalled();
      } finally {
        a.close();
      }
    });
    it("enforces model-account admission before invoking either model", async () => {
      const a = setup(engine);
      try {
        a.policy.bindings.selected.quota = {
          poolId: "account",
          unit: "requests",
          remaining: 0,
          evidence
        };
        await expect(a.submit("quota-denied")).rejects.toThrow();
        expect(a.generate).not.toHaveBeenCalled();
        expect(a.other).not.toHaveBeenCalled();
        expect(a.transport).not.toHaveBeenCalled();
      } finally {
        a.close();
      }
    });
    it("keeps foreground chat responsive and suppresses late tool results after cancellation", async () => {
      let release!: (v: unknown) => void, started!: () => void;
      const gate = new Promise<unknown>((r) => {
          release = r;
        }),
        begun = new Promise<void>((r) => {
          started = r;
        });
      const execute = vi.fn(async () => {
        started();
        return gate;
      });
      const a = setup(engine, [
        { id: "held", description: "Held fixture", inputSchema: {}, validate: (v) => v, execute }
      ]);
      try {
        a.setPlan({ action: "retrieve", calls: [{ tool: "held", arguments: {} }] });
        await a.submit("held");
        await begun;
        a.setPlan({ action: "answer", message: "Foreground completed" });
        await a.submit("foreground");
        expect(
          (await a.timeline.getEvents("c")).some(
            (e) =>
              e.messageId === "foreground" &&
              e.type === "provisional" &&
              e.text === "Foreground completed"
          )
        ).toBe(true);
        a.service.cancelMessage("c", "held");
        release({ secret: "LATE_RESULT" });
        await a.chat.whenIdle();
        const events = await a.timeline.getEvents("c");
        expect(events.some((e) => e.messageId === "held" && e.type === "refined")).toBe(false);
        expect(
          events.some(
            (e) => e.messageId === "held" && e.type === "terminal" && e.finishReason === "cancelled"
          )
        ).toBe(true);
        expect(JSON.stringify(events)).not.toContain("LATE_RESULT");
      } finally {
        release({});
        await a.chat.whenIdle();
        a.close();
      }
    });
  });
