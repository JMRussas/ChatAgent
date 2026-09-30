/** Helpers for explicit live acceptance; importing this module never calls Claude. */
import { execFile } from "node:child_process";
import type { RegisteredBinding } from "../providerRegistry";
import { cliBinding } from "./providers";
import { createHekateClaudeAdapter, HEKATE_CLAUDE_ID, type HekateBridgeConfig } from "./hekateClaude";
import { processTreeTerminator, type CliRunner, type ProcessTreeTerminator } from "./runner";

export function acceptanceBinding(binding: RegisteredBinding, config: HekateBridgeConfig, runner: CliRunner,
  outputBudget: number, createAdapter = createHekateClaudeAdapter): RegisteredBinding {
  if (binding.entry.provider !== "cli" || binding.entry.cli?.adapterId !== HEKATE_CLAUDE_ID)
    throw new Error("LIVE_ACCEPTANCE_BINDING_UNSUPPORTED");
  return cliBinding(binding, createAdapter(config, binding.entry.model, runner), config.workingDirectory, outputBudget);
}

export function observedTreeTerminator(record: (pids: number[]) => void,
  terminator: ProcessTreeTerminator = processTreeTerminator): ProcessTreeTerminator {
  return { terminate: async child => {
    try {
      if (!child.pid) throw new Error("LIVE_PROCESS_ID_MISSING");
      const script = `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do { $next=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids+= $next } while ($next.Count -gt 0); ConvertTo-Json -Compress -InputObject @($ids)`;
      const stdout = await new Promise<string>((resolve, reject) => execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536, windowsHide: true },
        (error, stdout) => error ? reject(new Error("LIVE_PROCESS_INSPECTION_FAILED")) : resolve(stdout)));
      const pids: unknown = JSON.parse(stdout);
      if (!Array.isArray(pids) || !pids.includes(child.pid) || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
        throw new Error("LIVE_PROCESS_INSPECTION_INVALID");
      record(pids);
    } finally {
      // Inspection failure must never skip termination of the actual invocation.
      await terminator.terminate(child);
    }
  } };
}
