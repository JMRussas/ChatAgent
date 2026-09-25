import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
