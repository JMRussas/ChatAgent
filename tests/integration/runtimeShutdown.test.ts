import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import {
  createRuntimeHandle,
  loadShutdownConfig,
  type RuntimeHandle
} from "../../src/app/runtimeHandle";
import { entry, message, runtime } from "../helpers/dispatchFixtures";
import { GenerationError } from "../../src/domain/generation";
import { allowAllTestAuth } from "../helpers/testAuth";

const handles: RuntimeHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.shutdown()));
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function start(
  r: ReturnType<typeof runtime>,
  options: { graceMs?: number; timeoutMs?: number; persist?: () => Promise<void> } = {}
) {
  const server = createChatServer(r.service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stopBackground = vi.fn(),
    stopInternal = vi.fn(() => r.manager.shutdown()),
    persist = options.persist ?? vi.fn(async () => {});
  const handle = createRuntimeHandle(server, r.service, {
    config: { graceMs: options.graceMs ?? 10, timeoutMs: options.timeoutMs ?? 1000 },
    stopBackground,
    stopInternal,
    persist
  });
  handles.push(handle);
  return {
    handle,
    stopBackground,
    stopInternal,
    persist,
    url: `http://127.0.0.1:${handle.address.port}`
  };
}
describe("runtime shutdown", () => {
  it("validates the grace period and total deadline", () => {
    expect(loadShutdownConfig({})).toEqual({ graceMs: 5000, timeoutMs: 10000 });
    for (const env of [
      { SHUTDOWN_GRACE_MS: "-1" },
      { SHUTDOWN_TIMEOUT_MS: "5000" },
      { SHUTDOWN_GRACE_MS: "NaN" },
      { SHUTDOWN_TIMEOUT_MS: "2147483648" }
    ])
      expect(() => loadShutdownConfig(env)).toThrow();
  });
  it("rejects new requests, cancels and awaits active work, closes SSE, and waits for final persistence exactly once", async () => {
    const entered = deferred(),
      cleanup = deferred(),
      save = deferred(),
      saving = deferred();
    const r = runtime([entry("a")], {
      a: {
        fast: {
          createProvisionalReply: async (_, control) => {
            entered.resolve();
            await new Promise<void>((resolve) =>
              control!.signal.addEventListener("abort", () => resolve(), { once: true })
            );
            await cleanup.promise;
            throw new GenerationError("CANCELLED", false);
          }
        }
      }
    });
    const persist = vi.fn(async () => {
      saving.resolve();
      await save.promise;
    });
    const { handle, url, stopBackground } = await start(r, { persist });
    const response = fetch(`${url}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "c", userId: "u", text: "hello" })
    });
    await entered.promise;
    const stream = await fetch(`${url}/conversations/c/events/stream`);
    const reader = stream.body!.getReader();
    await reader.read();
    const closing = handle.shutdown();
    expect(handle.shutdown()).toBe(closing);
    const rejected = await fetch(`${url}/messages`, { method: "POST", body: "{}" });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ code: "SHUTTING_DOWN" });
    expect(stopBackground).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await saving.promise;
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    expect(
      (await r.service.getTimeline("c")).some(
        (e) => e.type === "terminal" && e.finishReason === "cancelled"
      )
    ).toBe(true);
    save.resolve();
    await closing;
    expect(persist).toHaveBeenCalledTimes(1);
    expect(handle.server.listening).toBe(false);
    await (await response).text();
    while (!(await reader.read()).done) {
      /* drain final SSE bytes */
    }
  });
  it("lets running calls complete within grace and cancels queued deep work", async () => {
    const gate = deferred<{ text: string; finishReason: "stop" }>(),
      entered = deferred();
    const r = runtime([entry("a")], {
      a: {
        fast: {
          createProvisionalReply: async () => {
            entered.resolve();
            return gate.promise;
          }
        }
      }
    });
    const pending = r.service.submitMessage(message("Compare and design code"));
    await entered.promise;
    const { handle } = await start(r, { graceMs: 200 });
    const closing = handle.shutdown();
    gate.resolve({ text: "done", finishReason: "stop" });
    await pending;
    await closing;
    const events = await r.service.getTimeline("c");
    expect(events.some((e) => e.phase === "fast" && e.finishReason === "stop")).toBe(true);
    expect(events.some((e) => e.phase === "deep" && e.finishReason === "cancelled")).toBe(true);
    expect(r.queue.size()).toBe(0);
    expect(r.calls.get("a")!.deep.resolveDeepTask).not.toHaveBeenCalled();
  });
  it("cancels attempts created after the grace period and releases their reservations", async () => {
    const r = runtime([entry("a")]);
    const preparation = deferred(),
      entered = deferred(),
      cancelled = deferred();
    const prepare = r.dispatch.prepare.bind(r.dispatch);
    vi.spyOn(r.dispatch, "prepare").mockImplementation(async (...args) => {
      entered.resolve();
      await preparation.promise;
      return prepare(...args);
    });
    const cancel = r.service.cancelRemaining.bind(r.service);
    vi.spyOn(r.service, "cancelRemaining").mockImplementation(async () => {
      await cancel();
      cancelled.resolve();
    });
    const pending = r.service.submitMessage(message("Compare and design code"));
    await entered.promise;
    const { handle } = await start(r, { graceMs: 0 });
    const closing = handle.shutdown();
    await cancelled.promise;
    preparation.resolve();
    await pending;
    await closing;
    expect(r.calls.get("a")!.fast.createProvisionalReply).not.toHaveBeenCalled();
    expect(r.calls.get("a")!.deep.resolveDeepTask).not.toHaveBeenCalled();
    expect(r.dispatch.telemetry().reservations.every((r) => r.status === "released")).toBe(true);
    expect(r.queue.size()).toBe(0);
  });
  it("reports persistence failure after closing the listener", async () => {
    const r = runtime();
    const { handle } = await start(r, {
      persist: async () => {
        throw new Error("disk full");
      }
    });
    await expect(handle.shutdown()).rejects.toThrow("RUNTIME_SHUTDOWN_FAILED");
    expect(handle.server.listening).toBe(false);
  });
  it("reports a bounded failure and closes HTTP when persistence hangs", async () => {
    const stalled = deferred();
    const r = runtime();
    const { handle } = await start(r, {
      graceMs: 0,
      timeoutMs: 50,
      persist: () => stalled.promise
    });
    await expect(handle.shutdown()).rejects.toThrow("RUNTIME_SHUTDOWN_TIMEOUT");
    expect(handle.server.listening).toBe(false);
    stalled.resolve();
  });
});
