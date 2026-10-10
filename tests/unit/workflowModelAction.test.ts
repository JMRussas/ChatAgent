import { describe, expect, it, vi } from "vitest";
import { workflowModelAction } from "../../src/workflows/modelAction";
import type { WorkflowContext } from "../../src/workflows/types";
import type { FastModelProvider } from "../../src/providers/interfaces";
import type { GenerationResult } from "../../src/domain/generation";

const budget = {
  windowTokens: 64000,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 1024,
  deepOutputTokens: 2048
};
const facts = () => ({
  fastProvider: "test",
  fastModel: "summary",
  deepProvider: "test",
  deepModel: "summary",
  generatedAtIso: new Date().toISOString()
});
const caller: WorkflowContext = {
  principal: { principalId: "owner", roles: new Set(["client"]), via: "session" },
  operationId: "model-step"
};

describe("workflow model action", () => {
  it("preserves a complete provider answer, metadata and reported usage", async () => {
    const usage = { source: "provider-response" as const, inputTokens: 20, outputTokens: 8 };
    const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
      text: "The report contains three items.\nAll three need review.",
      finishReason: "stop",
      usage
    }));
    const metadata = { provider: "test", model: "summary" };
    const action = workflowModelAction(
      { createProvisionalReply: generate, metadata },
      budget,
      facts
    );
    expect(await action("Summarize the report", { items: 3 }, caller)).toEqual({
      text: "The report contains three items.\nAll three need review.",
      model: metadata,
      usage
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0].message.text).toContain("Summarize the report");
    expect(generate.mock.calls[0]![0].message.text).toContain('"items":3');
  });

  it("refuses a truncated answer as an incomplete workflow result", async () => {
    const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => ({
      text: "An unfinished summary",
      finishReason: "length"
    }));
    const action = workflowModelAction({ createProvisionalReply: generate }, budget, facts);
    await expect(action("Summarize", {}, caller)).rejects.toMatchObject({
      code: "MODEL_INCOMPLETE",
      status: 502
    });
  });

  it("discards a completed answer returned after cancellation", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reply!: (result: GenerationResult) => void;
    const lateReply = new Promise<GenerationResult>((resolve) => {
      reply = resolve;
    });
    const generate = vi.fn<FastModelProvider["createProvisionalReply"]>(async () => {
      entered();
      return lateReply;
    });
    const action = workflowModelAction({ createProvisionalReply: generate }, budget, facts);
    const controller = new AbortController();
    const pending = action("Summarize", {}, { ...caller, signal: controller.signal });
    await started;
    controller.abort();
    reply({ text: "Late complete answer", finishReason: "stop" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(generate.mock.calls[0]![1]?.signal.aborted).toBe(true);
  });
});
