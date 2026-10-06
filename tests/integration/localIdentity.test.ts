import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import { FilePrivacyError, makePrivate, verifyPrivate } from "../../src/auth/filePrivacy";
import {
  LocalIdentityError,
  loadOrCreateIdentity,
  rotateIdentity
} from "../../src/auth/localIdentity";

// Real files and real permissions: on Windows these call PowerShell for the ACL.
const TIMEOUT = 120_000;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
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
