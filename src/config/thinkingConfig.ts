import type { RuntimeProviderConfig } from "./providerConfig";
import { GenerationError } from "../domain/generation";
import { withGenerationDeadline } from "../providers/streaming";

export interface VerifiedThinking { fast?: boolean; deep?: boolean }
/** Explicit controls require current runtime metadata, not model-name heuristics.
 * Ollama /api/show thinking.values contract checked 2026-09-25; see adapter notes. */
export async function verifyThinkingConfig(config: RuntimeProviderConfig, env: NodeJS.ProcessEnv = process.env): Promise<VerifiedThinking> {
  const verified: VerifiedThinking = {};
  for (const role of ["fast", "deep"] as const) {
    const setting = env[`OLLAMA_${role.toUpperCase()}_THINK`] ?? (role === "fast" ? "off" : "default");
    if (!["off", "on", "default"].includes(setting)) throw new Error(`OLLAMA_${role.toUpperCase()}_THINK must be off, on or default`);
    if (config[role].provider !== "ollama" || setting === "default") continue;
    const base = (config.ollama?.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    const requested = setting === "on";
    await withGenerationDeadline("Ollama metadata", 5000, undefined, async signal => {
      const versionResponse = await fetch(`${base}/api/version`, { signal });
      if (!versionResponse.ok) throw new GenerationError("THINKING_CONFIG_UNVERIFIED", false);
      const version = await versionResponse.json();
      if (typeof version.version !== "string" || !version.version) throw new GenerationError("THINKING_CONFIG_UNVERIFIED", false);
      const response = await fetch(`${base}/api/show`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config[role].model }), signal
      });
      if (!response.ok) throw new GenerationError("THINKING_CONFIG_UNVERIFIED", false);
      const metadata = await response.json();
      if (!Array.isArray(metadata.thinking?.values) || !metadata.thinking.values.includes(requested))
        throw new GenerationError("THINKING_CONFIG_UNSUPPORTED", false, `OLLAMA_${role.toUpperCase()}_THINK=${setting} is not verified by this runtime/model. Use default or a supported setting.`);
    });
    verified[role] = requested;
  }
  return verified;
}
