import { describe, expect, it } from "vitest";
import { parseBoundedNumberEnv, parseFiniteNumberEnv, parsePositiveIntEnv } from "../../src/config/runtimeEnv";

describe("runtime env parsing", () => {
  it("uses fallback for missing or invalid finite numbers", () => {
    expect(parseFiniteNumberEnv(undefined, 10)).toBe(10);
    expect(parseFiniteNumberEnv("", 10)).toBe(10);
    expect(parseFiniteNumberEnv("NaN", 10)).toBe(10);
    expect(parseFiniteNumberEnv("12.5", 10)).toBe(12.5);
  });

  it("bounds numeric env values", () => {
    expect(parseBoundedNumberEnv("200", 1000, 400, 5000)).toBe(400);
    expect(parseBoundedNumberEnv("7000", 1000, 400, 5000)).toBe(5000);
    expect(parseBoundedNumberEnv("900", 1000, 400, 5000)).toBe(900);
    expect(parseBoundedNumberEnv("bad", 1000, 400, 5000)).toBe(1000);
  });

  it("parses positive integer env values with floor and bounds", () => {
    expect(parsePositiveIntEnv("200.9", 5000, 250, 60_000)).toBe(250);
    expect(parsePositiveIntEnv("750.2", 5000, 250, 60_000)).toBe(750);
    expect(parsePositiveIntEnv("70000", 5000, 250, 60_000)).toBe(60_000);
    expect(parsePositiveIntEnv("0", 5000, 250, 60_000)).toBe(5000);
    expect(parsePositiveIntEnv("not-a-number", 5000, 250, 60_000)).toBe(5000);
  });
});
