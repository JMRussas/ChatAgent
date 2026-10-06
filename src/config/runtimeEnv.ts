export function parseFiniteNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export function parseBoundedNumberEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = parseFiniteNumberEnv(raw, fallback);
  return Math.max(min, Math.min(max, parsed));
}

export function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  const parsed = parseFiniteNumberEnv(raw, fallback);
  const rounded = Math.floor(parsed);

  if (!Number.isFinite(rounded) || rounded <= 0) {
    return fallback;
  }

  return Math.max(min, Math.min(max, rounded));
}

/**
 * Unlike parsePositiveIntEnv (which silently falls back on a bad value), this
 * rejects an explicitly-set invalid value at startup rather than masking a
 * misconfiguration with a default the operator never asked for.
 */
export function parseStrictPositiveIntEnv(
  raw: string | undefined,
  name: string,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}".`);
  }

  return parsed;
}

/** Strict counterpart to parseStrictPositiveIntEnv that also accepts zero. */
export function parseStrictNonNegativeIntEnv(
  raw: string | undefined,
  name: string,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer; got "${raw}".`);
  }

  return parsed;
}

export const MAX_PROVIDER_TIMEOUT_MS = 600_000;
/** A provider deadline: a whole number of milliseconds from 1 to 600000. */
export function assertProviderTimeoutMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROVIDER_TIMEOUT_MS)
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to ${MAX_PROVIDER_TIMEOUT_MS}.`
    );
  return value;
}
/**
 * Unset uses the fallback. Anything else, including an empty value, must be plain
 * decimal digits within range; the error names the setting, never the value.
 */
export function parseProviderTimeoutEnv(
  raw: string | undefined,
  name: string,
  fallback: number
): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw))
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to ${MAX_PROVIDER_TIMEOUT_MS}.`
    );
  return assertProviderTimeoutMs(Number(raw), name);
}

export function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}
