import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeReadiness,
  InventoryStore,
  type DiscoveryAdapter,
  type ModelObservation
} from "../../src/models/inventory";
import type { Connection } from "../../src/models/connections";
import { UNKNOWN_RESOURCE_FACTS } from "../../src/models/connections";

function fixtureObservation(overrides: Partial<ModelObservation> = {}): ModelObservation {
  return {
    bindingId: "b1",
    connectionId: "c1",
    model: "m1",
    observedAtIso: "2026-09-29T00:00:00.000Z",
    expiresAtIso: "2026-09-29T00:10:00.000Z",
    source: "fixture",
    installed: "yes",
    access: "allowed",
    health: "reachable",
    apiCompatibility: ["ollama-chat"],
    ...overrides
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "c1",
    apiKind: "ollama-chat",
    resourceFacts: UNKNOWN_RESOURCE_FACTS,
    quota: {},
    compute: { ownedOrRented: "unknown" },
    ...overrides
  };
}

describe("computeReadiness precedence", () => {
  const now = "2026-09-29T00:05:00.000Z";

  it("disabled takes precedence over everything else", () => {
    expect(
      computeReadiness({
        enabled: false,
        adapterImplemented: false,
        observation: fixtureObservation({ access: "denied" }),
        nowIso: now
      })
    ).toBe("disabled");
  });

  it("unsupported-adapter takes precedence over a fresh ready observation", () => {
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: false,
        observation: fixtureObservation(),
        nowIso: now
      })
    ).toBe("unsupported-adapter");
  });

  it("unchecked when no observation exists yet", () => {
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: undefined,
        nowIso: now
      })
    ).toBe("unchecked");
  });

  it("stale when the observation has expired, even if access/health look fine", () => {
    const expired = fixtureObservation({ expiresAtIso: "2026-09-29T00:04:59.000Z" });
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: expired,
        nowIso: now
      })
    ).toBe("stale");
  });

  it("denied when access is explicitly denied and the observation is fresh", () => {
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: fixtureObservation({ access: "denied" }),
        nowIso: now
      })
    ).toBe("denied");
  });

  it("unavailable when health is unreachable or access is merely unknown", () => {
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: fixtureObservation({ health: "unreachable" }),
        nowIso: now
      })
    ).toBe("unavailable");
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: fixtureObservation({ access: "unknown" }),
        nowIso: now
      })
    ).toBe("unavailable");
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: fixtureObservation({ installed: "no" }),
        nowIso: now
      })
    ).toBe("unavailable");
  });

  it("ready requires fresh, allowed, reachable, installed all at once", () => {
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: fixtureObservation(),
        nowIso: now
      })
    ).toBe("ready");
  });
});

describe("InventoryStore", () => {
  it.each([
    [undefined, 600000],
    ["2026-09-29T00:00:30.000Z", 30000],
    ["2026-09-29T01:00:00.000Z", 600000],
    ["2026-09-29T00:00:00.000Z", 0]
  ])("caps discovery validity %s at %s ms", async (expiresAtIso, expectedMs) => {
    const observation = { ...fixtureObservation(), expiresAtIso };
    const store = new InventoryStore(
      { "ollama-chat": { discover: async () => [observation] } },
      { intervalMs: 1000, ttlMs: 600000, timeoutMs: 1000, maxConcurrentRequests: 1 }
    );
    await store.refreshConnection(connection());
    const stored = store.getObservation("b1")!;
    expect(Date.parse(stored.expiresAtIso) - Date.parse(stored.observedAtIso)).toBe(expectedMs);
    if (expectedMs === 30000)
      expect(
        computeReadiness({
          enabled: true,
          adapterImplemented: true,
          observation: stored,
          nowIso: "2026-09-29T00:00:31.000Z"
        })
      ).toBe("stale");
    store.shutdown();
  });
  afterEach(() => vi.useRealTimers());

  it("stores observations from a successful discovery call", async () => {
    const adapter: DiscoveryAdapter = { discover: vi.fn(async () => [fixtureObservation()]) };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 4 }
    );

    await store.refreshConnection(connection());
    expect(store.getObservation("b1")).toMatchObject({ installed: "yes", health: "reachable" });
  });

  it("a failed refresh retains the prior observation without extending its expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));

    let call = 0;
    const adapter: DiscoveryAdapter = {
      discover: vi.fn(async () => {
        call += 1;
        if (call === 1) return [fixtureObservation({ observedAtIso: "2026-09-29T00:00:00.000Z" })];
        throw new Error("provider unreachable");
      })
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 4 },
      () => new Date()
    );

    await store.refreshConnection(connection());
    const first = store.getObservation("b1")!;

    vi.setSystemTime(new Date("2026-09-29T00:05:00.000Z"));
    await store.refreshConnection(connection());
    const second = store.getObservation("b1")!;

    expect(second).toEqual(first);
  });

  it("fake-clock expiration makes a ready binding become stale, and a failed refresh cannot renew it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));

    const adapter: DiscoveryAdapter = {
      discover: vi
        .fn()
        .mockResolvedValueOnce([fixtureObservation({ observedAtIso: "2026-09-29T00:00:00.000Z" })])
        .mockRejectedValueOnce(new Error("still unreachable"))
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 60_000, timeoutMs: 1000, maxConcurrentRequests: 4 }
    );

    await store.refreshConnection(connection());
    const nowFresh = new Date().toISOString();
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: store.getObservation("b1"),
        nowIso: nowFresh
      })
    ).toBe("ready");

    vi.setSystemTime(new Date("2026-09-29T00:02:00.000Z")); // past the 60s TTL
    await store.refreshConnection(connection()); // fails; must not refresh expiresAtIso
    const nowLater = new Date().toISOString();
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: store.getObservation("b1"),
        nowIso: nowLater
      })
    ).toBe("stale");
  });

  it("a full successful listing removes disappeared bindings and makes them unchecked", async () => {
    const adapter: DiscoveryAdapter = {
      discover: vi
        .fn()
        .mockResolvedValueOnce([
          fixtureObservation({ bindingId: "b1" }),
          fixtureObservation({ bindingId: "b2", model: "m2" })
        ])
        .mockResolvedValueOnce([fixtureObservation({ bindingId: "b1" })]) // b2 disappeared
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 4 }
    );

    await store.refreshConnection(connection());
    expect(store.getObservation("b2")?.installed).toBe("yes");

    await store.refreshConnection(connection());
    expect(store.getObservation("b2")).toBeUndefined();
    expect(
      computeReadiness({
        enabled: true,
        adapterImplemented: true,
        observation: store.getObservation("b2"),
        nowIso: new Date().toISOString()
      })
    ).toBe("unchecked");
    expect(store.getObservation("b1")?.installed).toBe("yes");
  });

  it("a partial provider failure leaves other connections usable", async () => {
    const failing: DiscoveryAdapter = {
      discover: vi.fn(async () => {
        throw new Error("azure unreachable");
      })
    };
    const working: DiscoveryAdapter = {
      discover: vi.fn(async () => [
        fixtureObservation({ bindingId: "ollama-b1", connectionId: "ollama-conn" })
      ])
    };
    const store = new InventoryStore(
      { "azure-openai-chat": failing, "ollama-chat": working },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 4 }
    );

    await store.refreshAll([
      connection({ connectionId: "azure-conn", apiKind: "azure-openai-chat" }),
      connection({ connectionId: "ollama-conn", apiKind: "ollama-chat" })
    ]);

    expect(store.getObservation("ollama-b1")).toBeDefined();
    expect(store.listObservations()).toHaveLength(1);
  });

  it("one refresh per connection at a time -- a concurrent call joins the in-flight one", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: DiscoveryAdapter = {
      discover: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [fixtureObservation()];
      })
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 4 }
    );

    await Promise.all([
      store.refreshConnection(connection()),
      store.refreshConnection(connection())
    ]);
    expect(maxInFlight).toBe(1);
    expect(adapter.discover).toHaveBeenCalledTimes(1);
  });

  it("refreshAll limits concurrent connection refreshes to maxConcurrentRequests", async () => {
    let concurrent = 0;
    let peak = 0;
    const adapter: DiscoveryAdapter = {
      discover: vi.fn(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return [];
      })
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 2 }
    );
    const connections = Array.from({ length: 6 }, (_, i) => connection({ connectionId: `c${i}` }));

    await store.refreshAll(connections);
    expect(peak).toBeLessThanOrEqual(2);
    expect(adapter.discover).toHaveBeenCalledTimes(6);
  });

  it("obeys the discovery timeout via AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const adapter: DiscoveryAdapter = {
      discover: vi.fn((_connection, signal) => {
        observedSignal = signal;
        return new Promise<ModelObservation[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 5, maxConcurrentRequests: 4 }
    );

    await store.refreshConnection(connection());
    expect(observedSignal?.aborted).toBe(true);
  });

  it("shutdown cancels in-flight discovery requests and is idempotent", async () => {
    let receivedSignal: AbortSignal | undefined;
    const adapter: DiscoveryAdapter = {
      discover: vi.fn((_connection, signal) => {
        receivedSignal = signal;
        return new Promise<ModelObservation[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    };
    const store = new InventoryStore(
      { "ollama-chat": adapter },
      { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 60_000, maxConcurrentRequests: 4 }
    );

    const pending = store.refreshConnection(connection());
    store.shutdown();
    store.shutdown(); // idempotent
    await pending;

    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("InventoryStore batch validation and refresh status", () => {
  const settings = { intervalMs: 1000, ttlMs: 600_000, timeoutMs: 1000, maxConcurrentRequests: 1 };
  const NOW = new Date("2026-09-29T00:05:00.000Z");
  function storeWith(
    listings: Record<string, (connection: Connection, signal: AbortSignal) => unknown>,
    limits: Partial<import("../../src/config/discoveryLimits").DiscoveryLimits> = {},
    config = settings
  ) {
    const discover = vi.fn(async (c: Connection, signal: AbortSignal) =>
      listings[c.connectionId](c, signal)
    );
    const store = new InventoryStore(
      { "ollama-chat": { discover: discover as DiscoveryAdapter["discover"] } },
      config,
      () => NOW,
      {
        maxModelsPerConnection: 1000,
        maxObservations: 4096,
        maxBytes: 8388608,
        maxResponseBytes: 4194304,
        maxRefreshStatuses: 256,
        ...limits
      }
    );
    return { store, discover };
  }
  const row = (bindingId: string, overrides: Record<string, unknown> = {}) => ({
    ...fixtureObservation({ bindingId }),
    expiresAtIso: undefined,
    ...overrides
  });
  const status = (store: InventoryStore, connectionId = "c1") =>
    store.refreshStatuses().connections.find((s) => s.connectionId === connectionId);

  it("rejects a whole batch whose final row is malformed, keeping prior rows and expiry", async () => {
    let batch: unknown[] = [row("b1"), row("b2")];
    const { store } = storeWith({ c1: () => batch });
    await store.refreshConnection(connection());
    const before = store.listObservations();
    expect(before.map((o) => o.bindingId)).toEqual(["b1", "b2"]);
    for (const last of [
      row("b3", { installed: "maybe" }),
      row("b3", { effectiveContextTokens: 0 }),
      row("b3", { effectiveOutputTokens: 1.5 }),
      row("b3", { apiCompatibility: ["x".repeat(65)] }),
      row("b3", { lastErrorCode: "raw provider message" }),
      row("b3", { extra: true }),
      row("b3", { observedAtIso: "2026-09-29T00:00:00+99:99" }),
      row("b3", { expiresAtIso: "invalid" }),
      { ...row("b3"), model: "" },
      null
    ]) {
      batch = [row("b1", { model: "changed" }), row("b2"), last];
      await store.refreshConnection(connection());
      expect(store.listObservations()).toEqual(before);
      expect(status(store)).toMatchObject({
        outcome: "failed",
        code: "DISCOVERY_INVALID_SHAPE",
        observations: 2
      });
    }
  });

  it("rejects an invalid envelope, and an incomplete listing publishes nothing", async () => {
    let listing: unknown = { observations: [row("b1")], complete: true, extra: 1 };
    const { store } = storeWith({ c1: () => listing });
    await store.refreshConnection(connection());
    expect(status(store)).toMatchObject({ code: "DISCOVERY_INVALID_SHAPE" });
    listing = { observations: [row("b1")], complete: false };
    await store.refreshConnection(connection());
    expect(store.listObservations()).toEqual([]);
    expect(status(store)).toMatchObject({ outcome: "partial", code: "DISCOVERY_INCOMPLETE" });
  });

  it("canonicalizes offsets, rejects future and reversed times, and caps the TTL", async () => {
    let batch: unknown[] = [];
    const { store } = storeWith({ c1: () => batch });
    batch = [
      row("b1", {
        observedAtIso: "2026-09-29T01:00:00+01:00",
        expiresAtIso: "2026-09-29T02:00:00+01:00"
      })
    ];
    await store.refreshConnection(connection());
    expect(store.getObservation("b1")).toMatchObject({
      observedAtIso: "2026-09-29T00:00:00.000Z",
      // The declared hour is capped by the ten-minute TTL.
      expiresAtIso: "2026-09-29T00:10:00.000Z"
    });
    // Equal and already-past expiry are valid (immediately stale).
    batch = [row("b1", { expiresAtIso: "2026-09-29T00:00:00.000Z" })];
    await store.refreshConnection(connection());
    expect(status(store)).toMatchObject({ outcome: "succeeded" });
    const cases: [Record<string, unknown>, string][] = [
      [{ observedAtIso: "2026-09-29T00:05:00.001Z" }, "DISCOVERY_FUTURE_OBSERVATION"],
      [{ expiresAtIso: "2026-09-28T23:59:59.999Z" }, "DISCOVERY_REVERSED_EXPIRY"]
    ];
    for (const [overrides, code] of cases) {
      batch = [row("b1", overrides)];
      await store.refreshConnection(connection());
      expect(status(store)).toMatchObject({ outcome: "failed", code });
      // The rejected row never becomes fresh.
      expect(store.getObservation("b1")!.expiresAtIso).toBe("2026-09-29T00:00:00.000Z");
    }
    // Exactly now is not in the future.
    batch = [row("b1", { observedAtIso: NOW.toISOString() })];
    await store.refreshConnection(connection());
    expect(status(store)).toMatchObject({ outcome: "succeeded" });
  });

  it("rejects duplicate, foreign and mismatched identities", async () => {
    let batch: unknown[] = [];
    const { store } = storeWith({
      c1: () => batch,
      c2: () => [row("shared", { connectionId: "c2" })]
    });
    await store.refreshConnection(connection({ connectionId: "c2" }));
    for (const [rows, code] of [
      [[row("b1"), row("b1")], "DISCOVERY_DUPLICATE_BINDING"],
      [[row("shared")], "DISCOVERY_FOREIGN_BINDING"],
      [[row("b1", { connectionId: "c2" })], "DISCOVERY_INVALID_IDENTITY"]
    ] as const) {
      batch = [...rows];
      await store.refreshConnection(connection());
      expect(status(store)).toMatchObject({ outcome: "failed", code });
    }
    expect(store.getObservation("shared")!.connectionId).toBe("c2");
  });

  it("a successful empty listing removes only its own connection", async () => {
    let batch: unknown[] = [row("b1")];
    const { store } = storeWith({ c1: () => batch, c2: () => [row("b2", { connectionId: "c2" })] });
    await store.refreshAll([connection(), connection({ connectionId: "c2" })]);
    batch = [];
    await store.refreshConnection(connection());
    expect(store.listObservations().map((o) => o.bindingId)).toEqual(["b2"]);
    expect(status(store)).toMatchObject({ outcome: "succeeded", observations: 0 });
    expect(status(store, "c2")).toMatchObject({ outcome: "succeeded", observations: 1 });
  });

  it("keeps only owned codes from adapter errors", async () => {
    let failure: Error = new Error("Ollama /api/tags failed (500) at http://secret-host");
    const { store } = storeWith({
      c1: () => {
        throw failure;
      }
    });
    await store.refreshConnection(connection());
    expect(status(store)).toMatchObject({ code: "DISCOVERY_FAILED" });
    expect(JSON.stringify(store.refreshStatuses())).not.toContain("secret");
    for (const code of [
      "DISCOVERY_CAPACITY",
      "DISCOVERY_INCOMPLETE_LISTING",
      "DISCOVERY_RESPONSE_TOO_LARGE",
      "DISCOVERY_EMPTY_BODY"
    ]) {
      failure = new Error(code);
      await store.refreshConnection(connection());
      expect(status(store)).toMatchObject({ code });
    }
  });

  it("records a timeout on settlement and never publishes a late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish!: (rows: unknown[]) => void;
    const { store, discover } = storeWith(
      { c1: () => new Promise((resolve) => (finish = resolve)) },
      {},
      { ...settings, timeoutMs: 100 }
    );
    const first = store.refreshConnection(connection());
    await vi.advanceTimersByTimeAsync(100);
    // Still one flight: a second refresh joins it instead of overlapping.
    expect(store.refreshConnection(connection())).toBe(first);
    expect(status(store)).toBeUndefined();
    finish([row("b1")]);
    await first;
    expect(discover).toHaveBeenCalledTimes(1);
    expect(store.listObservations()).toEqual([]);
    expect(status(store)).toMatchObject({ outcome: "failed", code: "DISCOVERY_TIMEOUT" });
  });

  it("publishes nothing and records nothing for a result arriving after shutdown", async () => {
    let finish!: (rows: unknown[]) => void;
    const { store } = storeWith({ c1: () => new Promise((resolve) => (finish = resolve)) });
    const pending = store.refreshConnection(connection());
    store.shutdown();
    finish([row("b1")]);
    await pending;
    expect(store.listObservations()).toEqual([]);
    expect(store.refreshStatuses().connections).toEqual([]);
  });

  it("publishes nothing under an invalid clock, and a later bad read cannot follow publication", async () => {
    let clock: () => Date = () => new Date(Number.NaN);
    const store = new InventoryStore(
      { "ollama-chat": { discover: async () => [row("b1")] } },
      settings,
      () => clock()
    );
    await store.refreshConnection(connection());
    expect(store.listObservations()).toEqual([]);
    expect(status(store)).toMatchObject({
      outcome: "failed",
      code: "DISCOVERY_INVALID_CLOCK",
      completedAtIso: null
    });
    // Valid for validation, then throwing on every later read.
    let reads = 0;
    clock = () => {
      if (reads++ > 0) throw new Error("clock gone");
      return NOW;
    };
    await expect(store.refreshConnection(connection())).resolves.toBeUndefined();
    expect(store.listObservations().map((o) => o.bindingId)).toEqual(["b1"]);
    expect(status(store)).toMatchObject({
      outcome: "succeeded",
      completedAtIso: NOW.toISOString()
    });
    expect(reads).toBe(1);
  });

  it("evicts the least recently refreshed status first", async () => {
    const listings = new Proxy({} as Record<string, () => unknown>, {
      get: () => () => []
    });
    const { store } = storeWith(listings, { maxRefreshStatuses: 3 });
    for (const id of ["c1", "c2", "c3", "c1", "c4"])
      await store.refreshConnection(connection({ connectionId: id }));
    expect(store.refreshStatuses().connections.map((s) => s.connectionId)).toEqual([
      "c1",
      "c3",
      "c4"
    ]);
  });

  it("records nothing when an adapter fails after shutdown", async () => {
    const { store } = storeWith({
      c1: (_c, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        )
    });
    const pending = store.refreshConnection(connection());
    store.shutdown();
    await pending;
    expect(store.refreshStatuses().connections).toEqual([]);
  });

  it("never calls the adapter or keeps a status for an oversized connection id", async () => {
    const { store, discover } = storeWith({});
    await store.refreshConnection(connection({ connectionId: "x".repeat(257) }));
    expect(discover).not.toHaveBeenCalled();
    expect(store.refreshStatuses()).toEqual({ connections: [], retained: 0, limit: 256 });
  });

  it("bounds statuses under connection churn and clears a failure on success", async () => {
    let fail = true;
    const listings = new Proxy({} as Record<string, () => unknown>, {
      get: (_, id: string) => () => {
        if (id === "c0" && fail) throw new Error("boom");
        return [row(`${id}-b`, { connectionId: id })];
      }
    });
    const { store } = storeWith(listings, { maxRefreshStatuses: 3 });
    await store.refreshConnection(connection({ connectionId: "c0" }));
    expect(status(store, "c0")).toMatchObject({ outcome: "failed" });
    fail = false;
    await store.refreshConnection(connection({ connectionId: "c0" }));
    expect(status(store, "c0")).toMatchObject({ outcome: "succeeded", code: null });
    for (let n = 1; n <= 10; n++)
      await store.refreshConnection(connection({ connectionId: `c${n}` }));
    const view = store.refreshStatuses();
    expect(view.retained).toBe(3);
    expect(view.limit).toBe(3);
    expect(view.connections.map((s) => s.connectionId)).toEqual(["c10", "c8", "c9"]);
    // Evicting statuses never removes observations.
    expect(store.listObservations()).toHaveLength(11);
    // Returned statuses are copies.
    view.connections[0].outcome = "failed";
    expect(store.refreshStatuses().connections[0].outcome).toBe("succeeded");
  });
});
