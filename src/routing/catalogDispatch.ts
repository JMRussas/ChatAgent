import { loadExecutionRetention, type ExecutionRetention } from "../config/executionRetention";
import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "../config/modelCatalog";
import type { DispatchPolicy } from "../config/dispatchConfig";
import type { ContextBudget, ConversationContext } from "../app/contextBuilder";
import { ContextBudgetError } from "../app/contextBuilder";
import type { ContextManager, PrepareContextInput } from "../app/contextManager";
import { type TrustedRuntimeFacts } from "../app/systemInstructions";
import type { ProviderRegistry } from "../providers/providerRegistry";
import type { ModelObservation } from "../models/inventory";
import {
  GenerationError,
  normalizeGenerationError,
  type GenerationMetadata,
  type GenerationControl
} from "../domain/generation";
import { classifyTaskRequirements, type ModelTask } from "./taskClassifier";
import { rankModels, ModelSelectionError, type Candidate } from "./modelSelector";
import { AdmissionError, ResourceAdmission, resourceExclusion } from "./resourceAdmission";

export interface PhaseDispatch {
  id: string;
  role: "fast" | "deep";
  candidate: Candidate;
  ticket?: string;
  fallbacks: Candidate[];
  fallbackUsed: boolean;
  context: ConversationContext;
}
export interface DispatchPlan {
  context: ConversationContext;
  fast: PhaseDispatch;
  deep?: PhaseDispatch;
}
export interface DispatchMetric {
  bindingId: string;
  phase: "fast" | "deep";
  task: ModelTask;
  size: string;
  attemptId: string;
  result: string;
  elapsedMs: number;
}
export class CatalogDispatch {
  readonly admission: ResourceAdmission;
  private phases = new Map<string, PhaseDispatch>();
  private metrics: DispatchMetric[] = [];
  private completed = new Map<string, number>();
  constructor(
    readonly catalog: ModelCatalog,
    readonly registry: ProviderRegistry,
    readonly policy: DispatchPolicy,
    readonly budget: ContextBudget,
    private observations: () => readonly ModelObservation[],
    private now: () => Date = () => new Date(),
    private readonly retention: ExecutionRetention = loadExecutionRetention(),
    private readonly retentionClock = Date.now
  ) {
    this.admission = new ResourceAdmission(
      policy,
      () => this.now().getTime(),
      retention,
      retentionClock
    );
  }
  retentionStats() {
    this.prune();
    return {
      phases: this.phases.size,
      retained: this.completed.size,
      metrics: this.metrics.length
    };
  }
  private prune() {
    for (const [id, at] of this.completed) {
      if (
        this.retentionClock() - at < this.retention.completedTtlMs &&
        this.completed.size <= this.retention.maxCompleted
      )
        continue;
      this.phases.delete(id);
      this.completed.delete(id);
    }
  }
  /** Called by the owning workflow only after physical work, retries and writes settle. */
  complete(phase?: PhaseDispatch) {
    if (!phase || !this.phases.has(phase.id)) return;
    this.release(phase);
    if (!this.completed.has(phase.id)) this.completed.set(phase.id, this.retentionClock());
    this.prune();
  }
  activate(phase: PhaseDispatch) {
    this.completed.delete(phase.id);
  }
  get(id?: string) {
    this.prune();
    return id ? this.phases.get(id) : undefined;
  }
  telemetry(): {
    attempts: DispatchMetric[];
    reservations: ReturnType<ResourceAdmission["snapshot"]>;
    accounting?: ReturnType<ResourceAdmission["accounting"]>;
  } {
    return {
      attempts: structuredClone(this.metrics),
      reservations: this.admission.snapshot(),
      accounting: this.admission.accounting()
    };
  }
  record(phase: PhaseDispatch, attemptId: string, size: string, result: string, elapsedMs: number) {
    this.metrics.push({
      bindingId: phase.candidate.selection.bindingId,
      phase: phase.role,
      task: phase.candidate.requirements.task,
      size,
      attemptId,
      result,
      elapsedMs
    });
    this.metrics.splice(0, Math.max(0, this.metrics.length - this.retention.maxMetrics));
  }
  metadata(phase: PhaseDispatch): GenerationMetadata {
    const c = phase.candidate;
    return {
      ...c.binding[phase.role]?.metadata,
      provider: c.entry.provider,
      model: c.entry.model,
      bindingId: c.selection.bindingId,
      selection: structuredClone(c.selection),
      task: c.requirements.task
    };
  }
  async prepare(
    manager: ContextManager,
    input: PrepareContextInput,
    bindingId?: string
  ): Promise<DispatchPlan> {
    const capture = await manager.capture(input);
    const task = input.planningInstruction
      ? {
          task: "conversation" as const,
          requiredCapabilities: [],
          inputTokens: 0,
          outputTokens: this.budget.fastOutputTokens
        }
      : classifyTaskRequirements({
          text: input.currentUserText,
          routeDecision: input.routeDecision ?? "direct",
          inputTokens: 0,
          outputTokens: this.budget.fastOutputTokens
        });
    const catalog = structuredClone(this.catalog),
      observations = structuredClone(this.observations());
    const rank = (role: "fast" | "deep") => {
      const requirements =
        role === "fast" && input.routeDecision === "deep"
          ? { ...task, task: "conversation" as const, requiredCapabilities: [] }
          : { ...task };
      requirements.outputTokens =
        role === "fast" ? this.budget.fastOutputTokens : this.budget.deepOutputTokens;
      return rankModels({
        catalog,
        registry: this.registry,
        observations,
        policy: this.policy,
        admission: this.admission,
        role,
        requirements,
        ...(bindingId ? { onlyBindingIds: [bindingId] } : {}),
        nowIso: this.now().toISOString(),
        applicationWindow: this.budget.windowTokens,
        preview: (windowTokens, entry) =>
          capture.preview(
            {
              ...this.budget,
              windowTokens,
              fastOutputTokens: requirements.outputTokens,
              deepOutputTokens: requirements.outputTokens
            },
            {
              ...input.trustedFacts,
              [`${role}Provider`]: entry.provider,
              [`${role}Model`]: entry.model
            },
            task.task
          )
      });
    };
    const fastCandidates = rank("fast");
    const deepCandidates = input.routeDecision === "deep" ? rank("deep") : undefined;
    const exclusions: ModelSelectionError["exclusions"] = [];
    for (const fast of fastCandidates)
      for (const deep of deepCandidates ?? [undefined]) {
        const allowance = Math.min(
          fast.windowTokens - fast.requirements.outputTokens,
          deep ? deep.windowTokens - deep.requirements.outputTokens : Infinity
        );
        const maxOutput = Math.max(
          fast.requirements.outputTokens,
          deep?.requirements.outputTokens ?? 0
        );
        const budget = {
          ...this.budget,
          windowTokens: allowance + maxOutput,
          fastOutputTokens: fast.requirements.outputTokens,
          deepOutputTokens: deep?.requirements.outputTokens ?? 0
        };
        const facts: TrustedRuntimeFacts = {
          ...input.trustedFacts,
          fastProvider: fast.entry.provider,
          fastModel: fast.entry.model,
          deepProvider: deep?.entry.provider ?? "none",
          deepModel: deep?.entry.model ?? "none"
        };
        const context = capture.preview(budget, facts, task.task);
        if (context instanceof ContextBudgetError) continue;
        const chosen = [fast, ...(deep ? [deep] : [])];
        const requests = chosen.map((c) => ({
          resources: c.resources,
          inputTokens: context.estimatedInputTokens,
          outputTokens: c.requirements.outputTokens
        }));
        let tickets: string[];
        try {
          tickets = await this.admission.reserveWithWait(requests);
        } catch (error) {
          exclusions.push({
            bindingId: fast.selection.bindingId,
            reasons: [(error as Error).message]
          });
          continue;
        }
        const phase = (
          c: Candidate,
          role: "fast" | "deep",
          ticket: string,
          candidates: Candidate[]
        ): PhaseDispatch => {
          const list = this.policy.fallbackBindingIds[role];
          const fallbacks = (bindingId ? [] : list).flatMap((id) =>
            candidates.filter((v) => v.selection.bindingId === id && id !== c.selection.bindingId)
          );
          const result: PhaseDispatch = {
            id: randomUUID(),
            role,
            candidate: c,
            ticket,
            fallbacks,
            fallbackUsed: false,
            context: structuredClone(context)
          };
          this.phases.set(result.id, result);
          return result;
        };
        const plan = {
          context,
          fast: phase(fast, "fast", tickets[0], fastCandidates),
          ...(deep ? { deep: phase(deep, "deep", tickets[1], deepCandidates!) } : {})
        };
        capture.schedule(budget, facts, task.task);
        return plan;
      }
    throw new ModelSelectionError(exclusions);
  }
  async execute<T>(
    phase: PhaseDispatch,
    control: GenerationControl,
    size: string,
    work: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    let outcome = "error";
    try {
      await this.begin(phase, control.signal);
      control.signal.throwIfAborted();
      const result = await work();
      outcome = control.signal.aborted
        ? "cancelled"
        : ((result as { finishReason?: string }).finishReason ?? "stop");
      return result;
    } catch (error) {
      outcome = normalizeGenerationError(error).code;
      throw error;
    } finally {
      this.record(phase, control.attemptId, size, outcome, Date.now() - start);
      this.finish(phase);
    }
  }
  wrapSummary(
    provider: import("../providers/interfaces").FastModelProvider,
    bindingId: string,
    outputTokens: number
  ): import("../providers/interfaces").FastModelProvider {
    return {
      metadata: provider.metadata,
      createProvisionalReply: async (input, control) => {
        if (!control || !input.context)
          throw new GenerationError("SUMMARY_CONTEXT_REQUIRED", false);
        const candidate = rankModels({
          catalog: structuredClone(this.catalog),
          registry: this.registry,
          observations: this.observations(),
          policy: this.policy,
          admission: this.admission,
          role: "fast",
          requirements: {
            task: "summarization",
            requiredCapabilities: ["structuredOutput"],
            inputTokens: input.context.estimatedInputTokens,
            outputTokens
          },
          applicationWindow: this.budget.windowTokens,
          nowIso: this.now().toISOString(),
          onlyBindingIds: [bindingId],
          preview: (window) =>
            input.context!.estimatedInputTokens + outputTokens + this.budget.safetyTokens <= window
              ? structuredClone(input.context!)
              : new ContextBudgetError(
                  input.context!.estimatedInputTokens,
                  window - outputTokens - this.budget.safetyTokens
                )
        })[0];
        const phase: PhaseDispatch = {
          id: randomUUID(),
          role: "fast",
          candidate,
          fallbacks: [],
          fallbackUsed: false,
          context: input.context
        };
        return this.execute(phase, control, "internal-summary", async () => {
          const result = await provider.createProvisionalReply(input, control);
          this.validateAnswer(phase, result.text, result.finishReason);
          return result;
        });
      }
    };
  }
  private revalidate(phase: PhaseDispatch, candidate = phase.candidate) {
    const obs = this.observations().find((o) => o.bindingId === candidate.selection.bindingId);
    const now = this.now();
    if (
      !obs ||
      Date.parse(obs.observedAtIso) > now.getTime() ||
      obs.expiresAtIso <= now.toISOString() ||
      obs.installed !== "yes" ||
      obs.access !== "allowed" ||
      obs.health !== "reachable" ||
      obs.revision !== candidate.selection.revision
    )
      throw new AdmissionError("BINDING_OBSERVATION_CHANGED_OR_STALE");
    const resources = this.policy.bindings[candidate.entry.id];
    if (
      resources?.quotaAdmission === "adapter-preflight" &&
      candidate.binding.quotaAdmission !== "adapter-preflight"
    )
      throw new AdmissionError("QUOTA_PREFLIGHT_UNSUPPORTED");
    const denied = resourceExclusion(resources, this.policy, now.getTime());
    if (denied) throw new AdmissionError(denied);
    if (JSON.stringify(resources) !== JSON.stringify(candidate.resources))
      throw new AdmissionError("RESOURCE_EVIDENCE_CHANGED");
    const limit = Math.min(candidate.windowTokens, obs.effectiveContextTokens ?? Infinity);
    if (
      phase.context.estimatedInputTokens +
        candidate.requirements.outputTokens +
        this.budget.safetyTokens >
        limit ||
      candidate.requirements.outputTokens > (obs.effectiveOutputTokens ?? Infinity)
    )
      throw new AdmissionError("FALLBACK_CONTEXT_LIMIT");
  }
  async begin(phase: PhaseDispatch, signal: AbortSignal) {
    this.activate(phase);
    try {
      this.revalidate(phase);
      phase.ticket ??= (
        await this.admission.reserveWithWait(
          [
            {
              resources: phase.candidate.resources,
              inputTokens: phase.context.estimatedInputTokens,
              outputTokens: phase.candidate.requirements.outputTokens
            }
          ],
          signal
        )
      )[0];
      await this.admission.begin(phase.ticket, signal);
    } catch (error) {
      this.release(phase);
      throw new GenerationError(
        error instanceof AdmissionError ? error.code : "ADMISSION_FAILED",
        false
      );
    }
  }
  finish(phase: PhaseDispatch) {
    if (phase.ticket) this.admission.finish(phase.ticket);
    phase.ticket = undefined;
  }
  release(phase?: PhaseDispatch) {
    if (phase?.ticket) this.admission.release(phase.ticket);
  }
  validateAnswer(phase: PhaseDispatch, text: string, finishReason: string) {
    if (
      finishReason === "stop" &&
      phase.candidate.requirements.requiredCapabilities.includes("structuredOutput")
    ) {
      try {
        JSON.parse(text);
      } catch {
        throw new GenerationError("STRUCTURED_OUTPUT_INVALID", false);
      }
    }
  }
  fallback(phase: PhaseDispatch, code: string): boolean {
    const quotaFallback =
      code === "QUOTA_EXHAUSTED" &&
      phase.candidate.entry.billing?.exhaustionPolicy === "approved-fallback";
    if (
      phase.fallbackUsed ||
      (!quotaFallback && !["PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT"].includes(code))
    )
      return false;
    for (const candidate of phase.fallbacks) {
      // Per-entry permission is required in addition to the explicit list/policy
      // when changing to metered billing.
      if (
        candidate.resources?.facts.billingComponents.includes("metered-usage") &&
        !phase.candidate.resources?.facts.billingComponents.includes("metered-usage") &&
        !phase.candidate.entry.billing?.usageBillingFallbackAllowed
      )
        continue;
      const originalContext = phase.context;
      const context = structuredClone(originalContext);
      const factLine = phase.role === "fast" ? /^Fast responder:.*$/m : /^Deep responder:.*$/m;
      context.systemInstruction = context.systemInstruction.replace(
        factLine,
        () =>
          `${phase.role === "fast" ? "Fast" : "Deep"} responder: ${candidate.entry.provider}/${candidate.entry.model}`
      );
      context.estimatedInputTokens +=
        Buffer.byteLength(context.systemInstruction) -
        Buffer.byteLength(originalContext.systemInstruction);
      context.snapshotId = randomUUID();
      phase.context = context;
      try {
        this.revalidate(phase, candidate);
        this.admission.check([
          {
            resources: candidate.resources,
            inputTokens: phase.context.estimatedInputTokens,
            outputTokens: candidate.requirements.outputTokens
          }
        ]);
        const ticket = this.admission.reserve([
          {
            resources: candidate.resources,
            inputTokens: phase.context.estimatedInputTokens,
            outputTokens: candidate.requirements.outputTokens
          }
        ])[0];
        phase.candidate = candidate;
        phase.ticket = ticket;
        phase.fallbackUsed = true;
        candidate.selection = {
          ...candidate.selection,
          reasons: [...candidate.selection.reasons, "explicit-fallback"]
        };
        return true;
      } catch {
        phase.context = originalContext; /* Try only the explicitly ordered alternatives. */
      }
    }
    return false;
  }
}
