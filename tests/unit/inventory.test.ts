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
    ["2026-09-29T00:00:00.000Z", 0],
    ["invalid", 0]
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

  it("a full successful listing marks a previously-seen, now-disappeared binding unavailable", async () => {
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
    expect(store.getObservation("b2")).toMatchObject({ installed: "no", health: "unreachable" });
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
