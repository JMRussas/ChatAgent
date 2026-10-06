import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { parseProviderTimeoutEnv } from "../../src/config/runtimeEnv";
import {
  loadRuntimeProviderConfigFromEnv,
  type RuntimeProviderConfig
} from "../../src/config/providerConfig";
import { buildDeepProvider, buildFastProvider } from "../../src/providers/providerFactory";
import type { GenerationControl } from "../../src/domain/generation";
import { sampleContext } from "../helpers/contextFixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const budget = {
  windowTokens: 8192,
  maxHistoryTurns: 12,
  safetyTokens: 256,
  fastOutputTokens: 512,
  deepOutputTokens: 1024
};
const mock = { provider: "mock" as const, model: "mock-v1", temperature: 0.2 };
const message = {
  messageId: "m",
  conversationId: "c",
  userId: "u",
  text: "hello",
  timestampIso: new Date().toISOString()
};
const deepTask = {
  taskId: "t",
  messageId: "m",
  conversationId: "c",
  normalizedPrompt: "hello",
  createdAtIso: new Date().toISOString(),
  sizeBand: "medium" as const
};

describe("parseProviderTimeoutEnv", () => {
  const NAME = "AZURE_OPENAI_FAST_TIMEOUT_MS";
  it("uses the default only when unset, and accepts the bounds", () => {
    expect(parseProviderTimeoutEnv(undefined, NAME, 10_000)).toBe(10_000);
    expect(parseProviderTimeoutEnv("1", NAME, 10_000)).toBe(1);
    expect(parseProviderTimeoutEnv("600000", NAME, 10_000)).toBe(600_000);
    expect(parseProviderTimeoutEnv("0001500", NAME, 10_000)).toBe(1500);
  });
  it("rejects anything but plain in-range decimal digits, naming only the setting", () => {
    for (const raw of [
      "",
      "0",
      "600001",
      "1e4",
      "0x10",
      " 10",
      "10 ",
      "10\n",
      "10\r\n",
      "10\r",
      "10\u2028",
      "+10",
      "-10",
      "1.5",
      "10_000",
      "abc",
      "99999999999999999999"
    ]) {
      let message = "";
      try {
        parseProviderTimeoutEnv(raw, NAME, 10_000);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(raw)).toBe(
        `${NAME} must be a whole number of milliseconds from 1 to 600000.`
      );
    }
  });
});

describe("provider deadline configuration", () => {
  it("carries each role's deadline, defaulting per provider", () => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.invalid");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "key");
    vi.stubEnv("BEDROCK_REGION", "us-east-1");
    vi.stubEnv("AZURE_OPENAI_FAST_TIMEOUT_MS", "1500");
    vi.stubEnv("BEDROCK_DEEP_TIMEOUT_MS", "90000");
    const config = loadRuntimeProviderConfigFromEnv();
    expect(config.azure).toMatchObject({ fastTimeoutMs: 1500, deepTimeoutMs: 10_000 });
    expect(config.bedrock).toMatchObject({ fastTimeoutMs: 60_000, deepTimeoutMs: 90_000 });
  });

  it.each([
    "AZURE_OPENAI_FAST_TIMEOUT_MS",
    "AZURE_OPENAI_DEEP_TIMEOUT_MS",
    "BEDROCK_FAST_TIMEOUT_MS",
    "BEDROCK_DEEP_TIMEOUT_MS"
  ])("rejects an invalid %s even when that provider is not configured", (name) => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "");
    vi.stubEnv("BEDROCK_REGION", "");
    vi.stubEnv(name, "soon");
    expect(() => loadRuntimeProviderConfigFromEnv()).toThrow(
      `${name} must be a whole number of milliseconds from 1 to 600000.`
    );
  });
});

describe("provider deadlines reach each role", () => {
  const azure = (timeouts: { fastTimeoutMs?: number; deepTimeoutMs?: number } = {}) =>
    ({
      fast: { provider: "azure", model: "fast", temperature: 0.2 },
      deep: { provider: "azure", model: "deep", temperature: 0.2 },
      azure: { endpoint: "https://example.invalid", apiKey: "k", apiVersion: "v", ...timeouts }
    }) as RuntimeProviderConfig;
  const bedrock = (timeouts: { fastTimeoutMs?: number; deepTimeoutMs?: number } = {}) =>
    ({
      fast: { provider: "bedrock", model: "fast", temperature: 0.2 },
      deep: { provider: "bedrock", model: "deep", temperature: 0.2 },
      bedrock: { region: "us-east-1", ...timeouts }
    }) as RuntimeProviderConfig;
  /** Every request waits until it is aborted. */
  function hangingTransports() {
    const hang = (signal?: AbortSignal | null) =>
      new Promise<never>((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      );
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => hang(init?.signal))
    );
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(((
      _command: unknown,
      options?: { abortSignal?: AbortSignal }
    ) => hang(options?.abortSignal)) as never);
  }
  async function deadlineOf(run: () => Promise<unknown>, expected: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: unknown;
    const pending = run().then(
      () => (settled = "resolved"),
      (error) => (settled = error)
    );
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      message: expect.stringContaining(`after ${expected}ms`)
    });
  }
  const fast = (config: RuntimeProviderConfig) => () =>
    buildFastProvider(config, budget, {}).createProvisionalReply({
      message,
      correctedText: "hello",
      routeDecision: "direct"
    });
  const deep = (config: RuntimeProviderConfig) => () =>
    buildDeepProvider(config, budget, {}).resolveDeepTask(deepTask);

  it.each([
    ["azure fast", () => fast(azure({ fastTimeoutMs: 1234, deepTimeoutMs: 5678 })), 1234],
    ["azure deep", () => deep(azure({ fastTimeoutMs: 1234, deepTimeoutMs: 5678 })), 5678],
    ["bedrock fast", () => fast(bedrock({ fastTimeoutMs: 2345, deepTimeoutMs: 6789 })), 2345],
    ["bedrock deep", () => deep(bedrock({ fastTimeoutMs: 2345, deepTimeoutMs: 6789 })), 6789],
    ["azure fast default", () => fast(azure()), 10_000],
    ["bedrock deep default", () => deep(bedrock()), 60_000]
  ])("%s times out at exactly its deadline", async (_, run, expected) => {
    hangingTransports();
    await deadlineOf(run(), expected);
  });

  it.each([Number.NaN, 0, -1, 1.5, 600_001, Number.POSITIVE_INFINITY])(
    "rejects a hand-built deadline of %s",
    (value) => {
      expect(() => buildFastProvider(azure({ fastTimeoutMs: value }), budget, {})).toThrow(
        "azure.fastTimeoutMs must be a whole number of milliseconds from 1 to 600000."
      );
      expect(() => buildDeepProvider(bedrock({ deepTimeoutMs: value }), budget, {})).toThrow(
        "bedrock.deepTimeoutMs must be a whole number of milliseconds from 1 to 600000."
      );
    }
  );

  it("leaves mock providers untouched", () => {
    expect(() =>
      buildFastProvider({ fast: mock, deep: mock } as RuntimeProviderConfig, budget, {})
    ).not.toThrow();
  });
});

describe("Bedrock streamed body that stalls", () => {
  const bedrock = {
    fast: { provider: "bedrock", model: "fast", temperature: 0.2 },
    deep: { provider: "bedrock", model: "deep", temperature: 0.2 },
    bedrock: { region: "us-east-1", fastTimeoutMs: 1500, deepTimeoutMs: 2500 }
  } as RuntimeProviderConfig;
  /** The stream opens, then never yields another event until it is aborted. */
  function stallingStream() {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(((
      _command: unknown,
      options?: { abortSignal?: AbortSignal }
    ) =>
      Promise.resolve({
        stream: {
          async *[Symbol.asyncIterator]() {
            await new Promise((_, reject) =>
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(options.abortSignal!.reason),
                { once: true }
              )
            );
          }
        }
      })) as never);
  }
  function control() {
    const controller = new AbortController();
    const value: GenerationControl = {
      signal: controller.signal,
      attemptId: "a",
      onDelta: async () => {}
    };
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    return { controller, value, removed };
  }
  const runs = {
    fast: (c: GenerationControl) =>
      buildFastProvider(bedrock, budget, {}).createProvisionalReply(
        { message, correctedText: "hello", routeDecision: "direct", context: sampleContext() },
        c
      ),
    deep: (c: GenerationControl) =>
      buildDeepProvider(bedrock, budget, {}).resolveDeepTask(
        { ...deepTask, context: sampleContext() },
        c
      )
  };

  it.each([
    ["fast", 1500],
    ["deep", 2500]
  ] as const)(
    "%s ends at its configured deadline, or as the caller's cancellation, and cleans up",
    async (role, deadline) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const cancel of [false, true]) {
        stallingStream();
        const c = control();
        const outcome = runs[role](c.value).then(
          () => "resolved",
          (error) => error
        );
        await vi.advanceTimersByTimeAsync(deadline - 1);
        if (cancel) c.controller.abort();
        else await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject(
          cancel
            ? { code: "CANCELLED" }
            : { code: "PROVIDER_TIMEOUT", message: expect.stringContaining(`after ${deadline}ms`) }
        );
        // The deadline timer and the caller's abort listener are both released.
        expect(vi.getTimerCount()).toBe(0);
        expect(c.removed).toHaveBeenCalledWith("abort", expect.any(Function));
        vi.restoreAllMocks();
      }
    }
  );
});
