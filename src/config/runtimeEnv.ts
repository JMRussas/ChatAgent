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

export function parsePositiveIntEnv(raw: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = parseFiniteNumberEnv(raw, fallback);
  const rounded = Math.floor(parsed);

  if (!Number.isFinite(rounded) || rounded <= 0) {
    return fallback;
  }

  return Math.max(min, Math.min(max, rounded));
}
