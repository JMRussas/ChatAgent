import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { CliAdapter, CliReadiness } from "./adapter";
import { CliAdapterRegistry } from "./adapter";
import { CliRunner, cliLimits } from "./runner";
import { GenerationError, observedUsageLowerBound } from "../../domain/generation";
import type { ModelCatalog } from "../../config/modelCatalog";
import { connectionIdForEntry } from "../../config/modelCatalog";
import { entryBindingId, type ProviderRegistry } from "../providerRegistry";
import type { Connection } from "../../models/connections";
import type { DiscoveryAdapter } from "../../models/inventory";
import type { ContextBudgetConfig } from "../../config/contextConfig";

export const HEKATE_CLAUDE_ID = "hekate-claude";
export type ClaudeUsagePolicy = "strict" | "headroom";
/** Headroom is a best-effort admission check, never a billing reservation. */
export function claudeUsageAdmission(
  usage: unknown,
  model: string,
  policy: ClaudeUsagePolicy = "strict",
  now = Date.now()
): Pick<CliReadiness, "quota" | "blockedReason"> {
  const blocked = (blockedReason: NonNullable<CliReadiness["blockedReason"]>) => ({
    quota: "unknown" as const,
    blockedReason
  });
  if (policy === "strict") return blocked("CLI_INCLUDED_ONLY_UNSUPPORTED");
  const snapshot = usage as CliReadiness["usage"];
  const observed = Date.parse(snapshot?.observedAt ?? "");
  if (
    !snapshot ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > 30000 ||
    !Array.isArray(snapshot.windows)
  )
    return blocked("CLI_USAGE_UNAVAILABLE");
  const family = /^(?:claude-)?(sonnet|opus|haiku)(?:-|$)/.exec(model)?.[1];
  if (!family) return blocked("CLI_USAGE_UNAVAILABLE");
  const scopes = new Set(["five_hour", "seven_day", `seven_day_${family}`]);
  const windows = snapshot.windows.filter((w) => w && scopes.has(w.scope));
  if (
    !["five_hour", "seven_day"].every((scope) => windows.some((w) => w.scope === scope)) ||
    new Set(windows.map((w) => w.scope)).size !== windows.length ||
    windows.some(
      (w) =>
        !Number.isFinite(w.usedPercentage) ||
        w.usedPercentage < 0 ||
        !Number.isFinite(Date.parse(w.resetsAt)) ||
        Date.parse(w.resetsAt) <= now
    )
  )
    return blocked("CLI_USAGE_UNAVAILABLE");
  if (windows.some((w) => w.usedPercentage >= 80)) return blocked("CLI_USAGE_HEADROOM");
  return { quota: "available" };
}
export interface HekateBridgeConfig {
  python: string;
  root: string;
  executable: string;
  workingDirectory: string;
  usagePolicy?: ClaudeUsagePolicy;
  /**
   * Reading account usage uses an undocumented endpoint, so it happens only when
   * enabled. Independent of the admission policy: headroom without it is blocked.
   */
  usageInspection?: boolean;
}
export function hekateBridgeConfig(env: NodeJS.ProcessEnv): HekateBridgeConfig | undefined {
  if (!env.HEKATE_CLI_ROOT) return;
  if (!env.HEKATE_CLI_PYTHON || !env.HEKATE_CLAUDE_EXECUTABLE || !env.HEKATE_CLI_WORKING_DIRECTORY)
    throw new Error("HEKATE_CLI_CONFIG_INCOMPLETE");
  const usagePolicy = env.HEKATE_CLAUDE_USAGE_POLICY ?? "strict";
  if (usagePolicy !== "strict" && usagePolicy !== "headroom")
    throw new Error("HEKATE_CLI_USAGE_POLICY_INVALID");
  const inspection = env.HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED;
  if (inspection !== undefined && inspection !== "true" && inspection !== "false")
    throw new Error("HEKATE_CLI_USAGE_INSPECTION_INVALID");
  return {
    usagePolicy,
    usageInspection: inspection === "true",
    python: env.HEKATE_CLI_PYTHON,
    root: env.HEKATE_CLI_ROOT,
    executable: env.HEKATE_CLAUDE_EXECUTABLE,
    workingDirectory: env.HEKATE_CLI_WORKING_DIRECTORY
  };
}
const safeCodes = new Set([
  "HEKATE_PROVIDER_UNAVAILABLE",
  "HEKATE_BRIDGE_FAILED",
  "OUTPUT_TOO_LARGE",
  "CLI_INVALID_REQUEST",
  "CLI_MALFORMED_OUTPUT",
  "CLI_EMPTY_OUTPUT",
  "CLI_NONZERO_EXIT",
  "CLI_AUTOMATION_UNSUPPORTED",
  "CLI_PROVIDER_ERROR",
  "QUOTA_EXHAUSTED",
  "AUTH_REQUIRED"
]);
export function parseBridgeEvent(line: string) {
  const value = JSON.parse(line);
  if (value?.type === "error")
    throw new GenerationError(
      safeCodes.has(value.code) ? value.code : "HEKATE_BRIDGE_FAILED",
      false
    );
  if (
    value?.type !== "complete" ||
    typeof value.text !== "string" ||
    !["stop", "length"].includes(value.finishReason)
  )
    throw new GenerationError("CLI_MALFORMED_OUTPUT", false);
  // The bridge observes modelUsage only for its verified CLI release, as a lower bound:
  // CLI retries it cannot show may add more. Counts are revalidated here; anything
  // else, including any claimed complete usage, is dropped and the answer kept.
  const observed = value.observedUsage;
  const usageLowerBound =
    observed?.source === "cli-model-usage-lower-bound"
      ? observedUsageLowerBound(observed.inputTokens, observed.outputTokens)
      : undefined;
  return {
    type: "complete" as const,
    text: value.text,
    finishReason: value.finishReason as "stop" | "length",
    ...(usageLowerBound ? { usageLowerBound } : {})
  };
}
interface InspectionStatus {
  version?: string;
  authenticated?: string;
  automation?: string;
  usage?: CliReadiness["usage"];
  usageErrorCode?: string | null;
}
/** One account inspection shared by discovery/models/preflight. Never extends evidence. */
export class ClaudeInspectionCache {
  private cached?: { status: InspectionStatus; checkedAt: number; expiresAt: number };
  private pending?: Promise<NonNullable<ClaudeInspectionCache["cached"]>>;
  private pendingController?: AbortController;
  private waiters = 0;
  constructor(
    private read: (signal: AbortSignal) => Promise<InspectionStatus>,
    private now = Date.now
  ) {}
  async get(signal: AbortSignal, refreshAheadMs = 0) {
    signal.throwIfAborted();
    const now = this.now();
    if (
      !this.cached ||
      this.cached.expiresAt <= now + (this.cached.status.usage ? refreshAheadMs : 0) ||
      this.cached.checkedAt > now
    ) {
      if (!this.pending) this.pendingController = new AbortController();
      this.pending ??= (async () => {
        const status = await this.read(
          AbortSignal.any([this.pendingController!.signal, AbortSignal.timeout(25000)])
        );
        const checkedAt = this.now(),
          observed = Date.parse(status.usage?.observedAt ?? "");
        const validUsage =
          Number.isFinite(observed) && observed <= checkedAt && observed + 30000 > checkedAt;
        const expiresAt = validUsage
          ? Math.min(checkedAt + 30000, observed + 30000)
          : checkedAt + (status.usageErrorCode === "CLI_USAGE_RATE_LIMITED" ? 30000 : 5000);
        return (this.cached = { status, checkedAt, expiresAt });
      })().finally(() => {
        this.pending = undefined;
      });
      const pending = this.pending;
      // Cancel the shared child only when its last waiter leaves.
      this.waiters++;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (failed: boolean, error?: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          this.waiters--;
          if (signal.aborted && this.waiters === 0) this.pendingController?.abort(signal.reason);
          if (failed) reject(error);
          else resolve();
        };
        const abort = () => finish(true, signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.then(
          () => finish(false),
          (error) => finish(true, error)
        );
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    return structuredClone(this.cached!);
  }
}
function accountInspection(config: HekateBridgeConfig) {
  const script = resolve("bridges/hekate/claude_bridge.py");
  return new ClaudeInspectionCache(async (signal) => {
    const result = await new Promise<string>((resolve, reject) =>
      execFile(
        config.python,
        [
          script,
          "inspect",
          "--root",
          config.root,
          "--executable",
          config.executable,
          ...(config.usageInspection ? ["--inspect-usage"] : [])
        ],
        {
          cwd: config.workingDirectory,
          signal,
          timeout: 25000,
          maxBuffer: 8192,
          windowsHide: true
        },
        (error, stdout) =>
          error ? reject(new GenerationError("HEKATE_BRIDGE_UNAVAILABLE", false)) : resolve(stdout)
      )
    );
    return JSON.parse(result) as InspectionStatus;
  });
}
export function createHekateClaudeAdapter(
  config: HekateBridgeConfig,
  model: string,
  runner: CliRunner,
  inspections = accountInspection(config)
): CliAdapter {
  const script = resolve("bridges/hekate/claude_bridge.py");
  const args = [
    script,
    "generate",
    "--root",
    config.root,
    "--executable",
    config.executable,
    "--model",
    model,
    "--max-bytes",
    String(runner.limits.maxOutputBytes)
  ];
  const inspect = async (profile: string, signal: AbortSignal): Promise<CliReadiness> => {
    if (profile !== "default") throw new GenerationError("CLI_PROFILE_UNSUPPORTED", false);
    const { status, checkedAt, expiresAt } = await inspections.get(signal);
    const admission = claudeUsageAdmission(status.usage, model, config.usagePolicy);
    const usageErrorCode = [
      "CLI_USAGE_RATE_LIMITED",
      "CLI_USAGE_HTTP_ERROR",
      "CLI_USAGE_UNAVAILABLE",
      "CLI_USAGE_INSPECTION_DISABLED"
    ].includes(status.usageErrorCode ?? "")
      ? (status.usageErrorCode as CliReadiness["blockedReason"])
      : undefined;
    return {
      version: typeof status.version === "string" ? status.version : null,
      authenticated: status.authenticated === "yes" ? "yes" : "no",
      automation: status.automation === "supported" ? "supported" : "unsupported",
      usage: status.usage ?? undefined,
      ...admission,
      ...(admission.blockedReason === "CLI_USAGE_UNAVAILABLE" && usageErrorCode
        ? { blockedReason: usageErrorCode }
        : {}),
      observedAt: new Date(checkedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString()
    };
  };
  return runner.adapter({
    id: HEKATE_CLAUDE_ID,
    executable: config.python,
    args,
    allowedWorkingRoot: config.workingDirectory,
    answerOnly: true,
    inspect,
    encode: (request) =>
      JSON.stringify({
        context: request.context,
        role: request.role,
        outputBudget: request.outputBudget
      }),
    parse: parseBridgeEvent
  });
}

/** Optional local connection; provider-specific flags stay in Hekate's Python code. */
export function connectHekateClaude(
  catalog: ModelCatalog,
  registry: ProviderRegistry | undefined,
  budget: ContextBudgetConfig,
  env: NodeJS.ProcessEnv = process.env
): { connections: Connection[]; discovery?: DiscoveryAdapter; bindingIds: string[] } {
  const config = hekateBridgeConfig(env);
  if (!config) return { connections: [], bindingIds: [] };
  const runner = new CliRunner(cliLimits(env));
  const inspections = accountInspection(config);
  const selected = catalog.models.filter(
    (e) =>
      e.provider === "cli" &&
      e.cli?.adapterId === HEKATE_CLAUDE_ID &&
      e.cli.accountProfile === "default"
  );
  const adapters = new Map<string, CliAdapter>();
  const connections: Connection[] = [];
  for (const entry of selected) {
    const connection: Connection = {
      connectionId: connectionIdForEntry(entry),
      apiKind: "cli",
      resourceFacts: {
        executionScope: "managed-cloud",
        billingComponents: ["subscription", "unknown"]
      },
      quota: {},
      compute: { ownedOrRented: "unknown" }
    };
    if (!connections.some((c) => c.connectionId === connection.connectionId))
      connections.push(connection);
    const adapter = createHekateClaudeAdapter(config, entry.model, runner, inspections);
    adapters.set(entryBindingId(entry), adapter);
    if (registry && entry.enabled) {
      const allowlist = new CliAdapterRegistry();
      allowlist.register(adapter);
      registry.registerCli(
        {
          bindingId: entryBindingId(entry),
          entry,
          connection,
          quotaAdmission: "adapter-preflight"
        },
        allowlist,
        config.workingDirectory,
        {
          fast: Math.min(budget.fastOutputTokens, entry.limits.maxOutputTokens ?? 512),
          deep: Math.min(budget.deepOutputTokens, entry.limits.maxOutputTokens ?? 512)
        }
      );
    }
  }
  return {
    connections,
    bindingIds: [...adapters.keys()],
    discovery: {
      discover: async (connection, signal) => {
        // Discovery renews successful evidence on its configured cadence, even when
        // startup timing puts a tick just outside an early-refresh threshold.
        // Invocation preflight reuses remaining validity; negative backoff is never shortened.
        await inspections.get(signal, 30000);
        const entries = selected.filter((e) => connectionIdForEntry(e) === connection.connectionId);
        return Promise.all(
          entries.map(async (entry) => {
            const state = await adapters.get(entryBindingId(entry))!.inspect("default", signal);
            return {
              bindingId: entryBindingId(entry),
              connectionId: connection.connectionId,
              model: entry.model,
              source: "hekate-cli-auth-inspection",
              revision: state.version ?? undefined,
              observedAtIso: state.observedAt,
              expiresAtIso: state.expiresAt,
              installed: state.version ? ("yes" as const) : ("unknown" as const),
              access: state.authenticated === "yes" ? ("allowed" as const) : ("denied" as const),
              health:
                state.authenticated === "yes" &&
                state.automation === "supported" &&
                state.quota === "available" &&
                !state.blockedReason
                  ? ("reachable" as const)
                  : ("unknown" as const),
              apiCompatibility: ["cli"],
              lastErrorCode:
                state.authenticated === "yes"
                  ? (state.blockedReason ??
                    (state.quota === "available" ? undefined : "CLI_QUOTA_UNKNOWN"))
                  : "AUTH_REQUIRED"
            };
          })
        );
      }
    }
  };
}
