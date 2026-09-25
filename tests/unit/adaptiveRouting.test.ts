import { describe, expect, it } from "vitest";
import type { FastAnalysis, UserMessage } from "../../src/domain/types";
import { AdaptiveRoutingCoordinator } from "../../src/routing/adaptiveRouting";
import { InMemoryLatencyEstimator } from "../../src/telemetry/latencyEstimator";

function baseAnalysis(routeDecision: "direct" | "deep" | "clarify"): FastAnalysis {
  return {
    correctedText: "hello",
    needsExternalData: false,
    needsClarification: false,
    routeDecision,
    confidence: 0.8,
    reasons: ["base"]
  };
}

function msg(text: string): UserMessage {
  return {
    conversationId: "c1",
    userId: "u1",
    text,
    timestampIso: new Date().toISOString()
  };
}

describe("adaptive routing", () => {
  it("routes to clarify for high ambiguity", () => {
    const estimator = new InMemoryLatencyEstimator();
    const coordinator = new AdaptiveRoutingCoordinator(
      estimator,
      { provider: "azure", model: "fast" },
      { provider: "azure", model: "deep" }
    );

    const decision = coordinator.decide(msg("do it"), baseAnalysis("direct"));
    expect(decision.routeDecision).toBe("clarify");
  });

  it("routes to deep when external data is needed", () => {
    const estimator = new InMemoryLatencyEstimator();
    const coordinator = new AdaptiveRoutingCoordinator(
      estimator,
      { provider: "azure", model: "fast" },
      { provider: "azure", model: "deep" }
    );

    const decision = coordinator.decide(msg("find latest inflation data with sources"), baseAnalysis("direct"));
    expect(decision.routeDecision).toBe("deep");
  });

  it("routes moderate prompts to deep when predicted fast p95 breaches policy", () => {
    const estimator = new InMemoryLatencyEstimator();

    estimator.seedPrior(
      {
        provider: "azure",
        model: "fast",
        route: "direct",
        sizeBand: "medium"
      },
      { p50: 1000, p90: 1400, p95: 1600, p99: 2200 }
    );

    const coordinator = new AdaptiveRoutingCoordinator(
      estimator,
      { provider: "azure", model: "fast" },
      { provider: "azure", model: "deep" },
      { maxFastP95Ms: 1000 }
    );

    const decision = coordinator.decide(
      msg("Please compare options for implementing retries in this service"),
      baseAnalysis("direct")
    );

    expect(decision.routeDecision).toBe("deep");
  });
});
