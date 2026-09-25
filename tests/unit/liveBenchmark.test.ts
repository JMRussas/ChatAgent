import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";

describe("live benchmark runner", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("collects live benchmark records for direct and deep routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fastResponse: { analysis: { routeDecision: "direct" } } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fastResponse: { analysis: { routeDecision: "deep" } } })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [{ type: "user" }, { type: "refined" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [{ type: "user" }, { type: "refined" }] }) });

    global.fetch = fetchMock as unknown as typeof fetch;

    const records = await runLiveBenchmark(
      {
        name: "mock-live",
        fastProvider: "mock",
        fastModel: "mock-v1",
        deepProvider: "mock",
        deepModel: "mock-v1"
      },
      [
        { id: "p1", text: "Explain event loops" },
        { id: "p2", text: "Find latest inflation and cite sources" }
      ],
      {
        baseUrl: "http://localhost:3000"
      }
    );

    expect(records.length).toBe(2);
    expect(records[0].routeDecision).toBe("direct");
    expect(records[1].routeDecision).toBe("deep");
  });
});
