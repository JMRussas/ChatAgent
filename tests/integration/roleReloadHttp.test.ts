import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoleCatalog } from "../../src/app/roleCatalog";

// CA-ISSUE-012 acceptance oracle: POST /roles/config/reload on the assembled server.
// An operator route with a strict empty body that re-reads only the configured file;
// a failure answers 400 with the previous catalog kept and echoes no file content.
//
// The live catalog is observed through a PASS-THROUGH wrapper of the real
// loadRoleCatalog: it records the exact instance startServer received and changes
// nothing about loading, reloading or replacing (no production test hook).
//
// INTEGRATED COPY: identical to the frozen oracle (sha256 f921fe94, task base 1f75576) except an explicit
// 30 s timeout on each test, because every test starts the real server and the 5 s default is exceeded
// under full-suite load (CA-ISSUE-012 integration finding C2).
const live = vi.hoisted(() => ({ catalogs: [] as unknown[] }));
vi.mock("../../src/app/roleCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/roleCatalog")>();
  const record = (catalog: unknown) => {
    if (catalog) live.catalogs.push(catalog);
    return catalog;
  };
  return {
    ...actual,
    loadRoleCatalog: ((...args: Parameters<typeof actual.loadRoleCatalog>) => {
      const result: unknown = actual.loadRoleCatalog(...args);
      return result instanceof Promise ? result.then(record) : record(result);
    }) as typeof actual.loadRoleCatalog
  };
});
const { startServer } = await import("../../src/server");
const { clientAuthHeaders } = await import("../../src/auth/clientToken");
/** The role ids of the one catalog instance the running server loaded. */
const liveIds = () => {
  expect(live.catalogs).toHaveLength(1);
  return (live.catalogs[0] as RoleCatalog).list().map((r) => r.id);
};

let directory = "";
beforeEach(async () => {
  vi.stubEnv("WORKSPACE_ENABLED", "false");
  live.catalogs.length = 0;
  directory = await mkdtemp(join(tmpdir(), "role-reload-http-"));
  vi.stubEnv("CHAT_IDENTITY_DIR", join(directory, "ChatAgent"));
  vi.stubEnv("MODEL_ROUTING_MODE", "fixed");
  vi.stubEnv("EVAL_RECORDING", "false");
  vi.stubEnv("MODEL_DISPATCH_CONFIG_PATH", "");
  vi.stubEnv("HEKATE_CLI_ROOT", "");
  for (const phase of ["FAST", "DEEP"]) {
    vi.stubEnv(`CHAT_${phase}_PROVIDER`, "mock");
    vi.stubEnv(`CHAT_${phase}_MODEL`, "mock-v1");
  }
  vi.stubEnv("SPORTS_BRIEFING_CONFIG_PATH", "");
  vi.stubEnv("DOC_TASK_PYTHON", "");
  vi.stubEnv("CONTEXT_SUMMARY_MODE", "off");
  vi.stubEnv("TELEMETRY_STORE_PATH", join(directory, "telemetry.json"));
  vi.stubEnv("SHUTDOWN_GRACE_MS", "0");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const catalog = (...ids: string[]) =>
  JSON.stringify({
    version: "role-catalog-v1",
    roles: ids.map((id) => ({
      id,
      version: "1",
      bindingId: "fixed",
      instructions: `Role ${id} SECRET-INSTRUCTION-CANARY`,
      toolIds: []
    }))
  });

async function serve(rolePath: string) {
  vi.stubEnv("ROLE_CATALOG_PATH", rolePath);
  const handle = await startServer(0);
  const base = `http://127.0.0.1:${handle.address.port}`;
  const headers = {
    operator: await clientAuthHeaders(base, "operator"),
    client: await clientAuthHeaders(base, "client")
  };
  const reload = async (as: "operator" | "client", body: unknown = {}) => {
    const res = await fetch(`${base}/roles/config/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers[as] },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { handle, reload };
}

it("reloads the configured file for an operator and reports version, role ids and hash", async () => {
  const path = join(directory, "roles.json");
  await writeFile(path, catalog("writer"));
  const { handle, reload } = await serve(path);
  try {
    expect(liveIds()).toEqual(["writer"]);
    await writeFile(path, catalog("writer", "editor"));
    const reply = await reload("operator");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      version: "role-catalog-v1",
      roleIds: ["writer", "editor"],
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    });
    // The running server's own catalog changed, not only the response.
    expect(liveIds()).toEqual(["writer", "editor"]);
  } finally {
    await handle.shutdown();
  }
}, 30_000);

it("requires the operator role", async () => {
  const path = join(directory, "roles.json");
  await writeFile(path, catalog("writer"));
  const { handle, reload } = await serve(path);
  try {
    await writeFile(path, catalog("writer", "editor"));
    const reply = await reload("client");
    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe("OPERATOR_REQUIRED");
    expect(liveIds()).toEqual(["writer"]);
  } finally {
    await handle.shutdown();
  }
}, 30_000);

it("accepts only an empty body, so the path is never request-controlled", async () => {
  const path = join(directory, "roles.json");
  await writeFile(path, catalog("writer"));
  const { handle, reload } = await serve(path);
  try {
    await writeFile(path, catalog("writer", "editor"));
    // A VALID alternate file exists at the requested path, so a handler that wrongly
    // honoured the request path could not pass merely because the file was missing.
    const other = join(directory, "other.json");
    await writeFile(other, catalog("intruder"));
    const reply = await reload("operator", { path: other });
    expect(reply.status).toBe(400);
    // The rejected request applied nothing, observed before any follow-up request.
    expect(liveIds()).toEqual(["writer"]);
    const applied = await reload("operator");
    expect(applied.status).toBe(200);
    expect(applied.body.roleIds).toEqual(["writer", "editor"]);
    expect(liveIds()).toEqual(["writer", "editor"]);
  } finally {
    await handle.shutdown();
  }
}, 30_000);

it("answers an invalid file with 400 ROLE_CATALOG_RELOAD_FAILED and no file content", async () => {
  const path = join(directory, "roles.json");
  await writeFile(path, catalog("writer"));
  const { handle, reload } = await serve(path);
  try {
    await writeFile(path, catalog("writer").replace("role-catalog-v1", "role-catalog-v9"));
    const reply = await reload("operator");
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("ROLE_CATALOG_RELOAD_FAILED");
    expect(reply.text).not.toContain("SECRET-INSTRUCTION-CANARY");
    expect(reply.text).not.toContain(directory);
    expect(liveIds()).toEqual(["writer"]);
  } finally {
    await handle.shutdown();
  }
}, 30_000);

it("is disabled with 404 ROLE_RELOAD_DISABLED when no role file is configured", async () => {
  const { handle, reload } = await serve("");
  try {
    const reply = await reload("operator");
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe("ROLE_RELOAD_DISABLED");
  } finally {
    await handle.shutdown();
  }
}, 30_000);
