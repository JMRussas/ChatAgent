import { afterEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
let status: Record<string, unknown> = {};
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (e: null, out: string) => void
    ) => {
      calls.push(args);
      callback(null, JSON.stringify(status));
    }
  )
}));
import { connectHekateClaude, hekateBridgeConfig } from "../../src/providers/cli/hekateClaude";
import { ProviderRegistry } from "../../src/providers/providerRegistry";
import { entry, budget } from "../helpers/dispatchFixtures";

afterEach(() => {
  calls.length = 0;
});

const env = (extra: Record<string, string> = {}) => ({
  HEKATE_CLI_ROOT: "root",
  HEKATE_CLI_PYTHON: "python",
  HEKATE_CLAUDE_EXECUTABLE: "claude",
  HEKATE_CLI_WORKING_DIRECTORY: "cwd",
  ...extra
});

describe("Claude usage inspection opt-in", () => {
  it("is off unless exactly true, and rejects anything else", () => {
    expect(hekateBridgeConfig(env())?.usageInspection).toBe(false);
    expect(
      hekateBridgeConfig(env({ HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED: "false" }))?.usageInspection
    ).toBe(false);
    expect(
      hekateBridgeConfig(env({ HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED: "true" }))?.usageInspection
    ).toBe(true);
    for (const value of ["", "1", "yes", "TRUE", " true"])
      expect(() =>
        hekateBridgeConfig(env({ HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED: value }))
      ).toThrow("HEKATE_CLI_USAGE_INSPECTION_INVALID");
  });

  async function discover(extra: Record<string, string>) {
    const model = entry("claude", {
      provider: "cli",
      model: "sonnet",
      cli: {
        adapterId: "hekate-claude",
        accountProfile: "default",
        authentication: "unknown",
        nonInteractive: "supported",
        streaming: "unsupported",
        outputFormat: "jsonl",
        executionMode: "answer-only",
        automationSupport: "supported"
      }
    });
    const connected = connectHekateClaude(
      { version: 1, models: [model] },
      new ProviderRegistry(),
      budget,
      env(extra)
    );
    const [observation] = (await connected.discovery!.discover(
      connected.connections[0],
      new AbortController().signal
    )) as { lastErrorCode?: string }[];
    return observation;
  }

  it("asks the bridge to read usage only when enabled", async () => {
    status = { version: "1", authenticated: "yes", automation: "supported", usage: null };
    await discover({});
    expect(calls.at(-1)).not.toContain("--inspect-usage");
    await discover({ HEKATE_CLAUDE_USAGE_INSPECTION_ENABLED: "true" });
    expect(calls.at(-1)).toContain("--inspect-usage");
  });

  it("reports disabled inspection explicitly under the headroom policy", async () => {
    status = {
      version: "1",
      authenticated: "yes",
      automation: "supported",
      usage: null,
      usageErrorCode: "CLI_USAGE_INSPECTION_DISABLED"
    };
    expect(await discover({ HEKATE_CLAUDE_USAGE_POLICY: "headroom" })).toMatchObject({
      lastErrorCode: "CLI_USAGE_INSPECTION_DISABLED"
    });
    // The strict policy is unchanged.
    expect(await discover({})).toMatchObject({ lastErrorCode: "CLI_INCLUDED_ONLY_UNSUPPORTED" });
  });
});
