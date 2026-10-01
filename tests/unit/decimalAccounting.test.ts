import { expect, it } from "vitest";
import { decimalUnits, decimalNumber } from "../../src/routing/decimalAccounting";
it.each([0, 0.1, 0.3, 1e-9, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER])(
  "preserves finite input %s",
  (value) => {
    expect(decimalNumber(decimalUnits(value))).toBe(value);
  }
);
it("sums decimal inputs without a tolerance and preserves real overages", () => {
  expect(decimalUnits(0.1) + decimalUnits(0.2)).toBe(decimalUnits(0.3));
  expect(decimalUnits(0.30000000000000004)).toBeGreaterThan(decimalUnits(0.3));
});
it.each([NaN, Infinity, -Infinity, -1])("rejects invalid amount %s", (value) => {
  expect(() => decimalUnits(value)).toThrow("INVALID_ACCOUNTING_AMOUNT");
});
