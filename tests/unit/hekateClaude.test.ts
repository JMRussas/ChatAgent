import { describe, expect, it } from "vitest";
import { connectHekateClaude, hekateBridgeConfig, parseBridgeEvent, claudeUsageAdmission } from "../../src/providers/cli/hekateClaude";
import { ProviderRegistry, entryBindingId } from "../../src/providers/providerRegistry";
import { entry, budget } from "../helpers/dispatchFixtures";
import { cliBinding } from "../../src/providers/cli/providers";
import type { CliGenerationRequest } from "../../src/providers/cli/adapter";
import type { ConversationContext } from "../../src/domain/context";

describe("Hekate Claude bridge", () => {
  const now = Date.parse("2026-09-30T00:00:00Z");
  const usage = (extraUsageEnabled = true) => ({ observedAt: new Date(now).toISOString(), extraUsageEnabled,
    windows: ["five_hour", "seven_day"].map(scope => ({ scope, usedPercentage: 3, resetsAt: new Date(now + 60000).toISOString() })) });
  it("does not infer a strict billing guarantee from account settings", () => {
    for (const snapshot of [usage(true), usage(false), undefined])
      expect(claudeUsageAdmission(snapshot, "sonnet")).toMatchObject({ blockedReason: "CLI_INCLUDED_ONLY_UNSUPPORTED" });
  });
  it("admits fresh headroom without requiring account changes", () => {
    for (const enabled of [true, false])
      expect(claudeUsageAdmission(usage(enabled), "sonnet", "headroom", now)).toEqual({ quota: "available" });
  });
  it("checks shared and selected-model limits at the cutoff", () => {
    for (const scope of ["five_hour", "seven_day", "seven_day_sonnet"]) {
      const snapshot = usage();
      snapshot.windows = snapshot.windows.filter(w => w.scope !== scope);
      snapshot.windows.push({ scope, usedPercentage: 80, resetsAt: new Date(now + 60000).toISOString() });
      expect(claudeUsageAdmission(snapshot, "claude-sonnet-4-6", "headroom", now)).toMatchObject({ blockedReason: "CLI_USAGE_HEADROOM" });
    }
    const snapshot = usage();
    snapshot.windows.push({ scope: "seven_day_opus", usedPercentage: 100, resetsAt: new Date(now + 60000).toISOString() });
    expect(claudeUsageAdmission(snapshot, "sonnet", "headroom", now).quota).toBe("available");
  });
  it("fails closed for absent, stale, future, malformed or expired observations", () => {
    for (const snapshot of [undefined, {}, { ...usage(), windows: [] },
      { ...usage(), observedAt: new Date(now - 30001).toISOString() },
      { ...usage(), observedAt: new Date(now + 1).toISOString() },
      ...[NaN, -1, "3"].map(usedPercentage => ({ ...usage(), windows: usage().windows.map(w => ({ ...w, usedPercentage })) })),
      { ...usage(), windows: usage().windows.map(w => ({ ...w, resetsAt: new Date(now).toISOString() })) }])
      expect(claudeUsageAdmission(snapshot, "sonnet", "headroom", now)).toMatchObject({ blockedReason: "CLI_USAGE_UNAVAILABLE" });
    expect(claudeUsageAdmission(usage(), "unknown-model", "headroom", now).quota).toBe("unknown");
  });
  it("requires explicit operator paths and ignores absent configuration", () => {
    expect(hekateBridgeConfig({})).toBeUndefined();
    expect(() => hekateBridgeConfig({ HEKATE_CLI_ROOT: "root" })).toThrow("HEKATE_CLI_CONFIG_INCOMPLETE");
  });
  it("only registers the selected adapter and default OS profile", () => {
    const make = (id: string, adapterId: string, accountProfile: string) => entry(id, { provider: "cli", cli: {
      adapterId, accountProfile, authentication: "unknown", nonInteractive: "supported", streaming: "unsupported",
      outputFormat: "jsonl", executionMode: "answer-only", automationSupport: "supported" } });
    const models = [make("a", "hekate-claude", "default"), make("b", "other", "default"), make("c", "hekate-claude", "invented")];
    const registry = new ProviderRegistry();
    const connected = connectHekateClaude({ version: 1, models }, registry, budget, {
      HEKATE_CLI_ROOT: "root", HEKATE_CLI_PYTHON: "python", HEKATE_CLAUDE_EXECUTABLE: "claude", HEKATE_CLI_WORKING_DIRECTORY: "cwd" });
    expect(connected.bindingIds).toEqual([entryBindingId(models[0])]);
    expect(registry.get(entryBindingId(models[0]))?.fast).toBeDefined();
    expect(registry.get(entryBindingId(models[1]))).toBeUndefined();
    expect(connected.connections[0].resourceFacts.billingComponents).toContain("unknown");
  });
  it("rejects diagnostics and redacts unrecognized bridge failures", () => {
    expect(() => parseBridgeEvent('{"type":"diagnostic","text":"secret"}')).toThrow("CLI_MALFORMED_OUTPUT");
    expect(() => parseBridgeEvent('{"type":"error","code":"secret"}')).toThrow("HEKATE_BRIDGE_FAILED");
    expect(() => parseBridgeEvent('{"type":"error","code":"QUOTA_EXHAUSTED"}')).toThrow("QUOTA_EXHAUSTED");
    expect(parseBridgeEvent('{"type":"complete","text":"answer","finishReason":"length"}').finishReason).toBe("length");
  });
  it("passes the selected role and its reserved output budget", async () => {
    const requests: CliGenerationRequest[] = [];
    const e = entry("a", { provider: "cli", cli: { adapterId: "hekate-claude", accountProfile: "default", authentication: "unknown",
      nonInteractive: "supported", streaming: "unsupported", outputFormat: "jsonl", executionMode: "answer-only", automationSupport: "supported" } });
    const binding = cliBinding({ bindingId: entryBindingId(e), entry: e, connection: { connectionId: "c", apiKind: "cli",
      resourceFacts: { executionScope: "unknown", billingComponents: ["unknown"] }, quota: {}, compute: { ownedOrRented: "unknown" } } },
    { id: "hekate-claude", inspect: async () => { throw new Error("unused"); }, async *generate(request) {
      requests.push(request); yield { type: "complete", text: "ok", finishReason: "stop" };
    } }, "cwd", { fast: 32, deep: 64 });
    const context = {} as ConversationContext;
    await binding.fast!.createProvisionalReply({ message: { userId: "u", conversationId: "c", text: "hi", timestampIso: "now" }, correctedText: "hi", routeDecision: "direct", context });
    await binding.deep!.resolveDeepTask({ taskId: "t", conversationId: "c", normalizedPrompt: "hi", createdAtIso: "now", context });
    expect(requests.map(r => [r.role, r.outputBudget])).toEqual([["fast", 32], ["deep", 64]]);
  });
});
