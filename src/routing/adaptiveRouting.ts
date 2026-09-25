import type { FastAnalysis, UserMessage } from "../domain/types";
import { classifyPrompt, type PromptSizeBand } from "./classifier";
import { InMemoryLatencyEstimator } from "../telemetry/latencyEstimator";
import type { RoutingTelemetrySnapshot } from "../telemetry/latencyTelemetryStore";

export interface ProviderProfile {
  provider: string;
  model: string;
}

export interface AdaptiveRoutingPolicy {
  maxFastP95Ms: number;
}

export interface AdaptiveDecision {
  routeDecision: "direct" | "deep" | "clarify";
  sizeBand: PromptSizeBand;
  reasons: string[];
}

function routeForFastMetric(route: "direct" | "deep" | "clarify"): "direct" | "deep" | "clarify" {
  return route;
}

export class AdaptiveRoutingCoordinator {
  private maxFastP95Ms: number;

  constructor(
    private readonly estimator: InMemoryLatencyEstimator,
    private readonly fastProfile: ProviderProfile,
    private readonly deepProfile: ProviderProfile,
    private readonly policy: AdaptiveRoutingPolicy = { maxFastP95Ms: 1000 }
  ) {
    this.maxFastP95Ms = policy.maxFastP95Ms;
  }

  decide(message: UserMessage, baseAnalysis: FastAnalysis): AdaptiveDecision {
    const classification = classifyPrompt(message.text);
    const reasons: string[] = [...baseAnalysis.reasons];
    let routeDecision = baseAnalysis.routeDecision;

    const fastPrediction = this.estimator.estimate({
      provider: this.fastProfile.provider,
      model: this.fastProfile.model,
      route: routeForFastMetric(routeDecision),
      sizeBand: classification.sizeBand
    });

    if (classification.ambiguity === "high") {
      routeDecision = "clarify";
      reasons.push("Adaptive classifier flagged high ambiguity.");
    } else if (classification.externalDataNeeded) {
      routeDecision = "deep";
      reasons.push("Adaptive classifier detected external data need.");
    } else if (classification.complexity === "complex" && routeDecision !== "clarify") {
      routeDecision = "deep";
      reasons.push("Adaptive classifier flagged high complexity.");
    } else if (
      classification.complexity === "moderate" &&
      routeDecision === "direct" &&
      fastPrediction.p95 > this.maxFastP95Ms
    ) {
      routeDecision = "deep";
      reasons.push(`Adaptive p95 guardrail moved route to deep (${Math.round(fastPrediction.p95)}ms predicted).`);
    }

    return {
      routeDecision,
      sizeBand: classification.sizeBand,
      reasons
    };
  }

  recordFastLatency(route: "direct" | "deep" | "clarify", sizeBand: PromptSizeBand, latencyMs: number): void {
    this.estimator.recordLatency(
      {
        provider: this.fastProfile.provider,
        model: this.fastProfile.model,
        route,
        sizeBand
      },
      latencyMs
    );
  }

  recordDeepLatency(sizeBand: PromptSizeBand, latencyMs: number): void {
    this.estimator.recordLatency(
      {
        provider: this.deepProfile.provider,
        model: this.deepProfile.model,
        route: "deep",
        sizeBand
      },
      latencyMs
    );
  }

  setMaxFastP95Ms(value: number): void {
    this.maxFastP95Ms = Math.max(400, Math.min(5000, value));
  }

  getPolicy(): AdaptiveRoutingPolicy {
    return {
      maxFastP95Ms: this.maxFastP95Ms
    };
  }

  getLatencyEstimates() {
    return this.estimator.listEstimates();
  }

  snapshotEstimator() {
    return this.estimator.snapshot();
  }

  hydrateEstimator(snapshot: Parameters<InMemoryLatencyEstimator["hydrate"]>[0]): void {
    this.estimator.hydrate(snapshot);
  }

  snapshotState(): RoutingTelemetrySnapshot {
    return {
      estimator: this.estimator.snapshot(),
      policy: {
        maxFastP95Ms: this.maxFastP95Ms
      }
    };
  }

  hydrateState(snapshot: RoutingTelemetrySnapshot): void {
    this.estimator.hydrate(snapshot.estimator);
    this.setMaxFastP95Ms(snapshot.policy.maxFastP95Ms);
  }
}
