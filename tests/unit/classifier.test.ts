import { describe, expect, it } from "vitest";
import { classifyPrompt } from "../../src/routing/classifier";

describe("prompt classifier", () => {
  it("treats normal wh-questions as low ambiguity", () => {
    const result = classifyPrompt("WHAT DAY IS IT?");
    expect(result.ambiguity).toBe("low");
  });

  it("does not treat day-of-week question as external data lookup", () => {
    const result = classifyPrompt("what day is it today?");
    expect(result.externalDataNeeded).toBe(false);
  });

  it("detects ambiguity for underspecified prompts", () => {
    const result = classifyPrompt("do it");
    expect(result.ambiguity).toBe("high");
  });

  it("detects external data cues", () => {
    const result = classifyPrompt("Find the latest inflation numbers and cite sources");
    expect(result.externalDataNeeded).toBe(true);
  });

  it("classifies complex architecture prompts", () => {
    const result = classifyPrompt("Compare architecture tradeoffs and design a multi-step benchmark plan");
    expect(result.complexity).toBe("complex");
  });
});
