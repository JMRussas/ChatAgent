import { describe, expect, it } from "vitest";
import {
  connectHekateClaude,
  hekateBridgeConfig,
  parseBridgeEvent,
  claudeUsageAdmission,
  ClaudeInspectionCache
} from "../../src/providers/cli/hekateClaude";
import { ProviderRegistry, entryBindingId } from "../../src/providers/providerRegistry";
import { entry, budget } from "../helpers/dispatchFixtures";
import { cliBinding } from "../../src/providers/cli/providers";
import type { CliGenerationRequest } from "../../src/providers/cli/adapter";
import type { ConversationContext } from "../../src/domain/context";

describe("Hekate Claude bridge", () => {
  const now = Date.parse("2026-09-30T00:00:00Z");
  const usage = (extraUsageEnabled = true) => ({
    observedAt: new Date(now).toISOString(),
    extraUsageEnabled,
    windows: ["five_hour", "seven_day"].map((scope) => ({
      scope,
      usedPercentage: 3,
      resetsAt: new Date(now + 60000).toISOString()
    }))
  });
  it("does not infer a strict billing guarantee from account settings", () => {
    for (const snapshot of [usage(true), usage(false), undefined])
      expect(claudeUsageAdmission(snapshot, "sonnet")).toMatchObject({
        blockedReason: "CLI_INCLUDED_ONLY_UNSUPPORTED"
      });
  });
  it("admits fresh headroom without requiring account changes", () => {
    for (const enabled of [true, false])
      expect(claudeUsageAdmission(usage(enabled), "sonnet", "headroom", now)).toEqual({
        quota: "available"
      });
  });
  it("checks shared and selected-model limits at the cutoff", () => {
    for (const scope of ["five_hour", "seven_day", "seven_day_sonnet"]) {
      const snapshot = usage();
      snapshot.windows = snapshot.windows.filter((w) => w.scope !== scope);
      snapshot.windows.push({
        scope,
        usedPercentage: 80,
        resetsAt: new Date(now + 60000).toISOString()
      });
      expect(claudeUsageAdmission(snapshot, "claude-sonnet-4-6", "headroom", now)).toMatchObject({
        blockedReason: "CLI_USAGE_HEADROOM"
      });
    }
    const snapshot = usage();
    snapshot.windows.push({
      scope: "seven_day_opus",
      usedPercentage: 100,
      resetsAt: new Date(now + 60000).toISOString()
    });
    expect(claudeUsageAdmission(snapshot, "sonnet", "headroom", now).quota).toBe("available");
  });
  it("fails closed for absent, stale, future, malformed or expired observations", () => {
    for (const snapshot of [
      undefined,
      {},
      { ...usage(), windows: [] },
      { ...usage(), observedAt: new Date(now - 30001).toISOString() },
      { ...usage(), observedAt: new Date(now + 1).toISOString() },
      ...[NaN, -1, "3"].map((usedPercentage) => ({
        ...usage(),
        windows: usage().windows.map((w) => ({ ...w, usedPercentage }))
      })),
      {
        ...usage(),
        windows: usage().windows.map((w) => ({ ...w, resetsAt: new Date(now).toISOString() }))
      }
    ])
      expect(claudeUsageAdmission(snapshot, "sonnet", "headroom", now)).toMatchObject({
        blockedReason: "CLI_USAGE_UNAVAILABLE"
      });
    expect(claudeUsageAdmission(usage(), "unknown-model", "headroom", now).quota).toBe("unknown");
  });
  it("requires explicit operator paths and ignores absent configuration", () => {
    expect(hekateBridgeConfig({})).toBeUndefined();
    expect(() => hekateBridgeConfig({ HEKATE_CLI_ROOT: "root" })).toThrow(
      "HEKATE_CLI_CONFIG_INCOMPLETE"
    );
  });
  it("only registers the selected adapter and default OS profile", () => {
    const make = (id: string, adapterId: string, accountProfile: string) =>
      entry(id, {
        provider: "cli",
        cli: {
          adapterId,
          accountProfile,
          authentication: "unknown",
          nonInteractive: "supported",
          streaming: "unsupported",
          outputFormat: "jsonl",
          executionMode: "answer-only",
          automationSupport: "supported"
        }
      });
    const models = [
      make("a", "hekate-claude", "default"),
      make("b", "other", "default"),
      make("c", "hekate-claude", "invented")
    ];
    const registry = new ProviderRegistry();
    const connected = connectHekateClaude({ version: 1, models }, registry, budget, {
      HEKATE_CLI_ROOT: "root",
      HEKATE_CLI_PYTHON: "python",
      HEKATE_CLAUDE_EXECUTABLE: "claude",
      HEKATE_CLI_WORKING_DIRECTORY: "cwd"
    });
    expect(connected.bindingIds).toEqual([entryBindingId(models[0])]);
    expect(registry.get(entryBindingId(models[0]))?.fast).toBeDefined();
    expect(registry.get(entryBindingId(models[1]))).toBeUndefined();
    expect(connected.connections[0].resourceFacts.billingComponents).toContain("unknown");
  });
  it("rejects diagnostics and redacts unrecognized bridge failures", () => {
    expect(() => parseBridgeEvent('{"type":"diagnostic","text":"secret"}')).toThrow(
      "CLI_MALFORMED_OUTPUT"
    );
    expect(() => parseBridgeEvent('{"type":"error","code":"secret"}')).toThrow(
      "HEKATE_BRIDGE_FAILED"
    );
    expect(() => parseBridgeEvent('{"type":"error","code":"QUOTA_EXHAUSTED"}')).toThrow(
      "QUOTA_EXHAUSTED"
    );
    expect(
      parseBridgeEvent('{"type":"complete","text":"answer","finishReason":"length"}').finishReason
    ).toBe("length");
  });
  it("passes the selected role and its reserved output budget", async () => {
    const requests: CliGenerationRequest[] = [];
    const e = entry("a", {
      provider: "cli",
      cli: {
        adapterId: "hekate-claude",
        accountProfile: "default",
        authentication: "unknown",
        nonInteractive: "supported",
        streaming: "unsupported",
        outputFormat: "jsonl",
        executionMode: "answer-only",
        automationSupport: "supported"
      }
    });
    const binding = cliBinding(
      {
        bindingId: entryBindingId(e),
        entry: e,
        connection: {
          connectionId: "c",
          apiKind: "cli",
          resourceFacts: { executionScope: "unknown", billingComponents: ["unknown"] },
          quota: {},
          compute: { ownedOrRented: "unknown" }
        }
      },
      {
        id: "hekate-claude",
        inspect: async () => {
          throw new Error("unused");
        },
        async *generate(request) {
          requests.push(request);
          yield { type: "complete", text: "ok", finishReason: "stop" };
        }
      },
      "cwd",
      { fast: 32, deep: 64 }
    );
    const context = {} as ConversationContext;
    await binding.fast!.createProvisionalReply({
      message: { userId: "u", conversationId: "c", text: "hi", timestampIso: "now" },
      correctedText: "hi",
      routeDecision: "direct",
      context
    });
    await binding.deep!.resolveDeepTask({
      taskId: "t",
      conversationId: "c",
      normalizedPrompt: "hi",
      createdAtIso: "now",
      context
    });
    expect(requests.map((r) => [r.role, r.outputBudget])).toEqual([
      ["fast", 32],
      ["deep", 64]
    ]);
  });
});

it("shares fresh account inspection without renewing its original expiry", async () => {
  let now = Date.parse("2026-09-30T00:00:00Z"),
    reads = 0;
  const cache = new ClaudeInspectionCache(
    async () => {
      reads++;
      return {
        usage: {
          source: "test",
          observedAt: new Date(now).toISOString(),
          windows: [],
          extraUsageEnabled: true
        }
      };
    },
    () => now
  );
  const signal = new AbortController().signal;
  const [first, joined] = await Promise.all([cache.get(signal), cache.get(signal)]);
  expect(reads).toBe(1);
  expect(joined.expiresAt).toBe(first.expiresAt);
  now += 20000;
  expect((await cache.get(signal)).expiresAt).toBe(first.expiresAt);
  expect(reads).toBe(1);
  now += 10000;
  expect((await cache.get(signal)).expiresAt).toBe(now + 30000);
  expect(reads).toBe(2);
});
it("does not reuse expired usage and briefly backs off a rate-limited inspection", async () => {
  let now = 100000,
    reads = 0;
  const cache = new ClaudeInspectionCache(
    async () => {
      reads++;
      return { usageErrorCode: "CLI_USAGE_RATE_LIMITED" };
    },
    () => now
  );
  const signal = new AbortController().signal;
  expect((await cache.get(signal)).status.usage).toBeUndefined();
  now += 20000;
  await cache.get(signal);
  expect(reads).toBe(1);
  now += 10000;
  await cache.get(signal);
  expect(reads).toBe(2);
});
it("cancels one inspection waiter without cancelling a shared inspection", async () => {
  let release!: (value: {}) => void;
  const cache = new ClaudeInspectionCache(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const controller = new AbortController();
  const first = cache.get(controller.signal),
    second = cache.get(new AbortController().signal);
  controller.abort(new Error("cancelled"));
  await expect(first).rejects.toThrow("cancelled");
  release({});
  await expect(second).resolves.toHaveProperty("status");
});
it("cancels the inspection child when its last waiter leaves", async () => {
  let inspectionSignal!: AbortSignal;
  const cache = new ClaudeInspectionCache(async (signal) => {
    inspectionSignal = signal;
    return await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    );
  });
  const controller = new AbortController();
  const waiting = cache.get(controller.signal);
  controller.abort(new Error("shutdown"));
  await expect(waiting).rejects.toThrow("shutdown");
  expect(inspectionSignal.aborted).toBe(true);
});
it("refreshes ahead for discovery without shortening negative backoff", async () => {
  let now = 100000,
    reads = 0;
  const cache = new ClaudeInspectionCache(
    async () => {
      reads++;
      return reads === 1
        ? {
            usage: {
              source: "test",
              observedAt: new Date(now).toISOString(),
              windows: [],
              extraUsageEnabled: true
            }
          }
        : { usageErrorCode: "CLI_USAGE_RATE_LIMITED" };
    },
    () => now
  );
  const signal = new AbortController().signal;
  await cache.get(signal);
  now += 20000;
  await cache.get(signal, 10000);
  expect(reads).toBe(2);
  now += 20000;
  await cache.get(signal, 10000);
  expect(reads).toBe(2);
});
it("discovery refreshes despite startup skew while invocation checks reuse fresh evidence", async () => {
  let now = 1000,
    reads = 0;
  const cache = new ClaudeInspectionCache(
    async () => {
      reads++;
      return {
        usage: {
          source: "test",
          observedAt: new Date(now).toISOString(),
          windows: [],
          extraUsageEnabled: true
        }
      };
    },
    () => now
  );
  const signal = new AbortController().signal;
  const first = await cache.get(signal);
  now += 19000;
  expect((await cache.get(signal)).expiresAt).toBe(first.expiresAt);
  expect(reads).toBe(1);
  expect((await cache.get(signal, 30000)).expiresAt).toBe(now + 30000);
  expect(reads).toBe(2);
});
