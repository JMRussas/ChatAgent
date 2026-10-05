import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadDiscoveryLimits, type DiscoveryLimits } from "../../config/discoveryLimits";
/** Cap the SDK's HTTP body before its JSON deserializer materializes the listing. */
export class BoundedDiscoveryHttpHandler extends NodeHttpHandler {
  constructor(private readonly maxBytes: number) {
    super();
  }
  async handle(...args: Parameters<NodeHttpHandler["handle"]>) {
    const result = await super.handle(...args);
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of result.response.body) {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > this.maxBytes) throw Error("DISCOVERY_RESPONSE_TOO_LARGE");
        chunks.push(value);
      }
      result.response.body = Buffer.concat(chunks);
      return result;
    } catch (error) {
      result.response.body.destroy();
      throw error;
    }
  }
}
// Source: @aws-sdk/client-bedrock TypeScript definitions (installed version,
// verified 2026-09-29): ListFoundationModelsCommand -> ListFoundationModelsResponse
// { modelSummaries?: FoundationModelSummary[] }, where FoundationModelSummary has
// modelId, modelName?, providerName?, inferenceTypesSupported? ("ON_DEMAND" |
// "PROVISIONED"), and modelLifecycle?.status ("ACTIVE" | "LEGACY"). This is the
// Bedrock *control-plane* client (model catalog), distinct from
// @aws-sdk/client-bedrock-runtime (inference) already used for chat calls.
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";
import type { Connection } from "../connections";
import type { DiscoveryAdapter, DiscoveryObservation } from "../inventory";
import { bindingKey } from "../connections";

export class BedrockDiscoveryAdapter implements DiscoveryAdapter {
  async discover(
    connection: Connection,
    signal: AbortSignal,
    limits: DiscoveryLimits = loadDiscoveryLimits()
  ): Promise<DiscoveryObservation[]> {
    if (!connection.region) return [];

    const handler = new BoundedDiscoveryHttpHandler(limits.maxResponseBytes);
    const client = new BedrockClient({
      region: connection.region,
      maxAttempts: 1,
      requestHandler: handler
    });
    try {
      const response = await client.send(new ListFoundationModelsCommand({}), {
        abortSignal: signal
      });
      if (!Array.isArray(response.modelSummaries)) throw Error("DISCOVERY_INCOMPLETE_LISTING");
      if (response.modelSummaries.length > limits.maxModelsPerConnection)
        throw Error("DISCOVERY_CAPACITY");
      if (
        response.modelSummaries.some(
          (summary) => typeof summary.modelId !== "string" || !summary.modelId
        )
      )
        throw Error("DISCOVERY_INCOMPLETE_LISTING");
      const observedAtIso = new Date().toISOString();

      return (response.modelSummaries ?? [])
        .filter(
          (summary): summary is typeof summary & { modelId: string } =>
            typeof summary.modelId === "string"
        )
        .map(
          (summary) =>
            ({
              bindingId: bindingKey(connection.connectionId, "bedrock-converse", summary.modelId),
              connectionId: connection.connectionId,
              model: summary.modelId,
              observedAtIso,
              source: "bedrock-list-foundation-models",
              installed: "yes",
              // Listing permission (bedrock:ListFoundationModels) does not imply
              // invoke permission (bedrock:InvokeModel) -- this API cannot tell us
              // that, and a billed invoke probe is explicitly out of scope.
              access: "unknown",
              health:
                summary.modelLifecycle?.status === "ACTIVE"
                  ? "reachable"
                  : summary.modelLifecycle?.status === "LEGACY"
                    ? "unreachable"
                    : "unknown",
              apiCompatibility: ["bedrock-converse"]
            }) satisfies DiscoveryObservation
        );
    } finally {
      handler.destroy();
    }
  }
}
