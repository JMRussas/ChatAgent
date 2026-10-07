import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPolicySchema, type BindingResources } from "../../src/config/dispatchConfig";
import { CatalogDispatch } from "../../src/routing/catalogDispatch";
import { DEFAULT_QUOTA_ENVELOPE_LIMITS, type QuotaEnvelope } from "../../src/routing/quotaEnvelope";
import { GenerationError, type GenerationControl } from "../../src/domain/generation";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { OllamaDeepProvider } from "../../src/providers/ollamaProviders";
import { AzureDeepProvider, AzureFastProvider } from "../../src/providers/azureProviders";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockDeepProvider, BedrockFastProvider } from "../../src/providers/bedrockProviders";
import { MAX_ANSWER_BYTES } from "../../src/providers/streaming";
import { budget, entry, evidence, now, resources, runtime } from "../helpers/dispatchFixtures";

// Per-call provider usage settling token-envelope tickets through CatalogDispatch.
// Everything is offline: work() stands in for an adapter's returned result.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const window = (unit: "tokens" | "requests" = "tokens", allowance = 100_000): QuotaEnvelope => ({
  poolId: "pool",
  windowId: "w0",
  sequence: 1,
  startsAt: "2026-09-29T00:00:00.000Z",
  resetsAt: "2026-09-30T00:00:00.000Z",
  allowance,
  unit,
  scope: { kind: "account" },
  evidence: { checkedAtIso: evidence.checkedAtIso, expiresAtIso: evidence.expiresAtIso }
});
const enveloped = (unit: "tokens" | "requests" = "tokens") =>
  resources({ quotaEnvelope: { poolId: "pool", unit } });
const input = {
  conversationId: "c",
  currentMessageId: "turn-1",
  currentUserText: "Explain code",
  trustedFacts: {
    fastProvider: "mock",
    fastModel: "mock",
    deepProvider: "mock",
    deepModel: "mock",
    generatedAtIso: now
  },
  routeDecision: "direct" as const
};

async function setup(
  binding: BindingResources = enveloped(),
  quotaEnvelopes: QuotaEnvelope[] = [window()],
  ids = ["a"],
  routeDecision: "direct" | "deep" = "direct",
  clock: () => Date = () => new Date(now)
) {
  const r = runtime(ids.map((id) => entry(id)));
  const policy = dispatchPolicySchema.parse({
    quotaEnvelopes,
    bindings: Object.fromEntries(ids.map((id) => [id, binding]))
  });
  policy.fallbackBindingIds.fast = r.catalog.models.map(entryBindingId);
  const dispatch = new CatalogDispatch(
    r.catalog,
    r.registry,
    policy,
    budget,
    () => r.observations,
    clock
  );
  const plan = await dispatch.prepare(r.manager, { ...input, routeDecision });
  return { dispatch, plan, ticket: plan.fast.ticket! };
}
function control() {
  const controller = new AbortController();
  const value: GenerationControl = {
    signal: controller.signal,
    attemptId: "attempt",
    onDelta: async () => {}
  };
  return { controller, value };
}
const usage = (inputTokens = 40, outputTokens = 2) => ({
  source: "provider-response" as const,
  inputTokens,
  outputTokens
});
const completed = (finishReason: "stop" | "length" = "stop") => ({
  text: "ok",
  finishReason,
  usage: usage(40, 2)
});
const remaining = (d: CatalogDispatch) => d.admission.envelopeAvailability()[0]?.remaining;
const links = (d: CatalogDispatch) => d.admission.retentionStats().unsettledEnvelopeLinks;
const charge = (d: CatalogDispatch, id: string) =>
  d.telemetry().reservations.find((c) => c.id === id);

describe("per-call usage settlement", () => {
  it("settles a completed token-envelope call at its reported usage and retires its link", async () => {
    for (const finishReason of ["stop", "length"] as const) {
      const { dispatch, plan, ticket } = await setup();
      // The reservation holds the estimate: estimated input plus the whole output cap.
      expect(Number(remaining(dispatch))).toBeLessThan(100_000 - budget.fastOutputTokens);
      const result = await dispatch.execute(plan.fast, control().value, "medium", async () =>
        completed(finishReason)
      );
      expect(result.usage).toEqual(usage(40, 2));
      expect(remaining(dispatch)).toBe("99958");
      expect(links(dispatch)).toBe(0);
      expect(plan.fast.ticket).toBeUndefined();
      // Money stays unreported: no invented zero charge.
      expect(charge(dispatch, ticket)).toMatchObject({
        status: "unsettled",
        reportedUsd: null,
        started: true
      });
    }
  });

  it.each([
    ["the result carries no usage", async () => ({ text: "ok", finishReason: "stop" })],
    [
      "usage is malformed",
      async () => ({ ...completed(), usage: { ...usage(), inputTokens: -1 } })
    ],
    [
      "usage overflows a safe sum",
      async () => ({ ...completed(), usage: usage(Number.MAX_SAFE_INTEGER, 1) })
    ],
    [
      "usage is not from the provider response",
      async () => ({ ...completed(), usage: { ...usage(), source: "estimate" } })
    ],
    ["the result was cancelled", async () => ({ ...completed(), finishReason: "cancelled" })],
    ["the result has no finish reason", async () => ({ text: "ok", usage: usage() })],
    [
      // As when validateAnswer() rejects a provider result inside work().
      "validation rejects a completed result",
      async () => {
        throw new GenerationError("STRUCTURED_OUTPUT_INVALID", false);
      }
    ],
    [
      "the call is cancelled",
      async () => {
        throw new GenerationError("CANCELLED", false);
      }
    ]
  ] as [string, () => Promise<unknown>][])("keeps the estimate when %s", async (_label, work) => {
    const { dispatch, plan, ticket } = await setup();
    const estimated = remaining(dispatch);
    await dispatch.execute(plan.fast, control().value, "medium", work).catch(() => undefined);
    expect(remaining(dispatch)).toBe(estimated);
    expect(links(dispatch)).toBe(1);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
  });

  it("settles known consumption that completed after an abort", async () => {
    const { dispatch, plan } = await setup();
    const c = control();
    const result = await dispatch.execute(plan.fast, c.value, "medium", async () => {
      c.controller.abort();
      return completed();
    });
    expect(result.text).toBe("ok");
    expect(dispatch.telemetry().attempts.at(-1)?.result).toBe("cancelled");
    expect(remaining(dispatch)).toBe("99958");
    expect(links(dispatch)).toBe(0);
  });

  it("applies a report once; a repeated finish changes nothing", async () => {
    const { dispatch, plan, ticket } = await setup();
    await dispatch.execute(plan.fast, control().value, "medium", async () => completed());
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    dispatch.finish(plan.fast, { usage: usage(1, 1) });
    expect(report).not.toHaveBeenCalled();
    expect(dispatch.admission.reportQuotaUsage(ticket, 0)).toBe(false);
    expect(remaining(dispatch)).toBe("99958");
    expect(links(dispatch)).toBe(0);
  });

  it("retains reported overage as debt and refuses the next admission", async () => {
    const { dispatch, plan } = await setup();
    await dispatch.execute(plan.fast, control().value, "medium", async () => ({
      ...completed(),
      usage: usage(100_000, 7)
    }));
    expect(dispatch.admission.envelopeAvailability()).toMatchObject([
      { remaining: "0", debt: "7" }
    ]);
    expect(links(dispatch)).toBe(0);
    await expect(
      dispatch.execute(plan.fast, control().value, "medium", async () => completed())
    ).rejects.toThrow("QUOTA_EXHAUSTED");
  });

  it("retires reported calls beyond the open-charge cap without losing their consumption", async () => {
    const { dispatch, plan } = await setup();
    const calls = DEFAULT_QUOTA_ENVELOPE_LIMITS.maxOpenCharges + 1;
    for (let i = 0; i < calls; i++) {
      await dispatch.execute(plan.fast, control().value, "medium", async () => ({
        ...completed(),
        usage: usage(1, 1)
      }));
    }
    expect(links(dispatch)).toBe(0);
    expect(remaining(dispatch)).toBe(String(100_000 - calls * 2));
  });

  it("settles an Ollama deep response on its deep ticket and preserves the fast reservation", async () => {
    const {
      dispatch,
      plan,
      ticket: fastTicket
    } = await setup(enveloped(), [window()], ["a"], "deep");
    const fastReserved = charge(dispatch, fastTicket)!.quotaUnits!;
    const deepTicket = plan.deep!.ticket!;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: { content: "deep answer" },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 30,
              eval_count: 10
            }) + "\n"
          )
      )
    );
    const c = control();
    const provider = new OllamaDeepProvider("http://fixture.invalid", "model", 0);
    const result = await dispatch.execute(plan.deep!, c.value, "medium", () =>
      provider.resolveDeepTask(
        {
          taskId: "deep-task",
          conversationId: "c",
          normalizedPrompt: "Explain code",
          createdAtIso: now,
          context: plan.deep!.context
        },
        c.value
      )
    );
    expect(result.usage).toEqual(usage(30, 10));
    expect(remaining(dispatch)).toBe(String(100_000 - fastReserved - 40));
    expect(charge(dispatch, fastTicket)).toMatchObject({ status: "reserved", started: false });
    expect(dispatch.admission.reportQuotaUsage(deepTicket, 0)).toBe(false);
    expect(links(dispatch)).toBe(0);
    dispatch.release(plan.fast);
  });

  it("settles an Azure non-streaming response at its prompt and completion tokens", async () => {
    const { dispatch, plan, ticket } = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ index: 0, message: { content: "answer" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 10,
            total_tokens: 40,
            prompt_tokens_details: { cached_tokens: 20 }
          }
        })
      )
    );
    const provider = new AzureFastProvider("https://fixture.invalid", "k", "2024-10-21", "d", 0);
    const result = await dispatch.execute(plan.fast, control().value, "medium", () =>
      provider.createProvisionalReply({
        message: { conversationId: "c", userId: "u", text: "Explain code", timestampIso: now },
        correctedText: "Explain code",
        routeDecision: "direct",
        context: plan.fast.context
      })
    );
    expect(result.usage).toEqual(usage(30, 10));
    expect(remaining(dispatch)).toBe("99960");
    expect(links(dispatch)).toBe(0);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
  });

  // Streamed Azure chunks as the stable 2024-10-21 spec documents them.
  const sse = (frame: unknown) =>
    `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`;
  const azureStream = (...frames: unknown[]) => {
    const fetchMock = vi.fn(async () => new Response(frames.map(sse).join("")));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const promptFilter = { choices: [], prompt_filter_results: [{ prompt_index: 0 }], usage: null };
  const chunk = (content: string) => ({
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    usage: null
  });
  const finished = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null };
  const totals = (prompt_tokens = 30, completion_tokens = 10) => ({
    choices: [],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
  });
  type Plan = Awaited<ReturnType<typeof setup>>["plan"];
  /** The real adapter, streaming under the same control the dispatch phase uses. */
  const azureReply = (plan: Plan, c: { value: GenerationControl }, apiVersion = "2024-10-21") =>
    new AzureFastProvider(
      "https://fixture.invalid",
      "k",
      apiVersion,
      "d",
      0
    ).createProvisionalReply(
      {
        message: { conversationId: "c", userId: "u", text: "Explain code", timestampIso: now },
        correctedText: "Explain code",
        routeDecision: "direct",
        context: plan.fast.context
      },
      c.value
    );
  const streamedFast = (
    dispatch: CatalogDispatch,
    plan: Plan,
    c: { value: GenerationControl },
    apiVersion = "2024-10-21"
  ) => dispatch.execute(plan.fast, c.value, "medium", () => azureReply(plan, c, apiVersion));

  it("settles an Azure streamed response from its final usage chunk", async () => {
    const { dispatch, plan, ticket } = await setup();
    const fetchMock = azureStream(
      promptFilter,
      chunk("ans"),
      chunk("wer"),
      finished,
      totals(),
      "[DONE]"
    );
    const c = control();
    const emitted: string[] = [];
    c.value.onDelta = async (text) => {
      emitted.push(text);
    };
    const result = await streamedFast(dispatch, plan, c);
    expect(result).toEqual({ text: "answer", finishReason: "stop", usage: usage(30, 10) });
    expect(emitted).toEqual(["ans", "wer"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(remaining(dispatch)).toBe("99960");
    expect(links(dispatch)).toBe(0);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
  });

  it("settles a completed Azure stream when the turn is aborted after it returns", async () => {
    const { dispatch, plan } = await setup();
    azureStream(chunk("answer"), finished, totals(), "[DONE]");
    const c = control();
    const result = await dispatch.execute(plan.fast, c.value, "medium", async () => {
      const reply = await azureReply(plan, c);
      c.controller.abort(); // after [DONE]: the call's usage is known consumption
      return reply;
    });
    expect(result).toEqual({ text: "answer", finishReason: "stop", usage: usage(30, 10) });
    expect(dispatch.telemetry().attempts.at(-1)?.result).toBe("cancelled");
    expect(remaining(dispatch)).toBe("99960");
    expect(links(dispatch)).toBe(0);
  });

  it("keeps the estimate when a stream is aborted after its usage chunk while awaiting [DONE]", async () => {
    const { dispatch, plan, ticket } = await setup();
    const estimated = remaining(dispatch);
    const encoder = new TextEncoder();
    // Each chunk is enqueued only on a separate read; a read past the usage chunk
    // shows the adapter consumed it and is now waiting for [DONE].
    const pending = [chunk("answer"), finished, totals()].map((f) => encoder.encode(sse(f)));
    let awaitingDone!: () => void;
    const waiting = new Promise<void>((resolve) => (awaitingDone = resolve));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(source) {
          const next = pending.shift();
          if (next) return source.enqueue(next);
          awaitingDone();
          return new Promise<void>(() => {}); // [DONE] never arrives
        },
        cancel
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body))
    );
    const c = control();
    const call = streamedFast(dispatch, plan, c);
    await waiting;
    c.controller.abort();
    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancel).toHaveBeenCalled();
    expect(dispatch.telemetry().attempts.at(-1)?.result).toBe("CANCELLED");
    expect(remaining(dispatch)).toBe(estimated);
    expect(links(dispatch)).toBe(1);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
  });

  it("settles an Azure streamed deep response on its deep ticket", async () => {
    const {
      dispatch,
      plan,
      ticket: fastTicket
    } = await setup(enveloped(), [window()], ["a"], "deep");
    const fastReserved = charge(dispatch, fastTicket)!.quotaUnits!;
    const deepTicket = plan.deep!.ticket!;
    azureStream(promptFilter, chunk("deep answer"), finished, totals(25, 15), "[DONE]");
    const c = control();
    const provider = new AzureDeepProvider("https://fixture.invalid", "k", "2024-10-21", "d", 0);
    const result = await dispatch.execute(plan.deep!, c.value, "medium", () =>
      provider.resolveDeepTask(
        {
          taskId: "deep-task",
          conversationId: "c",
          normalizedPrompt: "Explain code",
          createdAtIso: now,
          context: plan.deep!.context
        },
        c.value
      )
    );
    expect(result.usage).toEqual(usage(25, 15));
    expect(remaining(dispatch)).toBe(String(100_000 - fastReserved - 40));
    expect(charge(dispatch, fastTicket)).toMatchObject({ status: "reserved", started: false });
    expect(dispatch.admission.reportQuotaUsage(deepTicket, 0)).toBe(false);
    expect(links(dispatch)).toBe(0);
    dispatch.release(plan.fast);
  });

  it("charges streamed Azure overage as debt", async () => {
    const { dispatch, plan } = await setup();
    azureStream(chunk("answer"), finished, totals(100_000, 7), "[DONE]");
    await streamedFast(dispatch, plan, control());
    expect(dispatch.admission.envelopeAvailability()).toMatchObject([
      { remaining: "0", debt: "7" }
    ]);
    expect(links(dispatch)).toBe(0);
  });

  // The expected outcome is the answer without usage, or the exact error code.
  it.each([
    ["no usage chunk arrives", "2024-10-21", [chunk("answer"), finished, "[DONE]"], "answer"],
    [
      "usage arrives before the finish",
      "2024-10-21",
      [chunk("answer"), totals(), finished, "[DONE]"],
      "answer"
    ],
    [
      "usage is reported twice",
      "2024-10-21",
      [chunk("answer"), finished, totals(), totals(), "[DONE]"],
      "answer"
    ],
    [
      "the API version is not allowlisted",
      "2024-08-01-preview",
      [chunk("answer"), finished, totals(), "[DONE]"],
      "answer"
    ],
    [
      "the stream ends after its usage chunk without [DONE]",
      "2024-10-21",
      [chunk("answer"), finished, totals()],
      "INVALID_STREAM"
    ],
    [
      "the call is cancelled mid-stream",
      "2024-10-21",
      [chunk("a"), chunk("b"), finished, totals(), "[DONE]"],
      "CANCELLED"
    ]
  ] as [string, string, unknown[], string][])(
    "keeps an Azure streamed response estimated when %s",
    async (label, apiVersion, frames, outcome) => {
      const { dispatch, plan, ticket } = await setup();
      const estimated = remaining(dispatch);
      azureStream(...frames);
      const c = control();
      if (label.includes("cancelled")) c.value.onDelta = async () => c.controller.abort();
      const call = streamedFast(dispatch, plan, c, apiVersion);
      if (outcome === "answer")
        expect(await call).toEqual({ text: "answer", finishReason: "stop" });
      else await expect(call).rejects.toMatchObject({ code: outcome });
      expect(remaining(dispatch)).toBe(estimated);
      expect(links(dispatch)).toBe(1);
      expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
    }
  );

  // Bedrock ConverseStream events, driven by hand; send() is replaced, nothing leaves.
  const bedrockStream = (
    events: unknown[],
    after: () => Promise<IteratorResult<unknown>> = async () => ({ done: true, value: undefined })
  ) => {
    let i = 0;
    const stream = {
      next: () =>
        i < events.length ? Promise.resolve({ done: false, value: events[i++] }) : after(),
      return: async () => ({ done: true as const, value: undefined }),
      [Symbol.asyncIterator]() {
        return stream;
      }
    };
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation((async () => ({
      stream
    })) as any);
  };
  const stalled = () => new Promise<IteratorResult<unknown>>(() => {});
  const bedrockDelta = (text: string) => ({ contentBlockDelta: { delta: { text } } });
  const bedrockStop = (stopReason = "end_turn") => ({ messageStop: { stopReason } });
  // inputTokens excludes cache reads and writes: 10 + 20 + 5 input, 5 output, 40 total.
  const bedrockMetadata = (totalTokens = 40) => ({
    metadata: {
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 5,
        totalTokens
      }
    }
  });
  const bedrockFast = (dispatch: CatalogDispatch, plan: Plan, c: { value: GenerationControl }) =>
    dispatch.execute(plan.fast, c.value, "medium", () =>
      new BedrockFastProvider("us-east-1", "model", 0).createProvisionalReply(
        {
          message: { conversationId: "c", userId: "u", text: "Explain code", timestampIso: now },
          correctedText: "Explain code",
          routeDecision: "direct",
          context: plan.fast.context
        },
        c.value
      )
    );

  it("settles a Bedrock streamed response from the metadata after messageStop", async () => {
    const { dispatch, plan, ticket } = await setup();
    bedrockStream([bedrockDelta("ans"), bedrockDelta("wer"), bedrockStop(), bedrockMetadata()]);
    const c = control();
    const emitted: string[] = [];
    c.value.onDelta = async (text) => {
      emitted.push(text);
    };
    const result = await bedrockFast(dispatch, plan, c);
    expect(result).toEqual({ text: "answer", finishReason: "stop", usage: usage(35, 5) });
    expect(emitted).toEqual(["ans", "wer"]);
    expect(remaining(dispatch)).toBe("99960");
    expect(links(dispatch)).toBe(0);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
  });

  it("settles a Bedrock streamed deep response on its deep ticket", async () => {
    const {
      dispatch,
      plan,
      ticket: fastTicket
    } = await setup(enveloped(), [window()], ["a"], "deep");
    const fastReserved = charge(dispatch, fastTicket)!.quotaUnits!;
    bedrockStream([bedrockDelta("deep answer"), bedrockStop(), bedrockMetadata()]);
    const c = control();
    const result = await dispatch.execute(plan.deep!, c.value, "medium", () =>
      new BedrockDeepProvider("us-east-1", "model", 0).resolveDeepTask(
        {
          taskId: "deep-task",
          conversationId: "c",
          normalizedPrompt: "Explain code",
          createdAtIso: now,
          context: plan.deep!.context
        },
        c.value
      )
    );
    expect(result.usage).toEqual(usage(35, 5));
    expect(remaining(dispatch)).toBe(String(100_000 - fastReserved - 40));
    expect(charge(dispatch, fastTicket)).toMatchObject({ status: "reserved", started: false });
    expect(links(dispatch)).toBe(0);
    dispatch.release(plan.fast);
  });

  // The expected outcome is the answer without usage, or the exact error code.
  it.each([
    [
      "metadata arrives only before messageStop",
      [bedrockMetadata(), bedrockDelta("answer"), bedrockStop()],
      undefined,
      "answer"
    ],
    [
      "the stream ends at messageStop",
      [bedrockDelta("answer"), bedrockStop()],
      undefined,
      "answer"
    ],
    [
      "the metadata total disagrees",
      [bedrockDelta("answer"), bedrockStop(), bedrockMetadata(15)],
      undefined,
      "answer"
    ],
    [
      "the metadata tail stalls past its bound",
      [bedrockDelta("answer"), bedrockStop()],
      stalled,
      "answer"
    ],
    [
      "the turn is cancelled while waiting for metadata",
      [bedrockDelta("answer"), bedrockStop()],
      "cancel-in-tail",
      "answer"
    ],
    [
      "the turn is cancelled before messageStop",
      [bedrockDelta("answer")],
      "cancel-before-stop",
      "CANCELLED"
    ],
    [
      "the stop reason is rejected",
      [bedrockDelta("answer"), bedrockStop("tool_use"), bedrockMetadata()],
      undefined,
      "UNSUPPORTED_FINISH"
    ],
    [
      "the metadata event exceeds the event size limit",
      [
        bedrockDelta("answer"),
        bedrockStop(),
        { metadata: { ...bedrockMetadata().metadata, trace: "x".repeat(MAX_ANSWER_BYTES) } }
      ],
      undefined,
      "answer"
    ],
    [
      "the metadata read result is malformed",
      [bedrockDelta("answer"), bedrockStop()],
      async () => null as never,
      "answer"
    ],
    [
      "a cancellation lands just after the metadata read resolves",
      [bedrockDelta("answer"), bedrockStop()],
      "cancel-after-read",
      "answer"
    ]
  ] as [
    string,
    unknown[],
    (() => Promise<IteratorResult<unknown>>) | string | undefined,
    string
  ][])(
    "keeps a Bedrock streamed response estimated when %s",
    async (_label, events, tail, outcome) => {
      const { dispatch, plan, ticket } = await setup();
      const estimated = remaining(dispatch);
      const c = control();
      const after =
        tail === "cancel-after-read"
          ? () => {
              const read = Promise.resolve({ done: false, value: bedrockMetadata() });
              // Subscribes after the adapter does: the abort runs once the read has
              // settled the wait, before the adapter inspects it.
              queueMicrotask(() => void read.then(() => c.controller.abort()));
              return read;
            }
          : typeof tail === "string"
            ? () => {
                c.controller.abort(); // the read that follows the scripted events cancels
                return stalled();
              }
            : tail;
      bedrockStream(events, after);
      const call = bedrockFast(dispatch, plan, c);
      if (outcome === "answer")
        expect(await call).toEqual({ text: "answer", finishReason: "stop" });
      else await expect(call).rejects.toMatchObject({ code: outcome });
      expect(remaining(dispatch)).toBe(estimated);
      expect(links(dispatch)).toBe(1);
      expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
    }
  );

  it.each([
    [
      "a static request quota",
      () =>
        resources({
          quota: { poolId: "static", unit: "requests", remaining: 10, evidence }
        }),
      []
    ],
    [
      "a static token quota",
      () =>
        resources({
          quota: { poolId: "static", unit: "tokens", remaining: 100_000, evidence }
        }),
      []
    ],
    ["an envelope-free binding", () => resources(), []]
  ] as [string, () => BindingResources, QuotaEnvelope[]][])(
    "never reports into %s",
    async (_label, binding, envelopes) => {
      const { dispatch, plan, ticket } = await setup(binding(), envelopes);
      const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
      await dispatch.execute(plan.fast, control().value, "medium", async () => completed());
      expect(report).not.toHaveBeenCalled();
      expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
    }
  );

  // A request envelope counts local adapter invocations: admission reserves exactly one
  // unit per dispatch ticket. A returned stop or length result finalizes that one unit,
  // whatever its token usage (the CLI reports none). It says nothing about external API
  // calls or provider allowances; anything else keeps the estimate of one, still linked.
  const requestSetup = (ids = ["a"]) => setup(enveloped("requests"), [window("requests", 10)], ids);

  it.each([
    ["valid usage", (finishReason: "stop" | "length") => completed(finishReason)],
    // The CLI bridge's completion frame carries no usage.
    ["no usage", (finishReason: "stop" | "length") => ({ text: "ok", finishReason })],
    [
      "invalid usage",
      (finishReason: "stop" | "length") => ({
        ...completed(finishReason),
        usage: { ...usage(), outputTokens: -1 }
      })
    ]
  ] as [string, (finishReason: "stop" | "length") => unknown][])(
    "settles a completed request-envelope invocation at one with %s and retires its link",
    async (_label, result) => {
      for (const abortAfter of [false, true])
        for (const finishReason of ["stop", "length"] as const) {
          const { dispatch, plan, ticket } = await requestSetup();
          expect(remaining(dispatch)).toBe("9"); // reserved at its estimate of one
          const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
          const c = control();
          await dispatch.execute(plan.fast, c.value, "medium", async () => {
            if (abortAfter) c.controller.abort(); // a completed call is known consumption
            return result(finishReason);
          });
          expect(report).toHaveBeenCalledExactlyOnceWith(ticket, 1);
          expect(remaining(dispatch)).toBe("9");
          expect(links(dispatch)).toBe(0);
          // Money stays unreported, and the ticket settles only once.
          expect(charge(dispatch, ticket)).toMatchObject({
            status: "unsettled",
            reportedUsd: null
          });
          dispatch.finish(plan.fast, {});
          expect(report).toHaveBeenCalledTimes(1);
          expect(dispatch.admission.reportQuotaUsage(ticket, 1)).toBe(false);
          expect(remaining(dispatch)).toBe("9");
        }
    }
  );

  it.each([
    ["the result was cancelled", async () => ({ ...completed(), finishReason: "cancelled" })],
    ["the result has no finish reason", async () => ({ text: "ok", usage: usage() })],
    [
      "validation rejects a completed result",
      async () => {
        throw new GenerationError("STRUCTURED_OUTPUT_INVALID", false);
      }
    ],
    [
      "the provider fails",
      async () => {
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      }
    ],
    [
      "the call is cancelled",
      async () => {
        throw new GenerationError("CANCELLED", false);
      }
    ]
  ] as [string, () => Promise<unknown>][])(
    "keeps a request envelope estimated when %s",
    async (_label, work) => {
      const { dispatch, plan, ticket } = await requestSetup();
      const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
      await dispatch.execute(plan.fast, control().value, "medium", work).catch(() => undefined);
      expect(report).not.toHaveBeenCalled();
      expect(remaining(dispatch)).toBe("9");
      expect(links(dispatch)).toBe(1);
      expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", reportedUsd: null });
    }
  );

  it("never settles a request on cleanup without completion evidence", async () => {
    const { dispatch, plan, ticket } = await requestSetup();
    await dispatch.begin(plan.fast, new AbortController().signal);
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    dispatch.finish(plan.fast); // direct cleanup: no returned result was observed
    expect(plan.fast.ticket).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
    expect(remaining(dispatch)).toBe("9");
    expect(links(dispatch)).toBe(1);
    expect(charge(dispatch, ticket)).toMatchObject({ status: "unsettled", started: true });
  });

  it("counts a failed attempt and its fallback as one request each", async () => {
    const { dispatch, plan, ticket: first } = await requestSetup(["a", "b"]);
    await expect(
      dispatch.execute(plan.fast, control().value, "medium", async () => {
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      })
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
    // fallback() reserves the replacement ticket itself, before the retried call runs.
    expect(dispatch.fallback(plan.fast, "PROVIDER_UNAVAILABLE")).toBe(true);
    const second = plan.fast.ticket;
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(charge(dispatch, second!)).toMatchObject({ status: "reserved", started: false });
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    await dispatch.execute(plan.fast, control().value, "medium", async () => ({
      text: "ok",
      finishReason: "stop"
    }));
    // The failed attempt keeps its unsettled request; the fallback settled at one.
    expect(report).toHaveBeenCalledExactlyOnceWith(second, 1);
    expect(remaining(dispatch)).toBe("8");
    expect(links(dispatch)).toBe(1);
    expect(dispatch.admission.reportQuotaUsage(second!, 1)).toBe(false);
    expect(dispatch.admission.reportQuotaUsage(first, 1)).toBe(true);
  });

  it("keeps a request ticket for a retry when settlement throws", async () => {
    const { dispatch, plan, ticket } = await requestSetup();
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    vi.spyOn(dispatch.admission, "finish").mockImplementationOnce(() => {
      throw new Error("settlement failed");
    });
    await expect(
      dispatch.execute(plan.fast, control().value, "medium", async () => completed())
    ).rejects.toThrow("settlement failed");
    expect(plan.fast.ticket).toBe(ticket);
    expect(report).not.toHaveBeenCalled();
    expect(remaining(dispatch)).toBe("9");
    expect(links(dispatch)).toBe(0); // not finished, so not yet linked
    dispatch.finish(plan.fast, {});
    expect(plan.fast.ticket).toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(ticket, 1);
    expect(remaining(dispatch)).toBe("9");
    expect(links(dispatch)).toBe(0);
  });

  it("retires request links beyond the open-charge cap without losing their invocations", async () => {
    const { dispatch, plan } = await setup(enveloped("requests"), [window("requests", 1000)]);
    const calls = DEFAULT_QUOTA_ENVELOPE_LIMITS.maxOpenCharges + 1;
    for (let i = 0; i < calls; i++)
      await dispatch.execute(plan.fast, control().value, "medium", async () => ({
        text: "ok",
        finishReason: "stop"
      }));
    expect(links(dispatch)).toBe(0);
    expect(remaining(dispatch)).toBe(String(1000 - calls));
  });

  it("counts finalized requests in their window and carries only unresolved ones past a rollover", async () => {
    const clock = { now: new Date(now) };
    const successor: QuotaEnvelope = {
      ...window("requests", 10),
      windowId: "w1",
      sequence: 2,
      startsAt: "2026-09-30T00:00:00.000Z",
      resetsAt: "2026-10-01T00:00:00.000Z"
    };
    const { dispatch, plan } = await setup(
      enveloped("requests"),
      [window("requests", 10), successor],
      ["a"],
      "direct",
      () => clock.now
    );
    for (const work of [
      async () => ({ text: "ok", finishReason: "stop" }),
      async () => ({ text: "ok", finishReason: "length" }),
      async () => {
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      }
    ])
      await dispatch.execute(plan.fast, control().value, "medium", work).catch(() => undefined);
    expect(dispatch.admission.envelopeAvailability()[0]).toMatchObject({
      windowId: "w0",
      remaining: "7"
    });
    expect(links(dispatch)).toBe(1);
    clock.now = new Date("2026-09-30T01:00:00.000Z");
    // Only the failed attempt's unresolved request carries into the new window.
    expect(dispatch.admission.envelopeAvailability()[0]).toMatchObject({
      windowId: "w1",
      remaining: "9"
    });
  });

  it("keeps the ticket and reports nothing when settlement throws", async () => {
    const { dispatch, plan, ticket } = await setup();
    const estimated = remaining(dispatch);
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    vi.spyOn(dispatch.admission, "finish").mockImplementationOnce(() => {
      throw new Error("settlement failed");
    });
    await expect(
      dispatch.execute(plan.fast, control().value, "medium", async () => completed())
    ).rejects.toThrow("settlement failed");
    expect(plan.fast.ticket).toBe(ticket);
    expect(report).not.toHaveBeenCalled();
    expect(remaining(dispatch)).toBe(estimated);
    expect(links(dispatch)).toBe(0);
    // A retried finish, given the call's completion, settles the same ticket once.
    dispatch.finish(plan.fast, { usage: usage(40, 2) });
    expect(plan.fast.ticket).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(remaining(dispatch)).toBe("99958");
    expect(links(dispatch)).toBe(0);
  });

  it("settles only the ticket that ran after a fallback", async () => {
    const { dispatch, plan, ticket: first } = await setup(enveloped(), [window()], ["a", "b"]);
    const estimated = remaining(dispatch);
    await expect(
      dispatch.execute(plan.fast, control().value, "medium", async () => {
        throw new GenerationError("PROVIDER_UNAVAILABLE", true);
      })
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
    // fallback() reserves the replacement ticket itself, before the retried call runs.
    expect(dispatch.fallback(plan.fast, "PROVIDER_UNAVAILABLE")).toBe(true);
    const second = plan.fast.ticket;
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(charge(dispatch, second!)).toMatchObject({ status: "reserved", started: false });
    const report = vi.spyOn(dispatch.admission, "reportQuotaUsage");
    await dispatch.execute(plan.fast, control().value, "medium", async () => completed());
    // The failed attempt stays estimated and linked; the fallback settled at 42.
    expect(report).toHaveBeenCalledExactlyOnceWith(second, 42);
    expect(remaining(dispatch)).toBe(String(Number(estimated) - 42));
    expect(links(dispatch)).toBe(1);
    expect(dispatch.admission.reportQuotaUsage(second!, 0)).toBe(false);
    expect(dispatch.admission.reportQuotaUsage(first, 0)).toBe(true);
  });
});
