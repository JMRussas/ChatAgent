import { describe, expect, it } from "vitest";
import { rankModels, type SelectionInput } from "../../src/routing/modelSelector";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { buildContext, ContextBudgetError } from "../../src/app/contextBuilder";
import { budget, entry, now, runtime } from "../helpers/dispatchFixtures";

function setup(entries = [entry("a"), entry("b")]) {
  const r = runtime(entries);
  const input: SelectionInput = { catalog: r.catalog, registry: r.registry, observations: r.observations,
    policy: r.policy, admission: r.dispatch.admission, role: "fast", requirements: { task: "coding", requiredCapabilities: [], inputTokens: 0, outputTokens: 512 },
    nowIso: now, applicationWindow: 8192, preview: windowTokens => buildContext({ conversationId: "c", events: [],
      currentMessageId: "m", currentUserText: "explain code", capturedAtIso: now, systemInstruction: "test", roleInstructions: { fast: "", deep: "" },
      budget: { ...budget, windowTokens } }) };
  return { r, input };
}
describe("catalog selector", () => {
  it.each(["disabled", "stale", "denied", "unknown-limit", "unsupported-adapter"])("excludes %s bindings", kind => {
    const { input } = setup();
    if (kind === "disabled") input.catalog.models[0].enabled = false;
    if (kind === "stale") input.observations[0].expiresAtIso = now;
    if (kind === "denied") input.observations[0].access = "denied";
    if (kind === "unknown-limit") input.catalog.models[0].limits = {};
    if (kind === "unsupported-adapter") input.catalog.models[0].model = "unregistered";
    expect(rankModels(input).map(c => c.entry.id)).toEqual(["b"]);
  });
  it("does not use quality without matching task/environment, enough samples and freshness", () => {
    const { input } = setup();
    const good = { task: "coding" as const, sampleCount: 20, successRate: 0.9, firstUsefulResponseP95Ms: 100,
      finalResponseP95Ms: 200, evaluatedAtIso: now, environment: "default-mock:default", report: "fixture" };
    input.catalog.models[1].evaluations = [good];
    expect(rankModels(input)[0].entry.id).toBe("b");
    for (const invalid of [{ sampleCount: 19 }, { environment: "another-connection:default" }, { task: "conversation" as const },
      { evaluatedAtIso: "2026-08-01T00:00:00.000Z" }, { evaluatedAtIso: "2026-10-01T00:00:00.000Z" }]) {
      input.catalog.models[1].evaluations = [{ ...good, ...invalid }];
      expect(rankModels(input)[0].entry.id).toBe("a");
    }
  });
  it("orders quality then latency then priority then lexical binding ID", () => {
    const { input } = setup([entry("z"), entry("a")]);
    const evalFor = (successRate: number, firstUsefulResponseP95Ms: number) => ({ task: "coding" as const, sampleCount: 20, successRate,
      firstUsefulResponseP95Ms, finalResponseP95Ms: 1000, evaluatedAtIso: now, environment: "default-mock:default", report: "fixture" });
    input.catalog.models[0].evaluations = [evalFor(1, 900)]; input.catalog.models[1].evaluations = [evalFor(0.9, 100)];
    expect(rankModels(input)[0].entry.id).toBe("z");
    input.catalog.models[1].evaluations = [evalFor(1, 100)]; expect(rankModels(input)[0].entry.id).toBe("a");
    input.catalog.models[0].evaluations = [evalFor(1, 100)]; input.catalog.models[0].routingPriority = 0;
    expect(rankModels(input)[0].entry.id).toBe("z");
    input.catalog.models[0].routingPriority = 100;
    for (let i = 0; i < 5; i++) expect(rankModels(input)[0].selection.bindingId).toBe(entryBindingId(input.catalog.models[1]));
  });
  it("ranks retained complete pairs above evaluation and excludes failed previews", () => {
    const { input } = setup();
    const preview = input.preview;
    input.preview = (window, e) => {
      const c = preview(window, e);
      if (!(c instanceof ContextBudgetError)) c.includedTurnIds = e.id === "b" ? ["newest"] : [];
      return c;
    };
    input.catalog.models[0].routingPriority = -100;
    expect(rankModels(input)[0].entry.id).toBe("b");
    input.preview = () => new ContextBudgetError(9000, 100);
    expect(() => rankModels(input)).toThrow("No eligible model");
  });
});
