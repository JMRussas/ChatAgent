import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";
import catalog from "../../data/model-catalog.json";
import { clientAuthHeaders } from "../../src/auth/clientToken";

// Every startServer in these tests gets its own installation identity, never the
// user profile one, and its requests carry the real tokens loaded from it.
let identityDir = "";
beforeEach(async () => {
  identityDir = await mkdtemp(join(tmpdir(), "chat-identity-"));
  vi.stubEnv("CHAT_IDENTITY_DIR", join(identityDir, "ChatAgent"));
  vi.stubEnv("MODEL_ROUTING_MODE", "fixed");
  vi.stubEnv("EVAL_RECORDING", "false");
  vi.stubEnv("MODEL_DISPATCH_CONFIG_PATH", "");
  vi.stubEnv("HEKATE_CLI_ROOT", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(identityDir, { recursive: true, force: true });
});

it("rejects a catalog window consumed by reserves before starting the server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatruntime-window-"));
  const catalogPath = join(directory, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      models: [
        {
          ...catalog.models.find((entry) => entry.id === "mock-default")!,
          limits: { contextTokens: 2048 }
        }
      ]
    })
  );
  for (const role of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${role}_PROVIDER`, "mock");
    vi.stubEnv(`CHAT_${role}_MODEL`, "mock-v1");
  }
  vi.stubEnv("CONTEXT_WINDOW_TOKENS", "8192");
  vi.stubEnv("CHAT_FAST_MAX_OUTPUT_TOKENS", "512");
  vi.stubEnv("CHAT_DEEP_MAX_OUTPUT_TOKENS", "2048");
  vi.stubEnv("CONTEXT_SAFETY_TOKENS", "256");
  vi.stubEnv("MODEL_CATALOG_PATH", catalogPath);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    await expect(startServer(0)).rejects.toThrow(/effective context window \(2048/);
    expect(log).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("stops startup on an invalid installation identity, leaving it unchanged and binding nothing", async () => {
  for (const role of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${role}_PROVIDER`, "mock");
    vi.stubEnv(`CHAT_${role}_MODEL`, "mock-v1");
  }
  vi.stubEnv("TELEMETRY_STORE_PATH", join(identityDir, "telemetry.json"));
  // A private directory holding an identity that does not match the format.
  const { loadOrCreateIdentity } = await import("../../src/auth/localIdentity");
  const dir = join(identityDir, "ChatAgent");
  await loadOrCreateIdentity(dir);
  await writeFile(join(dir, "identity.json"), '{"version":1}');
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await expect(startServer(0)).rejects.toThrow(/identity format/);
  expect(log).not.toHaveBeenCalled();
  expect(await readFile(join(dir, "identity.json"), "utf8")).toBe('{"version":1}');
}, 120_000);

it("rejects an occupied port without announcing success or starting background timers", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as AddressInfo).port;
  const directory = await mkdtemp(join(tmpdir(), "chatagent-startup-"));
  vi.stubEnv("CHAT_FAST_PROVIDER", "mock");
  vi.stubEnv("CHAT_DEEP_PROVIDER", "mock");
  vi.stubEnv("TELEMETRY_STORE_PATH", join(directory, "telemetry.json"));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    await expect(startServer(port)).rejects.toThrow(
      `Port ${port} is already in use. This server did not start.`
    );
    expect(log).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["0.0.0.0", "::", "192.168.1.20"])(
  "refuses the nonlocal bind %s before starting anything",
  async (host) => {
    vi.stubEnv("BIND_HOST", host);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interval = vi.spyOn(globalThis, "setInterval");
    await expect(startServer(0)).rejects.toThrow(/BIND_HOST must be one of/);
    expect(log).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  }
);

it("rejects an invalid request body limit before starting anything", async () => {
  vi.stubEnv("HTTP_MAX_BODY_BYTES", "unlimited");
  const interval = vi.spyOn(globalThis, "setInterval");
  await expect(startServer(0)).rejects.toThrow(/HTTP_MAX_BODY_BYTES must be a positive integer/);
  expect(interval).not.toHaveBeenCalled();
});

it("rejects an invalid concurrent-turn limit before starting anything", async () => {
  vi.stubEnv("CHAT_MAX_CONCURRENT_TURNS", "0");
  const interval = vi.spyOn(globalThis, "setInterval");
  await expect(startServer(0)).rejects.toThrow(
    /CHAT_MAX_CONCURRENT_TURNS must be a positive integer/
  );
  expect(interval).not.toHaveBeenCalled();
});

it("returns an ephemeral runtime handle and completes deep work automatically without process signal listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatagent-runtime-"));
  const telemetry = join(directory, "telemetry.json");
  const evaluationRoot = join(directory, "evaluations"),
    datasetPath = join(directory, "dataset.json");
  await writeFile(
    datasetPath,
    JSON.stringify({
      version: "test-v1",
      prompts: [
        {
          id: "deep",
          text: "Compare and design code for a complex distributed system with detailed tradeoffs"
        }
      ]
    })
  );
  vi.stubEnv("EVAL_RECORDING", "true");
  vi.stubEnv("EVAL_DATASET_PATH", datasetPath);
  vi.stubEnv("EVAL_OUTPUT_ROOT", evaluationRoot);
  for (const role of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${role}_PROVIDER`, "mock");
    vi.stubEnv(`CHAT_${role}_MODEL`, "mock-v1");
  }
  vi.stubEnv("CONTEXT_SUMMARY_MODE", "off");
  vi.stubEnv("DOC_TASK_PYTHON", "");
  vi.stubEnv("TELEMETRY_STORE_PATH", telemetry);
  vi.stubEnv("DEEP_WORKER_AUTO_RUN", "true");
  vi.stubEnv("DEEP_WORKER_INTERVAL_MS", "100");
  vi.stubEnv("SHUTDOWN_GRACE_MS", "0");
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const handle = await startServer(0);
  try {
    expect(handle.address.port).toBeGreaterThan(0);
    expect(handle.address.address).toBe("127.0.0.1");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    const base = `http://127.0.0.1:${handle.address.port}`;
    const client = await clientAuthHeaders(base, "client");
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...client },
      body: JSON.stringify({
        conversationId: "automatic",
        userId: "u",
        text: "Compare and design code for a complex distributed system with detailed tradeoffs"
      })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).deepTask).toBeDefined();
    await vi.waitFor(
      async () => {
        const result = await (
          await fetch(`${base}/conversations/automatic/events`, { headers: client })
        ).json();
        expect(result.events.some((event: { type: string }) => event.type === "refined")).toBe(
          true
        );
      },
      { timeout: 2000, interval: 25 }
    );
    const [benchmark] = await runLiveBenchmark(
      [
        {
          id: "deep",
          text: "Compare and design code for a complex distributed system with detailed tradeoffs"
        }
      ],
      { baseUrl: base, deadlineMs: 5000, pollIntervalMs: 25, headers: client }
    );
    expect(benchmark).toMatchObject({
      outcome: "stop",
      routeDecision: "deep",
      evidenceMode: "synthetic",
      retryCount: 0,
      quality: null
    });
    expect(benchmark.attempts.map((a) => a.phase).sort()).toEqual(["deep", "fast"]);
    expect(benchmark.responseHash).toMatch(/^[a-f0-9]{64}$/);
    const recording = await (
      await fetch(`${base}/telemetry/evaluation`, {
        headers: await clientAuthHeaders(base, "operator")
      })
    ).json();
    expect(recording.enabled).toBe(true);
    await handle.shutdown();
    const artifact = JSON.parse(
      await readFile(join(evaluationRoot, recording.runId, "run.json"), "utf8")
    );
    expect(artifact.manifest.status).toBe("complete");
    expect(artifact.summary.mode).toBe("synthetic");
    expect(artifact.trace.some((e: { type: string }) => e.type === "refined")).toBe(true);
    expect(JSON.parse(await readFile(telemetry, "utf8"))).toHaveProperty("estimator");
  } finally {
    await handle.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps mock chat working with a loaded role catalog and rejects role execution explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-role-mock-"));
  const path = join(directory, "roles.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "role-catalog-v1",
      roles: [
        { id: "writer", version: "1", bindingId: "fixed", instructions: "Write", toolIds: [] }
      ]
    })
  );
  for (const phase of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${phase}_PROVIDER`, "mock");
    vi.stubEnv(`CHAT_${phase}_MODEL`, "mock-v1");
  }
  vi.stubEnv("ROLE_CATALOG_PATH", path);
  vi.stubEnv("SPORTS_BRIEFING_CONFIG_PATH", "");
  vi.stubEnv("DOC_TASK_PYTHON", "");
  vi.stubEnv("CONTEXT_SUMMARY_MODE", "off");
  vi.stubEnv("TELEMETRY_STORE_PATH", join(directory, "telemetry.json"));
  vi.stubEnv("SHUTDOWN_GRACE_MS", "0");
  vi.stubEnv("HTTP_MAX_BODY_BYTES", "512");
  const handle = await startServer(0);
  const base = `http://127.0.0.1:${handle.address.port}`;
  const operator = await clientAuthHeaders(base, "operator");
  const client = await clientAuthHeaders(base, "client");
  try {
    // The configured limit reaches the assembled server. Only headers are sent, so
    // the rejection cannot race an upload.
    const oversized = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: handle.address.port,
          agent: false,
          method: "POST",
          path: "/routing/policy/set",
          headers: { "Content-Type": "application/json", "Content-Length": 513, ...operator }
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            req.destroy();
            resolve(res.statusCode);
          });
        }
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(oversized).toBe(413);
    const post = (body: unknown) =>
      fetch(`${base}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...client },
        body: JSON.stringify(body)
      });
    const body = { conversationId: "roles", userId: "u", text: "hello" };
    expect((await post(body)).status).toBe(200);
    const rejected = await post({ ...body, runControls: { roleId: "writer" } });
    expect(rejected.ok).toBe(false);
    expect(await rejected.text()).toContain("ROLE_EXECUTION_UNSUPPORTED");
  } finally {
    await handle.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
