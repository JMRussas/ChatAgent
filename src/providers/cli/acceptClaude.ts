/** Explicit live acceptance command; never imported by startup or offline tests. */
import "../../config/loadEnv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadModelCatalog } from "../../config/modelCatalog";
import { loadDispatchConfig } from "../../config/dispatchConfig";
import { ProviderRegistry } from "../providerRegistry";
import { connectHekateClaude, createHekateClaudeAdapter, hekateBridgeConfig } from "./hekateClaude";
import { CliRunner, cliLimits, processTreeTerminator, type CliProgram } from "./runner";
import { CatalogDispatch } from "../../routing/catalogDispatch";
import { ContextManager } from "../../app/contextManager";
import { InMemoryConversationTimelineStore } from "../../app/timelineStore";

const mode = process.argv[2];
if (!["answer", "cancel", "timeout"].includes(mode)) throw new Error("Specify answer, cancel, or timeout (live calls)");
const budget = { windowTokens: 8192, fastOutputTokens: mode === "answer" ? 128 : 2048, deepOutputTokens: 128, safetyTokens: 256, maxHistoryTurns: 4 };
const catalog = await loadModelCatalog(), registry = new ProviderRegistry();
const connected = connectHekateClaude(catalog, registry, budget);
const controller = new AbortController();
const observations = (await Promise.all(connected.connections.map(c => connected.discovery!.discover(c, controller.signal)))).flat();
const { policy } = await loadDispatchConfig();
const dispatch = new CatalogDispatch(catalog, registry, policy, budget, () => observations);
const manager = new ContextManager(new InMemoryConversationTimelineStore(), budget);
const prompt = mode === "answer" ? "Reply with exactly BRIDGE_OK." : "Write a detailed 2000-word explanation of sorting algorithms.";
try {
  const plan = await dispatch.prepare(manager, { conversationId: "claude-acceptance", currentMessageId: "smoke", currentUserText: prompt,
    routeDecision: "direct", trustedFacts: { fastProvider: "cli", fastModel: "sonnet", deepProvider: "none", deepModel: "none", generatedAtIso: new Date().toISOString() } });
  const control = { signal: controller.signal, attemptId: `live-${mode}`, onDelta: async () => {} };
  if (mode === "answer") {
    const result = await dispatch.execute(plan.fast, control, "acceptance", () => plan.fast.candidate.binding.fast!.createProvisionalReply(
      { context: plan.context, correctedText: prompt, routeDecision: "direct", message: { text: prompt, messageId: "smoke", conversationId: "claude-acceptance", userId: "operator", timestampIso: new Date().toISOString() } }, control));
    if (result.text.trim() !== "BRIDGE_OK" || result.finishReason !== "stop") throw new Error("LIVE_ANSWER_MISMATCH");
    console.log(JSON.stringify({ mode, bindingId: plan.fast.candidate.selection.bindingId, result, reservations: dispatch.telemetry().reservations }));
  } else {
    if (process.platform !== "win32") throw new Error("LIVE_TREE_CHECK_REQUIRES_WINDOWS");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let descendants: number[] = [];
    const runner = new class extends CliRunner {
      override adapter(program: CliProgram) {
        return super.adapter({ ...program, encode: request => {
          if (mode === "cancel") timer = setTimeout(() => controller.abort(), 4000);
          return program.encode(request);
        } });
      }
    }({ ...cliLimits(), timeoutMs: mode === "timeout" ? 12000 : 60000 }, { terminate: async child => {
      const script = `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do { $next=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids+= $next } while ($next.Count -gt 0); ConvertTo-Json -Compress -InputObject @($ids)`;
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      descendants = JSON.parse(stdout);
      await processTreeTerminator.terminate(child);
    } });
    const config = hekateBridgeConfig(process.env)!;
    const adapter = createHekateClaudeAdapter(config, "sonnet", runner);
    let code: string | undefined;
    try {
      await dispatch.execute(plan.fast, control, "acceptance", async () => {
        for await (const event of adapter.generate({ bindingId: plan.fast.candidate.selection.bindingId,
          context: plan.context,
          outputBudget: 2048, role: "fast", signal: controller.signal, workingDirectory: config.workingDirectory,
          accountProfile: "default", quotaPoolId: "claude-default", exhaustionPolicy: "fail" })) { void event; }
        return { finishReason: "stop" };
      });
    } catch (error) { code = (error as { code?: string }).code; }
    finally { if (timer) clearTimeout(timer); }
    const alive = descendants.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (code !== (mode === "cancel" ? "CANCELLED" : "PROVIDER_TIMEOUT") || descendants.length < 2 || alive.length)
      throw new Error(`LIVE_CLEANUP_FAILED:${JSON.stringify({ code, observedProcesses: descendants.length, alive })}`);
    console.log(JSON.stringify({ mode, code, observedProcesses: descendants.length, survivingProcesses: alive.length }));
  }
} finally { await manager.shutdown(); }
