import { z } from "zod";
import type { BindingResources } from "../config/dispatchConfig";
import type { CliReadiness } from "../providers/cli/adapter";

/**
 * Quota observation v1: a validation and description boundary, not reconciliation.
 *
 * It types what a source reports about one quota limit and classifies how one
 * observation differs from another. Nothing here grants, refunds or resets an
 * allowance, and nothing consumes it yet: a future reconciler must still match
 * authoritative covered charges, keep unstarted reservations and treat unmatched
 * usage as uncertain. A schema alone does not prove what a provider means.
 */

// Offsets are accepted; every timestamp is canonicalized to UTC before comparison.
// The format check alone admits impossible offsets such as +99:99, so the instant
// must also parse.
const iso = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid instant");

/** Declared by the adapter that produced the payload; never taken from the payload. */
export interface QuotaSourceCapability {
  sourceId: string;
  provenance: "provider-api" | "cli-usage" | "operator-config";
  /** Who states the as-of time: the provider, the local adapter, or nobody. */
  asOf: "provider" | "adapter-reported" | "none";
  /** Whether fixed or rolling window semantics are documented by the source. */
  windowSemantics: "documented" | "undocumented";
  /** Whether the source can say which usage its numbers include. */
  usageCoverage: "unknown" | "declared";
  correlation: "none" | "request-id";
}

const windowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), startsAt: iso, resetsAt: iso }).strict(),
  z.object({ kind: z.literal("rolling"), durationMs: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  // A reset time is reported, but what resets and how is not known.
  z.object({ kind: z.literal("unknown"), resetsAt: iso.optional() }).strict()
]);
const amount = z.number().finite().nonnegative().nullable();
const measureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("quantitative"),
      unit: z.enum(["requests", "tokens"]),
      limit: amount,
      used: amount,
      remaining: amount
    })
    .strict(),
  // A share of some unstated allowance: never a number of requests or tokens.
  z.object({ kind: z.literal("headroom"), usedPercentage: z.number().finite().min(0) }).strict()
]);
const coverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  // A description of what the source says it counted; never proof of completeness.
  z
    .object({
      kind: z.literal("declared"),
      events: z.enum(["accepted-requests", "completed-requests", "billed-units"]),
      callers: z.enum(["this-credential", "account", "unknown"]),
      throughAt: iso
    })
    .strict()
]);
export const quotaObservationSchema = z
  .object({
    version: z.literal("quota-observation-v1"),
    identity: z
      .object({
        sourceId: z.string().min(1),
        poolId: z.string().min(1),
        limitId: z.string().min(1)
      })
      .strict(),
    window: windowSchema,
    measure: measureSchema,
    coverage: coverageSchema,
    clocks: z
      .object({
        // As-of time stated by the source; whether that is the provider or a local
        // adapter is the capability's `asOf`, never this payload's claim.
        sourceAsOf: iso.nullable(),
        receivedAt: iso,
        // Configured facts carry when they were declared and until when, which is
        // not an observation.
        declaredAt: iso.optional(),
        declaredExpiresAt: iso.optional()
      })
      .strict()
  })
  .strict();
export type QuotaObservationInput = z.infer<typeof quotaObservationSchema>;

/**
 * provider-as-of: the provider's own snapshot time. adapter-as-of: a time a local
 * adapter reports. declared: operator configuration. local-receipt: display only.
 */
export type FreshnessBasis = "provider-as-of" | "adapter-as-of" | "declared" | "local-receipt";
export interface QuotaObservation extends QuotaObservationInput {
  capability: QuotaSourceCapability;
  /** Internal and opaque; never shown in user telemetry. */
  key: string;
  freshness: { basis: FreshnessBasis; until: string };
}

export type Normalized =
  | { status: "accepted"; observation: QuotaObservation }
  | { status: "ambiguous" | "unsupported"; reason: string }
  | { status: "invalid"; reason: "INVALID_SCHEMA" | "INVALID_OPTIONS"; issues: string[] };

const optionsSchema = z
  .object({
    maxAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    skewToleranceMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

const ms = (value: string) => Date.parse(value);
/** The largest instant a Date can represent. */
const MAX_INSTANT = 8.64e15;
const canonical = (value: string) => new Date(value).toISOString();
/** The capability with a fixed field order, so equal capabilities compare equal. */
function canonicalCapability(c: QuotaSourceCapability): QuotaSourceCapability {
  return {
    sourceId: c.sourceId,
    provenance: c.provenance,
    asOf: c.asOf,
    windowSemantics: c.windowSemantics,
    usageCoverage: c.usageCoverage,
    correlation: c.correlation
  };
}
/** Every timestamp in canonical ISO form, so equivalent instants compare equal. */
function canonicalTimes(o: QuotaObservationInput): QuotaObservationInput {
  const copy = structuredClone(o);
  if (copy.window.kind === "fixed") {
    copy.window.startsAt = canonical(copy.window.startsAt);
    copy.window.resetsAt = canonical(copy.window.resetsAt);
  }
  if (copy.window.kind === "unknown" && copy.window.resetsAt)
    copy.window.resetsAt = canonical(copy.window.resetsAt);
  if (copy.coverage.kind === "declared")
    copy.coverage.throughAt = canonical(copy.coverage.throughAt);
  const c = copy.clocks;
  copy.clocks = {
    sourceAsOf: c.sourceAsOf === null ? null : canonical(c.sourceAsOf),
    receivedAt: canonical(c.receivedAt),
    ...(c.declaredAt !== undefined ? { declaredAt: canonical(c.declaredAt) } : {}),
    ...(c.declaredExpiresAt !== undefined
      ? { declaredExpiresAt: canonical(c.declaredExpiresAt) }
      : {})
  };
  return copy;
}
export const quotaKey = (identity: QuotaObservationInput["identity"]) =>
  JSON.stringify([identity.sourceId, identity.poolId, identity.limitId]);

/** Validates one payload against what its source can actually state. Never throws. */
export function normalizeQuotaObservation(
  raw: unknown,
  capability: QuotaSourceCapability,
  now: number,
  options: { maxAgeMs: number; skewToleranceMs: number }
): Normalized {
  const settings = optionsSchema.safeParse(options);
  if (!settings.success || !Number.isFinite(now) || Math.abs(now) > MAX_INSTANT)
    return { status: "invalid", reason: "INVALID_OPTIONS", issues: issues(settings) };
  const parsed = quotaObservationSchema.safeParse(raw);
  if (!parsed.success)
    return { status: "invalid", reason: "INVALID_SCHEMA", issues: issues(parsed) };
  const o = canonicalTimes(parsed.data);
  const { maxAgeMs, skewToleranceMs } = settings.data;
  const ambiguous = (reason: string): Normalized => ({ status: "ambiguous", reason });

  if (o.identity.sourceId !== capability.sourceId) return ambiguous("SOURCE_MISMATCH");
  // A payload may not claim more than its source declares.
  if (o.clocks.sourceAsOf !== null && capability.asOf === "none")
    return ambiguous("AS_OF_NOT_DECLARED_BY_SOURCE");
  if (
    (o.window.kind === "fixed" || o.window.kind === "rolling") &&
    capability.windowSemantics !== "documented"
  )
    return ambiguous("WINDOW_SEMANTICS_NOT_DECLARED_BY_SOURCE");
  if (o.coverage.kind === "declared" && capability.usageCoverage !== "declared")
    return ambiguous("COVERAGE_NOT_DECLARED_BY_SOURCE");

  const received = ms(o.clocks.receivedAt),
    asOf = o.clocks.sourceAsOf === null ? null : ms(o.clocks.sourceAsOf),
    declared = o.clocks.declaredAt === undefined ? null : ms(o.clocks.declaredAt);
  if (received > now + skewToleranceMs) return ambiguous("FUTURE_RECEIPT");
  if (asOf !== null && asOf > received + skewToleranceMs) return ambiguous("CLOCK_SKEW");
  if (o.window.kind === "fixed" && ms(o.window.resetsAt) <= ms(o.window.startsAt))
    return ambiguous("WINDOW_BOUNDS_INVALID");
  if (o.coverage.kind === "declared" && asOf !== null && ms(o.coverage.throughAt) > asOf)
    return ambiguous("COVERAGE_AFTER_AS_OF");
  if (o.measure.kind === "quantitative") {
    const { limit, used, remaining } = o.measure;
    if (remaining === null && (limit === null || used === null))
      return { status: "unsupported", reason: "REMAINING_UNKNOWN" };
    // Overdrawn or contradictory figures are reported, never capped or refunded.
    if (limit !== null && used !== null && used > limit) return ambiguous("USED_EXCEEDS_LIMIT");
    if (limit !== null && remaining !== null && remaining > limit)
      return ambiguous("INCONSISTENT_MEASURE");
    if (limit !== null && used !== null && remaining !== null && limit - used !== remaining)
      return ambiguous("INCONSISTENT_MEASURE");
  }
  if (declared !== null && declared > received + skewToleranceMs) return ambiguous("CLOCK_SKEW");
  // Freshness follows the source's as-of, or the declaration time, when there is one:
  // a later receipt or mapping of the same snapshot is never fresher. Without either
  // it is local display freshness only. A declared expiry always caps it.
  const basis: FreshnessBasis =
    asOf !== null
      ? capability.asOf === "provider"
        ? "provider-as-of"
        : "adapter-as-of"
      : declared !== null
        ? "declared"
        : "local-receipt";
  let until = (asOf ?? declared ?? received) + maxAgeMs;
  if (o.clocks.declaredExpiresAt !== undefined)
    until = Math.min(until, ms(o.clocks.declaredExpiresAt));
  if (until > MAX_INSTANT)
    return {
      status: "invalid",
      reason: "INVALID_OPTIONS",
      issues: ["maxAgeMs: freshness beyond the representable date range"]
    };
  if (now >= until) return { status: "unsupported", reason: "STALE" };
  return {
    status: "accepted",
    observation: {
      ...o,
      capability: canonicalCapability(capability),
      key: quotaKey(o.identity),
      freshness: { basis, until: new Date(until).toISOString() }
    }
  };
}

function issues(result: { success: boolean; error?: z.ZodError }) {
  return result.success ? [] : result.error!.issues.map((i) => `${i.path.join(".")}: ${i.code}`);
}

export type DescribedAllowance =
  | {
      status: "described";
      remaining: number;
      unit: "requests" | "tokens";
      basis: FreshnessBasis;
      /** Always false in v1: a description, not permission to admit work. */
      authoritative: false;
    }
  | {
      status: "unsupported";
      reason:
        "HEADROOM_ONLY" | "REMAINING_UNKNOWN" | "WINDOW_NOT_STARTED" | "WINDOW_ENDED" | "STALE";
    };

/** What the observation says is left, if it says a number at all. Grants nothing. */
export function describeAllowance(o: QuotaObservation, now: number): DescribedAllowance {
  if (now >= ms(o.freshness.until)) return { status: "unsupported", reason: "STALE" };
  if (o.measure.kind === "headroom") return { status: "unsupported", reason: "HEADROOM_ONLY" };
  // A snapshot of a fixed window describes only that interval, not the current one.
  if (o.window.kind === "fixed" && now < ms(o.window.startsAt))
    return { status: "unsupported", reason: "WINDOW_NOT_STARTED" };
  if (o.window.kind === "fixed" && now >= ms(o.window.resetsAt))
    return { status: "unsupported", reason: "WINDOW_ENDED" };
  const { limit, used, remaining } = o.measure;
  const value = remaining ?? (limit !== null && used !== null ? limit - used : null);
  if (value === null) return { status: "unsupported", reason: "REMAINING_UNKNOWN" };
  return {
    status: "described",
    remaining: value,
    unit: o.measure.unit,
    basis: o.freshness.basis,
    authoritative: false
  };
}

export type SuccessorRelation =
  | "different-identity"
  | "no-provider-as-of"
  | "out-of-order"
  | "duplicate"
  | "same-instant-conflict"
  | "conflict"
  | "same-window"
  | "new-fixed-window"
  | "unknown-window";
export type EvidenceChange =
  | "REMAINING_DECREASED"
  | "REMAINING_INCREASED"
  | "USED_CHANGED"
  | "COVERAGE_CHANGED"
  | "RESET_TIME_CHANGED"
  | "HEADROOM_CHANGED"
  | "CAPABILITY_CHANGED";
export type MissingCapability =
  "PROVIDER_AS_OF" | "WINDOW_SEMANTICS" | "USAGE_COVERAGE" | "CORRELATION";

/**
 * Describes how next differs from previous. It reports evidence changes and the
 * capabilities a reconciler would lack; it never says an allowance may rise, be
 * refunded or reset, whatever the timestamps or coverage say. An empty `missing`
 * list does not mean the evidence is complete or eligible for reconciliation.
 */
export function classifySuccessor(
  previous: QuotaObservation,
  next: QuotaObservation
): { relation: SuccessorRelation; changes: EvidenceChange[]; missing: MissingCapability[] } {
  const missing = missingCapabilities(previous, next);
  const result = (relation: SuccessorRelation, changes: EvidenceChange[] = []) => ({
    relation,
    changes,
    missing
  });
  if (previous.key !== next.key) return result("different-identity");
  const before = previous.clocks.sourceAsOf,
    after = next.clocks.sourceAsOf;
  // Without provider as-of times on both sides, order and novelty are unknown: a
  // re-fetch is not evidence of anything new.
  if (
    before === null ||
    after === null ||
    previous.capability.asOf !== "provider" ||
    next.capability.asOf !== "provider"
  )
    return result("no-provider-as-of");
  if (ms(after) < ms(before)) return result("out-of-order");
  if (ms(after) === ms(before))
    return result(
      accountingFields(previous) === accountingFields(next) ? "duplicate" : "same-instant-conflict"
    );
  // What the source can state changed: not comparable as an ordinary successor.
  if (JSON.stringify(previous.capability) !== JSON.stringify(next.capability))
    return result("conflict", ["CAPABILITY_CHANGED"]);
  const a = previous.window,
    b = next.window;
  if (a.kind !== b.kind) return result("conflict");
  const pm = previous.measure,
    nm = next.measure;
  if (pm.kind !== nm.kind || (pm.kind === "quantitative" && pm.unit !== (nm as typeof pm).unit))
    return result("conflict");
  const changes = describeChanges(previous, next);
  if (a.kind === "fixed" && b.kind === "fixed") {
    if (a.startsAt === b.startsAt && a.resetsAt === b.resetsAt)
      return limitChanged(pm, nm) ? result("conflict") : result("same-window", changes);
    // A later, disjoint interval is described as a new window; it resets nothing here.
    if (ms(b.startsAt) >= ms(a.resetsAt)) return result("new-fixed-window", changes);
    return result("conflict");
  }
  if (a.kind === "rolling" && b.kind === "rolling" && a.durationMs !== b.durationMs)
    return result("conflict");
  if (limitChanged(pm, nm)) return result("conflict");
  if (a.kind === "unknown" && b.kind === "unknown")
    return result(
      "unknown-window",
      a.resetsAt !== b.resetsAt ? [...changes, "RESET_TIME_CHANGED"] : changes
    );
  return result("same-window", changes);
}

/** Everything that bears on accounting, including what the source can state. */
function accountingFields(o: QuotaObservation) {
  return JSON.stringify([o.window, o.measure, o.coverage, o.capability]);
}
function limitChanged(a: QuotaObservation["measure"], b: QuotaObservation["measure"]) {
  return (
    a.kind === "quantitative" &&
    b.kind === "quantitative" &&
    a.limit !== null &&
    b.limit !== null &&
    a.limit !== b.limit
  );
}
function describeChanges(previous: QuotaObservation, next: QuotaObservation): EvidenceChange[] {
  const changes: EvidenceChange[] = [];
  const p = previous.measure,
    n = next.measure;
  if (p.kind === "quantitative" && n.kind === "quantitative") {
    const before = p.remaining ?? (p.limit !== null && p.used !== null ? p.limit - p.used : null);
    const after = n.remaining ?? (n.limit !== null && n.used !== null ? n.limit - n.used : null);
    if (before !== null && after !== null && after < before) changes.push("REMAINING_DECREASED");
    if (before !== null && after !== null && after > before) changes.push("REMAINING_INCREASED");
    if (p.used !== n.used) changes.push("USED_CHANGED");
  }
  if (p.kind === "headroom" && n.kind === "headroom" && p.usedPercentage !== n.usedPercentage)
    changes.push("HEADROOM_CHANGED");
  if (JSON.stringify(previous.coverage) !== JSON.stringify(next.coverage))
    changes.push("COVERAGE_CHANGED");
  return changes;
}
function missingCapabilities(...observations: QuotaObservation[]): MissingCapability[] {
  const missing = new Set<MissingCapability>();
  for (const { capability: c, coverage, clocks } of observations) {
    if (c.asOf !== "provider" || clocks.sourceAsOf === null) missing.add("PROVIDER_AS_OF");
    if (c.windowSemantics !== "documented") missing.add("WINDOW_SEMANTICS");
    if (c.usageCoverage !== "declared" || coverage.kind !== "declared")
      missing.add("USAGE_COVERAGE");
    if (c.correlation !== "request-id") missing.add("CORRELATION");
  }
  return [...missing];
}

/** CliReadiness.usage as it must arrive at run time; every window field is required. */
const cliUsageSchema = z.object({
  observedAt: iso,
  windows: z.array(
    z.object({
      scope: z.string().min(1),
      usedPercentage: z.number().finite().min(0),
      resetsAt: iso
    })
  )
});
/** The existing CLI usage snapshot, as reported by the local bridge. */
export const CLAUDE_CLI_USAGE_CAPABILITY: QuotaSourceCapability = {
  sourceId: "claude-cli-usage",
  provenance: "cli-usage",
  asOf: "adapter-reported",
  windowSemantics: "undocumented",
  usageCoverage: "unknown",
  correlation: "none"
};
/**
 * Maps CliReadiness.usage windows as typed today. Window names are kept as limit
 * ids; their reset semantics are not known and are not assumed. A percentage over
 * 100 is kept as reported. The batch is all or nothing: missing usage is
 * unavailable, and a duplicate or malformed window rejects every window.
 */
export function fromClaudeUsageWindows(
  usage: CliReadiness["usage"],
  receivedAt: string,
  poolId: string
):
  | { status: "mapped"; observations: QuotaObservationInput[] }
  | { status: "unavailable"; reason: "USAGE_UNAVAILABLE" }
  | {
      status: "invalid";
      reason: "INVALID_MAPPING_INPUT" | "DUPLICATE_LIMIT" | "MALFORMED_WINDOW";
    } {
  // The caller's own arguments are checked once, before anything is mapped.
  if (!iso.safeParse(receivedAt).success || typeof poolId !== "string" || !poolId)
    return { status: "invalid", reason: "INVALID_MAPPING_INPUT" };
  if (!usage) return { status: "unavailable", reason: "USAGE_UNAVAILABLE" };
  const shape = cliUsageSchema.safeParse(usage);
  if (!shape.success) return { status: "invalid", reason: "MALFORMED_WINDOW" };
  if (!shape.data.windows.length) return { status: "unavailable", reason: "USAGE_UNAVAILABLE" };
  const observations: QuotaObservationInput[] = shape.data.windows.map((w) => ({
    version: "quota-observation-v1" as const,
    identity: { sourceId: CLAUDE_CLI_USAGE_CAPABILITY.sourceId, poolId, limitId: w.scope },
    window: { kind: "unknown" as const, resetsAt: w.resetsAt },
    measure: { kind: "headroom" as const, usedPercentage: w.usedPercentage },
    coverage: { kind: "unknown" as const },
    clocks: { sourceAsOf: shape.data.observedAt, receivedAt }
  }));
  if (new Set(observations.map((o) => o.identity.limitId)).size !== observations.length)
    return { status: "invalid", reason: "DUPLICATE_LIMIT" };
  return { status: "mapped", observations };
}

/** Operator configuration: declared, never observed. */
export const OPERATOR_CONFIG_CAPABILITY: QuotaSourceCapability = {
  sourceId: "operator-config",
  provenance: "operator-config",
  asOf: "none",
  windowSemantics: "undocumented",
  usageCoverage: "unknown",
  correlation: "none"
};
export function fromConfiguredQuota(
  quota: NonNullable<BindingResources["quota"]>,
  receivedAt: string
): QuotaObservationInput {
  // Only the static configured quota maps to an observation; an envelope has no
  // static remaining and is never described as one.
  if (
    typeof quota !== "object" ||
    quota === null ||
    typeof quota.remaining !== "number" ||
    "mode" in quota ||
    !quota.evidence
  )
    throw new TypeError("STATIC_QUOTA_REQUIRED");
  return {
    version: "quota-observation-v1",
    identity: {
      sourceId: OPERATOR_CONFIG_CAPABILITY.sourceId,
      poolId: quota.poolId,
      limitId: "configured"
    },
    window: { kind: "none" },
    measure: {
      kind: "quantitative",
      unit: quota.unit,
      limit: null,
      used: null,
      remaining: quota.remaining
    },
    coverage: { kind: "unknown" },
    clocks: {
      sourceAsOf: null,
      receivedAt,
      declaredAt: quota.evidence.checkedAtIso,
      declaredExpiresAt: quota.evidence.expiresAtIso
    }
  };
}
