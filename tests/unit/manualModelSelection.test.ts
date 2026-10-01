import { it, expect } from "vitest";
import { runtime, entry, message } from "../helpers/dispatchFixtures";
import { entryBindingId } from "../../src/providers/providerRegistry";
it("pins a registered model while retaining readiness and admission checks", async () => {
  const a = entry("a"),
    b = entry("b");
  const r = runtime([a, b]);
  const input = {
    conversationId: "c",
    currentMessageId: "m",
    currentUserText: "Hi",
    trustedFacts: {
      fastProvider: "mock",
      fastModel: "a",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: message().timestampIso
    },
    planningInstruction: "Return a plan"
  };
  const plan = await r.dispatch.prepare(r.manager, input, entryBindingId(b));
  expect(plan.fast.candidate.entry.id).toBe("b");
  expect(plan.fast.fallbacks).toEqual([]);
  r.dispatch.release(plan.fast);
  await expect(r.dispatch.prepare(r.manager, input, "missing")).rejects.toThrow();
  r.observations[1].access = "denied";
  await expect(r.dispatch.prepare(r.manager, input, entryBindingId(b))).rejects.toThrow();
});
