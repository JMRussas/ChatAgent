/** Isolated Chrome UI check and same-Ollama foreground/background latency probe.
 * Windows Node: node --import tsx experiments/doc-agent/browser_contention.ts PYTHON CHROME FRESH_OUTPUT
 * No browser package, downloads, existing browser profile or application .env needed.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createChatServer } from "../../src/server";
import { PythonDocumentTasks } from "../../src/app/documentTasks";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockFastProvider, MockDeepProvider } from "../../src/providers/mockProviders";
import { OllamaFastProvider } from "../../src/providers/ollamaProviders";

const [python, chromePath, output] = process.argv.slice(2);
if (!output) throw Error("Usage: browser_contention.ts PYTHON CHROME FRESH_OUTPUT");
await mkdir(output, { recursive: false });
await writeFile(resolve(output, ".gitignore"), "tasks/\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<any>, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw Error("Condition timed out");
}
const model = "gemma4:26b",
  ollama = "http://127.0.0.1:11434";
const metadata = await (
  await fetch(ollama + "/api/show", { method: "POST", body: JSON.stringify({ model }) })
).json();
if (!metadata.thinking?.values?.includes(false)) throw Error("Thinking off not verified");
const tags = await (await fetch(ollama + "/api/tags")).json();
const identity = tags.models.find((m: any) => m.name === model);
const records: any[] = [];
const report: any = {
  model: identity,
  ollamaVersion: await (await fetch(ollama + "/api/version")).json(),
  foreground: { temperature: 0, numPredict: 64, think: false, timeoutMs: 120000 },
  records
};
const bridge = new PythonDocumentTasks(
  python,
  resolve("experiments/doc-agent/chat_bridge.py"),
  resolve(output, "tasks"),
  model
);
let live = false;
const mock = new MockFastProvider(),
  real = new OllamaFastProvider(ollama, model, 0, 120000, 64, false);
const fast = {
  createProvisionalReply: (input: any, control: any) =>
    (live ? real : mock).createProvisionalReply(input, control)
};
const queue = new InMemoryTaskQueue(),
  timeline = new InMemoryConversationTimelineStore();
const service = new ChatService(
  new ChatOrchestrator(fast, queue, timeline),
  new DeepWorker(queue, new MockDeepProvider(), timeline),
  timeline
);
const server = createChatServer(service, { documentTasks: bridge });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
async function post(path: string, body: any, label: string) {
  const start = performance.now();
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000)
  });
  const data = await res.json();
  const record: any = { label, status: res.status, elapsedMs: performance.now() - start, data };
  records.push(record);
  return record;
}
const profile = resolve(tmpdir(), "chatagent-browser-" + randomUUID());
await mkdir(profile);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile,
    "about:blank"
  ],
  { stdio: "ignore" }
);
let ws: WebSocket | undefined;
try {
  const port = await until(async () => {
    try {
      return (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    } catch {
      return false;
    }
  }, 15000);
  const tabs = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  ws = new WebSocket(tabs.find((t: any) => t.type === "page").webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(Error("CDP connection failed"));
  });
  let seq = 0;
  const pending = new Map<number, any>();
  const exceptions: any[] = [];
  report.browserExceptions = exceptions;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    }
  };
  function cdp(method: string, params: any = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("CDP timeout: " + method));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  }
  async function js(expression: string) {
    const r = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: base });
  await until(() => js("Boolean(document.getElementById('documentTaskStart'))"));
  const scope = { conversationId: "browser-" + randomUUID(), userId: "browser-user" };
  await js(
    `document.getElementById('conversationId').value=${JSON.stringify(scope.conversationId)};document.getElementById('userId').value=${JSON.stringify(scope.userId)};document.getElementById('conversationId').dispatchEvent(new Event('change'));document.getElementById('prompt').value='Does the implemented ContextManager wait for a new background summary before answering?';document.getElementById('documentTaskStart').click()`
  );
  await until(() =>
    js("document.getElementById('documentTaskStatus').textContent.includes('submitted')")
  );
  if (await js("document.getElementById('sendButton').disabled"))
    throw Error("Background start disabled Send");
  await js(
    "document.getElementById('prompt').value='What is two plus two?';document.getElementById('sendButton').click()"
  );
  await until(() => js("document.getElementById('status').textContent.includes('accepted')"));
  await js(
    "document.getElementById('prompt').value='What is the default summary mode?';document.getElementById('documentTaskStart').click()"
  );
  await until(() => js("document.querySelectorAll('#documentTasks article').length===2"));
  await js(
    "[...document.querySelectorAll('#documentTasks article')].find(x=>x.textContent.includes('default summary')).querySelector('button').click()"
  );
  await until(() =>
    js(
      "[...document.querySelectorAll('#documentTasks article')].some(x=>x.textContent.includes('default summary')&&x.textContent.includes('cancelled'))"
    )
  );
  await until(() =>
    js("document.getElementById('documentTasks').textContent.includes('completed')")
  );
  report.browser = {
    foreground: "mock",
    checks: [
      "page load",
      "task start",
      "Send remains enabled",
      "foreground Send accepted",
      "second task cancellation",
      "completion rendered"
    ],
    panel: await js("document.getElementById('documentTasks').innerText"),
    exceptions
  };
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(output, "browser.png"), Buffer.from(screenshot.data, "base64"));
  await js(
    "document.getElementById('conversationId').value='empty-scope';document.getElementById('conversationId').dispatchEvent(new Event('change'))"
  );
  await until(() => js("document.getElementById('documentTasks').children.length===0"));
  report.browser.checks.push("scope change clears old tasks");
  if (exceptions.length) throw Error("Browser JavaScript exceptions");
  ws.close();
  ws = undefined;
  chrome.kill();
  console.log("Browser flow passed. Starting live foreground latency probe.");
  live = true;
  async function foreground(label: string) {
    const r = await post(
      "/messages",
      {
        conversationId: randomUUID(),
        userId: "probe",
        text: "What is two plus two? Answer in one short sentence."
      },
      label
    );
    console.log(JSON.stringify({ label, status: r.status, elapsedMs: r.elapsedMs }));
    return r;
  }
  await foreground("warmup");
  for (let n = 0; n < 3; n++) await foreground("baseline-before-" + n);
  const probeScope = { conversationId: "probe-" + randomUUID(), userId: "probe" };
  for (let n = 0; n < 3; n++) {
    const a = await post(
      "/document-tasks",
      {
        ...probeScope,
        op: "start",
        requestId: randomUUID(),
        question:
          "Does the implemented ContextManager wait for a new background summary before answering?"
      },
      "background-start-" + n
    );
    if (a.status !== 202) throw Error("Background admission failed");
    const status = () =>
      bridge.request({ ...probeScope, op: "status", taskId: a.data.taskId }) as Promise<any>;
    await until(async () => {
      const s = await status();
      if (["failed", "completed", "uncertain"].includes(s.status))
        throw Error("Background settled before overlap");
      return s.status === "running";
    }, 10000);
    await sleep(300);
    const before = await status();
    const ps = await (await fetch(ollama + "/api/ps")).json();
    const r = await foreground("overlap-" + n);
    r.backgroundBefore = before;
    r.ollamaLoadedBefore = ps;
    r.backgroundAfter = await status();
    const terminal = await until(async () => {
      const s = await status();
      return ["completed", "failed", "cancelled", "uncertain"].includes(s.status) && s;
    }, 180000);
    records.push({ label: "background-terminal-" + n, data: terminal });
  }
  for (let n = 0; n < 3; n++) await foreground("baseline-after-" + n);
  report.outcome = "completed";
} catch (e) {
  report.outcome = "failed";
  report.error = String(e);
  process.exitCode = 1;
  console.error(e);
} finally {
  await writeFile(resolve(output, "results.json"), JSON.stringify(report, null, 2));
  ws?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await sleep(1000);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
