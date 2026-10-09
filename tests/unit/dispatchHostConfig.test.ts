import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DispatchHost, REQUIRED_SOURCE_PATHS } from "../../src/integrations/hekate/dispatchHost";
import {
  DISPATCH_CONFIG_ENV,
  DispatchStartupError,
  MAX_DISPATCH_CONFIG_BYTES,
  loadDispatchHost
} from "../../src/integrations/hekate/dispatchHostConfig";

const ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const TASK = "3221839c-1b48-55b8-bb36-c9e425f13d9f";
const HASH = "0".repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir() {
  // The loader refuses any path that resolves through a link, so use the real spelling.
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "dispatch-config-")));
  dirs.push(dir);
  return dir;
}

function validConfig(dir: string): Record<string, any> {
  return {
    journalDir: path.join(dir, "journal"),
    containerWorkspace: "D:\\Git\\Hekate",
    traceRoot: path.join(dir, "traces"),
    python: { executable: path.join(dir, "python"), sha256: HASH, version: "Python 3.13.13" },
    source: {
      e1Root: path.join(dir, "e1"),
      files: REQUIRED_SOURCE_PATHS.map((rel) => ({ path: rel, sha256: HASH })),
      uvLock: { path: "uv.lock", sha256: HASH }
    },
    bounds: {
      stdoutBytes: 1024,
      stderrBytes: 1024,
      commandDeadlineMs: 1000,
      launchDeadlineMs: 2000,
      waitS: 1,
      toolMaxBytes: 1024,
      pinDeadlineMs: 1000
    },
    roots: [
      {
        rootId: ROOT,
        taskId: TASK,
        stateDir: path.join(dir, "state"),
        planFile: path.join(dir, "plan.json"),
        planSha256: HASH,
        importSha256: HASH,
        runRoot: path.join(dir, "traces", "run"),
        executable: path.join(dir, "model"),
        executableSha256: HASH,
        worker: "claude",
        rootGo: "go-ahead-token-1",
        actor: "operator:chatagent",
        limits: { maxDurationS: 60, pollS: 5, maxPollS: 5, heartbeatS: 5, maxNodes: 1 }
      }
    ]
  };
}

function write(dir: string, value: unknown, name = "dispatch.json") {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
  return file;
}
const load = (file: string | undefined) =>
  loadDispatchHost(file === undefined ? {} : { [DISPATCH_CONFIG_ENV]: file });

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchStartupError);
    return error as DispatchStartupError;
  }
  throw new Error("expected a startup refusal");
}

describe("dispatch host startup configuration", () => {
  it("stays disabled when the variable is unset", async () => {
    expect(await load(undefined)).toBeUndefined();
  });

  it("builds the actual DispatchHost from a strict file with an approved trace root", async () => {
    const dir = workDir();
    const host = await load(write(dir, validConfig(dir)));
    expect(host).toBeInstanceOf(DispatchHost);
    expect(host!.has(ROOT)).toBe(true);
    expect(host!.has("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["relative", "dispatch.json"],
    ["a NUL", "/tmp/a\0b"],
    ["too long", path.join(path.parse(process.cwd()).root, "x".repeat(600))]
  ])("refuses %s path", async (_name, value) => {
    expect((await code(load(value))).code).toBe("INVALID_CONFIG_PATH");
  });

  it("refuses a missing file and directory without echoing the path", async () => {
    const dir = workDir();
    const missing = await code(load(path.join(dir, "secret-name.json")));
    expect(missing.code).toBe("CONFIG_UNREADABLE");
    expect(missing.message).not.toContain("secret-name");
    expect((await code(load(dir))).code).toBe("CONFIG_NOT_REGULAR");
  });

  it("refuses a file symlink when this platform permits creating it", async (context) => {
    const dir = workDir();
    const real = write(dir, validConfig(dir));
    const link = path.join(dir, "link.json");
    try {
      symlinkSync(real, link);
    } catch {
      context.skip();
    }
    expect((await code(load(link))).code).toBe("CONFIG_NOT_REGULAR");
  });

  it("refuses a path through a linked directory when links are available", async (context) => {
    const dir = workDir();
    mkdirSync(path.join(dir, "real"));
    write(path.join(dir, "real"), validConfig(dir));
    try {
      symlinkSync(path.join(dir, "real"), path.join(dir, "alias"), "junction");
    } catch {
      context.skip();
    }
    expect((await code(load(path.join(dir, "alias", "dispatch.json")))).code).toBe(
      "CONFIG_NOT_REGULAR"
    );
  });

  it("refuses duplicate keys even when the last value would validate", async () => {
    const dir = workDir();
    const text = JSON.stringify(validConfig(dir));
    const duplicate = text.replace('"traceRoot":', '"traceRoot":"first-root","traceRoot":');
    const file = path.join(dir, "duplicates.json");
    writeFileSync(file, duplicate);
    expect((await code(load(file))).code).toBe("CONFIG_NOT_JSON");
  });

  it("bounds the file at 128 KiB", async () => {
    const dir = workDir();
    expect(MAX_DISPATCH_CONFIG_BYTES).toBe(128 * 1024);
    const over = write(dir, " ".repeat(MAX_DISPATCH_CONFIG_BYTES + 1));
    expect((await code(load(over))).code).toBe("CONFIG_TOO_LARGE");
    // At the cap the size is accepted, so the refusal is about content, not size.
    const atCap = write(dir, " ".repeat(MAX_DISPATCH_CONFIG_BYTES), "cap.json");
    expect((await code(load(atCap))).code).toBe("CONFIG_NOT_JSON");
  });

  it.each([
    ["not JSON", "{ nope"],
    ["a BOM", "\ufeff{}"],
    ["trailing text", "{} x"],
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])]
  ])("refuses %s", async (_name, text) => {
    const dir = workDir();
    expect((await code(load(write(dir, text)))).code).toBe("CONFIG_NOT_JSON");
  });

  it.each([["null"], ["[]"], ['"text"'], ["7"]])("refuses the non-object %s", async (text) => {
    const dir = workDir();
    expect((await code(load(write(dir, text)))).code).toBe("CONFIG_INVALID");
  });

  it("requires an explicit trace root for this workflow even though the adapter does not", async () => {
    const dir = workDir();
    const config = validConfig(dir);
    delete config.traceRoot;
    expect((await code(load(write(dir, config)))).code).toBe("TRACE_ROOT_REQUIRED");
    // The adapter itself still accepts the legacy shape.
    expect(() => new DispatchHost(config)).not.toThrow();
    config.traceRoot = null;
    expect((await code(load(write(dir, config, "null.json")))).code).toBe("TRACE_ROOT_REQUIRED");
  });

  it("refuses unknown keys, flags and wrong containment through the adapter's own schema", async () => {
    const dir = workDir();
    const cases: [string, (c: Record<string, any>) => void, string][] = [
      ["a top-level flag", (c) => (c.exeArg = "fake.py"), "(config)"],
      ["an entry argv", (c) => (c.python.entryArgs = ["-c", "print(1)"]), "python"],
      ["a root flag", (c) => (c.roots[0].shell = true), "roots.0"],
      ["a bad trace root", (c) => (c.traceRoot = path.join(dir, "elsewhere")), "traceRoot"],
      ["a filesystem trace root", (c) => (c.traceRoot = path.parse(dir).root), "traceRoot"],
      ["a relative trace root", (c) => (c.traceRoot = "traces"), "traceRoot"]
    ];
    for (const [name, change, field] of cases) {
      const config = validConfig(dir);
      change(config);
      const error = await code(load(write(dir, config, "case.json")));
      expect(error.code, name).toBe("CONFIG_INVALID");
      expect(error.fields, name).toContain(field);
    }
  });

  it("does not leak values, paths or credentials in a startup error", async () => {
    const dir = workDir();
    const config = validConfig(dir);
    config.roots[0].rootGo = "-SECRET-VALUE";
    config.python.executable = path.join(dir, "PRIVATE-PATH", "python");
    config.extra = "TOKEN-VALUE";
    const error = await code(load(write(dir, config)));
    for (const text of [error.message, String(error.fields), error.stack ?? ""].filter(Boolean))
      expect(text).not.toMatch(/SECRET-VALUE|PRIVATE-PATH|TOKEN-VALUE/);
    expect(error.message).not.toContain(dir);
  });
});
