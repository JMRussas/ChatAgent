import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";
import catalog from "../../data/model-catalog.json";

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
