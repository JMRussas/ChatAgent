import { evidenceCitationId } from "../../src/app/evidenceCitations";
import { projectTurnEvent } from "../../src/app/protocolV1";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilityChat } from "../../src/app/capabilityChat";
import { RoleCatalog } from "../../src/app/roleCatalog";
import { ContextManager } from "../../src/app/contextManager";
import { ToolResultStore } from "../../src/app/toolResult";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue, type FastModelProvider } from "../../src/providers/interfaces";
import { runControlsSchema } from "../../src/app/runControls";
afterEach(() => vi.useRealTimers());
function setup(
  engine: "native" | "langgraph" = "native",
  evidenceLimits?: { deadlineMs?: number; maxEvidenceBytes?: number },
  outputContract: "answer-evidence-v1" | "answer-evidence-v2" = "answer-evidence-v2"
) {
  const store = new ToolResultStore(),
    timeline = new InMemoryConversationTimelineStore(),
    queue = new InMemoryTaskQueue();
  const result = store.put("u", "c", {
    version: "tool-result-v1",
    context: {
      status: "ready",
      summary: "Scores",
      scope: "fixture",
      coverage: "partial",
      limitations: ["Not a play-by-play recap"],
      expiresAt: new Date(Date.now() + 120000).toISOString()
    },
    payload: {
      kind: "table",
      title: "Scores",
      columns: ["Team", "Score"],
      rows: [
        ["SECRET_UNSELECTED", "9"],
        ["Comets", "101"]
      ]
    },
    evidence: {
      sourceUrl: "https://example.invalid",
      observedAt: new Date().toISOString(),
      revision: "v1"
    }
  });
  const output = {
    status: "answer",
    scope: "selected_rows",
    claims: [
      {
        text: "Comets scored 101.",
        citations: [
          outputContract === "answer-evidence-v1"
            ? { resultId: result.context.resultId, row: 1, column: 1, quote: "101" }
            : evidenceCitationId(result.context.resultId, 1, 1)
        ]
      }
    ],
    limitations: []
  };
  const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
    text: JSON.stringify(output),
    finishReason: "stop"
  }));
  const execute = vi.fn();
  const role = new RoleCatalog({
    version: "role-catalog-v1",
    roles: [
      {
        id: "writer",
        version: "1",
        bindingId: "fixed",
        instructions: "Use supplied evidence.",
        toolIds: [],
        maxToolCalls: 0,
        maxInputTokens: 10000,
        outputContract,
        evidenceLimits
      }
    ]
  });
  const chat = new CapabilityChat(
    { createProvisionalReply: generate },
    queue,
    timeline,
    new ContextManager(timeline, {
      windowTokens: 16384,
      maxHistoryTurns: 12,
      safetyTokens: 256,
      fastOutputTokens: 1024,
      deepOutputTokens: 2048
    }),
    () => ({
      fastProvider: "test",
      fastModel: "test",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date().toISOString()
    }),
    () => [
      {
        id: "forbidden",
        description: "TOOL_SCHEMA_CANARY",
        inputSchema: {},
        validate: (v) => v,
        execute
      }
    ],
    undefined,
    role,
    engine,
    () => store
  );
  const message = {
    messageId: "m",
    conversationId: "c",
    userId: "u",
    text: "What is the score?",
    timestampIso: new Date().toISOString(),
    referenceSelections: [{ resultId: result.context.resultId, rows: [1] }],
    runControls: {
      mode: "answer-evidence" as const,
      thinking: "configured" as const,
      roleId: "writer"
    }
  };
  return { chat, store, timeline, generate, execute, message, output, result };
}
it.each(["native", "langgraph"] as const)(
  "%s answers only selected evidence and preserves grading limits",
  async (engine) => {
    const a = setup(engine);
    const reply = await a.chat.handleUserMessage(a.message);
    expect(reply.fastResponse.provisionalReply).toContain("Comets scored 101.");
    expect(reply.fastResponse.provisionalReply).toContain("Not a play-by-play recap");
    expect(reply.fastResponse.provisionalReply).toContain("Factual quality: ungraded");
    expect(a.generate).toHaveBeenCalledTimes(1);
    expect(a.execute).not.toHaveBeenCalled();
    const prompt = JSON.stringify(a.generate.mock.calls);
    expect(prompt).not.toContain("SECRET_UNSELECTED");
    expect(prompt).not.toContain("TOOL_SCHEMA_CANARY");
    const event = (await a.timeline.getEvents("c")).find((e) => e.groundedAnswer)!;
    expect(event.groundedAnswer).toMatchObject({
      citationChecks: "passed",
      semanticGrounding: "ungraded"
    });
    expect(projectTurnEvent("c", event)?.groundedAnswer).toEqual(event.groundedAnswer);
  }
);
it("requires owned evidence before inference and rejects mismatched role actions", async () => {
  const a = setup();
  await expect(a.chat.handleUserMessage({ ...a.message, userId: "other" })).rejects.toThrow(
    "RESULT_NOT_FOUND"
  );
  await expect(
    a.chat.handleUserMessage({ ...a.message, messageId: "empty", referenceSelections: [] })
  ).rejects.toThrow("ANSWER_EVIDENCE_REQUIRED");
  await expect(
    a.chat.handleUserMessage({
      ...a.message,
      messageId: "chat",
      runControls: { ...a.message.runControls, mode: "chat" }
    })
  ).rejects.toMatchObject({ code: "ROLE_OUTPUT_CONTRACT_MISMATCH" });
  expect(a.generate).not.toHaveBeenCalled();
  expect(runControlsSchema.parse({ mode: "answer-evidence" }).targetMessageId).toBeUndefined();
});
it("rejects fabricated citations and tool requests without publishing or executing them", async () => {
  const a = setup();
  a.output.claims[0].citations[0] = "c_0000000000000000";
  await expect(a.chat.handleUserMessage(a.message)).rejects.toThrow("ANSWER_CITATION_INVALID");
  a.generate.mockResolvedValueOnce({
    text: JSON.stringify({ action: "retrieve", calls: [{ tool: "forbidden", arguments: {} }] }),
    finishReason: "stop"
  });
  await expect(a.chat.handleUserMessage({ ...a.message, messageId: "tools" })).rejects.toThrow();
  expect(a.execute).not.toHaveBeenCalled();
  expect((await a.timeline.getEvents("c")).filter((e) => e.type === "provisional")).toHaveLength(0);
});
it.each(["native", "langgraph"] as const)(
  "%s suppresses cancelled output and drains the provider",
  async (engine) => {
    const a = setup(engine);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (started = r));
    a.generate.mockImplementationOnce(async () => {
      started();
      await gate;
      return { text: JSON.stringify(a.output), finishReason: "stop" };
    });
    let settled = false;
    const work = a.chat
      .handleUserMessage(a.message)
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    await ready;
    await a.chat.cancel("c", "m");
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    release();
    await work;
    expect((await a.timeline.getEvents("c")).filter((e) => e.groundedAnswer)).toHaveLength(0);
  }
);
it("blocks reload-invalidated evidence and late output", async () => {
  const a = setup();
  a.generate.mockImplementationOnce(async () => {
    a.store.clear();
    return { text: JSON.stringify(a.output), finishReason: "stop" };
  });
  await expect(a.chat.handleUserMessage(a.message)).rejects.toThrow("RESULT_NOT_FOUND");
  vi.useFakeTimers();
  const b = setup();
  b.generate.mockImplementationOnce(async () => {
    await vi.advanceTimersByTimeAsync(60000);
    return { text: JSON.stringify(b.output), finishReason: "stop" };
  });
  await expect(b.chat.handleUserMessage(b.message)).rejects.toThrow("WORKFLOW_DEADLINE");
  expect((await b.timeline.getEvents("c")).filter((e) => e.groundedAnswer)).toHaveLength(0);
});

it("honors configured role evidence limits", async () => {
  const a = setup("native", { maxEvidenceBytes: 1 });
  await expect(a.chat.handleUserMessage(a.message)).rejects.toThrow("ANSWER_EVIDENCE_LIMIT");
  expect(a.generate).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const b = setup("native", { deadlineMs: 10 });
  b.generate.mockImplementationOnce(async () => {
    await vi.advanceTimersByTimeAsync(10);
    return { text: JSON.stringify(b.output), finishReason: "stop" };
  });
  await expect(b.chat.handleUserMessage(b.message)).rejects.toThrow("WORKFLOW_DEADLINE");
});

it("rejects evidence roles that advertise tools or nonzero tool budgets", () => {
  for (const config of [
    { toolIds: ["lookup"], maxToolCalls: 1 },
    { toolIds: [], maxToolCalls: 1 }
  ]) {
    expect(
      () =>
        new RoleCatalog({
          version: "role-catalog-v1",
          roles: [
            {
              id: "writer",
              version: "1",
              bindingId: "fixed",
              instructions: "Write",
              outputContract: "answer-evidence-v2",
              ...config
            }
          ]
        })
    ).toThrow("Evidence-answer roles");
  }
});

it("preserves explicit v1 roles and canonical citation storage", async () => {
  const a = setup("native", undefined, "answer-evidence-v1");
  await a.chat.handleUserMessage(a.message);
  expect(
    (await a.timeline.getEvents("c")).find((e) => e.groundedAnswer)?.groundedAnswer
  ).toMatchObject({ answer: { claims: [{ citations: [{ row: 1, column: 1, quote: "101" }] }] } });
  expect(a.generate.mock.calls[0][0].context?.systemInstruction).toContain("ORIGINAL index");
  expect(a.generate.mock.calls[0][0].context?.systemInstruction).not.toContain(
    "additional uncertainty"
  );
});

it("publishes compact answers and deduplicated references without leaking payload into history", async () => {
  const a = setup();
  // This issued table fits the 16K evidence limit. Repeated citations expand its
  // long source URL used to expand beyond 1 MiB despite tiny model JSON.
  const result = a.store.put("u", "c", {
    ...a.result,
    context: { ...a.result.context },
    evidence: { ...a.result.evidence, sourceUrl: "https://example.invalid/" + "x".repeat(11000) }
  });
  const citation = evidenceCitationId(result.context.resultId, 1, 1);
  a.generate.mockResolvedValueOnce({
    text: JSON.stringify({
      status: "answer",
      scope: "selected_rows",
      claims: Array.from({ length: 20 }, () => ({
        text: "Comets scored 101.",
        citations: Array(10).fill(citation)
      })),
      limitations: []
    }),
    finishReason: "stop"
  });
  const reply = await a.chat.handleUserMessage({
    ...a.message,
    referenceSelections: [{ resultId: result.context.resultId, rows: [1] }],
    runControls: { mode: "answer-evidence", thinking: "configured" }
  });
  expect(reply.fastResponse.provisionalReply).toContain("Comets scored 101. [1]");
  expect(reply.fastResponse.provisionalReply).not.toContain(result.evidence.sourceUrl);
  expect(Buffer.byteLength(reply.fastResponse.provisionalReply)).toBeLessThan(2000);
  const event = (await a.timeline.getEvents("c")).find((e) => e.answerReferences)!;
  expect(event.answerReferences?.sources).toHaveLength(1);
  expect(event.answerReferences?.citations).toHaveLength(1);
  expect(event.answerReferences?.sources[0].url).toBe(result.evidence.sourceUrl);
  expect(projectTurnEvent("c", event)?.answerReferences).toEqual(event.answerReferences);
  a.generate.mockResolvedValueOnce({
    text: JSON.stringify({ action: "answer", message: "Ready" }),
    finishReason: "stop"
  });
  await a.chat.handleUserMessage({
    ...a.message,
    messageId: "followup",
    referenceSelections: [],
    runControls: { mode: "chat", thinking: "configured" }
  });
  expect(JSON.stringify(a.generate.mock.calls[1][0].context)).not.toContain(
    result.evidence.sourceUrl
  );
});

it("reviews selected citations with explicit mappings, and labels text-only scope", async () => {
  const a = setup();
  await a.chat.handleUserMessage(a.message);
  a.generate.mockResolvedValueOnce({
    text: JSON.stringify({ action: "answer", message: "Selected score is supported" }),
    finishReason: "stop"
  });
  const review = {
    ...a.message,
    messageId: "review",
    runControls: {
      mode: "review" as const,
      thinking: "configured" as const,
      targetMessageId: "m",
      reviewScope: "selected-evidence" as const
    }
  };
  await a.chat.handleUserMessage(review);
  const prompt = a.generate.mock.calls[1][0].context!.systemInstruction;
  expect(prompt).toContain('"marker":1');
  expect(prompt).toContain(evidenceCitationId(a.result.context.resultId, 1, 1));
  expect(prompt).not.toContain("SECRET_UNSELECTED");
  await expect(
    a.chat.handleUserMessage({ ...review, messageId: "none", referenceSelections: [] })
  ).rejects.toThrow("ANSWER_EVIDENCE_REQUIRED");
  await expect(
    a.chat.handleUserMessage({
      ...review,
      messageId: "unrelated",
      referenceSelections: [{ resultId: a.result.context.resultId, rows: [0] }]
    })
  ).rejects.toThrow("REVIEW_EVIDENCE_MISMATCH");
  a.generate.mockResolvedValueOnce({
    text: JSON.stringify({ action: "answer", message: "Clear wording" }),
    finishReason: "stop"
  });
  const text = await a.chat.handleUserMessage({
    ...review,
    messageId: "text",
    referenceSelections: [],
    runControls: { ...review.runControls, reviewScope: "text-only" }
  });
  expect(text.fastResponse.provisionalReply).toContain(
    "citations and factual grounding were not verified"
  );
  expect(a.generate.mock.calls[2][0].context!.systemInstruction).not.toContain(
    a.result.context.resultId
  );
});
it("revisions rebuild references through the grounded output contract", async () => {
  const a = setup();
  await a.chat.handleUserMessage(a.message);
  await a.chat.handleUserMessage({
    ...a.message,
    messageId: "revision",
    runControls: {
      mode: "revise",
      thinking: "configured",
      targetMessageId: "m",
      reviewScope: "selected-evidence"
    }
  });
  const events = await a.timeline.getEvents("c");
  expect(events.filter((e) => e.answerReferences)).toHaveLength(2);
  expect(
    events.find((e) => e.messageId === "revision" && e.answerReferences)?.answerReferences
      ?.citations[0].row
  ).toBe(1);
  a.generate.mockImplementationOnce(async () => {
    a.store.clear();
    return { text: JSON.stringify({ action: "answer", message: "late" }), finishReason: "stop" };
  });
  await expect(
    a.chat.handleUserMessage({
      ...a.message,
      messageId: "expired-review",
      runControls: {
        mode: "review",
        thinking: "configured",
        targetMessageId: "m",
        reviewScope: "selected-evidence"
      }
    })
  ).rejects.toThrow("RESULT_NOT_FOUND");
});
it("selected reviews reject foreign, expired and cancelled evidence before publication", async () => {
  const a = setup();
  await a.chat.handleUserMessage(a.message);
  const review = {
    ...a.message,
    messageId: "review",
    runControls: {
      mode: "review" as const,
      reviewScope: "selected-evidence" as const,
      thinking: "configured" as const,
      targetMessageId: "m"
    }
  };
  await expect(a.chat.handleUserMessage({ ...review, userId: "other" })).rejects.toThrow(
    "RESULT_NOT_FOUND"
  );
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 180000);
  await expect(a.chat.handleUserMessage({ ...review, messageId: "expired" })).rejects.toThrow(
    "ANSWER_EVIDENCE_EXPIRED"
  );
  vi.useRealTimers();
  const b = setup();
  await b.chat.handleUserMessage(b.message);
  b.generate.mockImplementationOnce(async (_input, control) => {
    await b.chat.cancel("c", "cancel-review");
    control!.signal.throwIfAborted();
    return { text: "", finishReason: "stop" };
  });
  await expect(
    b.chat.handleUserMessage({
      ...b.message,
      messageId: "cancel-review",
      runControls: review.runControls
    })
  ).rejects.toThrow("CANCELLED");
  expect(
    (await b.timeline.getEvents("c")).filter(
      (e) => e.messageId === "cancel-review" && e.type === "provisional"
    )
  ).toHaveLength(0);
});
