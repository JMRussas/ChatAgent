import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";
import type { ChatTimelineEvent } from "../../src/domain/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function server(route: "direct" | "deep", histories: Partial<ChatTimelineEvent>[][]) {
  let messageId = "",
    poll = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/messages")) {
      messageId = JSON.parse(init!.body as string).messageId;
      return {
        ok: true,
        json: async () => ({ messageId, fastResponse: { analysis: { routeDecision: route } } })
      };
    }
    if (url.endsWith("/cancel")) return { ok: true };
    if (!url.endsWith("/events")) throw new Error("Unexpected request");
    const events = histories[Math.min(poll++, histories.length - 1)].map((e) => ({
      text: "",
      createdAtIso: new Date().toISOString(),
      messageId,
      ...e
    }));
    return { ok: true, json: async () => ({ events }) };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const stop = (phase: "fast" | "deep", attemptId: string = phase): Partial<ChatTimelineEvent> => ({
  type: "terminal",
  phase,
  attemptId,
  finishReason: "stop"
});
const prompts = [{ id: "one", text: "Question" }];
const options = { baseUrl: "http://localhost:3000", pollIntervalMs: 1, deadlineMs: 1000 };

describe("live benchmark observations", () => {
  it("uses actual model metadata and never infers quality from a route", async () => {
    const fetch = server("direct", [
      [
        {
          type: "provisional",
          phase: "fast",
          attemptId: "fast",
          text: "Answer",
          answerKind: "substantive",
          model: { provider: "actual", model: "model-alias", bindingId: "binding" }
        },
        stop("fast")
      ]
    ]);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({
      outcome: "stop",
      quality: null,
      costUsd: null,
      usage: null,
      firstUsefulAnswerMs: null,
      retryCount: 0
    });
    expect(record.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.attempts[0]).toMatchObject({
      model: "model-alias",
      bindingId: "binding",
      bindingRevision: null,
      providerMs: null
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("waits for correlated terminals, counts attempts rather than polls, and uses the automatic worker", async () => {
    const fast = stop("fast");
    const retry: Partial<ChatTimelineEvent> = {
      type: "terminal",
      phase: "deep",
      attemptId: "d1",
      retrying: true,
      finishReason: "error"
    };
    const fetch = server("deep", [
      [
        fast,
        { ...stop("deep"), messageId: "another-turn" },
        { type: "refined", text: "not terminal" }
      ],
      [fast, retry],
      [fast, retry],
      [
        fast,
        retry,
        {
          type: "refined",
          phase: "deep",
          attemptId: "d2",
          text: "Final",
          answerKind: "substantive"
        },
        stop("deep", "d2")
      ]
    ]);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({ outcome: "stop", retryCount: 1 });
    expect(record.attempts).toHaveLength(3);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(4);
    expect(fetch.mock.calls.some(([url]) => url.includes("run-once"))).toBe(false);
  });
  it.each(["error", "length", "cancelled"] as const)(
    "retains %s outcomes without pretending success",
    async (finishReason) => {
      server("direct", [[{ ...stop("fast"), finishReason }]]);
      expect((await runLiveBenchmark(prompts, options))[0]).toMatchObject({
        outcome: finishReason,
        responseHash: null
      });
    }
  );
  it("does not count an acknowledgment as answer text", async () => {
    server("direct", [
      [{ type: "provisional", text: "Working on it", answerKind: "acknowledgment" }, stop("fast")]
    ]);
    expect((await runLiveBenchmark(prompts, options))[0]).toMatchObject({
      firstAnswerObservedMs: null,
      responseHash: null
    });
  });
  it("times out missing terminals and requests cancellation", async () => {
    const fetch = server("deep", [[stop("fast")]]);
    const [record] = await runLiveBenchmark(prompts, { ...options, deadlineMs: 15 });
    expect(record).toMatchObject({
      outcome: "deadline",
      finalObservedMs: null,
      cancellation: "acknowledged"
    });
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("/cancel");
  });
  it("applies the deadline to a stalled submission too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) =>
        url.endsWith("/cancel")
          ? Promise.resolve({ ok: true })
          : new Promise((_, reject) =>
              init.signal!.addEventListener("abort", () => reject(new Error("aborted")))
            )
      )
    );
    expect((await runLiveBenchmark(prompts, { ...options, deadlineMs: 15 }))[0]).toMatchObject({
      outcome: "deadline",
      responseReceivedMs: null
    });
  });
  it("stops the batch when transport fails and cancellation is unconfirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    const records = await runLiveBenchmark([...prompts, { id: "two", text: "Next" }], options);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "transport-error", cancellation: "unconfirmed" });
  });
  it("rejects invalid deadlines before making requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(runLiveBenchmark(prompts, { ...options, deadlineMs: NaN })).rejects.toThrow(
      "timing"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("observes streaming text before the submission response completes", async () => {
    let messageId = "",
      release!: () => void,
      completed = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/messages")) {
          messageId = JSON.parse(init!.body as string).messageId;
          await held;
          completed = true;
          return {
            ok: true,
            json: async () => ({
              messageId,
              fastResponse: { analysis: { routeDecision: "direct" } }
            })
          };
        }
        const events = [
          { type: "user", routeDecision: "direct", text: "Question", messageId },
          { type: "delta", phase: "fast", attemptId: "a", text: "Early", messageId }
        ];
        if (!completed) setTimeout(release, 10);
        return {
          ok: true,
          json: async () => ({
            events: completed
              ? [...events, { ...stop("fast", "a"), messageId, text: "Early" }]
              : events
          })
        };
      })
    );
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record.outcome).toBe("stop");
    expect(record.firstAnswerObservedMs).not.toBeNull();
    expect(record.firstAnswerObservedMs!).toBeLessThan(record.responseReceivedMs!);
    expect(record.firstAnswerObservedMs!).toBeLessThan(record.finalObservedMs!);
  });

  it("recovers actual attempts and retries after a provider HTTP 502", async () => {
    let messageId = "";
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/messages")) {
        messageId = JSON.parse(init!.body as string).messageId;
        return {
          ok: false,
          status: 502,
          json: async () => ({ code: "PROVIDER_UNAVAILABLE", error: "private detail" })
        };
      }
      return {
        ok: true,
        json: async () => ({
          events: [
            { type: "user", routeDecision: "direct", text: "Question", messageId },
            ...["a", "b", "c"].map((attemptId, i) => ({
              type: "terminal",
              phase: "fast",
              attemptId,
              messageId,
              text: "",
              retrying: i < 2,
              finishReason: "error",
              model: { provider: "actual", model: "actual-model", bindingId: "binding" }
            }))
          ]
        })
      };
    });
    vi.stubGlobal("fetch", fetch);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({
      outcome: "error",
      httpStatus: 502,
      errorCode: "PROVIDER_UNAVAILABLE",
      evidenceMode: "live",
      routeDecision: "direct",
      retryCount: 2,
      cancellation: "not-requested"
    });
    expect(record.attempts).toHaveLength(3);
    expect(record.attempts[2]).toMatchObject({
      provider: "actual",
      model: "actual-model",
      bindingId: "binding",
      finishReason: "error"
    });
    expect(JSON.stringify(record)).not.toContain("private detail");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/events"))).toBe(true);
  });

  it("reports admission rejection without waiting for nonexistent terminal events", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/messages")
        ? {
            ok: false,
            status: 503,
            json: async () => ({
              code: "NO_ELIGIBLE_MODEL",
              exclusions: [
                {
                  bindingId: "claude",
                  reasons: ["stale", "COMPUTE_CAPACITY_EXHAUSTED", "private detail"]
                }
              ]
            })
          }
        : url.endsWith("/cancel")
          ? { ok: false, status: 404 }
          : { ok: true, json: async () => ({ events: [] }) }
    );
    vi.stubGlobal("fetch", fetch);
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record).toMatchObject({
      outcome: "error",
      httpStatus: 503,
      errorCode: "NO_ELIGIBLE_MODEL",
      attempts: [],
      finalObservedMs: null
    });
    expect(record.selectionExclusions).toEqual([
      { bindingId: "claude", reasons: ["stale", "COMPUTE_CAPACITY_EXHAUSTED"] }
    ]);
    expect(JSON.stringify(record)).not.toContain("private detail");
    expect(record.elapsedMs).toBeLessThan(options.deadlineMs);
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/events")).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("aborts and awaits submission when concurrent timeline observation fails", async () => {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/messages"))
          return await new Promise((_, reject) => {
            init!.signal!.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        if (url.endsWith("/cancel")) return { ok: true };
        throw new Error("connection lost");
      })
    );
    const [record] = await runLiveBenchmark(prompts, options);
    expect(record.outcome).toBe("transport-error");
    expect(aborted).toBe(true);
  });
});

it("stops a scenario batch after a failed turn instead of contaminating its follow-up", async () => {
  server("direct", [[{ type: "terminal", phase: "fast", attemptId: "a", finishReason: "length" }]]);
  const records = await runLiveBenchmark([...prompts, { id: "two", text: "Follow up" }], {
    ...options,
    conversationGroups: ["scenario", "scenario"]
  });
  expect(records).toHaveLength(1);
  expect(records[0].outcome).toBe("length");
});
it("rejects malformed conversation plans before submitting anything", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const conversationGroups of [[], [""], ["has spaces"], ["one", "two"]])
    await expect(runLiveBenchmark(prompts, { ...options, conversationGroups })).rejects.toThrow(
      "Invalid conversation groups"
    );
  expect(fetch).not.toHaveBeenCalled();
});
