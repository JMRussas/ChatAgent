import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import { verifyPrivate } from "../../src/auth/filePrivacy";
import {
  loadIdentity,
  loadOrCreateIdentity,
  replaceIdentityFile,
  rotateIdentity
} from "../../src/auth/localIdentity";

// CA-ISSUE-014. A reader or scanner holding identity.json open WITH delete sharing makes
// a plain rename onto it fail with EPERM on Windows, every time; a POSIX-semantics
// replacement succeeds. The holder's share mode makes these real-file cases
// deterministic. Every case captures its outcome and then asserts it, so a missing
// behaviour fails as an assertion, never as a thrown error.
const TIMEOUT = 120_000;
const WAITS = [25, 50, 100, 200, 400, 800];
const onWindows = process.platform === "win32";
const roots: string[] = [];
const releases: Array<() => Promise<string>> = [];
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).map((release) => release()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const r of released) if (r.status === "rejected") throw r.reason;
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "chat-posix-"));
  roots.push(dir);
  return dir;
}

/**
 * Another process opens path for reading with the given sharing until released. Release
 * resolves to what that open handle read at release time. A setup failure resolves to
 * undefined, so the caller asserts on it.
 */
async function hold(path: string, share: string): Promise<(() => Promise<string>) | undefined> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [System.IO.File]::Open($env:CA_HOLD_PATH, 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('ready'); [void][Console]::In.ReadLine(); $b = New-Object byte[] 4096; $n = $f.Read($b, 0, 4096); [Console]::Out.WriteLine('held:' + [Convert]::ToBase64String($b, 0, $n)); $f.Close()`
    ],
    {
      env: { ...process.env, CA_HOLD_PATH: path },
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    }
  );
  child.stdin.on("error", () => undefined);
  let out = "";
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    child.once("error", () => resolve(false));
    child.once("close", () => resolve(false));
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("ready")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  let released: Promise<string> | undefined;
  const release = () =>
    (released ??= (async () => {
      child.stdin.end();
      await closed;
      const line = out.split(/\r?\n/).find((l) => l.startsWith("held:"));
      return line ? Buffer.from(line.slice(5), "base64").toString("utf8") : "";
    })());
  releases.push(release);
  if (!ready) {
    child.kill();
    return undefined;
  }
  return release;
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { name?: string; code?: string }) =>
      e?.name === "IdentityReplaceUncertain" ? e.name : (e?.code ?? String(e))
  );

async function pair() {
  const dir = await root();
  const temp = join(dir, "next.tmp"),
    target = join(dir, "identity.json");
  await writeFile(temp, "next");
  await writeFile(target, "current");
  return { dir, temp, target };
}

describe.runIf(onWindows)("replacement while a delete-sharing reader holds the target", () => {
  it(
    "replaces at once; the holder keeps the old bytes and new opens see the new ones",
    async () => {
      const { dir, temp, target } = await pair();
      const release = await hold(target, "ReadWrite, Delete");
      expect(release).toBeDefined();
      const waits: number[] = [];
      const result = await outcome(
        replaceIdentityFile(temp, target, { wait: async (ms) => waits.push(ms) })
      );
      const seenByNewOpen = await readFile(target, "utf8");
      const seenByHolder = await release!();
      expect(result).toBe("ok");
      expect(waits).toEqual([]);
      expect(seenByNewOpen).toBe("next");
      expect(seenByHolder).toBe("current");
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "rotates: same principal, next epoch, private, old authenticators rejected",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const before = await loadOrCreateIdentity(dir);
      const auth = new LocalAuthenticator(before);
      const release = await hold(join(dir, "identity.json"), "ReadWrite, Delete");
      expect(release).toBeDefined();
      const waits: number[] = [];
      let after: Awaited<ReturnType<typeof rotateIdentity>> | undefined;
      const result = await outcome(
        rotateIdentity(dir, { wait: async (ms) => waits.push(ms) }).then((r) => (after = r))
      );
      expect(result).toBe("ok");
      expect(waits).toEqual([]);
      expect(after).toMatchObject({ principalId: before.principalId, epoch: 1 });
      expect(after!.clientToken).not.toBe(before.clientToken);
      expect(await loadIdentity(dir)).toEqual(after);
      expect(await loadOrCreateIdentity(dir)).toEqual(after);
      await verifyPrivate(join(dir, "identity.json"), "file");
      expect(await readdir(dir)).toEqual(["identity.json"]);
      auth.useIdentity(after!);
      expect(auth.resolve({ authorization: `Bearer ${before.operatorToken}` })).toBeUndefined();
      expect(auth.resolve({ authorization: `Bearer ${after!.operatorToken}` })?.principalId).toBe(
        before.principalId
      );
    },
    TIMEOUT
  );

  it(
    "never lets a concurrent loader see no identity or a new principal",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const before = await loadOrCreateIdentity(dir);
      const release = await hold(join(dir, "identity.json"), "ReadWrite, Delete");
      expect(release).toBeDefined();
      let rotating = true;
      const seen: string[] = [];
      const loader = (async () => {
        while (rotating) {
          const loaded = await loadOrCreateIdentity(dir).then(
            (i) => `${i.principalId}#${i.epoch}`,
            (e: { code?: string }) => `error:${e?.code ?? String(e)}`
          );
          seen.push(loaded);
        }
      })();
      const result = await outcome(rotateIdentity(dir, { wait: async () => undefined }));
      rotating = false;
      await loader;
      expect(result).toBe("ok");
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen)
        expect([`${before.principalId}#0`, `${before.principalId}#1`]).toContain(s);
      expect((await loadIdentity(dir)).epoch).toBe(1);
    },
    TIMEOUT
  );
});

// The helper seam decides ambiguous helper outcomes deterministically: the result is read
// back from both files only after the helper has exited. A plain-reader holder (no delete
// sharing) keeps the ordinary rename failing throughout, so only the seam can act.
describe.runIf(onWindows)("replacement helper outcomes", () => {
  it(
    "counts a helper that applied the replacement but then failed as success",
    async () => {
      const { dir, temp, target } = await pair();
      const release = await hold(target, "Read");
      expect(release).toBeDefined();
      const waits: number[] = [];
      let calls = 0;
      const result = await outcome(
        replaceIdentityFile(temp, target, {
          wait: async (ms) => waits.push(ms),
          posixReplace: async (source, dest) => {
            calls++;
            await release!();
            await rename(source, dest);
            throw new Error("killed after replacing");
          }
        })
      );
      expect(result).toBe("ok");
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("next");
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "retries a helper failure that left both files as they were, ending with the rename's EPERM",
    async () => {
      const { temp, target } = await pair();
      expect(await hold(target, "Read")).toBeDefined();
      const waits: number[] = [];
      let calls = 0;
      const result = await replaceIdentityFile(temp, target, {
        wait: async (ms) => waits.push(ms),
        posixReplace: async () => {
          calls++;
          throw new Error("timed out before acting");
        }
      }).then(
        () => ({}),
        (e: { code?: string; syscall?: string; dest?: string }) => ({
          code: e?.code,
          syscall: e?.syscall,
          dest: e?.dest
        })
      );
      expect(result).toEqual({ code: "EPERM", syscall: "rename", dest: target });
      expect(calls).toBe(WAITS.length + 1);
      expect(waits).toEqual(WAITS);
      expect(await readFile(target, "utf8")).toBe("current");
      expect(await readFile(temp, "utf8")).toBe("next");
    },
    TIMEOUT
  );

  it(
    "reports a success claim that cannot be read back as uncertain, keeping both files",
    async () => {
      const { temp, target } = await pair();
      expect(await hold(target, "Read")).toBeDefined();
      const waits: number[] = [];
      const result = await outcome(
        replaceIdentityFile(temp, target, {
          wait: async (ms) => waits.push(ms),
          posixReplace: async () => 0
        })
      );
      expect(result).toBe("IdentityReplaceUncertain");
      expect(waits).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("current");
      expect(await readFile(temp, "utf8")).toBe("next");
    },
    TIMEOUT
  );

  it(
    "keeps the rotation lock and temp file when the outcome is uncertain",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const before = await loadOrCreateIdentity(dir);
      const original = await readFile(join(dir, "identity.json"), "utf8");
      expect(await hold(join(dir, "identity.json"), "Read")).toBeDefined();
      const result = await outcome(
        rotateIdentity(dir, { wait: async () => undefined, posixReplace: async () => 0 })
      );
      expect(result).toBe("IdentityReplaceUncertain");
      const files = await readdir(dir);
      expect(files).toEqual(
        expect.arrayContaining(["identity.json", "rotate.lock", expect.stringMatching(/\.tmp$/)])
      );
      expect(files).toHaveLength(3);
      expect(await readFile(join(dir, "identity.json"), "utf8")).toBe(original);
      expect((await loadIdentity(dir)).principalId).toBe(before.principalId);
    },
    TIMEOUT
  );
});

describe.runIf(onWindows)("replacement when the helper cannot be judged", () => {
  it(
    "reports a helper that may still be running as uncertain, keeping both files",
    async () => {
      const { temp, target } = await pair();
      expect(await hold(target, "Read")).toBeDefined();
      const waits: number[] = [];
      const result = await outcome(
        replaceIdentityFile(temp, target, {
          wait: async (ms) => waits.push(ms),
          posixReplace: async () => {
            const error = new Error("did not exit");
            error.name = "PosixReplaceStillRunning";
            throw error;
          }
        })
      );
      expect(result).toBe("IdentityReplaceUncertain");
      expect(waits).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("current");
      expect(await readFile(temp, "utf8")).toBe("next");
    },
    TIMEOUT
  );

  it(
    "never runs the helper while the target cannot be read, and retries as before",
    async () => {
      const { temp, target } = await pair();
      expect(await hold(target, "None")).toBeDefined();
      const waits: number[] = [];
      let calls = 0;
      const result = await outcome(
        replaceIdentityFile(temp, target, {
          wait: async (ms) => waits.push(ms),
          posixReplace: async () => {
            calls++;
            return 0;
          }
        })
      );
      expect(result).toBe("EPERM");
      expect(calls).toBe(0);
      expect(waits).toEqual(WAITS);
      expect(await readFile(temp, "utf8")).toBe("next");
    },
    TIMEOUT
  );
});

describe.runIf(onWindows)("replacement on another platform", () => {
  it(
    "never runs the helper and does not retry, even for a held target",
    async () => {
      const { temp, target } = await pair();
      expect(await hold(target, "ReadWrite, Delete")).toBeDefined();
      let calls = 0;
      const waits: number[] = [];
      const result = await outcome(
        replaceIdentityFile(temp, target, {
          platform: "linux",
          wait: async (ms) => waits.push(ms),
          posixReplace: async () => {
            calls++;
            return 0;
          }
        })
      );
      expect(result).toBe("EPERM");
      expect(calls).toBe(0);
      expect(waits).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("current");
    },
    TIMEOUT
  );
});

// The helper's process lifetime, through its transport seam: a fake child process.
describe("replacement helper process", () => {
  type Fake = EventEmitter & {
    pid?: number;
    stdout: EventEmitter;
    kills: number;
    kill: () => boolean;
  };
  function fakeSpawn(pid: number | undefined, script: (child: Fake) => void) {
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: new EventEmitter(),
      kills: 0,
      kill() {
        child.kills++;
        return true;
      }
    }) as Fake;
    const start = () => {
      queueMicrotask(() => script(child));
      return child;
    };
    return { child, start };
  }
  async function helper() {
    const mod: Record<string, unknown> = await import("../../src/auth/localIdentity");
    const fn = mod.windowsPosixReplace;
    expect(typeof fn).toBe("function");
    return fn as (
      source: string,
      target: string,
      transport: { spawn: unknown; timeoutMs: number; exitMs: number }
    ) => Promise<number>;
  }
  const settled = (p: Promise<number>) =>
    p.then(
      (rc) => `rc:${rc}`,
      (e: { name?: string; code?: string }) => `${e?.name ?? "?"}:${e?.code ?? ""}`
    );

  it("returns the helper's code only after the process closes", async () => {
    const run = await helper();
    const { start } = fakeSpawn(4242, (c) => {
      c.stdout.emit("data", Buffer.from("rc=0\r\n"));
      c.emit("close", 0);
    });
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 1000, exitMs: 1000 }))).toBe(
      "rc:0"
    );
  });

  it("keeps the deadline after a post-spawn error and reports a helper that never closes as still running", async () => {
    const run = await helper();
    const { child, start } = fakeSpawn(4242, (c) => c.emit("error", new Error("pipe broke")));
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 50, exitMs: 50 }))).toBe(
      "PosixReplaceStillRunning:"
    );
    expect(child.kills).toBe(1);
  });

  it("treats a post-spawn error followed by close as an exit without a result", async () => {
    const run = await helper();
    const { start } = fakeSpawn(4242, (c) => {
      c.stdout.emit("data", Buffer.from("rc=0\r\n"));
      c.emit("error", new Error("pipe broke"));
      c.emit("close", 0);
    });
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 1000, exitMs: 1000 }))).toBe(
      "Error:"
    );
  });

  it("rejects at once when no process was started", async () => {
    const run = await helper();
    const { child, start } = fakeSpawn(undefined, (c) =>
      c.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }))
    );
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 5000, exitMs: 5000 }))).toBe(
      "Error:ENOENT"
    );
    expect(child.kills).toBe(0);
  });

  it("treats an output stream error as an exit without a result, not a crash", async () => {
    const run = await helper();
    const { start } = fakeSpawn(4242, (c) => {
      c.stdout.emit("data", Buffer.from("rc=0\r\n"));
      c.stdout.emit("error", new Error("read failed"));
      c.emit("close", 0);
    });
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 1000, exitMs: 1000 }))).toBe(
      "Error:"
    );
  });

  it.each([
    ["malformed", ["rc=zero\r\n"], 0],
    ["oversized", ["x".repeat(300), "rc=0\r\n"], 0],
    ["a nonzero exit", ["rc=0\r\n"], 1]
  ])("rejects %s helper output after close", async (_, chunks, exitCode) => {
    const run = await helper();
    const { start } = fakeSpawn(4242, (c) => {
      for (const chunk of chunks as string[]) c.stdout.emit("data", Buffer.from(chunk));
      c.emit("close", exitCode);
    });
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 1000, exitMs: 1000 }))).toBe(
      "Error:"
    );
  });

  it("treats a helper killed at the deadline that then closes as an exit without a result", async () => {
    const run = await helper();
    const { child, start } = fakeSpawn(4242, (c) => {
      c.kill = () => {
        c.kills++;
        setTimeout(() => c.emit("close", null), 10);
        return true;
      };
    });
    expect(await settled(run("a", "b", { spawn: start, timeoutMs: 50, exitMs: 1000 }))).toBe(
      "Error:"
    );
    expect(child.kills).toBe(1);
  });
});
