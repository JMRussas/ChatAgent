import type { ModelCatalog, ModelEntry } from "../config/modelCatalog";
import type { DispatchPolicy, BindingResources } from "../config/dispatchConfig";
import { ContextBudgetError, type ConversationContext } from "../app/contextBuilder";
import { computeReadiness, type ModelObservation } from "../models/inventory";
import { entryBindingId, type ProviderRegistry, type RegisteredBinding } from "../providers/providerRegistry";
import type { TaskRequirements } from "./taskClassifier";
import { resourceExclusion, type ResourceAdmission } from "./resourceAdmission";

export interface ModelSelection {
  bindingId: string; catalogVersion: number; observationTimeIso: string;
  reasons: string[]; eligibleBindingIds: string[]; revision?: string;
}
export class ModelSelectionError extends Error {
  readonly code = "NO_ELIGIBLE_MODEL";
  constructor(readonly exclusions: { bindingId: string; reasons: string[] }[]) { super("No eligible model for this request"); }
}
export interface Candidate {
  binding: RegisteredBinding; entry: ModelEntry; context: ConversationContext; windowTokens: number;
  resources?: BindingResources; requirements: TaskRequirements; selection: ModelSelection;
}
export interface SelectionInput {
  catalog: ModelCatalog; registry: ProviderRegistry; observations: readonly ModelObservation[];
  policy: DispatchPolicy; admission: ResourceAdmission; role: "fast" | "deep";
  requirements: TaskRequirements; nowIso: string; applicationWindow: number;
  preview: (windowTokens: number, entry: ModelEntry) => ConversationContext | ContextBudgetError;
  onlyBindingIds?: string[];
}
export function rankModels(input: SelectionInput): Candidate[] {
  const now = Date.parse(input.nowIso);
  const exclusions: ModelSelectionError["exclusions"] = [];
  const candidates: Candidate[] = [];
  for (const entry of structuredClone(input.catalog.models)) {
    const bindingId = entryBindingId(entry), binding = input.registry.get(bindingId);
    if (input.onlyBindingIds && !input.onlyBindingIds.includes(bindingId)) continue;
    const obs = input.observations.find(o => o.bindingId === bindingId);
    const reasons: string[] = [];
    const readiness = computeReadiness({ enabled: entry.enabled, adapterImplemented: !!binding?.[input.role], observation: obs, nowIso: input.nowIso });
    if (readiness !== "ready") {
      reasons.push(readiness);
      if (obs?.lastErrorCode && /^[A-Z][A-Z0-9_]{0,79}$/.test(obs.lastErrorCode)) reasons.push(obs.lastErrorCode);
    }
    if (obs && (Date.parse(obs.observedAtIso) > now || !Number.isFinite(Date.parse(obs.observedAtIso)))) reasons.push("INVALID_OBSERVATION_TIME");
    if (binding && obs && !obs.apiCompatibility.includes(binding.connection.apiKind)) reasons.push("API_INCOMPATIBLE");
    if (!entry.roles.includes(input.role) || !entry.tasks.includes(input.requirements.task)) reasons.push("ROLE_OR_TASK_UNSUPPORTED");
    if (input.requirements.requiredCapabilities.some(c => entry.capabilities[c] !== "supported" || !binding?.capabilities.includes(c))) reasons.push("CAPABILITY_UNSUPPORTED");
    const contextLimits = [entry.limits.contextTokens, obs?.effectiveContextTokens].filter((n): n is number => n !== undefined);
    const outputLimits = [entry.limits.maxOutputTokens, obs?.effectiveOutputTokens].filter((n): n is number => n !== undefined);
    const windowTokens = Math.min(input.applicationWindow, ...contextLimits);
    if (!contextLimits.length || !outputLimits.length) reasons.push("LIMIT_UNKNOWN");
    if (outputLimits.length && input.requirements.outputTokens > Math.min(...outputLimits)) reasons.push("OUTPUT_LIMIT");
    const resources = structuredClone(input.policy.bindings[entry.id]);
    if (resources?.quotaAdmission === "adapter-preflight" && binding?.quotaAdmission !== "adapter-preflight")
      reasons.push("QUOTA_PREFLIGHT_UNSUPPORTED");
    const resourceReason = resourceExclusion(resources, input.policy, now);
    if (resourceReason) reasons.push(resourceReason);
    if (!reasons.length) {
      const context = input.preview(windowTokens, entry);
      if (context instanceof ContextBudgetError) reasons.push("CONTEXT_LIMIT");
      else {
        const requirements = { ...input.requirements, inputTokens: context.estimatedInputTokens };
        try { input.admission.check([{ resources, ...requirements }]); }
        catch (error) {
          if ((error as Error).message !== "QUOTA_EXHAUSTED" || input.policy.quotaExhaustionAction !== "wait") reasons.push((error as Error).message);
        }
        if (!reasons.length) candidates.push({ binding: binding!, entry, context, windowTokens, resources, requirements,
          selection: { bindingId, catalogVersion: input.catalog.version, observationTimeIso: obs!.observedAtIso,
            revision: obs!.revision, reasons: ["catalog-eligible", `task:${requirements.task}`, `role:${input.role}`], eligibleBindingIds: [] } });
      }
    }
    if (reasons.length) exclusions.push({ bindingId, reasons });
  }
  const measurement = (c: Candidate) => c.entry.evaluations?.filter(e => e.task === input.requirements.task &&
    e.environment === `${c.binding.connection.connectionId}:${input.policy.environment}` && e.sampleCount >= 20 &&
    now - Date.parse(e.evaluatedAtIso) >= 0 && now - Date.parse(e.evaluatedAtIso) <= 30 * 86400000)
    .sort((a, b) => b.evaluatedAtIso.localeCompare(a.evaluatedAtIso))[0];
  candidates.sort((a, b) => {
    const ae = measurement(a), be = measurement(b);
    return b.context.includedTurnIds.length - a.context.includedTurnIds.length ||
      (be?.successRate ?? -1) - (ae?.successRate ?? -1) ||
      (ae?.firstUsefulResponseP95Ms ?? Infinity) - (be?.firstUsefulResponseP95Ms ?? Infinity) ||
      (a.entry.routingPriority ?? 100) - (b.entry.routingPriority ?? 100) ||
      (a.selection.bindingId < b.selection.bindingId ? -1 : a.selection.bindingId > b.selection.bindingId ? 1 : 0);
  });
  for (const c of candidates) {
    c.selection.eligibleBindingIds = candidates.map(v => v.selection.bindingId);
    c.selection.reasons.push(`retained-pairs:${c.context.includedTurnIds.length}`, measurement(c) ? "matching-evaluation" : "no-matching-evaluation",
      `priority:${c.entry.routingPriority ?? 100}`);
  }
  if (!candidates.length) throw new ModelSelectionError(exclusions);
  return candidates;
}
