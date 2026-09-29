import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { GenerationError } from "../../src/domain/generation";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { createChatServer } from "../../src/server";
import { deriveTurns } from "../../src/ui/turnViewModel";
import { projectTurnEvent } from "../../src/app/protocolV1";
import { budget, entry, evidence, message, now, resources, runtime } from "../helpers/dispatchFixtures";

const specialists = () => [entry("chat", { roles: ["fast"], tasks: ["conversation"] }), entry("coder", { tasks: ["coding"] })];
describe("catalog dispatch integration", () => {
  it("selects fast coding for a short explanation and fast conversation plus deep coding for complex work", async () => {
    const r = runtime(specialists());
    const first = await r.service.submitMessage(message());
    expect(first.fastResponse.provisionalReply).toBe("coder");
    const second = await r.service.submitMessage(message("Compare and design code for a multi-file implementation", "turn-2"));
    expect(second.fastResponse.provisionalReply).toBe("chat");
    expect((await r.service.runDeepWorkerOnce())?.finalReply).toBe("coder");
    expect(r.unusedFast.createProvisionalReply).not.toHaveBeenCalled();
    expect(r.unusedDeep.resolveDeepTask).not.toHaveBeenCalled();
    expect(r.dispatch.telemetry().attempts.map(a => [a.phase, a.task])).toEqual([["fast", "coding"], ["fast", "conversation"], ["deep", "coding"]]);
  });
  it("retains newest whole pairs and sends identical frozen context to both providers", async () => {
    const entries = specialists(); entries[1].limits.contextTokens = 6000;
    const r = runtime(entries);
    for (let i = 0; i < 8; i++) {
      await r.timeline.appendEvent("c", { type: "user", messageId: `old-${i}`, text: "u".repeat(500), createdAtIso: now });
      await r.timeline.appendEvent("c", { type: "provisional", messageId: `old-${i}`, text: "a".repeat(500), processingStatus: "complete", createdAtIso: now });
    }
    await r.service.submitMessage(message("Compare and design code")); await r.service.runDeepWorkerOnce();
    const fastInput = vi.mocked(r.calls.get("chat")!.fast.createProvisionalReply).mock.calls[0][0];
    const deepInput = vi.mocked(r.calls.get("coder")!.deep.resolveDeepTask).mock.calls[0][0];
    expect(fastInput.context).toEqual(deepInput.context);
    const context = fastInput.context!;
    expect(context.includedTurnIds.length).toBeGreaterThan(0);
    expect(context.includedTurnIds.length).toBeLessThan(8);
    expect(context.includedTurnIds.at(-1)).toBe("old-7");
    expect(context.messages.length % 2).toBe(1);
    expect(context.estimatedInputTokens + budget.deepOutputTokens + budget.safetyTokens).toBeLessThanOrEqual(6000);
    await r.manager.shutdown();
  });
  it("keeps model and context frozen across catalog mutation and retry", async () => {
    const deep = { resolveDeepTask: vi.fn().mockRejectedValueOnce(new GenerationError("PROVIDER_UNAVAILABLE", true))
      .mockImplementation(async task => ({ taskId: task.taskId, finalReply: "done", finishReason: "stop", confidence: 1, citations: [], totalLatencyMs: 1 })) };
    const r = runtime(specialists(), { coder: { deep } });
    await r.service.submitMessage(message("Compare and design code"));
    r.catalog.models[1].model = "replacement"; r.catalog.models[1].enabled = false;
    await r.service.runDeepWorkerOnce(); await r.service.runDeepWorkerOnce();
    expect(deep.resolveDeepTask).toHaveBeenCalledTimes(2);
    expect(deep.resolveDeepTask.mock.calls[0][0].context).toEqual(deep.resolveDeepTask.mock.calls[1][0].context);
    expect(deep.resolveDeepTask.mock.calls[1][0].selection.bindingId).toContain("coder");
  });
  it("records explicit fallback with a new attempt and actual wire/UI labels", async () => {
    const r = runtime([entry("a"), entry("b")], { a: { fast: { createProvisionalReply: vi.fn().mockRejectedValue(new GenerationError("PROVIDER_UNAVAILABLE", true)) } } });
    r.policy.fallbackBindingIds.fast = [entryBindingId(r.catalog.models[1])];
    expect((await r.service.submitMessage(message())).fastResponse.provisionalReply).toBe("b");
    const events = await r.timeline.getEvents("c");
    const starts = events.filter(e => e.activity === "running");
    expect(starts.map(e => e.model?.model)).toEqual(["a", "b"]);
    expect(starts[0].attemptId).not.toBe(starts[1].attemptId);
    expect(starts[1].model?.selection?.reasons).toContain("explicit-fallback");
    expect(projectTurnEvent("c", starts[1])?.model?.bindingId).toBe(entryBindingId(r.catalog.models[1]));
    expect(deriveTurns(events)[0].answers[0].model).toBe("b");
    const original = vi.mocked(r.calls.get("a")!.fast.createProvisionalReply).mock.calls[0][0].context!;
    const fallback = vi.mocked(r.calls.get("b")!.fast.createProvisionalReply).mock.calls[0][0].context!;
    expect(fallback.messages).toEqual(original.messages);
    expect(fallback.systemInstruction).toContain("Fast responder: mock/b");
    expect(fallback.snapshotId).not.toBe(original.snapshotId);
  });
  it.each(["PROVIDER_AUTH", "CONTEXT_TOO_LARGE", "CANCELLED"])("never falls back on %s", async code => {
    const r = runtime([entry("a"), entry("b")], { a: { fast: { createProvisionalReply: vi.fn().mockRejectedValue(new GenerationError(code, false)) } } });
    r.policy.fallbackBindingIds.fast = [entryBindingId(r.catalog.models[1])];
    await r.service.submitMessage(message()).catch(() => undefined);
    expect(r.calls.get("b")!.fast.createProvisionalReply).not.toHaveBeenCalled();
  });
  it("never falls back after text emission", async () => {
    const fast = { createProvisionalReply: vi.fn(async (_input, control) => { await control!.onDelta("partial"); throw new GenerationError("PROVIDER_UNAVAILABLE", true); }) };
    const r = runtime([entry("a"), entry("b")], { a: { fast } });
    r.policy.fallbackBindingIds.fast = [entryBindingId(r.catalog.models[1])];
    await expect(r.service.submitMessage(message())).rejects.toThrow("PROVIDER_UNAVAILABLE");
    expect(r.calls.get("b")!.fast.createProvisionalReply).not.toHaveBeenCalled();
  });
  it("blocks fallback that cannot fit the already-selected history", async () => {
    const r = runtime([entry("a"), entry("b", { limits: { contextTokens: 3000, maxOutputTokens: 2048 } })],
      { a: { fast: { createProvisionalReply: vi.fn().mockRejectedValue(new GenerationError("PROVIDER_UNAVAILABLE", true)) } } });
    for (let i = 0; i < 3; i++) {
      await r.timeline.appendEvent("c", { type: "user", messageId: `old-${i}`, text: "u".repeat(600), createdAtIso: now });
      await r.timeline.appendEvent("c", { type: "provisional", messageId: `old-${i}`, text: "a".repeat(600), processingStatus: "complete", createdAtIso: now });
    }
    r.policy.fallbackBindingIds.fast = [entryBindingId(r.catalog.models[1])];
    await expect(r.service.submitMessage(message())).rejects.toThrow();
    expect(r.calls.get("b")!.fast.createProvisionalReply).not.toHaveBeenCalled();
  });
  it("RES-07: exhausted allowance never causes an unapproved metered fallback", async () => {
    const r = runtime([entry("a"), entry("b")], { a: { fast: { createProvisionalReply: vi.fn().mockRejectedValue(new GenerationError("PROVIDER_UNAVAILABLE", true)) } } });
    r.policy.maxIncrementalUsd = 1; r.policy.allowedBillingComponents.push("metered-usage");
    r.policy.bindings.a = resources({ quota: { poolId: "included", unit: "requests", remaining: 1, evidence } });
    r.policy.bindings.b = resources({ facts: { executionScope: "local-device", billingComponents: ["metered-usage"] },
      incremental: { currency: "USD", maxInvocationUsd: 0.1, evidence } });
    r.policy.fallbackBindingIds.fast = [entryBindingId(r.catalog.models[1])];
    await expect(r.service.submitMessage(message())).rejects.toThrow("QUOTA_EXHAUSTED");
    expect(r.calls.get("b")!.fast.createProvisionalReply).not.toHaveBeenCalled();
  });
  it("RES-05/06: cancellation releases queued work while retaining in-flight usage as unsettled", async () => {
    const fast = { createProvisionalReply: vi.fn((_input, control) => new Promise<never>((_resolve, reject) => {
      control!.signal.addEventListener("abort", () => reject(new GenerationError("CANCELLED", false)), { once: true });
    })) };
    const r = runtime(specialists(), { chat: { fast } });
    const pending = r.service.submitMessage(message("Compare and design code"));
    await vi.waitFor(() => expect(fast.createProvisionalReply).toHaveBeenCalled());
    await r.service.cancelMessage("c", "turn-1"); await pending;
    expect(r.dispatch.admission.snapshot().map(c => c.status)).toEqual(["unsettled", "released"]);
    await r.service.runDeepWorkerOnce();
    expect(r.calls.get("coder")!.deep.resolveDeepTask).not.toHaveBeenCalled();
  });
  it("labels overlapping coding/conversation turns by their own selected model", async () => {
    let release!: () => void;
    const fast = { createProvisionalReply: vi.fn(async () => { await new Promise<void>(r => { release = r; }); return { text: "code", finishReason: "stop" as const }; }) };
    const r = runtime(specialists(), { coder: { fast } });
    const slow = r.service.submitMessage(message());
    await vi.waitFor(() => expect(fast.createProvisionalReply).toHaveBeenCalled());
    await r.service.submitMessage(message("Hello my friend", "turn-2")); release(); await slow;
    expect(deriveTurns(await r.timeline.getEvents("c")).map(t => [t.messageId, t.answers[0].model]))
      .toEqual([["turn-1", "coder"], ["turn-2", "chat"]]);
  });
  it("returns 503 without timeline, queue or provider work and explicitly rejects image/tool payloads", async () => {
    const r = runtime([entry("chat", { tasks: ["conversation"] })]);
    const server = createChatServer(r.service);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...message(), messageId: undefined }) });
      expect(response.status).toBe(503); expect((await response.json()).code).toBe("NO_ELIGIBLE_MODEL");
      expect(await r.timeline.getEvents("c")).toEqual([]); expect(r.queue.size()).toBe(0);
      expect(r.calls.get("chat")!.fast.createProvisionalReply).not.toHaveBeenCalled();
      const unsupported = await fetch(`${base}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...message(), messageId: undefined, images: ["x"] }) });
      expect(unsupported.status).toBe(400); expect((await unsupported.json()).code).toBe("CAPABILITY_UNSUPPORTED");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("summary calls share the same ledger and cannot bypass an exhausted pool", async () => {
    const r = runtime();
    r.policy.bindings.a = resources({ quota: { poolId: "all", unit: "requests", remaining: 1, evidence } });
    await r.service.submitMessage(message());
    const provider = { createProvisionalReply: vi.fn() };
    const wrapped = r.dispatch.wrapSummary(provider, entryBindingId(r.catalog.models[0]), 100);
    const context = vi.mocked(r.calls.get("a")!.fast.createProvisionalReply).mock.calls[0][0].context!;
    await expect(wrapped.createProvisionalReply({ message: message(), correctedText: "summarize", routeDecision: "direct", context },
      { signal: new AbortController().signal, attemptId: "summary", onDelta: async () => {} })).rejects.toThrow("No eligible model");
    expect(provider.createProvisionalReply).not.toHaveBeenCalled();
  });
});

it("revalidates access before retry without switching credentials or making another call", async () => {
  const r = runtime(specialists(), { coder: { deep: { resolveDeepTask: vi.fn().mockRejectedValue(new GenerationError("PROVIDER_UNAVAILABLE", true)) } } });
  await r.service.submitMessage(message("Compare and design code"));
  await r.service.runDeepWorkerOnce();
  r.observations[1].access = "denied";
  await r.service.runDeepWorkerOnce();
  expect(r.calls.get("coder")!.deep.resolveDeepTask).toHaveBeenCalledTimes(1);
  expect((await r.timeline.getEvents("c")).at(-1)?.errorCode).toBe("BINDING_OBSERVATION_CHANGED_OR_STALE");
});

it("rejects malformed JSON output rather than accepting it as a completed structured answer", async () => {
  const r = runtime();
  await expect(r.service.submitMessage(message("Return valid JSON"))).rejects.toThrow("STRUCTURED_OUTPUT_INVALID");
  const events = await r.timeline.getEvents("c");
  expect(events.some(e => e.type === "provisional" && e.processingStatus === "complete")).toBe(false);
  expect(events.at(-1)?.errorCode).toBe("STRUCTURED_OUTPUT_INVALID");
});

it("rolls back unstarted pair reservations when timeline persistence fails", async () => {
  const r = runtime(specialists());
  vi.spyOn(r.timeline, "appendEvent").mockRejectedValueOnce(new Error("write failed"));
  await expect(r.service.submitMessage(message("Compare and design code"))).rejects.toThrow("write failed");
  expect(r.dispatch.admission.snapshot().map(c => c.status)).toEqual(["released", "released"]);
  expect(r.queue.size()).toBe(0);
});

it("allows at most one explicit fallback per phase", async () => {
  const fail = () => ({ createProvisionalReply: vi.fn().mockRejectedValue(new GenerationError("PROVIDER_UNAVAILABLE", true)) });
  const r = runtime([entry("a"), entry("b"), entry("c")], { a: { fast: fail() }, b: { fast: fail() } });
  r.policy.fallbackBindingIds.fast = r.catalog.models.slice(1).map(entryBindingId);
  await expect(r.service.submitMessage(message())).rejects.toThrow("PROVIDER_UNAVAILABLE");
  expect(r.calls.get("a")!.fast.createProvisionalReply).toHaveBeenCalledTimes(1);
  expect(r.calls.get("b")!.fast.createProvisionalReply).toHaveBeenCalled();
  expect(r.calls.get("c")!.fast.createProvisionalReply).not.toHaveBeenCalled();
});
