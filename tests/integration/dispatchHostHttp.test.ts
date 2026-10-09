import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import type { Authenticator } from "../../src/auth/authenticator";
import {
  DispatchHost,
  ORIGINAL_CONTAINER_WORKSPACE,
  PYTHON_ENTRY_PREFIX,
  REQUIRED_SOURCE_PATHS,
  type SpawnFn
} from "../../src/integrations/hekate/dispatchHost";
import { createChatServer } from "../../src/server";
import { allowAllTestAuth } from "../helpers/testAuth";

vi.setConfig({ testTimeout: 60_000 });

const FAKE = path.resolve("tests/fixtures/hekate/fake-owned-dispatch.mjs");
const ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const OTHER_ROOT = "00000000-0000-4000-8000-000000000001";
const OP1 = "11111111-1111-4111-8111-111111111111";
const OP2 = "22222222-2222-4222-8222-222222222222";
const LID = "a".repeat(32);
const base = `/development/plans/${ROOT}/dispatch`;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-http-"));
  dirs.push(dir);
  const e1Root = path.join(dir, "e1");
  const sourceFiles = REQUIRED_SOURCE_PATHS.map((rel) => {
    const full = path.join(e1Root, ...rel.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `# ${rel}\n`);
    return { path: rel, sha256: sha(`# ${rel}\n`) };
  });
  writeFileSync(path.join(e1Root, "uv.lock"), "lock v1\n");
  writeFileSync(path.join(dir, "plan.json"), '{"plan":true}');
  writeFileSync(path.join(dir, "model-cli.bin"), "model cli v1");
  const stateDir = path.join(dir, "state");
  mkdirSync(path.join(stateDir, "fake"), { recursive: true });
  const runRoot = path.join(dir, "run");
  const planSha = sha('{"plan":true}');
  const exeSha = sha("model cli v1");
  const importSha = sha("import-doc");
  const config = {
    journalDir: path.join(dir, "journal"),
    containerWorkspace: ORIGINAL_CONTAINER_WORKSPACE,
    python: {
      executable: process.execPath,
      sha256: sha(readFileSync(process.execPath)),
      version: process.version
    },
    source: {
      e1Root,
      files: sourceFiles,
      uvLock: { path: "uv.lock", sha256: sha("lock v1\n") }
    },
    bounds: {
      stdoutBytes: 16 * 1024,
      stderrBytes: 4 * 1024,
      commandDeadlineMs: 8000,
      launchDeadlineMs: 12_000,
      waitS: 2,
      toolMaxBytes: 512 * 1024 * 1024,
      pinDeadlineMs: 60_000
    },
    roots: [
      {
        rootId: ROOT,
        taskId: "3221839c-1b48-55b8-bb36-c9e425f13d9f",
        stateDir,
        planFile: path.join(dir, "plan.json"),
        planSha256: planSha,
        importSha256: importSha,
        runRoot,
        executable: path.join(dir, "model-cli.bin"),
        executableSha256: exeSha,
        worker: "claude" as const,
        rootGo: "go-ahead-token-1",
        actor: "operator:chatagent",
        limits: { maxDurationS: 3600, pollS: 30, maxPollS: 120, heartbeatS: 15, maxNodes: 2 }
      }
    ]
  };
  const running = {
    schema: "owned-dispatch-status.v0",
    importSha256: importSha,
    planFileSha256: planSha,
    runRoot,
    limits: { max_duration_s: 3600, poll_s: 30, max_poll_s: 120, heartbeat_s: 15, max_nodes: 2 },
    owner: {
      pid: 4242,
      processBirth: "133",
      startedAt: "2026-10-08T10:00:00+00:00",
      launchId: LID,
      exeSha256: exeSha
    },
    phase: "waiting",
    state: "blocked",
    stopReason: "spec_pending",
    heartbeat: { at: "2026-10-08T10:00:01+00:00" },
    counters: { cycles: 1, dispatched: 0 },
    note: "PROMPT-SENTINEL",
    liveness: "running"
  };
  const fake = (name: string, value: unknown) =>
    writeFileSync(path.join(stateDir, "fake", name), JSON.stringify(value));
  const calls = (command: string) => {
    const file = path.join(stateDir, "fake", "invocations.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; argv: string[] })
      .filter((call) => call.command === command);
  };
  // Test-only native wrapper: the host asks for `-m e1.owned_dispatch ...`; only this
  // injected spawn turns that validated argv into the fixed fake program.
  const spawn: SpawnFn = (file, args, options) =>
    nodeSpawn(
      file,
      args[0] === PYTHON_ENTRY_PREFIX[0] && args[1] === PYTHON_ENTRY_PREFIX[1]
        ? [FAKE, ...args.slice(2)]
        : args,
      options
    );
  return { dir, config, running, fake, calls, journalDir: config.journalDir, options: { spawn } };
}

function service() {
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  return new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline
  );
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const app = (dispatchHost?: DispatchHost, auth: Authenticator = allowAllTestAuth) =>
  listen(createChatServer(service(), { auth, dispatchHost }));
const post = (url: string, body: unknown, init: RequestInit = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init
  });
const allRoutes = (): [string, string][] => [
  ["GET", base],
  ["POST", `${base}/launch`],
  ["POST", `${base}/stop`]
];
const hit = (url: string, [method, route]: [string, string]) =>
  fetch(
    url + route,
    method === "POST" ? { method, body: JSON.stringify({ operationId: OP1 }) } : { method }
  );

describe("development plan dispatch HTTP", () => {
  it("is disabled with 404 when no host is configured, and chat behavior is unchanged", async () => {
    const url = await app();
    for (const route of allRoutes()) {
      const response = await hit(url, route);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "DISPATCH_HOST_DISABLED" });
    }
    const plan = await fetch(`${url}/development/plans/${ROOT}/status`);
    expect(plan.status).toBe(404);
    expect(await plan.json()).toMatchObject({ code: "PLAN_STATUS_DISABLED" });
    expect((await fetch(url + "/")).status).toBe(200);
    expect((await fetch(url + "/models")).status).toBe(200);
  });

  it("rejects a non-host option and an invalid config before any server exists", () => {
    expect(() =>
      createChatServer(service(), { auth: allowAllTestAuth, dispatchHost: {} as DispatchHost })
    ).toThrow("INVALID_DISPATCH_HOST");
    const f = fixture();
    const config = structuredClone(f.config);
    config.bounds.stdoutBytes = 1 << 20;
    expect(() => new DispatchHost(config)).toThrow("INVALID_DISPATCH_HOST_CONFIG");
    expect(existsSync(f.journalDir)).toBe(false);
  });

  it("answers 401 to anonymous and 403 to client-only callers before any native call", async () => {
    const f = fixture();
    f.fake("status.json", f.running);
    const host = new DispatchHost(f.config, f.options);
    const anonymous = await app(host, { resolve: () => undefined });
    const client = await app(host, {
      resolve: () => ({ principalId: "client:test", roles: new Set(["client"]), via: "bearer" })
    });
    for (const route of allRoutes()) {
      expect((await hit(anonymous, route)).status).toBe(401);
      const denied = await hit(client, route);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    }
    // Wrong methods are unknown routes: 401 anonymous, 404 once authenticated.
    expect((await fetch(anonymous + base, { method: "POST" })).status).toBe(401);
    expect((await fetch(client + `${base}/launch`)).status).toBe(404);
    expect(f.calls("status")).toHaveLength(0);
    expect(f.calls("launch")).toHaveLength(0);
    expect(existsSync(f.journalDir)).toBe(false);
  });

  it("denies the wrong method once authenticated", async () => {
    const f = fixture();
    const url = await app(new DispatchHost(f.config, f.options));
    expect((await fetch(url + base, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(url + `${base}/launch`)).status).toBe(404);
    expect((await fetch(url + `${base}/stop`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(url + `${base}/extra`)).status).toBe(404);
    expect(f.calls("status")).toHaveLength(0);
  });

  it("rejects queries, non-GUID roots and unlisted roots without native calls", async () => {
    const f = fixture();
    const url = await app(new DispatchHost(f.config, f.options));
    for (const [method, route] of allRoutes()) {
      const init =
        method === "POST" ? { method, body: JSON.stringify({ operationId: OP1 }) } : { method };
      const query = await fetch(url + route + "?exe=C:/evil.exe&flag=--exe-arg", init);
      expect(query.status).toBe(400);
      expect(await query.json()).toMatchObject({ code: "INVALID_QUERY" });
      const empty = await fetch(url + route + "?", init);
      expect(empty.status).toBe(400);
      const bad = await fetch(url + route.replace(ROOT, "not-a-guid"), init);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ code: "INVALID_ROOT" });
      const unlisted = await fetch(url + route.replace(ROOT, OTHER_ROOT), init);
      expect(unlisted.status).toBe(404);
      expect(await unlisted.json()).toEqual({ code: "DISPATCH_NOT_PREPARED" });
    }
    expect(readdirSync(f.dir).includes("journal")).toBe(false);
    expect(f.calls("status")).toHaveLength(0);
  });

  it.each([
    ["no body", ""],
    ["empty object", {}],
    ["a path", { operationId: OP1, path: "C:/evil" }],
    ["a flag", { operationId: OP1, flags: ["--exe-arg", "x"] }],
    ["a limit", { operationId: OP1, maxNodes: 20 }],
    ["a root", { operationId: OP1, rootId: OTHER_ROOT }],
    ["a non-uuid id", { operationId: "../../etc/passwd" }],
    ["a numeric id", { operationId: 7 }],
    ["an array", [OP1]],
    ["null", "null"],
    ["broken json", "{operationId"]
  ])("rejects a launch or stop body with %s before any native call", async (_n, body) => {
    const f = fixture();
    const url = await app(new DispatchHost(f.config, f.options));
    for (const route of ["launch", "stop"]) {
      const response = await post(`${url}${base}/${route}`, body);
      expect(response.status).toBe(400);
    }
    expect(f.calls("status")).toHaveLength(0);
    expect(f.calls("launch")).toHaveLength(0);
    expect(f.calls("stop")).toHaveLength(0);
    expect(existsSync(f.journalDir)).toBe(false);
  });

  it("enforces the request body limit", async () => {
    const f = fixture();
    const server = createChatServer(service(), {
      auth: allowAllTestAuth,
      dispatchHost: new DispatchHost(f.config, f.options),
      maxBodyBytes: 256
    });
    const url = await listen(server);
    const response = await post(`${url}${base}/launch`, {
      operationId: OP1,
      pad: "x".repeat(1024)
    });
    expect(response.status).toBe(413);
    expect(f.calls("launch")).toHaveLength(0);
  });

  it("launches, observes, stops and replays through the routes with public projections only", async () => {
    const f = fixture();
    const url = await app(new DispatchHost(f.config, f.options));
    f.fake("scenario.json", {
      launch: { mode: "launched", launchId: LID, writeStatus: f.running }
    });

    const idle = await fetch(url + base);
    expect(idle.status).toBe(200);
    expect(idle.headers.get("cache-control")).toBe("no-store");
    expect(await idle.json()).toMatchObject({ host: "none", lifecycle: "no_host" });

    const launched = await post(`${url}${base}/launch`, { operationId: OP1 });
    expect(launched.status).toBe(200);
    expect(await launched.json()).toEqual({
      code: "LAUNCHED",
      launchId: LID,
      host: "attached",
      operationId: OP1,
      outcome: "launched"
    });
    expect(f.calls("launch")).toHaveLength(1);

    const replay = await post(`${url}${base}/launch`, { operationId: OP1 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(f.calls("launch")).toHaveLength(1);

    const duplicate = await post(`${url}${base}/launch`, { operationId: OP2 });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ code: "OWNER_PRESENT" });
    expect(f.calls("launch")).toHaveLength(1);

    const stopped = await post(`${url}${base}/stop`, { operationId: OP2 });
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({
      code: "STOP_REQUESTED",
      state: "stop_requested",
      exited: false
    });

    const view = await fetch(url + base);
    const text = await view.text();
    expect(JSON.parse(text)).toMatchObject({
      lifecycle: "stop_requested",
      stopRequested: true,
      liveness: "running"
    });
    for (const leak of ["PROMPT", "SENTINEL", f.dir, "4242", "stderr"])
      expect(text).not.toContain(leak);
  });

  it("turns an unexpected native failure into a typed error that echoes nothing", async () => {
    const f = fixture();
    const url = await app(new DispatchHost(f.config, f.options));
    f.fake("scenario.json", { statusMode: "garbage" });
    const response = await fetch(url + base);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "STATUS_UNAVAILABLE" });
  });
});
