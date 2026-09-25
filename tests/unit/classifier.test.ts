import { describe, expect, it } from "vitest";
import { classifyPrompt } from "../../src/routing/classifier";

describe("prompt classifier", () => {
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
