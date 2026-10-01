import type { ModelCatalog, ModelEntry } from "../config/modelCatalog";
import { apiKindForEntry, connectionIdForEntry } from "../config/modelCatalog";
import { bindingKey, type Connection } from "../models/connections";
import type { FastModelProvider, DeepModelProvider } from "./interfaces";
import type { RuntimeProviderConfig } from "../config/providerConfig";
import type { ContextBudgetConfig } from "../config/contextConfig";
import { verifyThinkingConfig } from "../config/thinkingConfig";
import { buildFastProvider, buildDeepProvider } from "./providerFactory";
import { cliBinding } from "./cli/providers";
import type { CliAdapterRegistry } from "./cli/adapter";

export interface RegisteredBinding {
  bindingId: string;
  entry: ModelEntry;
  connection: Connection;
  fast?: FastModelProvider;
  deep?: DeepModelProvider;
  quotaAdmission?: "adapter-preflight";
  capabilities: ("tools" | "vision" | "structuredOutput")[];
}
export function entryBindingId(entry: ModelEntry) {
  return bindingKey(
    connectionIdForEntry(entry),
    apiKindForEntry(entry),
    entry.model,
    entry.cli?.accountProfile
  );
}
export class ProviderRegistry {
  private bindings = new Map<string, RegisteredBinding>();
  register(binding: RegisteredBinding) {
    if (this.bindings.has(binding.bindingId)) throw new Error("DUPLICATE_PROVIDER_BINDING");
    // Capture configuration; never clone callable adapter instances.
    this.bindings.set(binding.bindingId, {
      ...binding,
      entry: structuredClone(binding.entry),
      connection: structuredClone(binding.connection),
      capabilities: [...binding.capabilities]
    });
  }
  get(id: string) {
    return this.bindings.get(id);
  }
  registerCli(
    binding: Omit<RegisteredBinding, "fast" | "deep" | "capabilities">,
    adapters: CliAdapterRegistry,
    workingDirectory: string,
    outputBudget: number | { fast: number; deep: number }
  ) {
    const adapter = adapters.get(binding.entry.cli?.adapterId ?? "");
    if (!adapter) throw new Error("CLI_ADAPTER_NOT_IMPLEMENTED");
    this.register(cliBinding(binding, adapter, workingDirectory, outputBudget));
  }
}

export async function buildProviderRegistry(
  catalog: ModelCatalog,
  connections: Connection[],
  config: RuntimeProviderConfig,
  budget: ContextBudgetConfig,
  env: NodeJS.ProcessEnv = process.env
) {
  const registry = new ProviderRegistry();
  for (const entry of catalog.models) {
    const connection = connections.find((c) => c.connectionId === connectionIdForEntry(entry));
    if (!entry.enabled || entry.provider === "cli" || !connection) continue;
    if (
      (entry.provider === "azure" && !config.azure) ||
      (entry.provider === "bedrock" && !config.bedrock)
    )
      continue;
    const selected = {
      ...config,
      fast: { ...config.fast, provider: entry.provider, model: entry.model },
      deep: { ...config.deep, provider: entry.provider, model: entry.model }
    };
    const thinking = await verifyThinkingConfig(selected, env);
    registry.register({
      bindingId: entryBindingId(entry),
      entry,
      connection,
      fast: entry.roles.includes("fast")
        ? buildFastProvider(selected, budget, thinking)
        : undefined,
      deep: entry.roles.includes("deep")
        ? buildDeepProvider(selected, budget, thinking)
        : undefined,
      // JSON validity is enforced at the dispatch boundary. These adapters have
      // no implemented tool or image request mapping.
      capabilities: ["structuredOutput"]
    });
  }
  return registry;
}
