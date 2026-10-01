/** Exact arithmetic over the decimal spelling of finite, nonnegative JS numbers.
 * 324 decimal places cover Number.MIN_VALUE; no accepted input is rounded away.
 * BigInt units stay internal. Conversion back to Number is for telemetry only.
 * This cannot recover precision already lost before a number reaches the ledger.
 */
const SCALE = 324;
export function decimalUnits(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("INVALID_ACCOUNTING_AMOUNT");
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return BigInt(whole + fraction) * 10n ** BigInt(SCALE + Number(exponent) - fraction.length);
}
export function decimalNumber(units: bigint): number {
  return Number(`${units}e-${SCALE}`);
}

/** JSON-safe projection. Only overflowing values carry the exact decimal string. */
export function decimalTelemetry(units: bigint): {value:number;overflow:false} | {value:null;overflow:true;exact:string} {
  const value=decimalNumber(units);
  if(Number.isFinite(value))return {value,overflow:false};
  const digits=units.toString().padStart(SCALE+1,"0");
  const fraction=digits.slice(-SCALE).replace(/0+$/,"");
  const exact=digits.slice(0,-SCALE)+(fraction ? "."+fraction : "");
  return {value:null,overflow:true,exact};
}
