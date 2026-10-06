import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_USAGE_CAPABILITY,
  OPERATOR_CONFIG_CAPABILITY,
  classifySuccessor,
  describeAllowance,
  fromClaudeUsageWindows,
  fromConfiguredQuota,
  normalizeQuotaObservation,
  type QuotaObservation,
  type QuotaObservationInput,
  type QuotaSourceCapability
} from "../../src/routing/quotaObservation";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const options = { maxAgeMs: 60_000, skewToleranceMs: 1_000 };

/** A hypothetical provider that documents its windows, as-of and coverage. */
const PROVIDER: QuotaSourceCapability = {
  sourceId: "provider",
  provenance: "provider-api",
  asOf: "provider",
  windowSemantics: "documented",
  usageCoverage: "declared",
  correlation: "request-id"
};
function payload(overrides: Partial<QuotaObservationInput> = {}): QuotaObservationInput {
  return {
    version: "quota-observation-v1",
    identity: { sourceId: "provider", poolId: "pool", limitId: "daily" },
    window: { kind: "fixed", startsAt: at(-3_600_000), resetsAt: at(3_600_000) },
    measure: { kind: "quantitative", unit: "requests", limit: 100, used: 40, remaining: 60 },
    coverage: {
      kind: "declared",
      events: "accepted-requests",
      callers: "this-credential",
      throughAt: at(0)
    },
    clocks: { sourceAsOf: at(0), receivedAt: at(0) },
    ...overrides
  };
}
function accept(raw: unknown, capability = PROVIDER, now = T0, opts = options): QuotaObservation {
  const result = normalizeQuotaObservation(raw, capability, now, opts);
  if (result.status !== "accepted") throw new Error(JSON.stringify(result));
  return result.observation;
}
const reason = (raw: unknown, capability = PROVIDER, now = T0, opts = options) => {
  const result = normalizeQuotaObservation(raw, capability, now, opts);
  return result.status === "accepted" ? "accepted" : `${result.status}:${result.reason}`;
};

describe("normalize", () => {
  it("accepts a well-formed observation with provider-anchored freshness", () => {
    const o = accept(payload());
    expect(o.freshness).toEqual({ basis: "provider-as-of", until: at(60_000) });
    expect(o.key).toBe(JSON.stringify(["provider", "pool", "daily"]));
  });

  it("rejects invalid options and schemas without throwing", () => {
    for (const bad of [
      { maxAgeMs: 0, skewToleranceMs: 0 },
      { maxAgeMs: 1.5, skewToleranceMs: 0 },
      { maxAgeMs: 1, skewToleranceMs: -1 },
      { maxAgeMs: 1, skewToleranceMs: 0, extra: 1 }
    ])
      expect(reason(payload(), PROVIDER, T0, bad as typeof options)).toBe(
        "invalid:INVALID_OPTIONS"
      );
    expect(reason(payload(), PROVIDER, NaN)).toBe("invalid:INVALID_OPTIONS");
    // A zero skew tolerance is allowed.
    expect(reason(payload(), PROVIDER, T0, { maxAgeMs: 1, skewToleranceMs: 0 })).toBe("accepted");
    for (const bad of [
      null,
      { ...payload(), version: "quota-observation-v2" },
      { ...payload(), extra: true },
      payload({ clocks: { sourceAsOf: "yesterday", receivedAt: at(0) } }),
      payload({ measure: { kind: "headroom", usedPercentage: -1 } }),
      payload({ window: { kind: "rolling", durationMs: 0 } })
    ])
      expect(reason(bad)).toBe("invalid:INVALID_SCHEMA");
  });

  it("refuses payload claims the source does not declare", () => {
    expect(reason(payload(), { ...PROVIDER, sourceId: "other" })).toBe("ambiguous:SOURCE_MISMATCH");
    expect(reason(payload(), { ...PROVIDER, asOf: "none" })).toBe(
      "ambiguous:AS_OF_NOT_DECLARED_BY_SOURCE"
    );
    expect(reason(payload(), { ...PROVIDER, windowSemantics: "undocumented" })).toBe(
      "ambiguous:WINDOW_SEMANTICS_NOT_DECLARED_BY_SOURCE"
    );
    expect(reason(payload(), { ...PROVIDER, usageCoverage: "unknown" })).toBe(
      "ambiguous:COVERAGE_NOT_DECLARED_BY_SOURCE"
    );
  });

  it("checks clocks: future receipt, skew, bounds, coverage and staleness", () => {
    expect(reason(payload({ clocks: { sourceAsOf: at(0), receivedAt: at(1_001) } }))).toBe(
      "ambiguous:FUTURE_RECEIPT"
    );
    expect(reason(payload({ clocks: { sourceAsOf: at(1_001), receivedAt: at(0) } }))).toBe(
      "ambiguous:CLOCK_SKEW"
    );
    expect(reason(payload({ window: { kind: "fixed", startsAt: at(0), resetsAt: at(0) } }))).toBe(
      "ambiguous:WINDOW_BOUNDS_INVALID"
    );
    expect(
      reason(
        payload({
          coverage: {
            kind: "declared",
            events: "billed-units",
            callers: "account",
            throughAt: at(1)
          }
        })
      )
    ).toBe("ambiguous:COVERAGE_AFTER_AS_OF");
    // Stale by its own as-of, however recently it was received.
    expect(
      reason(
        payload({
          clocks: { sourceAsOf: at(-60_000), receivedAt: at(0) },
          coverage: { kind: "unknown" }
        }),
        PROVIDER,
        T0
      )
    ).toBe("unsupported:STALE");
    // Exactly at the boundary is stale; one millisecond before is not.
    expect(reason(payload(), PROVIDER, T0 + 60_000)).toBe("unsupported:STALE");
    expect(reason(payload(), PROVIDER, T0 + 59_999)).toBe("accepted");
  });

  it("checks quantitative measures for consistency and a knowable remainder", () => {
    expect(
      reason(
        payload({
          measure: { kind: "quantitative", unit: "tokens", limit: 100, used: 40, remaining: 50 }
        })
      )
    ).toBe("ambiguous:INCONSISTENT_MEASURE");
    expect(
      reason(
        payload({
          measure: { kind: "quantitative", unit: "tokens", limit: 100, used: null, remaining: null }
        })
      )
    ).toBe("unsupported:REMAINING_UNKNOWN");
  });

  it("labels freshness by who stated the time, and never refreshes on re-receipt", () => {
    const adapter = { ...PROVIDER, asOf: "adapter-reported" as const };
    expect(accept(payload(), adapter).freshness.basis).toBe("adapter-as-of");
    const local = accept(payload({ clocks: { sourceAsOf: null, receivedAt: at(0) } }), {
      ...PROVIDER,
      asOf: "none"
    });
    expect(local.freshness).toEqual({ basis: "local-receipt", until: at(60_000) });
    // The same snapshot received later keeps its original freshness.
    const again = accept(
      payload({ clocks: { sourceAsOf: at(0), receivedAt: at(30_000) } }),
      PROVIDER,
      T0 + 30_000
    );
    expect(again.freshness.until).toBe(at(60_000));
  });
});

describe("normalize: review regressions", () => {
  it("reports freshness beyond the date range instead of throwing (A)", () => {
    const extreme = { maxAgeMs: Number.MAX_SAFE_INTEGER, skewToleranceMs: 0 };
    expect(() => normalizeQuotaObservation(payload(), PROVIDER, T0, extreme)).not.toThrow();
    expect(normalizeQuotaObservation(payload(), PROVIDER, T0, extreme)).toMatchObject({
      status: "invalid",
      reason: "INVALID_OPTIONS"
    });
    expect(reason(payload(), PROVIDER, 8.64e15 + 1)).toBe("invalid:INVALID_OPTIONS");
    // A large but representable age is fine.
    expect(reason(payload(), PROVIDER, T0, { maxAgeMs: 10 ** 12, skewToleranceMs: 0 })).toBe(
      "accepted"
    );
  });

  it("rejects overdrawn or contradictory quantities instead of describing them (B)", () => {
    const measure = (limit: number | null, used: number | null, remaining: number | null) =>
      payload({ measure: { kind: "quantitative", unit: "requests", limit, used, remaining } });
    expect(reason(measure(10, 20, null))).toBe("ambiguous:USED_EXCEEDS_LIMIT");
    expect(reason(measure(10, null, 20))).toBe("ambiguous:INCONSISTENT_MEASURE");
    expect(reason(measure(10, 10, null))).toBe("accepted");
    expect(reason(measure(null, 5, 3))).toBe("accepted");
  });

  it("rejects impossible offsets without throwing", () => {
    for (const bad of [
      "2026-10-06T12:00:00+99:99",
      "2026-10-06T12:00:00+24:00",
      "2026-10-06T12:00:00+00:60"
    ]) {
      expect(() =>
        normalizeQuotaObservation(
          payload({ clocks: { sourceAsOf: bad, receivedAt: at(0) } }),
          PROVIDER,
          T0,
          options
        )
      ).not.toThrow();
      expect(reason(payload({ clocks: { sourceAsOf: bad, receivedAt: at(0) } }))).toBe(
        "invalid:INVALID_SCHEMA"
      );
      expect(
        fromClaudeUsageWindows(
          {
            source: "bridge",
            observedAt: at(0),
            windows: [{ scope: "five_hour", usedPercentage: 1, resetsAt: bad }],
            extraUsageEnabled: null
          },
          at(0),
          "p"
        )
      ).toEqual({ status: "invalid", reason: "MALFORMED_WINDOW" });
    }
  });

  it("compares equivalent ISO forms of the same instants as equal (C)", () => {
    const offset = payload({
      window: {
        kind: "fixed",
        startsAt: "2026-10-06T12:00:00+01:00",
        resetsAt: "2026-10-06T14:00:00.000+01:00"
      }
    });
    const utc = payload({
      window: { kind: "fixed", startsAt: at(-3_600_000), resetsAt: at(3_600_000) }
    });
    expect(classifySuccessor(accept(offset), accept(utc)).relation).toBe("duplicate");
    expect(accept(offset).window).toEqual(utc.window);
  });
});

describe("describeAllowance", () => {
  it("describes a number without ever being authoritative", () => {
    expect(describeAllowance(accept(payload()), T0)).toEqual({
      status: "described",
      remaining: 60,
      unit: "requests",
      basis: "provider-as-of",
      authoritative: false
    });
    const derived = accept(
      payload({
        measure: { kind: "quantitative", unit: "tokens", limit: 10, used: 4, remaining: null }
      })
    );
    expect(describeAllowance(derived, T0)).toMatchObject({ remaining: 6, authoritative: false });
  });

  it("never turns headroom into a number", () => {
    for (const usedPercentage of [0, 50, 100]) {
      const o = accept(
        payload({ measure: { kind: "headroom", usedPercentage }, coverage: { kind: "unknown" } })
      );
      expect(describeAllowance(o, T0)).toEqual({ status: "unsupported", reason: "HEADROOM_ONLY" });
    }
  });

  it("does not describe a fixed window that has not started yet (C)", () => {
    const o = accept(
      payload({ window: { kind: "fixed", startsAt: at(10_000), resetsAt: at(20_000) } })
    );
    expect(describeAllowance(o, T0 + 9_999)).toEqual({
      status: "unsupported",
      reason: "WINDOW_NOT_STARTED"
    });
    expect(describeAllowance(o, T0 + 10_000).status).toBe("described");
  });

  it("does not describe a fixed window that has ended, even while the snapshot is fresh", () => {
    const o = accept(
      payload({ window: { kind: "fixed", startsAt: at(-10_000), resetsAt: at(10_000) } })
    );
    expect(describeAllowance(o, T0 + 9_999).status).toBe("described");
    expect(describeAllowance(o, T0 + 10_000)).toEqual({
      status: "unsupported",
      reason: "WINDOW_ENDED"
    });
    expect(describeAllowance(o, T0 + 60_000)).toEqual({ status: "unsupported", reason: "STALE" });
  });
});

describe("classifySuccessor", () => {
  const next = (overrides: Partial<QuotaObservationInput>, offset = 10_000, cap = PROVIDER) =>
    accept(
      payload({
        clocks: { sourceAsOf: at(offset), receivedAt: at(offset) },
        coverage: {
          kind: "declared",
          events: "accepted-requests",
          callers: "this-credential",
          throughAt: at(offset)
        },
        ...overrides
      }),
      cap,
      T0 + offset
    );
  const first = () => accept(payload());

  it("describes an increase without ever permitting it", () => {
    const up = classifySuccessor(
      first(),
      next({
        measure: { kind: "quantitative", unit: "requests", limit: 100, used: 20, remaining: 80 }
      })
    );
    expect(up).toEqual({
      relation: "same-window",
      changes: ["REMAINING_INCREASED", "USED_CHANGED", "COVERAGE_CHANGED"],
      missing: []
    });
    // The result has no field that grants, refunds or resets anything.
    expect(Object.keys(up).sort()).toEqual(["changes", "missing", "relation"]);
    const down = classifySuccessor(
      first(),
      next({
        measure: { kind: "quantitative", unit: "requests", limit: 100, used: 50, remaining: 50 }
      })
    );
    expect(down.changes).toContain("REMAINING_DECREASED");
  });

  it("separates identities and refuses to order snapshots without provider as-of times", () => {
    expect(
      classifySuccessor(first(), next({ identity: { ...payload().identity, limitId: "x" } }))
        .relation
    ).toBe("different-identity");
    const adapter = { ...PROVIDER, asOf: "adapter-reported" as const };
    const a = accept(payload(), adapter),
      b = accept(payload({ clocks: { sourceAsOf: at(5), receivedAt: at(5) } }), adapter, T0 + 5);
    expect(classifySuccessor(a, b)).toMatchObject({
      relation: "no-provider-as-of",
      missing: ["PROVIDER_AS_OF"]
    });
  });

  it("ignores an older snapshot and treats an identical one as a duplicate", () => {
    const later = next({});
    expect(classifySuccessor(later, first()).relation).toBe("out-of-order");
    const copy = accept(
      payload({ clocks: { sourceAsOf: at(0), receivedAt: at(20_000) } }),
      PROVIDER,
      T0 + 20_000
    );
    expect(classifySuccessor(first(), copy).relation).toBe("duplicate");
    // A duplicate keeps the original freshness.
    expect(copy.freshness.until).toBe(first().freshness.until);
  });

  it("flags any accounting difference at the same instant, coverage and capability included", () => {
    const same = { clocks: { sourceAsOf: at(0), receivedAt: at(0) } };
    expect(
      classifySuccessor(
        first(),
        accept(
          payload({
            ...same,
            coverage: {
              kind: "declared",
              events: "completed-requests",
              callers: "this-credential",
              throughAt: at(0)
            }
          })
        )
      ).relation
    ).toBe("same-instant-conflict");
    expect(
      classifySuccessor(first(), accept(payload(same), { ...PROVIDER, correlation: "none" }))
        .relation
    ).toBe("same-instant-conflict");
  });

  it("describes a later disjoint fixed window, and conflicts on overlapping bounds", () => {
    const later = next(
      { window: { kind: "fixed", startsAt: at(3_600_000), resetsAt: at(7_200_000) } },
      3_600_000
    );
    expect(classifySuccessor(first(), later).relation).toBe("new-fixed-window");
    // Exactly adjacent counts as disjoint; starting one millisecond earlier overlaps.
    const overlapping = next(
      { window: { kind: "fixed", startsAt: at(3_599_999), resetsAt: at(7_200_000) } },
      3_599_999
    );
    expect(classifySuccessor(first(), overlapping).relation).toBe("conflict");
    const moved = next({ window: { kind: "fixed", startsAt: at(-3_600_000), resetsAt: at(1) } });
    expect(classifySuccessor(first(), moved).relation).toBe("conflict");
  });

  it("conflicts on a changed window kind, unit, rolling duration or limit", () => {
    expect(classifySuccessor(first(), next({ window: { kind: "none" } })).relation).toBe(
      "conflict"
    );
    expect(
      classifySuccessor(
        first(),
        next({
          measure: { kind: "quantitative", unit: "tokens", limit: 100, used: 40, remaining: 60 }
        })
      ).relation
    ).toBe("conflict");
    expect(
      classifySuccessor(
        first(),
        next({
          measure: { kind: "quantitative", unit: "requests", limit: 200, used: 40, remaining: 160 }
        })
      ).relation
    ).toBe("conflict");
    const rolling = (durationMs: number, offset: number) =>
      next({ window: { kind: "rolling", durationMs } }, offset);
    expect(classifySuccessor(rolling(3_600_000, 0), rolling(3_600_000, 10_000)).relation).toBe(
      "same-window"
    );
    expect(classifySuccessor(rolling(3_600_000, 0), rolling(7_200_000, 10_000)).relation).toBe(
      "conflict"
    );
  });

  it("reports a changed reset time on an unknown window without assuming a reset", () => {
    const cap = { ...PROVIDER, windowSemantics: "undocumented" as const };
    const a = next({ window: { kind: "unknown", resetsAt: at(1_000_000) } }, 0, cap),
      b = next({ window: { kind: "unknown", resetsAt: at(2_000_000) } }, 10_000, cap);
    expect(classifySuccessor(a, b)).toEqual({
      relation: "unknown-window",
      changes: ["COVERAGE_CHANGED", "RESET_TIME_CHANGED"],
      missing: ["WINDOW_SEMANTICS"]
    });
  });

  it("compares capabilities regardless of field order, and conflicts when one changes (D)", () => {
    const reordered = Object.fromEntries(Object.entries(PROVIDER).reverse()) as typeof PROVIDER;
    expect(
      classifySuccessor(
        first(),
        accept(payload({ clocks: { sourceAsOf: at(0), receivedAt: at(0) } }), reordered)
      ).relation
    ).toBe("duplicate");
    expect(
      classifySuccessor(first(), next({}, 10_000, { ...PROVIDER, correlation: "none" }))
    ).toEqual({ relation: "conflict", changes: ["CAPABILITY_CHANGED"], missing: ["CORRELATION"] });
  });

  it("conflicts on a changed limit within an unknown window (D)", () => {
    const cap = { ...PROVIDER, windowSemantics: "undocumented" as const };
    const window = { kind: "unknown" as const, resetsAt: at(1_000_000) };
    const a = next({ window }, 0, cap),
      b = next(
        {
          window,
          measure: { kind: "quantitative", unit: "requests", limit: 200, used: 40, remaining: 160 }
        },
        10_000,
        cap
      );
    expect(classifySuccessor(a, b).relation).toBe("conflict");
  });

  it("reports a missing as-of even from a source that could state one (E)", () => {
    const a = accept(payload({ clocks: { sourceAsOf: null, receivedAt: at(0) } }));
    expect(classifySuccessor(a, a)).toMatchObject({
      relation: "no-provider-as-of",
      missing: ["PROVIDER_AS_OF"]
    });
  });

  it("lists every capability a reconciler would lack", () => {
    const bare = { ...PROVIDER, usageCoverage: "unknown" as const, correlation: "none" as const };
    const a = next({ coverage: { kind: "unknown" } }, 0, bare),
      b = next({ coverage: { kind: "unknown" } }, 10_000, bare);
    expect(classifySuccessor(a, b).missing.sort()).toEqual(["CORRELATION", "USAGE_COVERAGE"]);
    // A source able to declare coverage that did not declare it still lacks coverage.
    const c = next({ coverage: { kind: "unknown" } }, 0),
      d = next({ coverage: { kind: "unknown" } }, 10_000);
    expect(classifySuccessor(c, d).missing).toEqual(["USAGE_COVERAGE"]);
  });
});

describe("adapters", () => {
  const usage = (windows: unknown[]) => ({
    source: "bridge",
    observedAt: at(0),
    windows: windows as { scope: string; usedPercentage: number; resetsAt: string }[],
    extraUsageEnabled: null
  });
  it("maps the existing CLI usage shape as headroom with unknown reset semantics", () => {
    const mapped = fromClaudeUsageWindows(
      usage([
        { scope: "five_hour", usedPercentage: 12, resetsAt: at(3_600_000) },
        { scope: "seven_day", usedPercentage: 140, resetsAt: at(86_400_000) }
      ]),
      at(500),
      "profile-ref"
    );
    if (mapped.status !== "mapped") throw new Error(mapped.status);
    const observations = mapped.observations.map((p) =>
      accept(p, CLAUDE_CLI_USAGE_CAPABILITY, T0 + 500)
    );
    // Over 100% is kept as reported, not rejected or capped.
    expect(observations.map((o) => [o.identity.limitId, o.window, o.measure])).toEqual([
      [
        "five_hour",
        { kind: "unknown", resetsAt: at(3_600_000) },
        { kind: "headroom", usedPercentage: 12 }
      ],
      [
        "seven_day",
        { kind: "unknown", resetsAt: at(86_400_000) },
        { kind: "headroom", usedPercentage: 140 }
      ]
    ]);
    expect(observations[0].freshness.basis).toBe("adapter-as-of");
    expect(describeAllowance(observations[0], T0)).toEqual({
      status: "unsupported",
      reason: "HEADROOM_ONLY"
    });
    expect(classifySuccessor(observations[0], observations[0]).missing.sort()).toEqual([
      "CORRELATION",
      "PROVIDER_AS_OF",
      "USAGE_COVERAGE",
      "WINDOW_SEMANTICS"
    ]);
  });

  it("maps a usage batch all or nothing", () => {
    expect(fromClaudeUsageWindows(undefined, at(0), "p")).toEqual({
      status: "unavailable",
      reason: "USAGE_UNAVAILABLE"
    });
    expect(fromClaudeUsageWindows(usage([]), at(0), "p").status).toBe("unavailable");
    const good = { scope: "five_hour", usedPercentage: 1, resetsAt: at(1) };
    expect(fromClaudeUsageWindows(usage([good, { ...good }]), at(0), "p")).toEqual({
      status: "invalid",
      reason: "DUPLICATE_LIMIT"
    });
    for (const bad of [
      { ...good, scope: "seven_day", usedPercentage: Number.NaN },
      { ...good, scope: "seven_day", usedPercentage: -1 },
      { ...good, scope: "seven_day", resetsAt: "soon" },
      { ...good, scope: "" },
      null
    ])
      expect(fromClaudeUsageWindows(usage([good, bad]), at(0), "p")).toEqual({
        status: "invalid",
        reason: "MALFORMED_WINDOW"
      });
  });

  it("validates the caller's receipt time and pool before mapping", () => {
    const window = { scope: "five_hour", usedPercentage: 1, resetsAt: at(1) };
    for (const [receivedAt, poolId] of [
      ["bad", "p"],
      ["2026-10-06T12:00:00+99:99", "p"],
      [at(0), ""]
    ])
      expect(fromClaudeUsageWindows(usage([window]), receivedAt, poolId)).toEqual({
        status: "invalid",
        reason: "INVALID_MAPPING_INPUT"
      });
    // Checked before availability, so a bad argument is never reported as missing usage.
    expect(fromClaudeUsageWindows(undefined, "bad", "p")).toEqual({
      status: "invalid",
      reason: "INVALID_MAPPING_INPUT"
    });
  });

  it("validates the incoming usage shape before mapping (F)", () => {
    const good = { scope: "five_hour", usedPercentage: 1, resetsAt: at(1) };
    const { resetsAt: _, ...noReset } = good;
    expect(fromClaudeUsageWindows(usage([noReset]), at(0), "p")).toEqual({
      status: "invalid",
      reason: "MALFORMED_WINDOW"
    });
    expect(fromClaudeUsageWindows({ ...usage([good]), observedAt: "now" }, at(0), "p")).toEqual({
      status: "invalid",
      reason: "MALFORMED_WINDOW"
    });
  });

  it("maps configured quota as declared, capped by its configured expiry", () => {
    const quota = {
      poolId: "pool",
      unit: "requests" as const,
      remaining: 5,
      evidence: {
        source: "operator",
        kind: "configured" as const,
        checkedAtIso: at(-10_000),
        expiresAtIso: at(20_000)
      }
    };
    const mapped = fromConfiguredQuota(quota, at(0));
    expect(mapped.clocks).toEqual({
      sourceAsOf: null,
      receivedAt: at(0),
      declaredAt: at(-10_000),
      declaredExpiresAt: at(20_000)
    });
    const o = accept(mapped, OPERATOR_CONFIG_CAPABILITY);
    expect(o.freshness).toEqual({ basis: "declared", until: at(20_000) });
    expect(describeAllowance(o, T0)).toMatchObject({ remaining: 5, basis: "declared" });
    // Mapping stale configuration later does not make it fresh.
    expect(
      reason(fromConfiguredQuota(quota, at(25_000)), OPERATOR_CONFIG_CAPABILITY, T0 + 25_000)
    ).toBe("unsupported:STALE");
    const old = { ...quota, evidence: { ...quota.evidence, expiresAtIso: at(600_000) } };
    expect(
      reason(fromConfiguredQuota(old, at(55_000)), OPERATOR_CONFIG_CAPABILITY, T0 + 55_000)
    ).toBe("unsupported:STALE");
  });
});
