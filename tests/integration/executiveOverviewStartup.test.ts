import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server";
import { clientAuthHeaders } from "../../src/auth/clientToken";
import { RAW_PLAN, ROOT } from "../helpers/attemptProgressFixtures";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "executive-overview-startup-"));
  vi.stubEnv("CHAT_IDENTITY_DIR", join(directory, "identity"));
  for (const phase of ["FAST", "DEEP"]) {
    vi.stubEnv("CHAT_" + phase + "_PROVIDER", "mock");
    vi.stubEnv("CHAT_" + phase + "_MODEL", "mock-v1");
  }
  for (const key of [
    "HEKATE_PLAN_API_URL",
    "HEKATE_EXECUTIVE_OVERVIEW",
    "HEKATE_EXECUTIVE_ROOTS_JSON",
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

const roots = (rootId = ROOT) => JSON.stringify([{ rootId, label: "Delivery", goal: "Ship" }]);

// Real maintained startup and auth; only the loopback Hekate plan responses are fixtures.
it("serves the overview through real startup when explicitly enabled", async () => {
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    const known = req.url === "/api/plan-contract/v1/plans/" + ROOT;
    res.writeHead(known ? 200 : 404, { "content-type": "application/json" });
    res.end(known ? RAW_PLAN : "{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("HEKATE_PLAN_API_URL", "http://127.0.0.1:" + (upstream.address() as AddressInfo).port);
  vi.stubEnv("HEKATE_EXECUTIVE_OVERVIEW", "1");
  vi.stubEnv("HEKATE_EXECUTIVE_ROOTS_JSON", roots());
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = await startServer(0);
    const base = "http://127.0.0.1:" + runtime.address.port;
    const operator = await clientAuthHeaders(base, "operator");
    const html = await (await fetch(base + "/", { headers: operator })).text();
    expect(html).toContain('id="execRefresh"');
    expect(requests).toEqual([]);
    const client = await clientAuthHeaders(base, "client");
    expect(
      (await fetch(base + "/development/executive/overview", { headers: client })).status
    ).toBe(403);
    expect(requests).toEqual([]);
    const response = await fetch(base + "/development/executive/overview", { headers: operator });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.roots).toMatchObject([{ rootId: ROOT, label: "Delivery", status: "ok" }]);
    expect(requests).toEqual(["GET /api/plan-contract/v1/plans/" + ROOT]);
  } finally {
    await runtime?.shutdown();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 30_000);

it("stays disabled through real startup without the explicit enablement", async () => {
  vi.stubEnv("HEKATE_PLAN_API_URL", "http://127.0.0.1:9");
  vi.stubEnv("HEKATE_EXECUTIVE_ROOTS_JSON", roots());
  const runtime = await startServer(0);
  try {
    const base = "http://127.0.0.1:" + runtime.address.port;
    const headers = await clientAuthHeaders(base, "operator");
    expect(await (await fetch(base + "/", { headers })).text()).not.toContain("execRefresh");
    const response = await fetch(base + "/development/executive/overview", { headers });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "EXECUTIVE_OVERVIEW_DISABLED" });
  } finally {
    await runtime.shutdown();
  }
}, 30_000);

it.each([
  ["malformed JSON", "SECRET-{not-json", "http://127.0.0.1:9"],
  [
    "too many roots",
    JSON.stringify(Array.from({ length: 9 }, () => ({ rootId: ROOT, label: "x" }))),
    "http://127.0.0.1:9"
  ],
  ["no plan API", roots(), undefined]
])(
  "fails startup for %s without echoing the value",
  async (_name, rootsJson, url) => {
    vi.stubEnv("HEKATE_EXECUTIVE_OVERVIEW", "1");
    vi.stubEnv("HEKATE_EXECUTIVE_ROOTS_JSON", rootsJson);
    vi.stubEnv("HEKATE_PLAN_API_URL", url);
    const failure = await startServer(0).then(
      () => undefined,
      (error: Error) => error
    );
    expect(failure).toBeDefined();
    expect(failure!.message).toBe("INVALID_EXECUTIVE_ROOTS");
  },
  30_000
);
