// Source: Ollama official API docs (github.com/ollama/ollama, docs/api.md),
// verified 2026-09-29. GET /api/tags lists installed local models. POST
// /api/show returns per-model metadata; context length lives under
// model_info as "<architecture-family>.context_length" (e.g. "llama.context_length"),
// not a fixed key name, since it varies by model architecture.
import type { Connection } from "../connections";
import type { DiscoveryAdapter, ModelObservation } from "../inventory";
import { bindingKey } from "../connections";
import { mapWithConcurrency } from "./util";

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; details?: { family?: string; parameter_size?: string; quantization_level?: string } }>;
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  capabilities?: string[];
}

function findContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

export class OllamaDiscoveryAdapter implements DiscoveryAdapter {
  constructor(private readonly fetchMetadata: boolean = true) {}

  async discover(connection: Connection, signal: AbortSignal): Promise<ModelObservation[]> {
    if (!connection.baseUrl) return [];

    const tagsResponse = await fetch(`${connection.baseUrl}/api/tags`, { signal });
    if (!tagsResponse.ok) {
      throw new Error(`Ollama /api/tags failed (${tagsResponse.status})`);
    }

    const payload = (await tagsResponse.json()) as OllamaTagsResponse;
    const models = (payload.models ?? []).filter((m): m is { name: string } => typeof m.name === "string" && m.name.length > 0);

    return mapWithConcurrency(models, 4, async (entry) => {
      const observedAtIso = new Date().toISOString();
      const base: ModelObservation = {
        bindingId: bindingKey(connection.connectionId, "ollama-chat", entry.name),
        connectionId: connection.connectionId,
        model: entry.name,
        observedAtIso,
        expiresAtIso: observedAtIso, // stamped by InventoryStore with the configured TTL
        source: "ollama-api-tags",
        installed: "yes",
        // Local Ollama has no separate list-vs-invoke permission model; an
        // installed model can be invoked. Unlike cloud IAM, there is no
        // evidence here that would make this merely "unknown".
        access: "allowed",
        health: "reachable",
        apiCompatibility: ["ollama-chat"]
      };

      if (!this.fetchMetadata) return base;

      try {
        const showResponse = await fetch(`${connection.baseUrl}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: entry.name }),
          signal
        });
        if (!showResponse.ok) return base;

        const show = (await showResponse.json()) as OllamaShowResponse;
        const contextTokens = findContextLength(show.model_info);
        return contextTokens === undefined ? base : { ...base, effectiveContextTokens: contextTokens };
      } catch {
        // Per-model metadata is best-effort; the base observation (installed,
        // reachable) still stands even if /api/show fails for this one model.
        return base;
      }
    });
  }
}
