import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";
import catalog from "../../data/model-catalog.json";

beforeEach(() => {
  vi.stubEnv("MODEL_ROUTING_MODE", "fixed");
  vi.stubEnv("MODEL_DISPATCH_CONFIG_PATH", "");
  vi.stubEnv("HEKATE_CLI_ROOT", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("rejects a catalog window consumed by reserves before starting the server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatruntime-window-"));
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ version: 1, models: [
    { ...catalog.models.find(entry => entry.id === "mock-default")!, limits: { contextTokens: 2048 } }
  ] }));
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

it("rejects an occupied port without announcing success or starting background timers", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, resolve));
  const port = (occupied.address() as AddressInfo).port;
  const directory = await mkdtemp(join(tmpdir(), "chatagent-startup-"));
  vi.stubEnv("CHAT_FAST_PROVIDER", "mock");
  vi.stubEnv("CHAT_DEEP_PROVIDER", "mock");
  vi.stubEnv("TELEMETRY_STORE_PATH", join(directory, "telemetry.json"));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    await expect(startServer(port)).rejects.toThrow(`Port ${port} is already in use. This server did not start.`);
    expect(log).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("returns an ephemeral runtime handle and completes deep work automatically without process signal listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatagent-runtime-"));
  const telemetry = join(directory, "telemetry.json");
  for (const role of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${role}_PROVIDER`, "mock"); vi.stubEnv(`CHAT_${role}_MODEL`, "mock-v1");
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
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    const base = `http://127.0.0.1:${handle.address.port}`;
    const response = await fetch(`${base}/messages`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "automatic", userId: "u", text: "Compare and design code for a complex distributed system with detailed tradeoffs" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).deepTask).toBeDefined();
    await vi.waitFor(async () => {
      const result = await (await fetch(`${base}/conversations/automatic/events`)).json();
      expect(result.events.some((event: { type: string }) => event.type === "refined")).toBe(true);
    }, { timeout: 2000, interval: 25 });
    await handle.shutdown();
    expect(JSON.parse(await readFile(telemetry, "utf8"))).toHaveProperty("estimator");
  } finally { await handle.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
