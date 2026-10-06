import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { CapabilityChat } from "../../src/app/capabilityChat";
import { GenerationError } from "../../src/domain/generation";
import { ToolResultStore } from "../../src/app/toolResult";
import { abortableSleep } from "../../src/routing/resourceAdmission";
import { allowAllTestAuth } from "../helpers/testAuth";
import { entry, evidence, message, resources, runtime } from "../helpers/dispatchFixtures";
import { entryBindingId } from "../../src/providers/providerRegistry";
import type { FastModelProvider } from "../../src/providers/interfaces";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Runtime = ReturnType<typeof runtime>;
/** Every binding draws on one quota pool with room for one request, held by the test. */
function blockOnQuota(r: Runtime, quotaIds = Object.keys(r.policy.bindings)) {
  r.policy.quotaExhaustionAction = "wait";
  r.policy.waitTimeoutMs = 300_000;
  const quota = { poolId: "pool", unit: "requests" as const, remaining: 1, evidence };
  for (const id of quotaIds) r.policy.bindings[id] = resources({ quota });
  const [hold] = r.dispatch.admission.reserve([
    { resources: r.policy.bindings[quotaIds[0]], inputTokens: 0, outputTokens: 0 }
  ]);
  return hold;
}
const input = (routeDecision: "direct" | "deep" = "direct") => ({
  conversationId: "c",
  currentMessageId: "turn-1",
  currentUserText: "Explain code",
  trustedFacts: {
    fastProvider: "mock",
    fastModel: "mock",
    deepProvider: "mock",
    deepModel: "mock",
    generatedAtIso: new Date().toISOString()
  },
  routeDecision
});
const live = (r: Runtime) =>
  r.dispatch.telemetry().reservations.filter((v) => v.status === "reserved");
/** Resolves once the admission ledger has been asked to wait at least once. */
async function waiting(r: Runtime) {
  const spy = vi.mocked(r.dispatch.admission.reserve);
  await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e as { code?: string }).code ?? String(e)
  );

describe("abortable admission sleep", () => {
  it("settles on abort and leaves no timer or listener behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const slept = abortableSleep(10_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await slept;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    // And on timeout, the listener is removed as well.
    const other = new AbortController();
    const removeOther = vi.spyOn(other.signal, "removeEventListener");
    const timed = abortableSleep(5, other.signal);
    await vi.advanceTimersByTimeAsync(5);
    await timed;
    expect(removeOther).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch preparation", () => {
  it("does no capture or reservation when already aborted", async () => {
    const r = runtime();
    const capture = vi.spyOn(r.manager, "capture");
    const reserve = vi.spyOn(r.dispatch.admission, "reserve");
    expect(await code(r.dispatch.prepare(r.manager, input(), undefined, AbortSignal.abort()))).toBe(
      "CANCELLED"
    );
    expect(capture).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["a cancel", new GenerationError("CANCELLED", false), "CANCELLED"],
    ["a deadline", new GenerationError("WORKFLOW_DEADLINE", false), "WORKFLOW_DEADLINE"]
  ])(
    "ends a quota wait on %s with its own code, without trying other candidates",
    async (_, reason, expected) => {
      // b has free capacity: an abort mistaken for an exclusion would fall back to it.
      const r = runtime([entry("a"), entry("b")]);
      const hold = blockOnQuota(r, ["a"]);
      r.policy.fallbackBindingIds = { fast: [], deep: [] };
      vi.spyOn(r.dispatch.admission, "reserve");
      const controller = new AbortController();
      const prepared = code(
        r.dispatch
          .prepare(r.manager, input(), entryBindingId(entry("a")), controller.signal)
          .catch((e) => {
            throw e;
          })
      );
      const unscoped = new AbortController();
      const anyCandidate = code(r.dispatch.prepare(r.manager, input(), undefined, unscoped.signal));
      await waiting(r);
      const started = Date.now();
      controller.abort(reason);
      unscoped.abort(reason);
      expect(await prepared).toBe(expected);
      expect(await anyCandidate).toBe(expected);
      expect(Date.now() - started).toBeLessThan(1_000);
      // Only the test's own hold is reserved: b was never reserved.
      expect(live(r).map((v) => v.id)).toEqual([hold]);
      expect(r.dispatch.retentionStats().phases).toBe(0);
    }
  );

  it("releases fast and deep reservations when aborted right after reserving", async () => {
    const r = runtime();
    const controller = new AbortController();
    const reserveWithWait = r.dispatch.admission.reserveWithWait.bind(r.dispatch.admission);
    vi.spyOn(r.dispatch.admission, "reserveWithWait").mockImplementation(async (...args) => {
      const tickets = await reserveWithWait(...args);
      controller.abort(new GenerationError("CANCELLED", false));
      return tickets;
    });
    expect(
      await code(r.dispatch.prepare(r.manager, input("deep"), undefined, controller.signal))
    ).toBe("CANCELLED");
    const reservations = r.dispatch.telemetry().reservations;
    expect(reservations).toHaveLength(2);
    expect(reservations.every((v) => v.status === "released" && !v.started)).toBe(true);
    expect(r.dispatch.retentionStats().phases).toBe(0);
  });

  it("rolls back reservations and registered phases when scheduling the capture throws", async () => {
    const r = runtime();
    const capture = r.manager.capture.bind(r.manager);
    vi.spyOn(r.manager, "capture").mockImplementation(async (...args) => {
      const captured = await capture(...args);
      captured.schedule = () => {
        throw new Error("summary scheduling failed");
      };
      return captured;
    });
    await expect(r.dispatch.prepare(r.manager, input("deep"))).rejects.toThrow(
      "summary scheduling failed"
    );
    expect(r.dispatch.telemetry().reservations.every((v) => v.status === "released")).toBe(true);
    expect(r.dispatch.retentionStats().phases).toBe(0);
  });

  it("rolls back the fast phase and both reservations when creating the deep phase throws", async () => {
    const r = runtime();
    const fast = r.policy.fallbackBindingIds.fast;
    r.policy.fallbackBindingIds = {
      fast,
      get deep(): string[] {
        throw new Error("deep phase failed");
      }
    };
    const phases = vi.spyOn(Map.prototype, "set");
    await expect(r.dispatch.prepare(r.manager, input("deep"))).rejects.toThrow("deep phase failed");
    // The fast phase had been registered before the deep one failed.
    expect(phases.mock.calls.some(([, v]) => (v as { role?: string })?.role === "fast")).toBe(true);
    phases.mockRestore();
    const reservations = r.dispatch.telemetry().reservations;
    expect(reservations).toHaveLength(2);
    expect(reservations.every((v) => v.status === "released")).toBe(true);
    expect(r.dispatch.retentionStats().phases).toBe(0);
  });

  it("still succeeds once held quota is released without a cancel", async () => {
    const r = runtime();
    const hold = blockOnQuota(r);
    vi.spyOn(r.dispatch.admission, "reserve");
    const controller = new AbortController();
    const prepared = r.dispatch.prepare(r.manager, input(), undefined, controller.signal);
    await waiting(r);
    r.dispatch.admission.release(hold);
    const plan = await prepared;
    expect(plan.fast.ticket).toBeDefined();
    expect(live(r).map((v) => v.id)).toEqual([plan.fast.ticket]);
  });
});

describe("legacy turn cancelled while waiting for admission", () => {
  async function serve(r: Runtime) {
    const server = createChatServer(r.service, { auth: allowAllTestAuth });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
  }

  it("answers the cancel, rejects the turn with 409 and leaves no trace", async () => {
    const r = runtime();
    const hold = blockOnQuota(r);
    vi.spyOn(r.dispatch.admission, "reserve");
    const s = await serve(r);
    const turn = message("Explain code", randomUUID());
    try {
      const posted = fetch(`${s.base}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(turn)
      });
      await waiting(r);
      const cancel = await fetch(`${s.base}/conversations/c/messages/${turn.messageId}/cancel`, {
        method: "POST"
      });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({
        messageId: turn.messageId,
        phases: {},
        preparation: "cancelled"
      });
      const response = await posted;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Generation cancelled", code: "CANCELLED" });
      expect(await r.timeline.getEvents("c")).toEqual([]);
      expect(r.queue.size()).toBe(0);
      expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
      expect(r.calls.get("a")!.deep.resolveDeepTask).not.toHaveBeenCalled();
      expect(live(r).map((v) => v.id)).toEqual([hold]);
      expect(r.orchestrator.retentionStats().preparing).toBe(0);
      // An unknown message is still not found.
      const unknown = await fetch(`${s.base}/conversations/c/messages/other/cancel`, {
        method: "POST"
      });
      expect(unknown.status).toBe(404);
      // Nothing entered history, so the message can be sent again once quota frees.
      r.dispatch.admission.release(hold);
      const again = await fetch(`${s.base}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(turn)
      });
      expect(again.status).toBe(200);
      expect((await again.json()).fastResponse.processingStatus).not.toBe("cancelled");
    } finally {
      await s.close();
    }
  });

  /** Holds the turn's history check (the read inside claimMessage) until released. */
  function holdHistoryRead(r: Runtime) {
    const read = r.timeline.getEvents.bind(r.timeline);
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => (entered = resolve));
    let proceed!: () => void;
    const held = new Promise<void>((resolve) => (proceed = resolve));
    vi.spyOn(r.timeline, "getEvents").mockImplementationOnce(async (conversationId) => {
      entered();
      await held;
      return read(conversationId);
    });
    return { reading, proceed };
  }

  it.each(["cancel", "shutdown"] as const)(
    "ends a turn on %s while its history check is still pending",
    async (how) => {
      const r = runtime();
      const history = holdHistoryRead(r);
      const pending = code(r.service.submitMessage(message()));
      await history.reading;
      if (how === "cancel")
        expect(await r.service.cancelMessage("c", "turn-1")).toEqual({
          messageId: "turn-1",
          phases: {},
          preparation: "cancelled"
        });
      else await r.service.cancelRemaining();
      history.proceed();
      expect(await pending).toBe("CANCELLED");
      expect(await r.timeline.getEvents("c")).toEqual([]);
      expect(r.dispatch.telemetry().reservations).toEqual([]);
      expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
      expect(r.orchestrator.retentionStats().preparing).toBe(0);
    }
  );

  it("keeps the original turn's controller when a duplicate is refused", async () => {
    const r = runtime();
    const hold = blockOnQuota(r);
    vi.spyOn(r.dispatch.admission, "reserve");
    const original = code(r.service.submitMessage(message()));
    await waiting(r);
    await expect(r.service.submitMessage(message())).rejects.toThrow(/already registered/);
    expect(r.orchestrator.retentionStats().preparing).toBe(1);
    expect(await r.service.cancelMessage("c", "turn-1")).toMatchObject({
      preparation: "cancelled"
    });
    expect(await original).toBe("CANCELLED");
    expect(live(r).map((v) => v.id)).toEqual([hold]);
    expect(r.orchestrator.retentionStats().preparing).toBe(0);
  });

  it("refuses a turn admitted before shutdown that enters the orchestrator after it", async () => {
    const r = runtime();
    const pending = code(r.service.submitMessage(message()));
    // The service queues the turn for a later microtask; shutdown runs first.
    r.service.stopAccepting();
    await r.service.cancelRemaining();
    expect(await pending).toBe("CANCELLED");
    expect(await r.timeline.getEvents("c")).toEqual([]);
    expect(r.dispatch.telemetry().reservations).toEqual([]);
    expect(r.orchestrator.retentionStats().preparing).toBe(0);
  });

  it("records a cancel that arrives while the user event is being written", async () => {
    const r = runtime();
    const append = r.timeline.appendEvent.bind(r.timeline);
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => (entered = resolve));
    let proceed!: () => void;
    const held = new Promise<void>((resolve) => (proceed = resolve));
    vi.spyOn(r.timeline, "appendEvent").mockImplementation(async (conversationId, event) => {
      if (event.type === "user") {
        entered();
        await held;
      }
      return append(conversationId, event);
    });
    const pending = r.service.submitMessage(message("Compare and design code"));
    await writing;
    expect(await r.service.cancelMessage("c", "turn-1")).toEqual({
      messageId: "turn-1",
      phases: {},
      preparation: "cancelled"
    });
    proceed();
    const reply = await pending;
    expect(reply.fastResponse.processingStatus).toBe("cancelled");
    // The deep route queued nothing and no provider started.
    expect(r.queue.size()).toBe(0);
    expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
    expect(r.calls.get("a")!.deep.resolveDeepTask).not.toHaveBeenCalled();
    const events = await r.timeline.getEvents("c");
    const terminals = events.filter((e) => e.type === "terminal");
    expect(terminals.map((e) => [e.phase, e.finishReason])).toEqual([
      ["fast", "cancelled"],
      ["deep", "cancelled"]
    ]);
    expect(r.dispatch.telemetry().reservations.every((v) => v.status === "released")).toBe(true);
    expect(r.orchestrator.retentionStats().preparing).toBe(0);
  });

  it("keeps started consumption when a cancel arrives after the provider started", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const r = runtime([entry("a")], {
      a: {
        fast: {
          createProvisionalReply: vi.fn<FastModelProvider["createProvisionalReply"]>(
            (_input, control) =>
              new Promise((_, reject) => {
                started();
                control!.signal.addEventListener("abort", () =>
                  reject(new GenerationError("CANCELLED", false))
                );
              })
          )
        }
      }
    });
    const pending = r.service.submitMessage(message());
    await running;
    await r.service.cancelMessage("c", "turn-1");
    expect((await pending).fastResponse.processingStatus).toBe("cancelled");
    // Started work is never refunded; its compute is released once it settles.
    expect(r.dispatch.telemetry().reservations.map((v) => [v.status, v.started])).toEqual([
      ["unsettled", true]
    ]);
    expect(r.dispatch.admission.retentionStats().computePools).toBe(0);
  });
});

describe("capability turn cancelled during initial preparation", () => {
  function capability(r: Runtime, store?: ToolResultStore) {
    return new CapabilityChat(
      {
        createProvisionalReply: vi.fn(async () => ({
          text: JSON.stringify({ action: "answer", message: "Answer" }),
          finishReason: "stop" as const
        }))
      },
      r.queue,
      r.timeline,
      r.manager,
      () => ({
        fastProvider: "test",
        fastModel: "test",
        deepProvider: "none",
        deepModel: "none",
        generatedAtIso: new Date().toISOString()
      }),
      () => [],
      r.dispatch,
      undefined,
      "native",
      store ? () => store : undefined
    );
  }

  it("ends with CANCELLED and releases nothing it did not reserve", async () => {
    const r = runtime();
    const hold = blockOnQuota(r);
    vi.spyOn(r.dispatch.admission, "reserve");
    const chat = capability(r);
    const pending = code(chat.handleUserMessage(message()));
    await waiting(r);
    await chat.cancel("c", "turn-1");
    expect(await pending).toBe("CANCELLED");
    expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
    expect(live(r).map((v) => v.id)).toEqual([hold]);
    expect(r.dispatch.retentionStats().phases).toBe(0);
  });

  it("ends an evidence answer at its workflow deadline while waiting for quota", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const r = runtime();
    const hold = blockOnQuota(r);
    vi.spyOn(r.dispatch.admission, "reserve");
    const store = new ToolResultStore();
    const result = store.put("u", "c", {
      version: "tool-result-v1",
      context: {
        status: "ready",
        summary: "Scores",
        scope: "fixture",
        coverage: "partial",
        limitations: [],
        expiresAt: new Date(Date.now() + 600_000).toISOString()
      },
      payload: { kind: "table", title: "Scores", columns: ["Team"], rows: [["Comets"]] },
      evidence: {
        sourceUrl: "https://example.invalid",
        observedAt: new Date().toISOString(),
        revision: "v1"
      }
    });
    const chat = capability(r, store);
    const pending = code(
      chat.handleUserMessage({
        ...message(),
        referenceSelections: [{ resultId: result.context.resultId, rows: [0] }],
        runControls: { mode: "answer-evidence", thinking: "configured" }
      })
    );
    await vi.advanceTimersByTimeAsync(59_000);
    expect(live(r).map((v) => v.id)).toEqual([hold]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe("WORKFLOW_DEADLINE");
    expect(live(r).map((v) => v.id)).toEqual([hold]);
    expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
  });
});
