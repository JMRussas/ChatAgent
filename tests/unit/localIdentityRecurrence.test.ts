import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "ca-identity-recurrence-"));
  roots.push(base);
  const dir = join(base, "ChatAgent");
  const identity = await loadOrCreateIdentity(dir);
  return { dir, identity, path: join(dir, "identity.json") };
}

const errno = (code: string, syscall: string, path: string) =>
  Object.assign(
    new Error(`${code}: operation not permitted, ${syscall}`),
    {
      code,
      syscall,
      path
    },
    TIMEOUT
  );

// A rotation refused at the lock never owned it: it wrote nothing and must not remove
// the lock that may belong to another rotation.
describe("rotation lock unavailable with a native replacement errno", () => {
  it(
    "refuses with a typed error that keeps the native cause, changing nothing",
    async () => {
      const { dir, identity, path } = await fixture();
      const before = await readFile(path, "utf8");
      const native = errno("EPERM", "open", join(dir, "rotate.lock"));
      const failure = await rotateIdentity(dir, {
        platform: "win32",
        openLock: async () => {
          throw native;
        }
      }).catch((e) => e);
      expect(failure).toBeInstanceOf(LocalIdentityError);
      expect(failure.cause).toBe(native);
      expect(failure.cause).toMatchObject({ code: "EPERM", syscall: "open" });
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readdir(dir)).toEqual(["identity.json"]);
      expect(await loadOrCreateIdentity(dir)).toEqual(identity);
    },
    TIMEOUT
  );

  it(
    "does not remove a lock that belongs to another rotation",
    async () => {
      const { dir, path } = await fixture();
      const before = await readFile(path, "utf8");
      const lock = join(dir, "rotate.lock");
      await writeFile(lock, "");
      await expect(
        rotateIdentity(dir, {
          platform: "win32",
          openLock: async () => {
            throw errno("EPERM", "open", lock);
          }
        })
      ).rejects.toBeInstanceOf(LocalIdentityError);
      expect((await readdir(dir)).sort()).toEqual(["identity.json", "rotate.lock"]);
      expect(await readFile(path, "utf8")).toBe(before);
    },
    TIMEOUT
  );

  it.each([
    ["EPERM on another platform", "linux", "EPERM"],
    ["EACCES on Windows", "win32", "EACCES"],
    ["EIO on Windows", "win32", "EIO"]
  ] as const)(
    "passes %s through unchanged",
    async (_name, platform, code) => {
      const { dir, path } = await fixture();
      const before = await readFile(path, "utf8");
      const native = errno(code, "open", join(dir, "rotate.lock"));
      await expect(
        rotateIdentity(dir, {
          platform,
          openLock: async () => {
            throw native;
          }
        })
      ).rejects.toBe(native);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );

  it(
    "still rotates once the lock can be created",
    async () => {
      const { dir, identity } = await fixture();
      const rotated = await rotateIdentity(dir, { platform: "win32" });
      expect(rotated).toMatchObject({ principalId: identity.principalId, epoch: 1 });
      expect(await readdir(dir)).toEqual(["identity.json"]);
    },
    TIMEOUT
  );
});
