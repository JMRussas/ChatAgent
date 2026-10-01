/** Windows Node: node --import tsx experiments/doc-agent/run_contention.ts PYTHON FRESH_OUTPUT */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { OllamaFastProvider } from "../../src/providers/ollamaProviders";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
import { startGateway, type Policy } from "./contention_gateway";

const [python, output] = process.argv.slice(2);
if (!python || !output) throw Error("Usage: run_contention.ts PYTHON FRESH_OUTPUT");
await mkdir(output, { recursive: false });
await writeFile(resolve(output, ".gitignore"), "tasks-*/\n");
const upstream = "http://127.0.0.1:11434",
  model = "gemma4:26b";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (path: string, body?: unknown) => {
  const r = await fetch(upstream + path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      : {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw Error("Ollama metadata unavailable");
  return r.json();
};
const prompts = [
  "Convert 90 minutes into hours. Answer in one sentence.",
  "Explain the difference between cancelling queued work and cancelling an already running operation. Use two short bullet points.",
  "A documentation task is still running while I ask another question. Explain in three short sentences why a responsive chat interface does not guarantee a fast model response, and what timing measurements would distinguish the delays."
];
const questions = [
  "Does the implemented ContextManager wait for a new background summary before answering? What happens to the original transcript?",
  "Does restarting ChatRuntime preserve conversation context and queued work in the implemented Iris protocol slice? Distinguish the proposal from the implementation checkpoint.",
  "Does the model catalog currently enable automatic model dispatch, or is that still planned?"
];
const order: Policy[] = [
  "concurrent",
  "fifo",
  "foreground-priority",
  "foreground-priority",
  "fifo",
  "concurrent"
];
const report: any = {
  startedAt: new Date().toISOString(),
  prompts,
  questions,
  order,
  blocks: [],
  outcome: "running",
  foreground: { temperature: 0, numPredict: 160, think: false, timeoutMs: 120000 },
  semantics:
    "Gateway arrival to first nonempty answer chunk. Admission is application dispatch, not Ollama internal admission. Baseline and overlap both burst three requests; FIFO isolates serialization from priority."
};
async function save() {
  await writeFile(resolve(output, "results.json"), JSON.stringify(report, null, 2));
}
async function until(check: () => Promise<boolean>, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw Error("Condition timed out");
}
try {
  report.model = (await api("/api/tags")).models.find((m: any) => m.name === model);
  if (!report.model) throw Error("Model not installed; no automatic download");
  const show = await api("/api/show", { model });
  if (!show.thinking?.values?.includes(false) || !show.capabilities?.includes("tools"))
    throw Error("Required capabilities not verified");
  report.thinking = show.thinking;
  report.modelInfo = show.model_info;
  report.ollamaVersion = await api("/api/version");
  report.loadedBefore = await api("/api/ps");
  report.nodeVersion = process.version;
  const metadataScript =
    "import sys,json;sys.path.insert(0,'experiments/doc-agent');from durable import versions;from retrieval import Corpus;from run import ROOT;print(json.dumps({'versions':versions(),'python':sys.version,'sources':Corpus.load(ROOT).snapshot()}))";
  const pythonMetadata = JSON.parse(
    execFileSync(python, ["-c", metadataScript], { encoding: "utf8" })
  );
  report.python = pythonMetadata.python;
  report.versions = pythonMetadata.versions;
  await writeFile(resolve(output, "sources.json"), JSON.stringify(pythonMetadata.sources, null, 2));
  report.hashes = {};
  for (const file of [
    "experiments/doc-agent/run_contention.ts",
    "experiments/doc-agent/contention_gateway.ts",
    "experiments/doc-agent/CONTENTION-EVALUATION.md",
    "experiments/doc-agent/chat_bridge.py",
    "experiments/doc-agent/durable.py",
    "experiments/doc-agent/graph_agent.py",
    "experiments/doc-agent/agent.py",
    "experiments/doc-agent/task_manager.py",
    "experiments/doc-agent/retrieval.py",
    "experiments/doc-agent/examples.py",
    "src/app/documentTasks.ts",
    "src/providers/ollamaProviders.ts",
    "src/providers/streaming.ts"
  ])
    report.hashes[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  await writeFile(
    resolve(output, "protocol.md"),
    await readFile("experiments/doc-agent/CONTENTION-EVALUATION.md")
  );
  await save();
  for (const [index, policy] of order.entries()) {
    const gateway = await startGateway(upstream, policy);
    const bridge = new PythonDocumentTasks(
      python,
      resolve("experiments/doc-agent/chat_bridge.py"),
      resolve(output, "tasks-" + index),
      model,
      gateway.url + "/background/worker"
    );
    const block: any = { index, policy, foreground: [], timings: gateway.records };
    report.blocks.push(block);
    const scope = { conversationId: "probe-" + randomUUID(), userId: "probe" };
    const tasks: any[] = [];
    async function foreground(label: string, text: string, cancelAfterDelta = false) {
      const provider = new OllamaFastProvider(
        gateway.url + "/foreground/" + label,
        model,
        0,
        120000,
        160,
        false
      );
      const controller = new AbortController(),
        started = performance.now();
      const r: any = { label, text, clientStartedAt: new Date().toISOString() };
      block.foreground.push(r);
      try {
        const result = await provider.createProvisionalReply(
          {
            message: { ...scope, text, timestampIso: new Date().toISOString() },
            correctedText: text,
            routeDecision: "direct"
          },
          {
            signal: controller.signal,
            attemptId: label,
            onDelta: async () => {
              r.firstDeltaMs ??= performance.now() - started;
              if (cancelAfterDelta) controller.abort();
            }
          }
        );
        r.result = result;
        r.outcome = "completed";
      } catch (e) {
        r.outcome = e instanceof Error ? e.message : String(e);
      }
      r.elapsedMs = performance.now() - started;
      console.log(
        JSON.stringify({
          block: index,
          policy,
          label,
          outcome: r.outcome,
          firstDeltaMs: r.firstDeltaMs,
          elapsedMs: r.elapsedMs
        })
      );
      return r;
    }
    try {
      gateway.state.phase = "warmup";
      await foreground("warmup", "Say ready in one word.");
      gateway.state.phase = "baseline";
      await Promise.all(prompts.map((prompt, n) => foreground("baseline-" + n, prompt)));
      block.loadedAfterWarmup = await api("/api/ps");
      gateway.state.phase = "overlap";
      const backgroundStart = performance.now();
      for (const question of questions)
        tasks.push(
          await bridge.request({ ...scope, op: "start", requestId: randomUUID(), question })
        );
      const cancelled: any = await bridge.request({
        ...scope,
        op: "start",
        requestId: randomUUID(),
        question: "What is the default summary mode?"
      });
      block.queuedCancellation = {
        before: cancelled,
        after: await bridge.request({ ...scope, op: "cancel", taskId: cancelled.taskId })
      };
      if (cancelled.status !== "queued" || block.queuedCancellation.after.status !== "cancelled")
        throw Error("Queued cancellation check failed");
      await until(
        async () =>
          gateway.records.some(
            (r) =>
              r.lane === "background" && r.admittedMs !== undefined && r.finishedMs === undefined
          ),
        30000
      );
      block.backgroundAtBurst = await bridge.request({ ...scope, op: "list" });
      await Promise.all(prompts.map((prompt, n) => foreground("overlap-" + n, prompt)));
      block.background = [];
      await until(async () => {
        const statuses: any = await bridge.request({ ...scope, op: "list" });
        for (const s of statuses)
          if (
            ["completed", "failed", "cancelled", "uncertain"].includes(s.status) &&
            !block.background.some((x: any) => x.taskId === s.taskId)
          )
            block.background.push({
              ...s,
              observedTerminalMs: performance.now() - backgroundStart
            });
        return tasks.every((t) =>
          statuses.some(
            (s: any) =>
              s.taskId === t.taskId &&
              ["completed", "failed", "cancelled", "uncertain"].includes(s.status)
          )
        );
      });
      gateway.state.phase = "cancellation";
      const cancellation = await foreground(
        "active-cancel",
        "List twenty concrete steps to design, implement, test, deploy and monitor a reliable background task system.",
        true
      );
      if (cancellation.outcome !== "CANCELLED") throw Error("Active cancellation check failed");
      await foreground("after-cancel", "What is three plus four? Answer briefly.");
      block.loadedAfter = await api("/api/ps");
      block.outcome = "completed";
    } catch (e) {
      block.outcome = "failed";
      block.error = String(e);
      throw e;
    } finally {
      // Stop only this experiment's sidecar/jobs; never stop the shared Ollama server.
      for (const task of tasks)
        await bridge.request({ ...scope, op: "cancel", taskId: task.taskId }).catch(() => {});
      bridge.close();
      await sleep(200);
      await gateway.close();
      await save();
    }
  }
  report.outcome = "completed";
} catch (e) {
  report.outcome = "failed";
  report.error = String(e);
  console.error(e);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
}
