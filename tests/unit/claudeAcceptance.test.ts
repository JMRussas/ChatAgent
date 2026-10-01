import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import {
  acceptanceBinding,
  observedTreeTerminator
} from "../../src/providers/cli/claudeAcceptance";
import { CliRunner } from "../../src/providers/cli/runner";
import { entry, runtime } from "../helpers/dispatchFixtures";
import { entryBindingId } from "../../src/providers/providerRegistry";
import type { CliGenerationRequest } from "../../src/providers/cli/adapter";
import type { ConversationContext } from "../../src/domain/context";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn()
}));
afterEach(() => vi.clearAllMocks());

describe("Claude live acceptance helpers", () => {
  it.each(["success", "timeout", "malformed"])(
    "terminates the invocation even when process inspection is %s",
    async (mode) => {
      const child = { pid: 123 } as ChildProcess;
      const terminate = vi.fn(async () => {}),
        record = vi.fn();
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        expect(args[2]).toMatchObject({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536 });
        args[3](
          mode === "timeout" ? new Error("timed out") : null,
          mode === "malformed" ? "invalid JSON" : "[123,456]"
        );
        return child;
      });
      const cleanup = observedTreeTerminator(record, { terminate }).terminate(child);
      if (mode === "success") {
        await cleanup;
        expect(record).toHaveBeenCalledWith([123, 456]);
      } else {
        await expect(cleanup).rejects.toThrow();
        expect(record).not.toHaveBeenCalled();
      }
      expect(terminate).toHaveBeenCalledExactlyOnceWith(child);
    }
  );

  it("executes the selected model, profile, pool, policy and output budget", async () => {
    const selected = entry("alternate", {
      provider: "cli",
      model: "opus",
      cli: {
        adapterId: "hekate-claude",
        accountProfile: "alternate",
        authentication: "unknown",
        nonInteractive: "supported",
        streaming: "unsupported",
        outputFormat: "jsonl",
        executionMode: "answer-only",
        automationSupport: "supported"
      },
      billing: {
        kind: "subscription",
        quotaPoolId: "alternate-pool",
        exhaustionPolicy: "wait",
        usageBillingFallbackAllowed: false
      }
    });
    const binding = runtime([selected]).registry.get(entryBindingId(selected))!;
    binding.connection.apiKind = "cli";
    let request: CliGenerationRequest | undefined;
    const factory = vi.fn((_config, model, _runner) => ({
      id: "hekate-claude",
      inspect: vi.fn(),
      generate: async function* (input: CliGenerationRequest) {
        expect(model).toBe("opus");
        request = input;
        yield { type: "complete" as const, text: "done", finishReason: "stop" as const };
      }
    }));
    const wrapped = acceptanceBinding(
      binding,
      { python: "python", root: "root", executable: "claude", workingDirectory: "cwd" },
      new CliRunner(),
      321,
      factory
    );
    const context = { systemInstruction: "fixture" } as ConversationContext;
    await wrapped.fast!.createProvisionalReply({
      context,
      correctedText: "test",
      routeDecision: "direct",
      message: {
        text: "test",
        messageId: "m",
        conversationId: "c",
        userId: "u",
        timestampIso: new Date().toISOString()
      }
    });
    expect(request).toMatchObject({
      bindingId: binding.bindingId,
      accountProfile: "alternate",
      quotaPoolId: "alternate-pool",
      exhaustionPolicy: "wait",
      outputBudget: 321,
      context
    });
  });
});
