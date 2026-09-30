import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { CliAdapter, CliReadiness } from "./adapter";
import { CliAdapterRegistry } from "./adapter";
import { CliRunner, cliLimits } from "./runner";
import { GenerationError } from "../../domain/generation";
import type { ModelCatalog } from "../../config/modelCatalog";
import { connectionIdForEntry } from "../../config/modelCatalog";
import { entryBindingId, type ProviderRegistry } from "../providerRegistry";
import type { Connection } from "../../models/connections";
import type { DiscoveryAdapter } from "../../models/inventory";
import type { ContextBudgetConfig } from "../../config/contextConfig";

export const HEKATE_CLAUDE_ID = "hekate-claude";
export interface HekateBridgeConfig { python: string; root: string; executable: string; workingDirectory: string }
export function hekateBridgeConfig(env: NodeJS.ProcessEnv): HekateBridgeConfig | undefined {
  if (!env.HEKATE_CLI_ROOT) return;
  if (!env.HEKATE_CLI_PYTHON || !env.HEKATE_CLAUDE_EXECUTABLE || !env.HEKATE_CLI_WORKING_DIRECTORY)
    throw new Error("HEKATE_CLI_CONFIG_INCOMPLETE");
  return { python: env.HEKATE_CLI_PYTHON, root: env.HEKATE_CLI_ROOT,
    executable: env.HEKATE_CLAUDE_EXECUTABLE, workingDirectory: env.HEKATE_CLI_WORKING_DIRECTORY };
}
const safeCodes = new Set(["HEKATE_PROVIDER_UNAVAILABLE", "HEKATE_BRIDGE_FAILED", "OUTPUT_TOO_LARGE", "CLI_INVALID_REQUEST",
  "CLI_MALFORMED_OUTPUT", "CLI_EMPTY_OUTPUT", "CLI_NONZERO_EXIT", "CLI_AUTOMATION_UNSUPPORTED", "CLI_PROVIDER_ERROR", "QUOTA_EXHAUSTED", "AUTH_REQUIRED"]);
export function parseBridgeEvent(line: string) {
  const value = JSON.parse(line);
  if (value?.type === "error") throw new GenerationError(safeCodes.has(value.code) ? value.code : "HEKATE_BRIDGE_FAILED", false);
  if (value?.type !== "complete" || typeof value.text !== "string" || !["stop", "length"].includes(value.finishReason))
    throw new GenerationError("CLI_MALFORMED_OUTPUT", false);
  return { type: "complete" as const, text: value.text, finishReason: value.finishReason as "stop" | "length" };
}
export function createHekateClaudeAdapter(config: HekateBridgeConfig, model: string, runner: CliRunner): CliAdapter {
  const script = resolve("bridges/hekate/claude_bridge.py");
  const args = [script, "generate", "--root", config.root, "--executable", config.executable,
    "--model", model, "--max-bytes", String(runner.limits.maxOutputBytes)];
  const inspect = async (profile: string, signal: AbortSignal): Promise<CliReadiness> => {
    if (profile !== "default") throw new GenerationError("CLI_PROFILE_UNSUPPORTED", false);
    const result = await new Promise<string>((resolve, reject) => execFile(config.python,
      [script, "inspect", "--root", config.root, "--executable", config.executable],
      { cwd: config.workingDirectory, signal, timeout: 25000, maxBuffer: 8192, windowsHide: true },
      (error, stdout) => error ? reject(new GenerationError(signal.aborted ? "CANCELLED" : "HEKATE_BRIDGE_UNAVAILABLE", false)) : resolve(stdout)));
    const status = JSON.parse(result);
    const now = new Date().toISOString();
    return { version: typeof status.version === "string" ? status.version : null,
      authenticated: status.authenticated === "yes" ? "yes" : "no", automation: status.automation === "supported" ? "supported" : "unsupported",
      // No documented remaining-quota probe exists in the reused provider.
      // Keep admission closed rather than manufacturing an unlimited allowance.
      quota: "unknown", observedAt: now, expiresAt: new Date(Date.now() + 30000).toISOString() };
  };
  return runner.adapter({ id: HEKATE_CLAUDE_ID, executable: config.python, args,
    allowedWorkingRoot: config.workingDirectory, answerOnly: true, inspect,
    encode: request => JSON.stringify({ context: request.context, role: request.role, outputBudget: request.outputBudget }), parse: parseBridgeEvent });
}

/** Optional local connection; provider-specific flags stay in Hekate's Python code. */
export function connectHekateClaude(catalog: ModelCatalog, registry: ProviderRegistry | undefined,
  budget: ContextBudgetConfig, env: NodeJS.ProcessEnv = process.env): { connections: Connection[]; discovery?: DiscoveryAdapter; bindingIds: string[] } {
  const config = hekateBridgeConfig(env);
  if (!config) return { connections: [], bindingIds: [] };
  const runner = new CliRunner(cliLimits(env));
  const selected = catalog.models.filter(e => e.provider === "cli" && e.cli?.adapterId === HEKATE_CLAUDE_ID && e.cli.accountProfile === "default");
  const adapters = new Map<string, CliAdapter>();
  const connections: Connection[] = [];
  for (const entry of selected) {
    const connection: Connection = { connectionId: connectionIdForEntry(entry), apiKind: "cli",
      resourceFacts: { executionScope: "managed-cloud", billingComponents: ["subscription", "unknown"] }, quota: {}, compute: { ownedOrRented: "unknown" } };
    if (!connections.some(c => c.connectionId === connection.connectionId)) connections.push(connection);
    const adapter = createHekateClaudeAdapter(config, entry.model, runner);
    adapters.set(entryBindingId(entry), adapter);
    if (registry && entry.enabled) {
      const allowlist = new CliAdapterRegistry(); allowlist.register(adapter);
      registry.registerCli({ bindingId: entryBindingId(entry), entry, connection }, allowlist,
        config.workingDirectory, { fast: Math.min(budget.fastOutputTokens, entry.limits.maxOutputTokens ?? 512),
          deep: Math.min(budget.deepOutputTokens, entry.limits.maxOutputTokens ?? 512) });
    }
  }
  return { connections, bindingIds: [...adapters.keys()], discovery: { discover: async (connection, signal) => {
    const entries = selected.filter(e => connectionIdForEntry(e) === connection.connectionId);
    return Promise.all(entries.map(async entry => {
      const state = await adapters.get(entryBindingId(entry))!.inspect("default", signal);
      return { bindingId: entryBindingId(entry), connectionId: connection.connectionId, model: entry.model,
        source: "hekate-cli-auth-inspection", revision: state.version ?? undefined,
        observedAtIso: state.observedAt, expiresAtIso: state.expiresAt,
        installed: state.version ? "yes" as const : "unknown" as const,
        access: state.authenticated === "yes" ? "allowed" as const : "denied" as const,
        health: "unknown" as const, apiCompatibility: ["cli"], lastErrorCode: state.authenticated === "yes" ? "CLI_QUOTA_UNKNOWN" : "AUTH_REQUIRED" };
    }));
  } } };
}
