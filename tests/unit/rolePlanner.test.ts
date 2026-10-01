import { expect, it, vi } from "vitest";
import { runRolePlanner, rolePlannerEngine } from "../../src/app/rolePlanner";
it.each(["native", "langgraph"] as const)(
  "%s validates once without retry and propagates validation errors",
  async (engine) => {
    const invoke = vi.fn(async () => ({ text: "{}", finishReason: "stop" as const })),
      validate = vi.fn(() => {
        throw Error("INVALID_PLAN");
      });
    await expect(
      runRolePlanner(engine, invoke, validate, new AbortController().signal)
    ).rejects.toThrow("INVALID_PLAN");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
  }
);
it.each(["native", "langgraph"] as const)(
  "%s stops before validation when the provider ignores cancellation",
  async (engine) => {
    const controller = new AbortController(),
      validate = vi.fn();
    const invoke = vi.fn(async () => {
      controller.abort();
      return { text: "{}", finishReason: "stop" as const };
    });
    await expect(runRolePlanner(engine, invoke, validate, controller.signal)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
  }
);
it.each(["native", "langgraph"] as const)(
  "%s never invokes a provider for pre-cancelled work",
  async (engine) => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn();
    await expect(runRolePlanner(engine, invoke, (v) => v, controller.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  }
);
it("rejects an unknown engine", () => {
  expect(() => rolePlannerEngine("invalid")).toThrow("ROLE_PLANNER_ENGINE_INVALID");
});

it.each(["native", "langgraph"] as const)(
  "%s retains ownership until a cancelled provider actually settles",
  async (engine) => {
    const controller = new AbortController();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      begun = new Promise<void>((r) => {
        started = r;
      });
    const validate = vi.fn();
    let settled = false;
    const pending = runRolePlanner(
      engine,
      async () => {
        started();
        await gate;
        return { text: "{}", finishReason: "stop" };
      },
      validate,
      controller.signal
    );
    const outcome = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await begun;
    controller.abort();
    try {
      await new Promise((r) => setTimeout(r, 25));
      expect(settled).toBe(false);
    } finally {
      release();
      await outcome;
    }
    expect(validate).not.toHaveBeenCalled();
  }
);
