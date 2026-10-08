import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalIdentityError,
  loadOrCreateIdentity,
  rotateIdentity
} from "../../src/auth/localIdentity";

// Real Windows ACL helpers use the same finite bound as maintained identity integration tests.
const TIMEOUT = 120_000;
const HELPER_LIFETIME_S = 60;
const win = process.platform === "win32";

// Creates the lock, then marks it for deletion through its own handle with legacy
// (non-POSIX) semantics and keeps the handle open: the name stays in the directory as a
// delete-pending file until the handle closes. Paths arrive only through the environment.
// Finite: it exits when the release file appears or after HELPER_LIFETIME_S seconds.
const HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class CaPending {",
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  "public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);",
  '[DllImport("kernel32.dll", SetLastError = true)]',
  "public static extern bool SetFileInformationByHandle(IntPtr handle, int infoClass, ref int info, uint size);",
  '[DllImport("kernel32.dll", SetLastError = true)]',
  "public static extern bool CloseHandle(IntPtr handle);",
  "}",
  "'@",
  // DELETE | GENERIC_READ, share read/write/delete, CREATE_NEW.
  "$h = [CaPending]::CreateFileW($env:CA_HOLD_LOCK, 2147549184, 7, [IntPtr]::Zero, 1, 0, [IntPtr]::Zero)",
  "if ($h -eq [IntPtr](-1)) { exit 2 }",
  "$flag = 1",
  "if (-not [CaPending]::SetFileInformationByHandle($h, 4, [ref]$flag, 4)) { exit 3 }",
  "[IO.File]::WriteAllText($env:CA_HOLD_READY, 'ready')",
  `$end = [DateTime]::UtcNow.AddSeconds(${HELPER_LIFETIME_S})`,
  "while (-not (Test-Path -LiteralPath $env:CA_HOLD_RELEASE) -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 20 }",
  "[void][CaPending]::CloseHandle($h)"
].join("\n");

const roots: string[] = [];
const holders: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
afterEach(async () => {
  for (const { child, closed } of holders.splice(0)) {
    if (child.exitCode === null) child.kill();
    await boundedClose(closed);
  }
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function boundedClose(closed: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lock holder did not close within 10 seconds.")),
          10_000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "ca-identity-contention-"));
  roots.push(base);
  const dir = join(base, "ChatAgent");
  const identity = await loadOrCreateIdentity(dir);
  return { base, dir, identity, path: join(dir, "identity.json"), lock: join(dir, "rotate.lock") };
}

const until = async (done: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}.`);
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

/** Starts the hidden holder; resolves once the lock is delete-pending and held open. */
async function holdDeletePending(base: string, lock: string) {
  const ready = join(base, "hold.ready");
  const release = join(base, "hold.release");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HOLDER_SCRIPT],
    {
      env: {
        ...process.env,
        CA_HOLD_LOCK: lock,
        CA_HOLD_READY: ready,
        CA_HOLD_RELEASE: release
      },
      windowsHide: true,
      stdio: "ignore"
    }
  );
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  holders.push({ child, closed });
  await until(async () => (await exists(ready)) || child.exitCode !== null, "the lock holder");
  if (child.exitCode !== null) throw new Error(`Lock holder exited with ${child.exitCode}.`);
  return {
    // Releases the handle and waits until the helper has closed, so the name is gone.
    release: async () => {
      await writeFile(release, "");
      await boundedClose(closed);
    }
  };
}

// The precondition is part of the test: the fixture must really produce the Windows
// lock-open failure, or the recovery assertions would prove nothing.
async function expectPending(lock: string) {
  const failure = await open(lock, "wx").catch((e) => e);
  expect(failure).toMatchObject({ code: "EPERM" });
}

describe.skipIf(!win)("rotation lock held delete-pending by another handle (Windows)", () => {
  it(
    "recovers once the holder closes, rotating exactly once with the same principal",
    async () => {
      const { base, dir, identity, lock } = await fixture();
      const holder = await holdDeletePending(base, lock);
      await expectPending(lock);
      const waits: number[] = [];
      const rotated = await rotateIdentity(dir, {
        wait: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) await holder.release();
        }
      });
      expect(waits).toEqual([25, 50]);
      expect(rotated).toMatchObject({ principalId: identity.principalId, epoch: 1 });
      expect(rotated.sessionKey).not.toBe(identity.sessionKey);
      expect(await loadOrCreateIdentity(dir)).toEqual(rotated);
      expect((await readdir(dir)).sort()).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "refuses after the bounded waits while held, leaving identity and the pending lock alone",
    async () => {
      const { base, dir, identity, path, lock } = await fixture();
      const before = await readFile(path, "utf8");
      const holder = await holdDeletePending(base, lock);
      await expectPending(lock);
      const waits: number[] = [];
      const failure = await rotateIdentity(dir, {
        wait: async (ms) => {
          waits.push(ms);
        }
      }).catch((e) => e);
      expect(failure).toBeInstanceOf(LocalIdentityError);
      expect(failure.cause).toMatchObject({ code: "EPERM" });
      expect(waits).toEqual([25, 50, 100, 200, 400, 800]);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await exists(lock)).toBe(true); // still the holder's delete-pending name
      await holder.release();
      // Nothing was left behind by the refusal: the next rotation succeeds.
      expect(await rotateIdentity(dir)).toMatchObject({
        principalId: identity.principalId,
        epoch: 1
      });
    },
    TIMEOUT
  );

  it(
    "does not retry EEXIST and never removes a lock another rotation created meanwhile",
    async () => {
      const { base, dir, path, lock } = await fixture();
      const before = await readFile(path, "utf8");
      const holder = await holdDeletePending(base, lock);
      await expectPending(lock);
      const waits: number[] = [];
      const failure = await rotateIdentity(dir, {
        wait: async (ms) => {
          waits.push(ms);
          // The pending lock disappears and another rotation takes the name first.
          await holder.release();
          await writeFile(lock, "other-owner", { flag: "wx" });
        }
      }).catch((e) => e);
      expect(failure).toBeInstanceOf(LocalIdentityError);
      expect(failure.message).toContain("Another rotation holds");
      expect(waits).toEqual([25]);
      expect(await readFile(lock, "utf8")).toBe("other-owner");
      expect(await readFile(path, "utf8")).toBe(before);
      expect((await readdir(dir)).sort()).toEqual(["identity.json", "rotate.lock"]);
    },
    TIMEOUT
  );
});

describe("rotation lock EEXIST", () => {
  it(
    "is refused at once with no wait and the existing lock kept",
    async () => {
      const { dir, path, lock } = await fixture();
      const before = await readFile(path, "utf8");
      await writeFile(lock, "other-owner");
      const waits: number[] = [];
      await expect(
        rotateIdentity(dir, {
          platform: "win32",
          wait: async (ms) => {
            waits.push(ms);
          }
        })
      ).rejects.toBeInstanceOf(LocalIdentityError);
      expect(waits).toEqual([]);
      expect(await readFile(lock, "utf8")).toBe("other-owner");
      expect(await readFile(path, "utf8")).toBe(before);
    },
    TIMEOUT
  );
});
