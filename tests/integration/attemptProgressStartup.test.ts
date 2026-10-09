import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";
import { clientAuthHeaders } from "../../src/auth/clientToken";
import {
  ROOT,
  RUNNING,
  claude,
  traceRecords,
  upstreamBodies
} from "../helpers/attemptProgressFixtures";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "attempt-progress-startup-"));
  vi.stubEnv("CHAT_IDENTITY_DIR", join(directory, "identity"));
  for (const phase of ["FAST", "DEEP"]) {
    vi.stubEnv("CHAT_" + phase + "_PROVIDER", "mock");
    vi.stubEnv("CHAT_" + phase + "_MODEL", "mock-v1");
  }
  for (const key of [
    "HEKATE_PLAN_API_URL",
    "HEKATE_DISPATCH_CONFIG_PATH",
    "ROLE_CATALOG_PATH",
    "MODEL_CATALOG_PATH"
  ])
    vi.stubEnv(key, undefined);
  for (const key of [
    "HEKATE_CLI_ROOT",
    "MODEL_DISPATCH_CONFIG_PATH",
    "SPORTS_BRIEFING_CONFIG_PATH",
    "DOC_TASK_PYTHON"
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("MODEL_ROUTING_MODE", "fixed");
  vi.stubEnv("EVAL_RECORDING", "false");
  vi.stubEnv("CONTEXT_SUMMARY_MODE", "off");
  vi.stubEnv("DEEP_WORKER_AUTO_RUN", "false");
  vi.stubEnv("TELEMETRY_STORE_PATH", join(directory, "telemetry.json"));
  vi.stubEnv("SHUTDOWN_GRACE_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

// Real maintained startup, auth and collector: only the loopback Hekate responses are fixtures.
// The enclosing bound includes Windows identity ACL subprocesses; no real model/dispatcher starts.
it("enables progress through the real startup when the trusted plan API is configured", async () => {
  const answer = upstreamBodies({
    records: traceRecords([{ text: claude.assistant([claude.text("Public step.")]) }])
  });
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    const body = answer(req.url ?? "");
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(body ?? "{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("HEKATE_PLAN_API_URL", "http://127.0.0.1:" + (upstream.address() as AddressInfo).port);
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = await startServer(0);
    const base = "http://127.0.0.1:" + runtime.address.port;
    const headers = await clientAuthHeaders(base, "operator");
    const html = await (await fetch(base + "/", { headers })).text();
    expect(html.includes('id="attemptProgress"')).toBe(true);
    const response = await fetch(
      base + "/development/plans/" + ROOT + "/nodes/" + RUNNING + "/progress",
      { headers }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ schema: "attempt-progress/v1", rootId: ROOT, nodeId: RUNNING });
    expect(body.activity.items).toMatchObject([{ kind: "text", text: "Public step." }]);
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
  } finally {
    await runtime?.shutdown();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 30_000);

it("keeps progress disabled through real startup without a plan API", async () => {
  const runtime = await startServer(0);
  try {
    const base = "http://127.0.0.1:" + runtime.address.port;
    const headers = await clientAuthHeaders(base, "operator");
    const html = await (await fetch(base + "/", { headers })).text();
    expect(html.includes('id="attemptProgress"')).toBe(false);
    const response = await fetch(
      base + "/development/plans/" + ROOT + "/nodes/" + RUNNING + "/progress",
      { headers }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ATTEMPT_PROGRESS_DISABLED" });
  } finally {
    await runtime.shutdown();
  }
}, 30_000);
