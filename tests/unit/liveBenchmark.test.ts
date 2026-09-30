import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";
import type { ChatTimelineEvent } from "../../src/domain/types";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function server(route: "direct" | "deep", histories: Partial<ChatTimelineEvent>[][]) {
  let messageId = "", poll = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/messages")) {
      messageId = JSON.parse(init!.body as string).messageId;
      return { ok: true, json: async () => ({ messageId, fastResponse: { analysis: { routeDecision: route } } }) };
    }
    if (url.endsWith("/cancel")) return { ok: true };
    if (!url.endsWith("/events")) throw new Error("Unexpected request");
    const events = histories[Math.min(poll++, histories.length - 1)].map(e => ({ text: "", createdAtIso: new Date().toISOString(), messageId, ...e }));
    return { ok: true, json: async () => ({ events }) };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const stop = (phase: "fast" | "deep", attemptId: string = phase): Partial<ChatTimelineEvent> => ({ type: "terminal", phase, attemptId, finishReason: "stop" });
const prompts = [{ id: "one", text: "Question" }];
const options = { baseUrl: "http://localhost:3000", pollIntervalMs: 1, deadlineMs: 1000 };

describe("live benchmark observations", () => {
  it("uses actual model metadata and never infers quality from a route", async () => {
    const fetch = server("direct", [[{ type: "provisional", phase: "fast", attemptId: "fast", text: "Answer", answerKind: "substantive",
      model: { provider: "actual", model: "model-alias", bindingId: "binding" } }, stop("fast")]]);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({ outcome: "stop", quality: null, costUsd: null, usage: null, firstUsefulAnswerMs: null, retryCount: 0 });
    expect(record.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.attempts[0]).toMatchObject({ model: "model-alias", bindingId: "binding", bindingRevision: null, providerMs: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("waits for correlated terminals, counts attempts rather than polls, and uses the automatic worker", async () => {
    const fast = stop("fast");
    const retry: Partial<ChatTimelineEvent> = { type: "terminal", phase: "deep", attemptId: "d1", retrying: true, finishReason: "error" };
    const fetch = server("deep", [
      [fast, { ...stop("deep"), messageId: "another-turn" }, { type: "refined", text: "not terminal" }],
      [fast, retry], [fast, retry],
      [fast, retry, { type: "refined", phase: "deep", attemptId: "d2", text: "Final", answerKind: "substantive" }, stop("deep", "d2")]
    ]);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({ outcome: "stop", retryCount: 1 });
    expect(record.attempts).toHaveLength(3);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(4);
    expect(fetch.mock.calls.some(([url]) => url.includes("run-once"))).toBe(false);
  });
  it.each(["error", "length", "cancelled"] as const)("retains %s outcomes without pretending success", async finishReason => {
    server("direct", [[{ ...stop("fast"), finishReason }]]);
    expect((await runLiveBenchmark(prompts, options))[0]).toMatchObject({ outcome: finishReason, responseHash: null });
  });
  it("does not count an acknowledgment as answer text", async () => {
    server("direct", [[{ type: "provisional", text: "Working on it", answerKind: "acknowledgment" }, stop("fast")]]);
    expect((await runLiveBenchmark(prompts, options))[0]).toMatchObject({ firstAnswerObservedMs: null, responseHash: null });
  });
  it("times out missing terminals and requests cancellation", async () => {
    const fetch = server("deep", [[stop("fast")]]);
    const [record] = await runLiveBenchmark(prompts, { ...options, deadlineMs: 15 });
    expect(record).toMatchObject({ outcome: "deadline", finalObservedMs: null, cancellation: "acknowledged" });
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("/cancel");
  });
  it("applies the deadline to a stalled submission too", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => url.endsWith("/cancel") ? Promise.resolve({ ok: true }) :
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))));
    expect((await runLiveBenchmark(prompts, { ...options, deadlineMs: 15 }))[0]).toMatchObject({ outcome: "deadline", responseReceivedMs: null });
  });
  it("stops the batch when transport fails and cancellation is unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const records = await runLiveBenchmark([...prompts, { id: "two", text: "Next" }], options);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "transport-error", cancellation: "unconfirmed" });
  });
  it("rejects invalid deadlines before making requests", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(runLiveBenchmark(prompts, { ...options, deadlineMs: NaN })).rejects.toThrow("timing");
    expect(fetch).not.toHaveBeenCalled();
  });
});
