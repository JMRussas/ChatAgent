// Source: @aws-sdk/client-bedrock TypeScript definitions (installed version,
// verified 2026-09-29): ListFoundationModelsCommand -> ListFoundationModelsResponse
// { modelSummaries?: FoundationModelSummary[] }, where FoundationModelSummary has
// modelId, modelName?, providerName?, inferenceTypesSupported? ("ON_DEMAND" |
// "PROVISIONED"), and modelLifecycle?.status ("ACTIVE" | "LEGACY"). This is the
// Bedrock *control-plane* client (model catalog), distinct from
// @aws-sdk/client-bedrock-runtime (inference) already used for chat calls.
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";
import type { Connection } from "../connections";
import type { DiscoveryAdapter, ModelObservation } from "../inventory";
import { bindingKey } from "../connections";

export class BedrockDiscoveryAdapter implements DiscoveryAdapter {
  async discover(connection: Connection, signal: AbortSignal): Promise<ModelObservation[]> {
    if (!connection.region) return [];

    const client = new BedrockClient({ region: connection.region, maxAttempts: 1 });
    const response = await client.send(new ListFoundationModelsCommand({}), { abortSignal: signal });
    const observedAtIso = new Date().toISOString();

    return (response.modelSummaries ?? [])
      .filter((summary): summary is typeof summary & { modelId: string } => typeof summary.modelId === "string")
      .map((summary) => ({
        bindingId: bindingKey(connection.connectionId, "bedrock-converse", summary.modelId),
        connectionId: connection.connectionId,
        model: summary.modelId,
        observedAtIso,
        expiresAtIso: observedAtIso, // stamped by InventoryStore with the configured TTL
        source: "bedrock-list-foundation-models",
        installed: "yes",
        // Listing permission (bedrock:ListFoundationModels) does not imply
        // invoke permission (bedrock:InvokeModel) -- this API cannot tell us
        // that, and a billed invoke probe is explicitly out of scope.
        access: "unknown",
        health: summary.modelLifecycle?.status === "ACTIVE" ? "reachable"
          : summary.modelLifecycle?.status === "LEGACY" ? "unreachable" : "unknown",
        apiCompatibility: ["bedrock-converse"]
      } satisfies ModelObservation));
  }
}
