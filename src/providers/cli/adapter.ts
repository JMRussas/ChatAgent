import type { ConversationContext } from "../../domain/context";
import type { FinishReason } from "../../domain/generation";

export interface CliReadiness {
  version: string | null;
  authenticated: "yes" | "no" | "unknown";
  automation: "supported" | "unsupported" | "unknown";
  quota: "available" | "exhausted" | "unknown";
  resetAt?: string;
  blockedReason?: "CLI_INCLUDED_ONLY_UNSUPPORTED" | "CLI_USAGE_UNAVAILABLE" | "CLI_USAGE_HEADROOM";
  usage?: { source: string; observedAt: string;
    windows: { scope: string; usedPercentage: number; resetsAt: string }[];
    extraUsageEnabled: boolean | null };
  observedAt: string;
  expiresAt: string;
}
export interface CliGenerationRequest {
  bindingId: string;
  context: ConversationContext;
  outputBudget: number;
  role?: "fast" | "deep";
  signal: AbortSignal;
  workingDirectory: string;
  accountProfile: string;
  quotaPoolId?: string;
  exhaustionPolicy: "wait" | "fail" | "approved-fallback";
}
export type CliGenerationEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string; finishReason: FinishReason }
  | { type: "queued"; reason: "concurrency" | "quota"; resetAt?: string };
export interface CliAdapter {
  readonly id: string;
  inspect(profile: string, signal: AbortSignal): Promise<CliReadiness>;
  generate(request: CliGenerationRequest): AsyncIterable<CliGenerationEvent>;
}

/** Code-owned registrations only; catalog data cannot construct an executable. */
export class CliAdapterRegistry {
  private readonly adapters = new Map<string, CliAdapter>();
  register(adapter: CliAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error("DUPLICATE_CLI_ADAPTER");
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): CliAdapter | undefined { return this.adapters.get(id); }
}
