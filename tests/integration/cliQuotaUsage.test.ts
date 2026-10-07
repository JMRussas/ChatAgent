import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPolicySchema } from "../../src/config/dispatchConfig";
import { CatalogDispatch } from "../../src/routing/catalogDispatch";
import type { QuotaEnvelope } from "../../src/routing/quotaEnvelope";
import type { GenerationControl } from "../../src/domain/generation";
import { entryBindingId } from "../../src/providers/providerRegistry";
import { CliRunner } from "../../src/providers/cli/runner";
import { cliBinding } from "../../src/providers/cli/providers";
import { parseBridgeEvent } from "../../src/providers/cli/hekateClaude";
import { budget, entry, evidence, now, resources, runtime } from "../helpers/dispatchFixtures";

// A real CLI subprocess, the real bridge-frame parser and CLI binding, and an observed
// lower bound reaching CatalogDispatch. Offline: the child prints one bridge frame.

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const window = (unit: "tokens" | "requests"): QuotaEnvelope => ({
  poolId: "pool",
  windowId: "w0",
  sequence: 1,
  startsAt: "2026-09-29T00:00:00.000Z",
  resetsAt: "2026-09-30T00:00:00.000Z",
  allowance: 100_000,
  unit,
  scope: { kind: "account" },
  evidence: { checkedAtIso: evidence.checkedAtIso, expiresAtIso: evidence.expiresAtIso }
});

async function setup(
  routeDecision: "direct" | "deep" = "direct",
  unit: "tokens" | "requests" = "tokens"
) {
  const r = runtime([entry("a")]);
  const policy = dispatchPolicySchema.parse({
    quotaEnvelopes: [window(unit)],
    bindings: { a: resources({ quotaEnvelope: { poolId: "pool", unit } }) }
  });
  policy.fallbackBindingIds.fast = r.catalog.models.map(entryBindingId);
  const dispatch = new CatalogDispatch(
    r.catalog,
    r.registry,
    policy,
    budget,
    () => r.observations,
    () => new Date(now)
  );
  const plan = await dispatch.prepare(r.manager, {
    conversationId: "c",
    currentMessageId: "turn-1",
    currentUserText: "Explain code",
    trustedFacts: {
      fastProvider: "mock",
      fastModel: "mock",
      deepProvider: "mock",
      deepModel: "mock",
      generatedAtIso: now
    },
    routeDecision
  });
  return { dispatch, plan };
}

/** A CLI binding whose child process prints exactly `frame` as its bridge output. */
async function binding(frame: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "chat-cli-usage-"));
  folders.push(cwd);
  const e = entry("cli-a", {
    provider: "cli",
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
  const adapter = new CliRunner({
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    maxConcurrency: 1,
    quotaMaxWaitMs: 1000
  }).adapter({
    id: "hekate-claude",
    executable: process.execPath,
    args: [
      "-e",
      `process.stdin.resume();process.stdin.on("end",()=>console.log(${JSON.stringify(JSON.stringify(frame))}))`
    ],
    allowedWorkingRoot: cwd,
    answerOnly: true,
    inspect: async () => ({
      version: "fixture",
      authenticated: "yes",
      automation: "supported",
      quota: "available",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }),
    encode: (request) => JSON.stringify({ outputBudget: request.outputBudget }),
    parse: parseBridgeEvent
  });
  return cliBinding(
    {
      bindingId: entryBindingId(e),
      entry: e,
      connection: {
        connectionId: "c",
        apiKind: "cli",
        resourceFacts: { executionScope: "managed-cloud", billingComponents: ["subscription"] },
        quota: {},
        compute: { ownedOrRented: "unknown" }
      }
    },
    adapter,
    cwd,
    { fast: 32, deep: 64 }
  );
}

function control(): GenerationControl {
  return { signal: new AbortController().signal, attemptId: "attempt", onDelta: async () => {} };
}
const observed = (inputTokens: number, outputTokens: number) => ({
  source: "cli-model-usage-lower-bound",
  inputTokens,
  outputTokens
});
const complete = (text: string, extra: object = {}) => ({
  type: "complete",
  text,
  finishReason: "stop",
  ...extra
});
const remaining = (d: CatalogDispatch) => d.admission.envelopeAvailability()[0]?.remaining;
const links = (d: CatalogDispatch) => d.admission.retentionStats().unsettledEnvelopeLinks;
const reservation = (d: CatalogDispatch, id: string | undefined) =>
  d.telemetry().reservations.find((r) => r.id === id);
async function fast(
  dispatch: CatalogDispatch,
  plan: Awaited<ReturnType<typeof setup>>["plan"],
  frame: unknown
) {
  const cli = await binding(frame);
  const c = control();
  return dispatch.execute(plan.fast, c, "medium", () =>
    cli.fast!.createProvisionalReply(
      {
        message: {} as never,
        correctedText: "hi",
        routeDecision: "direct",
        context: plan.fast.context
      },
      c
    )
  );
}

describe("CLI observed lower bounds", () => {
  it("raises a fast CLI charge above its estimate and keeps it open and linked", async () => {
    const { dispatch, plan } = await setup();
    const ticket = plan.fast.ticket;
    const result = await fast(
      dispatch,
      plan,
      complete("ok", { observedUsage: observed(50_000, 10_000) })
    );
    expect(result).toEqual({
      text: "ok",
      finishReason: "stop",
      usageLowerBound: { source: "observed-lower-bound", inputTokens: 50_000, outputTokens: 10_000 }
    });
    expect(remaining(dispatch)).toBe("40000");
    // Never settled: the link stays for a later complete report, and the
    // diagnostic reservation keeps its estimate.
    expect(links(dispatch)).toBe(1);
    expect(dispatch.admission.reportQuotaUsage(ticket!, 59_999)).toBe(false);
    expect(links(dispatch)).toBe(1);
    expect(dispatch.admission.reportQuotaUsage(ticket!, 60_000)).toBe(true);
    expect(remaining(dispatch)).toBe("40000");
    expect(links(dispatch)).toBe(0);
  });

  it("refuses the next admission once a lower bound exceeds the allowance", async () => {
    const { dispatch, plan } = await setup();
    await fast(dispatch, plan, complete("ok", { observedUsage: observed(100_000, 1) }));
    expect(dispatch.admission.envelopeAvailability()).toMatchObject([
      { remaining: "0", debt: "1" }
    ]);
    expect(links(dispatch)).toBe(1);
    await expect(fast(dispatch, plan, complete("again"))).rejects.toThrow("QUOTA_EXHAUSTED");
  });

  it("leaves a charge at its estimate when the observed minimum is lower", async () => {
    const { dispatch, plan } = await setup();
    const estimated = remaining(dispatch);
    await fast(dispatch, plan, complete("ok", { observedUsage: observed(3, 4) }));
    expect(remaining(dispatch)).toBe(estimated);
    expect(links(dispatch)).toBe(1);
  });

  it("raises a deep CLI charge on its own ticket", async () => {
    const { dispatch, plan } = await setup("deep");
    const fastReserved = reservation(dispatch, plan.fast.ticket)!.quotaUnits!;
    const cli = await binding(
      complete("deep", { finishReason: "length", observedUsage: observed(50_000, 10_000) })
    );
    const c = control();
    const result = await dispatch.execute(plan.deep!, c, "medium", () =>
      cli.deep!.resolveDeepTask(
        {
          taskId: "t",
          conversationId: "c",
          normalizedPrompt: "hi",
          createdAtIso: now,
          context: plan.deep!.context
        },
        c
      )
    );
    expect(result.usageLowerBound).toEqual({
      source: "observed-lower-bound",
      inputTokens: 50_000,
      outputTokens: 10_000
    });
    expect(result).not.toHaveProperty("usage");
    expect(remaining(dispatch)).toBe(String(100_000 - fastReserved - 60_000));
    expect(reservation(dispatch, plan.fast.ticket)).toMatchObject({
      status: "reserved",
      started: false
    });
    expect(links(dispatch)).toBe(1);
    dispatch.release(plan.fast);
  });

  it("settles a request envelope at one invocation whatever the observed tokens", async () => {
    const { dispatch, plan } = await setup("direct", "requests");
    await fast(dispatch, plan, complete("ok", { observedUsage: observed(50_000, 10_000) }));
    expect(remaining(dispatch)).toBe("99999");
    expect(links(dispatch)).toBe(0);
  });

  it.each([
    ["a length stop ended the CLI before any result", { finishReason: "length" }],
    ["the bridge claims complete usage", { usage: { ...observed(50_000, 10_000) } }],
    [
      "the lower bound has a foreign source",
      { observedUsage: { ...observed(50_000, 10_000), source: "provider-response" } }
    ],
    ["counts are invalid", { observedUsage: observed(-1, 10_000) }],
    ["counts overflow a safe sum", { observedUsage: observed(Number.MAX_SAFE_INTEGER, 1) }],
    ["the lower bound is not an object", { observedUsage: "60000" }]
  ])("keeps the estimate and the answer when %s", async (_label, extra) => {
    const { dispatch, plan } = await setup();
    const estimated = remaining(dispatch);
    const result = await fast(dispatch, plan, complete("ok", extra));
    expect(result.text).toBe("ok");
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("usageLowerBound");
    expect(remaining(dispatch)).toBe(estimated);
    expect(links(dispatch)).toBe(1);
  });
});

describe("a result carrying complete usage and a lower bound", () => {
  const minimum = { source: "observed-lower-bound" as const, inputTokens: 50_000, outputTokens: 0 };
  const usage = (inputTokens: number) => ({
    source: "provider-response" as const,
    inputTokens,
    outputTokens: 0
  });

  it("refuses complete usage below its own minimum and keeps the charge at that minimum", async () => {
    const { dispatch, plan } = await setup();
    await dispatch.execute(plan.fast, control(), "medium", async () => ({
      text: "ok",
      finishReason: "stop",
      usage: usage(49_999),
      usageLowerBound: minimum
    }));
    expect(remaining(dispatch)).toBe("50000");
    expect(links(dispatch)).toBe(1);
  });

  it("finalizes consistent complete usage at or above the minimum", async () => {
    const { dispatch, plan } = await setup();
    await dispatch.execute(plan.fast, control(), "medium", async () => ({
      text: "ok",
      finishReason: "stop",
      usage: usage(50_001),
      usageLowerBound: minimum
    }));
    expect(remaining(dispatch)).toBe("49999");
    expect(links(dispatch)).toBe(0);
  });
});
