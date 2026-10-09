import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import { FilePrivacyError, makePrivate, verifyPrivate } from "../../src/auth/filePrivacy";
import {
  IdentityReplaceUncertain,
  LocalIdentityError,
  loadOrCreateIdentity,
  replaceIdentityFile,
  rotateIdentity
} from "../../src/auth/localIdentity";

// Real files and real permissions: on Windows these call PowerShell for the ACL.
const TIMEOUT = 120_000;
const roots: string[] = [];
const holders: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Held files cannot be removed, so every holder is released first. Directories
  // are still removed if a release fails; that failure is then reported.
  const released = await Promise.allSettled(holders.splice(0).map((release) => release()));
  for (const root of roots.splice(0)) {
    if (process.platform !== "win32") await restoreOwnerAccess(root);
    await rm(root, { recursive: true, force: true });
  }
  for (const r of released) if (r.status === "rejected") throw r.reason;
});
/** A test may leave a directory without its owner execute bit; rm needs it back. */
async function restoreOwnerAccess(dir: string) {
  await chmod(dir, 0o700).catch(() => undefined);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await restoreOwnerAccess(path);
  }
}

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "chat-identity-"));
  roots.push(dir);
  return dir;
}

/** Grants read access to Everyone (S-1-1-0) on Windows, or group/other read on POSIX. */
function widen(path: string) {
  if (process.platform !== "win32") return chmod(path, 0o644);
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$i = Get-Item -LiteralPath $env:P -Force; $a = $i.GetAccessControl('Access'); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow')); $i.SetAccessControl($a)"
    ],
    { env: { ...process.env, P: path }, windowsHide: true }
  );
}

const HOLDER_READY_MS = 30_000;
const HOLDER_EXIT_MS = 10_000;

/** Whether p settles within ms; a rejection of p propagates. */
async function settlesWithin(p: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Windows only: another process opens path sharing read access only, so renaming
 * onto it fails with EPERM until the returned release closes it. Nothing is timed:
 * the file stays held until release is called. Release is registered before the
 * holder is ready, is idempotent, and kills the child if it does not exit when asked.
 */
async function hold(path: string) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f = [System.IO.File]::Open($env:CHATAGENT_IDENTITY_TEST_PATH, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); [void][Console]::In.ReadLine(); $f.Close()"
    ],
    {
      env: { ...process.env, CHATAGENT_IDENTITY_TEST_PATH: path },
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"]
    }
  );
  // A child that already exited makes ending its stdin fail with EPIPE; exit is
  // what release waits for, so that pipe error carries no information.
  child.stdin.on("error", () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let released: Promise<void> | undefined;
  const release = () =>
    (released ??= (async () => {
      child.stdin.end();
      if (await settlesWithin(exited, HOLDER_EXIT_MS)) return;
      child.kill();
      if (!(await settlesWithin(exited, HOLDER_EXIT_MS)))
        throw new Error(`holder process ${child.pid} did not exit`);
    })());
  holders.push(release);

  let out = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => reject(new Error("holder exited before holding the file")));
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("ready")) resolve();
    });
  });
  try {
    if (!(await settlesWithin(ready, HOLDER_READY_MS)))
      throw new Error(`holder did not report ready within ${HOLDER_READY_MS} ms`);
  } catch (error) {
    // The readiness failure is the error to report; a failed release is still
    // reported by afterEach, which awaits the same registered release.
    await release().catch(() => undefined);
    throw error;
  }
  return release;
}

const WAITS = [25, 50, 100, 200, 400, 800];
const onWindows = process.platform === "win32";

describe("identity file replacement", () => {
  async function pair() {
    const dir = await root();
    const temp = join(dir, "next.tmp"),
      target = join(dir, "identity.json");
    await writeFile(temp, "next");
    await writeFile(target, "current");
    return { temp, target };
  }

  it(
    "throws any other error at once, without waiting",
    async () => {
      const { temp, target } = await pair();
      const waits: number[] = [];
      await expect(
        replaceIdentityFile(temp + ".missing", target, { wait: async (ms) => waits.push(ms) })
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(waits).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("current");
    },
    TIMEOUT
  );

  it.runIf(onWindows)(
    "does not retry EPERM on any other platform",
    async () => {
      const { temp, target } = await pair();
      await hold(target);
      const waits: number[] = [];
      await expect(
        replaceIdentityFile(temp, target, {
          platform: "linux",
          wait: async (ms) => waits.push(ms)
        })
      ).rejects.toMatchObject({ code: "EPERM", syscall: "rename" });
      expect(waits).toEqual([]);
    },
    TIMEOUT
  );

  it.runIf(onWindows)(
    "replaces a held file once the holder releases it",
    async () => {
      const { temp, target } = await pair();
      const release = await hold(target);
      const waits: number[] = [];
      // Released only after a real rename against the held file has failed.
      await replaceIdentityFile(temp, target, {
        wait: async (ms) => {
          waits.push(ms);
          await release();
        }
      });
      expect(waits).toEqual([25]);
      expect(await readFile(target, "utf8")).toBe("next");
      expect(await readdir(join(target, ".."))).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it.runIf(onWindows)(
    "gives up after the last bounded wait with the real error, leaving both files",
    async () => {
      const { temp, target } = await pair();
      await hold(target);
      const waits: number[] = [];
      await expect(
        replaceIdentityFile(temp, target, { wait: async (ms) => waits.push(ms) })
      ).rejects.toMatchObject({ code: "EPERM", syscall: "rename", path: temp, dest: target });
      expect(waits).toEqual(WAITS);
      expect(await readFile(target, "utf8")).toBe("current");
      expect(await readFile(temp, "utf8")).toBe("next");
    },
    TIMEOUT
  );
});

describe.runIf(onWindows)("rotation while identity.json is held", () => {
  it(
    "keeps the lock and temp file while it waits, then completes once released",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const before = await loadOrCreateIdentity(dir);
      const release = await hold(join(dir, "identity.json"));
      const during: string[][] = [];
      const after = await rotateIdentity(dir, {
        wait: async () => {
          during.push(await readdir(dir));
          await release();
        }
      });
      expect(during).toHaveLength(1);
      expect(during[0]).toEqual(
        expect.arrayContaining(["identity.json", "rotate.lock", expect.stringMatching(/\.tmp$/)])
      );
      expect(during[0]).toHaveLength(3);
      expect(after).toMatchObject({ principalId: before.principalId, epoch: 1 });
      expect(await loadOrCreateIdentity(dir)).toEqual(after);
      await verifyPrivate(join(dir, "identity.json"), "file");
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "refuses with LocalIdentityError caused by the real error after the last wait, leaving the old identity and no lock or temp",
    async () => {
      const dir = join(await root(), "ChatAgent");
      await loadOrCreateIdentity(dir);
      const path = join(dir, "identity.json");
      const original = await readFile(path, "utf8");
      const release = await hold(path);
      const waits: number[] = [];
      const failure = await rotateIdentity(dir, {
        wait: async (ms) => {
          expect(await readdir(dir)).toContain("rotate.lock");
          waits.push(ms);
        }
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(LocalIdentityError);
      expect(failure).not.toBeInstanceOf(IdentityReplaceUncertain);
      expect((failure as Error).cause).toMatchObject({
        code: "EPERM",
        syscall: "rename",
        dest: path,
        path: expect.stringMatching(/\.tmp$/)
      });
      expect(waits).toEqual(WAITS);
      await release();
      expect(await readFile(path, "utf8")).toBe(original);
      await verifyPrivate(path, "file");
      expect(await readdir(dir)).toEqual(["identity.json"]);
      // The lock was released, so a later rotation proceeds from the old identity.
      expect((await rotateIdentity(dir)).epoch).toBe(1);
    },
    TIMEOUT
  );
});

describe("local identity rotation limits", () => {
  it(
    "serializes concurrent rotations and refuses to rotate past the largest epoch",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const start = await loadOrCreateIdentity(dir);
      const results = await Promise.allSettled([rotateIdentity(dir), rotateIdentity(dir)]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      // Either they ran one after another, or the second was refused; never both from epoch 0.
      const final = await loadOrCreateIdentity(dir);
      expect(final.epoch).toBe(ok.length);
      for (const r of refused)
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LocalIdentityError);
      expect(final.principalId).toBe(start.principalId);

      const path = join(dir, "identity.json");
      const atLimit = JSON.stringify({ ...final, epoch: Number.MAX_SAFE_INTEGER }, null, 2) + "\n";
      await writeFile(path, atLimit);
      await expect(rotateIdentity(dir)).rejects.toThrow(/cannot be rotated further/);
      expect(await readFile(path, "utf8")).toBe(atLimit);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );
});

describe("local identity on real files", () => {
  it(
    "creates a private directory and file once, then reloads the same identity",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const first = await loadOrCreateIdentity(dir);
      await verifyPrivate(dir, "directory");
      await verifyPrivate(join(dir, "identity.json"), "file");
      const again = await loadOrCreateIdentity(dir);
      expect(again).toEqual(first);
      expect(first.principalId).toMatch(/^local:/);
      expect(first.epoch).toBe(0);
    },
    TIMEOUT
  );

  it(
    "agrees on one identity when several first starts race",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const all = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateIdentity(dir)));
      expect(new Set(all.map((i) => JSON.stringify(i))).size).toBe(1);
      // No staging directories or temp files are left behind.
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "fails closed on an invalid existing file and leaves it unchanged",
    async () => {
      const dir = join(await root(), "ChatAgent");
      await loadOrCreateIdentity(dir);
      const path = join(dir, "identity.json");
      await writeFile(path, '{"version":1}');
      await expect(loadOrCreateIdentity(dir)).rejects.toBeInstanceOf(LocalIdentityError);
      expect(await readFile(path, "utf8")).toBe('{"version":1}');
    },
    TIMEOUT
  );

  it(
    "refuses a file or directory whose permissions were widened, without repairing it",
    async () => {
      const dir = join(await root(), "ChatAgent");
      await loadOrCreateIdentity(dir);
      const file = join(dir, "identity.json");
      await widen(file);
      await expect(loadOrCreateIdentity(dir)).rejects.toBeInstanceOf(FilePrivacyError);
      await expect(verifyPrivate(file, "file")).rejects.toBeInstanceOf(FilePrivacyError);

      const other = join(await root(), "ChatAgent");
      await loadOrCreateIdentity(other);
      await widen(other);
      await expect(loadOrCreateIdentity(other)).rejects.toThrow(/not private/);
    },
    TIMEOUT
  );

  it(
    "rejects a dedicated directory that is a link to somewhere else",
    async () => {
      const base = await root();
      const target = join(base, "real");
      await loadOrCreateIdentity(target);
      const linked = join(base, "ChatAgent");
      await symlink(target, linked, "junction");
      await expect(loadOrCreateIdentity(linked)).rejects.toThrow(/symbolic link or junction/);
      await expect(makePrivate(linked, "directory")).rejects.toBeInstanceOf(FilePrivacyError);
    },
    TIMEOUT
  );

  it(
    "rotates authenticators, keeps the principal, and the old ones stop working",
    async () => {
      const dir = join(await root(), "ChatAgent");
      const before = await loadOrCreateIdentity(dir);
      const auth = new LocalAuthenticator(before);
      const session = auth.issueSession();
      const after = await rotateIdentity(dir);
      expect(after.principalId).toBe(before.principalId);
      expect(after.epoch).toBe(1);
      expect(after.clientToken).not.toBe(before.clientToken);
      expect(await loadOrCreateIdentity(dir)).toEqual(after);
      await verifyPrivate(join(dir, "identity.json"), "file");
      // The running authenticator keeps the old identity until it is given the new one.
      expect(auth.resolve({ sessionToken: session })).toBeDefined();
      auth.useIdentity(after);
      expect(auth.resolve({ sessionToken: session })).toBeUndefined();
      expect(auth.resolve({ authorization: `Bearer ${before.operatorToken}` })).toBeUndefined();
      expect(auth.resolve({ authorization: `Bearer ${after.operatorToken}` })?.principalId).toBe(
        before.principalId
      );
    },
    TIMEOUT
  );
});
