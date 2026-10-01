import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_RESOURCE_FACTS, type Connection } from "../../../src/models/connections";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock", () => {
  class ListFoundationModelsCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class BedrockClient {
    send = sendMock;
    constructor(_config: unknown) {}
  }
  return { BedrockClient, ListFoundationModelsCommand };
});

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "default-bedrock",
    apiKind: "bedrock-converse",
    region: "us-east-1",
    resourceFacts: UNKNOWN_RESOURCE_FACTS,
    quota: {},
    compute: { ownedOrRented: "unknown" },
    ...overrides
  };
}

describe("BedrockDiscoveryAdapter", () => {
  // mockClear (call history only) rather than mockReset -- resetting a mock
  // that had a persistent implementation appears to confuse Vitest's
  // unhandled-rejection tracking for a subsequent rejecting mock in this file.
  beforeEach(() => sendMock.mockClear());

  it("maps ListFoundationModels output to observations with access left unknown (list != invoke permission)", async () => {
    sendMock.mockImplementationOnce(async () => ({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-5-sonnet",
          modelName: "Claude 3.5 Sonnet",
          providerName: "Anthropic",
          modelLifecycle: { status: "ACTIVE" }
        },
        { modelId: "amazon.titan-legacy", modelLifecycle: { status: "LEGACY" } }
      ]
    }));

    const { BedrockDiscoveryAdapter } =
      await import("../../../src/models/discovery/bedrockDiscovery");
    const adapter = new BedrockDiscoveryAdapter();
    const observations = await adapter.discover(connection(), new AbortController().signal);

    expect(observations).toEqual([
      expect.objectContaining({
        model: "anthropic.claude-3-5-sonnet",
        health: "reachable",
        access: "unknown",
        installed: "yes",
        source: "bedrock-list-foundation-models"
      }),
      expect.objectContaining({ model: "amazon.titan-legacy", health: "unreachable" })
    ]);
  });

  it("returns no observations for a connection without a region", async () => {
    const { BedrockDiscoveryAdapter } =
      await import("../../../src/models/discovery/bedrockDiscovery");
    const adapter = new BedrockDiscoveryAdapter();
    await expect(
      adapter.discover(connection({ region: undefined }), new AbortController().signal)
    ).resolves.toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("propagates a credentials/region error to the caller (InventoryStore treats the connection as unavailable)", async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new Error("Could not load credentials from any providers");
    });
    const { BedrockDiscoveryAdapter } =
      await import("../../../src/models/discovery/bedrockDiscovery");
    const adapter = new BedrockDiscoveryAdapter();
    await expect(adapter.discover(connection(), new AbortController().signal)).rejects.toThrow(
      /credentials/
    );
  });
});
