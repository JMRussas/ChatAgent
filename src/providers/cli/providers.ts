import type { ConversationContext } from "../../domain/context";
import {
  GenerationError,
  validObservedUsageLowerBound,
  type GenerationControl,
  type GenerationResult
} from "../../domain/generation";
import type { CliAdapter } from "./adapter";
import type { RegisteredBinding } from "../providerRegistry";

/** Explicit composition hook for reviewed adapters. Production registers none
 * until spec 05B verifies a real product and profile. No executable enters here. */
export function cliBinding(
  binding: Omit<RegisteredBinding, "fast" | "deep" | "capabilities">,
  adapter: CliAdapter,
  workingDirectory: string,
  outputBudget: number | { fast: number; deep: number }
): RegisteredBinding {
  const entry = structuredClone(binding.entry);
  if (
    entry.provider !== "cli" ||
    !entry.cli ||
    entry.cli.adapterId !== adapter.id ||
    binding.connection.apiKind !== "cli"
  )
    throw new Error("CLI_BINDING_MISMATCH");
  const profile = entry.cli.accountProfile;
  const metadata = { provider: "cli", model: entry.model, bindingId: binding.bindingId };
  async function generate(
    role: "fast" | "deep",
    context: ConversationContext | undefined,
    control?: GenerationControl
  ): Promise<GenerationResult> {
    if (!context) throw new GenerationError("CLI_CONTEXT_REQUIRED", false);
    let result: GenerationResult | undefined;
    for await (const event of adapter.generate({
      bindingId: binding.bindingId,
      context,
      role,
      outputBudget: typeof outputBudget === "number" ? outputBudget : outputBudget[role],
      workingDirectory,
      accountProfile: profile,
      quotaPoolId: entry.billing?.quotaPoolId,
      exhaustionPolicy: entry.billing?.exhaustionPolicy ?? "fail",
      signal: control?.signal ?? new AbortController().signal
    })) {
      if (event.type === "delta") await control?.onDelta(event.text);
      else if (event.type === "queued") await control?.onQueued?.(event.reason);
      else {
        // Adapters are a trust boundary: a lower bound is revalidated, never taken by
        // type, and a CLI result never carries complete usage.
        const usageLowerBound = validObservedUsageLowerBound(event.usageLowerBound);
        result = {
          text: event.text,
          finishReason: event.finishReason,
          ...(usageLowerBound ? { usageLowerBound } : {})
        };
      }
    }
    if (!result) throw new GenerationError("CLI_EMPTY_OUTPUT", false);
    return result;
  }
  return {
    ...binding,
    capabilities: [],
    fast: entry.roles.includes("fast")
      ? {
          metadata,
          createProvisionalReply: (input, control) => generate("fast", input.context, control)
        }
      : undefined,
    deep: entry.roles.includes("deep")
      ? {
          metadata,
          resolveDeepTask: async (input, control) => {
            const start = Date.now();
            const result = await generate("deep", input.context, control);
            return {
              taskId: input.taskId,
              finalReply: result.text,
              finishReason: result.finishReason,
              confidence: 0,
              citations: [],
              totalLatencyMs: Date.now() - start,
              ...(result.usageLowerBound ? { usageLowerBound: result.usageLowerBound } : {})
            };
          }
        }
      : undefined
  };
}
