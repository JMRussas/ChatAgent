import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliRunner, cliLimits, type CliProgram } from "../../src/providers/cli/runner";
import { CliAdapterRegistry, type CliGenerationRequest, type CliReadiness, type CliGenerationEvent } from "../../src/providers/cli/adapter";
import { GenerationError } from "../../src/domain/generation";
import type { ConversationContext } from "../../src/domain/context";
import { ProviderRegistry, entryBindingId } from "../../src/providers/providerRegistry";
import { entry } from "../helpers/dispatchFixtures";
import { GenerationAttempt } from "../../src/app/generationLifecycle";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const ready = (): CliReadiness => ({ version: "fixture-1", authenticated: "yes", automation: "supported", quota: "available",
  observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
async function setup(mode = "normal", overrides: Partial<CliProgram> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "chat-cli-")); folders.push(cwd);
  const program: CliProgram = { id: "fixture", executable: process.execPath, args: [resolve("tests/fixtures/cli/fixture.cjs"), mode],
    allowedWorkingRoot: cwd, answerOnly: true, inspect: async () => ready(), encode: request => JSON.stringify({ context: request.context }),
    parse: line => {
      const value = JSON.parse(line);
      if (value.type === "diagnostic") return;
      if (value.type === "error" && ["AUTH_REQUIRED", "QUOTA_EXHAUSTED"].includes(value.code)) throw new GenerationError(value.code, false);
      if (value.type === "delta" && typeof value.text === "string") return value;
      if (value.type === "complete" && typeof value.text === "string" && ["stop", "length", "cancelled"].includes(value.finishReason)) return value;
      throw new Error("bad frame");
    }, ...overrides };
  const context = { systemInstruction: "fixture" } as ConversationContext;
  const request: CliGenerationRequest = { bindingId: "fixture/model-a", context, outputBudget: 100, signal: new AbortController().signal,
    workingDirectory: cwd, accountProfile: "test", quotaPoolId: "shared", exhaustionPolicy: "fail" };
  return { program, request, cwd };
}
async function collect(stream: AsyncIterable<CliGenerationEvent>) { const events = []; for await (const event of stream) events.push(event); return events; }
const limits = { timeoutMs: 5000, maxOutputBytes: 4096, maxConcurrency: 1, quotaMaxWaitMs: 1000 };

describe("offline CLI runner", () => {
  it("validates positive limits", () => {
    expect(cliLimits({}).maxConcurrency).toBe(1);
    for (const value of ["0", "-1", "", "1.5", "abc"]) expect(() => cliLimits({ CLI_TIMEOUT_MS: value })).toThrow("INVALID_CLI_TIMEOUT_MS");
  });
  it("preserves hostile input via stdin, parses byte chunks and discards diagnostics", async () => {
    const { program, request, cwd } = await setup("echo");
    request.context.systemInstruction = 'héllo "quoted" $HOME $(touch injected) `touch injected` & echo secret';
    const result = await collect(new CliRunner(limits).adapter(program).generate(request));
    expect(result).toEqual([{ type: "delta", text: request.context.systemInstruction }, { type: "complete", text: request.context.systemInstruction, finishReason: "stop" }]);
    await expect(access(join(cwd, "injected"))).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });
  it.each([["nonzero", "CLI_NONZERO_EXIT"], ["empty", "CLI_EMPTY_OUTPUT"], ["malformed", "CLI_MALFORMED_OUTPUT"],
    ["overflow", "OUTPUT_TOO_LARGE"], ["login", "AUTH_REQUIRED"], ["quota", "QUOTA_EXHAUSTED"]])("maps %s to safe %s", async (mode, code) => {
    const { program, request } = await setup(mode);
    await expect(collect(new CliRunner(limits).adapter(program).generate(request))).rejects.toMatchObject({ code, message: code, retryable: false });
  });
  it("serializes separate models sharing the same quota pool", async () => {
    const { program, request } = await setup("slow");
    const runner = new CliRunner(limits);
    const first = runner.adapter(program).generate(request);
    // Start first before the second, then prove it cannot complete before release.
    const order: string[] = [];
    const one = collect(first).then(() => order.push("first"));
    await delay(60);
    const events = await collect(runner.adapter(program).generate({ ...request, bindingId: "fixture/model-b" }));
    order.push("second"); await one;
    expect(events[0]).toEqual({ type: "queued", reason: "concurrency" });
    expect(order).toEqual(["first", "second"]);
  });
  it("rejects missing auth, unknown quota, unsafe automation and stale readiness before spawn", async () => {
    for (const [patch, code] of [[{ authenticated: "no" }, "AUTH_REQUIRED"], [{ quota: "unknown" }, "CLI_QUOTA_UNKNOWN"],
      [{ automation: "unknown" }, "CLI_AUTOMATION_UNSUPPORTED"], [{ expiresAt: "2000-01-01" }, "CLI_READINESS_UNKNOWN"]] as const) {
      const { program, request } = await setup("normal", { inspect: async () => ({ ...ready(), ...patch }) });
      await expect(collect(new CliRunner(limits).adapter(program).generate(request))).rejects.toMatchObject({ code });
    }
  });
  it("waits only for a documented bounded quota reset and rechecks readiness", async () => {
    let calls = 0;
    const { program, request } = await setup("normal", { inspect: async () => ++calls === 1 ? { ...ready(), quota: "exhausted", resetAt: new Date(Date.now() + 40).toISOString() } : ready() });
    const events = await collect(new CliRunner(limits).adapter(program).generate({ ...request, exhaustionPolicy: "wait" }));
    expect(events[0]).toMatchObject({ type: "queued", reason: "quota" }); expect(calls).toBe(2);
    program.inspect = async () => ({ ...ready(), quota: "exhausted" });
    await expect(collect(new CliRunner(limits).adapter(program).generate({ ...request, exhaustionPolicy: "wait" }))).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
  });
  it("cancels quota waits immediately", async () => {
    const controller = new AbortController();
    const { program, request } = await setup("normal", { inspect: async () => ({ ...ready(), quota: "exhausted", resetAt: new Date(Date.now() + 900).toISOString() }) });
    const stream = new CliRunner(limits).adapter(program).generate({ ...request, signal: controller.signal, exhaustionPolicy: "wait" })[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ type: "queued" }); controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it.each(["cancel", "timeout"])("kills child and grandchild on %s", async kind => {
    const controller = new AbortController();
    const { program, request, cwd } = await setup("tree");
    const result = collect(new CliRunner({ ...limits, timeoutMs: kind === "timeout" ? 1500 : 5000 }).adapter(program).generate({ ...request, signal: controller.signal }));
    // Attach rejection handler immediately while waiting for fixture readiness.
    const outcome = result.catch(error => error);
    let pids: number[] = [];
    for (let n = 0; n < 100 && !pids.length; n++) { try { pids = JSON.parse(await readFile(join(cwd, "descendants.json"), "utf8")); } catch { await delay(10); } }
    expect(pids).toHaveLength(2);
    if (kind === "cancel") controller.abort();
    expect(await outcome).toMatchObject({ code: kind === "cancel" ? "CANCELLED" : "PROVIDER_TIMEOUT" });
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);
  it("refuses working directories outside the trusted root", async () => {
    const { program, request } = await setup();
    await expect(collect(new CliRunner(limits).adapter(program).generate({ ...request, workingDirectory: tmpdir() }))).rejects.toMatchObject({ code: "CLI_INVALID_WORKING_DIRECTORY" });
  });
  it("only resolves explicitly registered adapter IDs", async () => {
    const registry = new CliAdapterRegistry(); const { program } = await setup();
    expect(registry.get("fixture")).toBeUndefined();
    registry.register(new CliRunner(limits).adapter(program));
    expect(registry.get("fixture")?.id).toBe("fixture");
    expect(() => registry.register(new CliRunner(limits).adapter(program))).toThrow("DUPLICATE_CLI_ADAPTER");
  });
  it("registers reviewed adapters and forwards queued activity to the generation lifecycle", async () => {
    const adapters = new CliAdapterRegistry(), registry = new ProviderRegistry();
    const e = entry("cli-fixture", { provider: "cli", cli: { adapterId: "fixture", accountProfile: "test",
      authentication: "unknown", nonInteractive: "supported", streaming: "supported", outputFormat: "jsonl",
      executionMode: "answer-only", automationSupport: "supported" } });
    const bindingId = entryBindingId(e);
    const binding = { bindingId, entry: e, connection: { connectionId: "cli-fixture-test", apiKind: "cli" as const,
      resourceFacts: { executionScope: "unknown" as const, billingComponents: ["unknown" as const] }, quota: {}, compute: { ownedOrRented: "unknown" as const } } };
    expect(() => registry.registerCli(binding, adapters, process.cwd(), 100)).toThrow("CLI_ADAPTER_NOT_IMPLEMENTED");
    adapters.register({ id: "fixture", inspect: async () => ready(), async *generate() {
      yield { type: "queued", reason: "quota" }; yield { type: "delta", text: "answer" };
      yield { type: "complete", text: "answer", finishReason: "stop" };
    } });
    registry.registerCli(binding, adapters, process.cwd(), 100);
    const timeline = new InMemoryConversationTimelineStore();
    const attempt = new GenerationAttempt("c", "m", "fast", timeline);
    const result = await registry.get(bindingId)!.fast!.createProvisionalReply({
      message: { userId: "u", conversationId: "c", text: "hi", timestampIso: new Date().toISOString() },
      correctedText: "hi", routeDecision: "direct", context: {} as ConversationContext }, attempt.control);
    await attempt.finish("stop");
    expect(result.text).toBe("answer");
    expect(attempt.text).toBe("answer");
    expect(await timeline.getEvents("c")).toEqual(expect.arrayContaining([expect.objectContaining({ activity: "queued", text: "Waiting for provider quota to reset" })]));
  });
  it("does not retry or select a paid fallback on exhausted quota", async () => {
    let inspections = 0;
    const resetAt = new Date(Date.now() + 60000).toISOString();
    const { program, request } = await setup("normal", { inspect: async () => { inspections++; return { ...ready(), quota: "exhausted", resetAt }; } });
    await expect(collect(new CliRunner(limits).adapter(program).generate({ ...request, exhaustionPolicy: "approved-fallback" })))
      .rejects.toMatchObject({ code: "QUOTA_EXHAUSTED", retryable: false, resetAt });
    expect(inspections).toBe(1);
  });
});
