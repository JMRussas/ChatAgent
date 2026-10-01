import "../../config/loadEnv";
import { createHekateClaudeAdapter, hekateBridgeConfig } from "./hekateClaude";
import { CliRunner } from "./runner";

const config = hekateBridgeConfig(process.env);
if (!config) throw new Error("HEKATE_CLI_NOT_CONFIGURED");
try {
  const state = await createHekateClaudeAdapter(config, "sonnet", new CliRunner()).inspect(
    "default",
    AbortSignal.timeout(25000)
  );
  console.log(JSON.stringify({ adapter: "hekate-claude", profile: "default", ...state }, null, 2));
  if (state.authenticated !== "yes" || state.automation !== "supported") process.exitCode = 1;
} catch {
  console.error("HEKATE_BRIDGE_UNAVAILABLE");
  process.exitCode = 1;
}
