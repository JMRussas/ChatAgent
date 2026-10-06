import { describe, expect, it } from "vitest";
import {
  assertConcurrentTurnLimit,
  DEFAULT_MAX_CONCURRENT_TURNS,
  loadTurnAdmissionConfig
} from "../../src/config/turnAdmission";

describe("turn admission configuration", () => {
  it("defaults to eight concurrent turns", () => {
    expect(loadTurnAdmissionConfig({})).toEqual({
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_TURNS
    });
    expect(DEFAULT_MAX_CONCURRENT_TURNS).toBe(8);
    expect(loadTurnAdmissionConfig({ CHAT_MAX_CONCURRENT_TURNS: " " }).maxConcurrentTurns).toBe(8);
  });

  it("accepts an explicit limit and rejects invalid or excessive values", () => {
    expect(loadTurnAdmissionConfig({ CHAT_MAX_CONCURRENT_TURNS: "1" }).maxConcurrentTurns).toBe(1);
    expect(loadTurnAdmissionConfig({ CHAT_MAX_CONCURRENT_TURNS: "1000" }).maxConcurrentTurns).toBe(
      1000
    );
    for (const value of ["0", "-1", "1.5", "many", "1001"])
      expect(() => loadTurnAdmissionConfig({ CHAT_MAX_CONCURRENT_TURNS: value })).toThrow(
        /CHAT_MAX_CONCURRENT_TURNS/
      );
  });

  it("validates an explicit constructor limit the same way", () => {
    expect(assertConcurrentTurnLimit(3)).toBe(3);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])
      expect(() => assertConcurrentTurnLimit(value)).toThrow(/maxConcurrentTurns/);
  });
});
