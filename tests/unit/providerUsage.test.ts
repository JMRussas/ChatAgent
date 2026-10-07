import { describe, expect, it } from "vitest";
import { providerUsage, validProviderUsage } from "../../src/domain/generation";

describe("provider usage", () => {
  it("normalizes non-negative safe integer counts", () => {
    expect(providerUsage(0, 0)).toEqual({
      source: "provider-response",
      inputTokens: 0,
      outputTokens: 0
    });
    expect(providerUsage(Number.MAX_SAFE_INTEGER - 1, 1)).toEqual({
      source: "provider-response",
      inputTokens: Number.MAX_SAFE_INTEGER - 1,
      outputTokens: 1
    });
  });

  it.each([
    [undefined, 1],
    [1, null],
    [-1, 1],
    [1.5, 1],
    ["1", 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [Number.MAX_SAFE_INTEGER, 1]
  ] as [unknown, unknown][])("refuses counts %s and %s", (input, output) => {
    expect(providerUsage(input, output)).toBeUndefined();
  });

  it("revalidates usage at a boundary instead of trusting its type", () => {
    expect(
      validProviderUsage({ source: "provider-response", inputTokens: 3, outputTokens: 4, extra: 1 })
    ).toEqual({ source: "provider-response", inputTokens: 3, outputTokens: 4 });
    for (const value of [
      undefined,
      null,
      "usage",
      { inputTokens: 3, outputTokens: 4 },
      { source: "estimate", inputTokens: 3, outputTokens: 4 },
      { source: "provider-response", inputTokens: -3, outputTokens: 4 },
      { source: "provider-response", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }
    ])
      expect(validProviderUsage(value)).toBeUndefined();
  });
});
