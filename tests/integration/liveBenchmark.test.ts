import { expect, it } from "vitest";
import { createChatServer } from "../../src/server";
import { createRuntimeHandle } from "../../src/app/runtimeHandle";
import { entry, runtime } from "../helpers/dispatchFixtures";
import { GenerationError } from "../../src/domain/generation";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";
import { allowAllTestAuth } from "../helpers/testAuth";

it("retains provider failure and retry evidence through the real HTTP error response", async () => {
  const r = runtime([entry("a")], {
    a: {
      fast: {
        createProvisionalReply: async () => {
          throw new GenerationError("PROVIDER_UNAVAILABLE", true);
        }
      }
    }
  });
  const server = createChatServer(r.service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle = createRuntimeHandle(server, r.service, {
    config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => {},
    stopInternal: () => r.manager.shutdown(),
    persist: async () => {}
  });
  try {
    const [record] = await runLiveBenchmark([{ id: "hello", text: "Hello" }], {
      baseUrl: `http://127.0.0.1:${handle.address.port}`,
      pollIntervalMs: 5,
      deadlineMs: 3000
    });
    expect(record).toMatchObject({
      outcome: "error",
      httpStatus: 502,
      errorCode: "PROVIDER_UNAVAILABLE",
      routeDecision: "clarify",
      retryCount: 2,
      cancellation: "not-requested"
    });
    expect(record.attempts).toHaveLength(3);
    expect(record.attempts.every((a) => a.bindingId !== null && a.finishReason === "error")).toBe(
      true
    );
    expect(record.finalObservedMs).not.toBeNull();
  } finally {
    await handle.shutdown();
  }
});

it("links a bracketed HTTP benchmark to its completed recorder and exact-answer grades", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EvaluationRecorder } = await import("../../src/eval/recording/recorder");
  const { digest } = await import("../../src/eval/recording/contract");
  const { runLiveReport } = await import("../../src/bench/liveReport");
  const { linkLiveRecording } = await import("../../src/eval/recording/linkLive");
  const root = await mkdtemp(join(tmpdir(), "chatagent-http-link-"));
  const dataset = {
    version: "http-link-v1",
    prompts: [
      { id: "direct", text: "Explain event loops" },
      { id: "deep", text: "Compare and design code for a complex distributed system" }
    ]
  };
  const recorder = new EvaluationRecorder(
    {
      root,
      capture: "answers",
      maxBytes: 1000000,
      maxEvents: 1000,
      retentionMs: 60000,
      repetition: 1,
      condition: "cold"
    },
    dataset,
    { test: "http-link" },
    { revision: "a".repeat(40), sourceDigest: digest("source"), dirty: false }
  );
  const r = runtime([entry("a")], {}, recorder.record);
  const server = createChatServer(r.service, {
    auth: allowAllTestAuth,
    evaluationStatus: () => ({ enabled: true, ...recorder.status() })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setInterval(() => {
    void r.service.runDeepWorkerOnce();
  }, 5);
  const handle = createRuntimeHandle(server, r.service, {
    config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => clearInterval(timer),
    stopInternal: () => r.manager.shutdown(),
    persist: () => recorder.finish()
  });
  try {
    const report = await runLiveReport(dataset.prompts, {
      baseUrl: `http://127.0.0.1:${handle.address.port}`,
      pollIntervalMs: 5,
      deadlineMs: 3000
    });
    expect(report.recorderRunId).toBe(recorder.runId);
    await handle.shutdown();
    const artifact = JSON.parse(await readFile(recorder.path, "utf8"));
    const annotations = {
      version: 2,
      rubricVersion: "test",
      judge: { kind: "code", id: "fixture", configurationDigest: digest("fixture") },
      ratings: dataset.prompts.map((p) => ({
        promptId: p.id,
        responseHash: digest("a"),
        correctness: "pass",
        relevance: "pass",
        unsupportedClaims: "no",
        groundedness: "pass",
        taskCompletion: "pass"
      }))
    };
    const linked = linkLiveRecording(report, artifact, dataset, annotations);
    expect(linked).toMatchObject({ linked: true, qualityPassed: true, mode: "synthetic" });
    expect(linked.observations).toHaveLength(2);
  } finally {
    await handle.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("executes follow-ups in shared fresh conversations and links their exact evidence", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EvaluationRecorder } = await import("../../src/eval/recording/recorder");
  const { digest } = await import("../../src/eval/recording/contract");
  const { scenarioDataset } = await import("../../src/eval/scenarios");
  const { runLiveReport } = await import("../../src/bench/liveReport");
  const { linkScenarioRecording, linkLiveRecording } =
    await import("../../src/eval/recording/linkLive");
  const plan = scenarioDataset({
    version: "followup-test",
    scenarios: ["one", "two"].map((id) => ({
      id,
      turns: ["first", "followup"].map((turn) => ({
        id: `${id}-${turn}`,
        text: `Explain ${id} ${turn}`,
        expected: {
          groundedness: "Use supplied conversation only",
          taskCompletion: "Explain the requested term"
        }
      }))
    }))
  });
  const root = await mkdtemp(join(tmpdir(), "chatagent-scenarios-"));
  const recorder = new EvaluationRecorder(
    {
      root,
      capture: "answers",
      maxBytes: 1000000,
      maxEvents: 1000,
      retentionMs: 60000,
      repetition: 1,
      condition: "cold"
    },
    plan.dataset,
    { test: "scenarios" },
    { revision: "a".repeat(40), sourceDigest: digest("source"), dirty: false }
  );
  const contexts: string[][] = [];
  const r = runtime(
    [entry("a")],
    {
      a: {
        fast: {
          createProvisionalReply: async (input) => {
            contexts.push(input.context!.messages.map((m) => m.content));
            return { text: "Fixture answer", finishReason: "stop" };
          }
        }
      }
    },
    recorder.record
  );
  const server = createChatServer(r.service, {
    auth: allowAllTestAuth,
    evaluationStatus: () => ({ enabled: true, ...recorder.status() })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle = createRuntimeHandle(server, r.service, {
    config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => {},
    stopInternal: () => r.manager.shutdown(),
    persist: () => recorder.finish()
  });
  try {
    const report = await runLiveReport(plan.dataset.prompts, {
      baseUrl: `http://127.0.0.1:${handle.address.port}`,
      conversationGroups: plan.conversationGroups,
      pollIntervalMs: 5,
      deadlineMs: 3000
    });
    await handle.shutdown();
    expect(contexts).toEqual([
      ["Explain one first"],
      ["Explain one first", "Fixture answer", "Explain one followup"],
      ["Explain two first"],
      ["Explain two first", "Fixture answer", "Explain two followup"]
    ]);
    const artifact = JSON.parse(await readFile(recorder.path, "utf8"));
    const annotations = {
      version: 2,
      rubricVersion: "fixture",
      judge: { kind: "code", id: "fixture", configurationDigest: digest("fixture") },
      ratings: []
    };
    expect(linkScenarioRecording(report, artifact, plan.suite, annotations)).toMatchObject({
      linked: true,
      qualityPassed: false,
      schemaVersion: "chatagent-linked-scenarios-v1",
      grading: { runtimePassed: true },
      comparisonEligible: false
    });
    expect(() => linkLiveRecording(report, artifact, plan.dataset, annotations)).toThrow(
      "EVAL_LINK_DUPLICATE_TURN"
    );
    const split = structuredClone(report);
    split.records[1].conversationId = "split";
    expect(() => linkScenarioRecording(split, artifact, plan.suite, annotations)).toThrow(
      "EVAL_LINK_CONVERSATION_GROUP_MISMATCH"
    );
    const merged = structuredClone(report);
    merged.records[2].conversationId = merged.records[0].conversationId;
    expect(() => linkScenarioRecording(merged, artifact, plan.suite, annotations)).toThrow(
      "EVAL_LINK_CONVERSATION_GROUP_MISMATCH"
    );
  } finally {
    await handle.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
