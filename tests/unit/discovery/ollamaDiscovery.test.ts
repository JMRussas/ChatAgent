import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaDiscoveryAdapter } from "../../../src/models/discovery/ollamaDiscovery";
import { UNKNOWN_RESOURCE_FACTS, type Connection } from "../../../src/models/connections";

function connection(overrides: Partial<Connection> = {}): Connection {
  return { connectionId: "default-ollama", apiKind: "ollama-chat", baseUrl: "http://localhost:11434", resourceFacts: UNKNOWN_RESOURCE_FACTS, quota: {}, compute: { ownedOrRented: "unknown" }, ...overrides };
}

describe("OllamaDiscoveryAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists installed models with health/installed/access and per-model context length, with no real network calls", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [
            { name: "qwen3:8b", model: "qwen3:8b", details: { family: "qwen3" } },
            { name: "gemma4:26b" }
          ]
        }), { status: 200 });
      }
      if (url.endsWith("/api/show")) {
        return new Response(JSON.stringify({ model_info: { "qwen3.context_length": 32768 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new OllamaDiscoveryAdapter();
    const observations = await adapter.discover(connection(), new AbortController().signal);

    expect(observations).toHaveLength(2);
    const qwen = observations.find((o) => o.model === "qwen3:8b")!;
    expect(qwen).toMatchObject({ installed: "yes", access: "allowed", health: "reachable", source: "ollama-api-tags", effectiveContextTokens: 32768 });
    expect(qwen.apiCompatibility).toEqual(["ollama-chat"]);
    expect(observations.find((o) => o.model === "gemma4:26b")).toMatchObject({ installed: "yes" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.anything());
  });

  it("still reports the base observation when /api/show fails for one model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "broken:1b" }] }), { status: 200 });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch);

    const adapter = new OllamaDiscoveryAdapter();
    const observations = await adapter.discover(connection(), new AbortController().signal);

    expect(observations).toEqual([expect.objectContaining({ model: "broken:1b", installed: "yes" })]);
    expect(observations[0].effectiveContextTokens).toBeUndefined();
  });

  it("throws a clear error when /api/tags itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    const adapter = new OllamaDiscoveryAdapter();
    await expect(adapter.discover(connection(), new AbortController().signal)).rejects.toThrow(/503/);
  });

  it("returns no observations for a connection without a base URL", async () => {
    const adapter = new OllamaDiscoveryAdapter();
    await expect(adapter.discover(connection({ baseUrl: undefined }), new AbortController().signal)).resolves.toEqual([]);
  });
});
