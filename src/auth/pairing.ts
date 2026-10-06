import { randomInt, timingSafeEqual } from "node:crypto";

// Crockford base32 without I, L, O and U: easy to read from a console and type.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP = 5;
/** Ten characters from 32 symbols: 50 bits. */
const LENGTH = 2 * GROUP;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_FAILURES = 5;

export type PairingResult =
  /** The code matched; the caller may now issue a session. The code is spent. */
  | "paired"
  /** Wrong code; the active code stays valid until it reaches the failure limit. */
  | "invalid"
  /** No active code: never issued, already used, expired, locked or cleared. */
  | "no-code";

/**
 * At most one active pairing code. It is single use, expires after ten minutes, and
 * is discarded after five wrong attempts. Nothing re-issues a code automatically:
 * issuing is an explicit act (startup or an operator request) and replaces any
 * previous code. Expiry is computed from the injected clock; no timer is kept.
 */
export class PairingController {
  private active?: { code: string; expiresAt: number; failures: number };

  constructor(private readonly now: () => number = Date.now) {}

  /** Creates a new code, invalidating any previous one. Returns it for the console only. */
  issue(): string {
    let raw = "";
    for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const code = `${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`;
    this.active = { code, expiresAt: this.now() + PAIRING_TTL_MS, failures: 0 };
    return code;
  }

  /** Exact, constant-time comparison against the displayed form. */
  attempt(presented: unknown): PairingResult {
    const active = this.active;
    if (!active || this.now() >= active.expiresAt) {
      this.active = undefined;
      return "no-code";
    }
    const expected = Buffer.from(active.code);
    // The length is checked before anything is allocated from the input, and the
    // byte length again because one character may take several bytes.
    const given =
      typeof presented === "string" && presented.length === active.code.length
        ? Buffer.from(presented)
        : undefined;
    const match =
      given?.length === expected.length
        ? timingSafeEqual(given, expected)
        : (timingSafeEqual(expected, expected), false);
    if (match) {
      this.active = undefined;
      return "paired";
    }
    if (++active.failures >= PAIRING_MAX_FAILURES) this.active = undefined;
    return "invalid";
  }

  get hasActiveCode() {
    // An expired code is discarded once noticed rather than kept in memory.
    if (this.active && this.now() >= this.active.expiresAt) this.active = undefined;
    return !!this.active;
  }

  /** Shutdown: forget the code. */
  clear() {
    this.active = undefined;
  }
}
