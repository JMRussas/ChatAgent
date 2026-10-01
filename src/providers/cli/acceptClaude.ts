/** Explicit live acceptance command; never imported by startup or offline tests. */
import "../../config/loadEnv";
import { loadModelCatalog } from "../../config/modelCatalog";
import { InventoryStore } from "../../models/inventory";
import { loadDiscoveryConfigFromEnv } from "../../config/discoveryConfig";
import { loadDispatchConfig } from "../../config/dispatchConfig";
import { ProviderRegistry } from "../providerRegistry";
import { connectHekateClaude, hekateBridgeConfig } from "./hekateClaude";
import { CliRunner, cliLimits, type CliProgram } from "./runner";
import { acceptanceBinding, observedTreeTerminator } from "./claudeAcceptance";
import { CatalogDispatch } from "../../routing/catalogDispatch";
import { ContextManager } from "../../app/contextManager";
import { InMemoryConversationTimelineStore } from "../../app/timelineStore";

const mode = process.argv[2];
if (!["answer", "cancel", "timeout"].includes(mode))
  throw new Error("Specify answer, cancel, or timeout (live calls)");
const budget = {
  windowTokens: 8192,
  fastOutputTokens: mode === "answer" ? 128 : 2048,
  deepOutputTokens: 128,
  safetyTokens: 256,
  maxHistoryTurns: 4
};
const catalog = await loadModelCatalog(),
  registry = new ProviderRegistry();
const connected = connectHekateClaude(catalog, registry, budget);
const controller = new AbortController();
const inventory = new InventoryStore({ cli: connected.discovery }, loadDiscoveryConfigFromEnv());
await inventory.refreshAll(connected.connections);
const { policy } = await loadDispatchConfig();
const dispatch = new CatalogDispatch(catalog, registry, policy, budget, () =>
  inventory.listObservations()
);
const manager = new ContextManager(new InMemoryConversationTimelineStore(), budget);
const prompt =
  mode === "answer"
    ? "Reply with exactly BRIDGE_OK."
    : "Write a detailed 2000-word explanation of sorting algorithms.";
try {
  const plan = await dispatch.prepare(manager, {
    conversationId: "claude-acceptance",
    currentMessageId: "smoke",
    currentUserText: prompt,
    routeDecision: "direct",
    trustedFacts: {
      fastProvider: "cli",
      fastModel: "sonnet",
      deepProvider: "none",
      deepModel: "none",
      generatedAtIso: new Date().toISOString()
    }
  });
  const control = { signal: controller.signal, attemptId: `live-${mode}`, onDelta: async () => {} };
  if (mode === "answer") {
    const result = await dispatch.execute(plan.fast, control, "acceptance", () =>
      plan.fast.candidate.binding.fast!.createProvisionalReply(
        {
          context: plan.context,
          correctedText: prompt,
          routeDecision: "direct",
          message: {
            text: prompt,
            messageId: "smoke",
            conversationId: "claude-acceptance",
            userId: "operator",
            timestampIso: new Date().toISOString()
          }
        },
        control
      )
    );
    if (result.text.trim() !== "BRIDGE_OK" || result.finishReason !== "stop")
      throw new Error("LIVE_ANSWER_MISMATCH");
    console.log(
      JSON.stringify({
        mode,
        bindingId: plan.fast.candidate.selection.bindingId,
        result,
        reservations: dispatch.telemetry().reservations
      })
    );
  } else {
    if (process.platform !== "win32") throw new Error("LIVE_TREE_CHECK_REQUIRES_WINDOWS");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let descendants: number[] = [];
    const runner = new (class extends CliRunner {
      override adapter(program: CliProgram) {
        return super.adapter({
          ...program,
          encode: (request) => {
            if (mode === "cancel") timer = setTimeout(() => controller.abort(), 4000);
            return program.encode(request);
          }
        });
      }
    })(
      { ...cliLimits(), timeoutMs: mode === "timeout" ? 12000 : 60000 },
      observedTreeTerminator((pids) => {
        descendants = pids;
      })
    );
    const config = hekateBridgeConfig(process.env)!;
    const binding = acceptanceBinding(
      plan.fast.candidate.binding,
      config,
      runner,
      plan.fast.candidate.requirements.outputTokens
    );
    let code: string | undefined;
    try {
      await dispatch.execute(plan.fast, control, "acceptance", () =>
        binding.fast!.createProvisionalReply(
          {
            context: plan.fast.context,
            correctedText: prompt,
            routeDecision: "direct",
            message: {
              text: prompt,
              messageId: "smoke",
              conversationId: "claude-acceptance",
              userId: "operator",
              timestampIso: new Date().toISOString()
            }
          },
          control
        )
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const alive = descendants.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (
      code !== (mode === "cancel" ? "CANCELLED" : "PROVIDER_TIMEOUT") ||
      descendants.length < 2 ||
      alive.length
    )
      throw new Error(
        `LIVE_CLEANUP_FAILED:${JSON.stringify({ code, observedProcesses: descendants.length, alive })}`
      );
    console.log(
      JSON.stringify({
        mode,
        code,
        observedProcesses: descendants.length,
        survivingProcesses: alive.length
      })
    );
  }
} finally {
  inventory.shutdown();
  await manager.shutdown();
}
