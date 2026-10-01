import { describe, expect, it } from "vitest";
import {
  analyzeFast,
  detectNeedsClarification,
  detectNeedsExternalData,
  normalizeText
} from "../../src/domain/router";

describe("router", () => {
  it("normalizes whitespace", () => {
    expect(normalizeText("  hi   there  ")).toBe("hi there");
  });

  it("detects external data requirement", () => {
    expect(detectNeedsExternalData("find latest GDP numbers and cite sources")).toBe(true);
  });

  it("detects clarification need for underspecified prompts", () => {
    expect(detectNeedsClarification("do it")).toBe(true);
  });

  it("does not treat normal wh-questions as underspecified", () => {
    expect(detectNeedsClarification("WHAT DAY IS IT?")).toBe(false);
  });

  it("routes deep when external data is requested", () => {
    const analysis = analyzeFast({
      conversationId: "c1",
      userId: "u1",
      text: "Please look up the latest unemployment rate",
      timestampIso: new Date().toISOString()
    });

    expect(analysis.routeDecision).toBe("deep");
  });

  it("routes direct for standalone day question", () => {
    const result = analyzeFast({
      conversationId: "c",
      userId: "u",
      text: "WHAT DAY IS IT?",
      timestampIso: new Date().toISOString()
    });
    expect(result.routeDecision).toBe("direct");
  });
});
