import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { makePrivate, verifyPrivate } from "./filePrivacy";

// Canonical only: 43 characters can also spell non-canonical encodings of 32 bytes.
const secret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((s) => Buffer.from(s, "base64url").toString("base64url") === s, "32 bytes, base64url");

export const localIdentitySchema = z
  .object({
    version: z.literal(1),
    principalId: z
      .string()
      .regex(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    sessionKey: secret,
    clientToken: secret,
    operatorToken: secret,
    epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

/**
 * The installation's one principal and the authenticators that prove it. The
 * principal id never changes; rotation replaces the authenticators and bumps epoch.
 */
export type LocalIdentity = z.infer<typeof localIdentitySchema>;

export class LocalIdentityError extends Error {
  readonly code = "LOCAL_IDENTITY_INVALID";
}

const FILE = "identity.json";
const newSecret = () => randomBytes(32).toString("base64url");
const authenticators = () => ({
  sessionKey: newSecret(),
  clientToken: newSecret(),
  operatorToken: newSecret()
});

/** Default dedicated directory, outside the repository and in the user's own profile. */
export function defaultIdentityDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.CHAT_IDENTITY_DIR?.trim()) return env.CHAT_IDENTITY_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "ChatAgent");
  return join(env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "chatagent");
}

async function parse(path: string): Promise<LocalIdentity> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new LocalIdentityError(`${path} is not valid JSON; it was left unchanged.`);
  }
  const parsed = localIdentitySchema.safeParse(raw);
  if (!parsed.success)
    throw new LocalIdentityError(
      `${path} does not match the identity format; it was left unchanged.`
    );
  return parsed.data;
}

/**
 * A directory this call creates is made private before anything is written to it.
 * An existing one must already be private: widened permissions may have exposed
 * its contents, so they fail closed instead of being silently repaired.
 */
async function ensurePrivateDir(dir: string) {
  try {
    return await verifyPrivate(dir, "directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Built and protected under a temporary name, then renamed into place, so the
  // directory never exists at its real path without its private permissions.
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.${basename(dir)}-${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await makePrivate(staging, "directory");
    await rename(staging, dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "")) throw error;
    // Another initializer won the rename; its directory must already be private.
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await verifyPrivate(dir, "directory");
}

/** Writes a private temp file in the already-private directory; returns its path. */
async function writePrivateTemp(dir: string, identity: LocalIdentity) {
  const temp = join(dir, `.identity-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx");
  try {
    await handle.close();
    // Private before any secret is written to it.
    await makePrivate(temp, "file");
    const writer = await open(temp, "r+");
    try {
      await writer.writeFile(JSON.stringify(identity, null, 2) + "\n", "utf8");
      await writer.sync();
    } finally {
      await writer.close();
    }
    return temp;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Waits between replacement attempts: six waits totalling 1575 ms, so seven attempts.
 * This bounds the waiting, not the elapsed time; the renames themselves may take longer.
 */
const REPLACE_WAITS_MS = [25, 50, 100, 200, 400, 800];

/** @internal Test seam for replaceIdentityFile and rotateIdentity. */
export interface ReplaceOptions {
  /** Defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Defaults to a real timer. */
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * @internal Exported for tests; rotateIdentity is the caller.
 *
 * Renames temp over target. On Windows, EPERM from that rename may be transient:
 * it is what a rename onto a file another process holds open returns until the file
 * is released, although EPERM alone does not prove such a holder. So that one error
 * is retried after each bounded wait with the same temp and target. Any other error,
 * EPERM on any other platform, or EPERM after the last wait is thrown unchanged. The
 * target is never removed first, and temp is left for the caller to clean up.
 */
export async function replaceIdentityFile(
  temp: string,
  target: string,
  { platform = process.platform, wait = sleep }: ReplaceOptions = {}
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const held = platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM";
      if (!held || attempt >= REPLACE_WAITS_MS.length) throw error;
      await wait(REPLACE_WAITS_MS[attempt]);
    }
  }
}

/**
 * Loads the installation identity, creating it once if absent. The directory is made
 * private before any secret exists. An existing file is verified and never
 * regenerated, even if invalid. Concurrent first starts agree on one identity:
 * publication uses a hard link, which fails if another process published first.
 */
export async function loadOrCreateIdentity(dir = defaultIdentityDir()): Promise<LocalIdentity> {
  await ensurePrivateDir(dir);
  const path = join(dir, FILE);
  try {
    await verifyPrivate(path, "file");
    return await parse(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = await writePrivateTemp(dir, {
    version: 1,
    principalId: `local:${randomUUID()}`,
    ...authenticators(),
    epoch: 0
  });
  try {
    await link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another initializer published first; theirs is the identity.
  } finally {
    await rm(temp, { force: true });
  }
  await verifyPrivate(path, "file");
  return parse(path);
}

/**
 * Loads an existing identity without ever creating one, for clients of a running
 * server: a client pointed at the wrong directory must fail, not mint unrelated
 * credentials. The error names the directory, never a secret.
 */
export async function loadIdentity(dir = defaultIdentityDir()): Promise<LocalIdentity> {
  const path = join(dir, FILE);
  try {
    await verifyPrivate(dir, "directory");
    await verifyPrivate(path, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new LocalIdentityError(
        `No ChatAgent identity in ${dir}. Start the server once to create it, or set CHAT_IDENTITY_DIR to the server's identity directory.`
      );
    throw error;
  }
  return parse(path);
}

/**
 * Replaces the authenticators and increments epoch, keeping the principal id so
 * ownership is unaffected. A running server keeps its loaded identity until it is
 * given the new one (LocalAuthenticator.useIdentity) or restarted. The file is
 * replaced through replaceIdentityFile while the rotation lock is held; `wait` is
 * passed to it, for tests.
 */
export async function rotateIdentity(
  dir = defaultIdentityDir(),
  { wait }: Pick<ReplaceOptions, "wait"> = {}
): Promise<LocalIdentity> {
  await verifyPrivate(dir, "directory");
  const path = join(dir, FILE);
  // Rotations are serialized: two concurrent ones would read the same epoch. A lock
  // left by a crashed rotation is reported, never broken automatically.
  const lockPath = join(dir, "rotate.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new LocalIdentityError(
        `Another rotation holds ${lockPath}. If no rotation is running, remove that file and retry.`
      );
    throw error;
  }
  try {
    await verifyPrivate(path, "file");
    const current = await parse(path);
    if (current.epoch >= Number.MAX_SAFE_INTEGER)
      throw new LocalIdentityError(`${path} cannot be rotated further; it was left unchanged.`);
    const next: LocalIdentity = { ...current, ...authenticators(), epoch: current.epoch + 1 };
    const temp = await writePrivateTemp(dir, next);
    try {
      await replaceIdentityFile(temp, path, wait ? { wait } : {});
    } finally {
      await rm(temp, { force: true });
    }
    await verifyPrivate(path, "file");
    return next;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
