import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * A replacement whose outcome cannot be established from the files. Both the temp file
 * and the rotation lock are kept for inspection; the message names paths only.
 */
export class IdentityReplaceUncertain extends LocalIdentityError {
  constructor(temp: string, target: string) {
    super(
      `Replacing ${target} with ${temp} has an uncertain outcome; both files and any rotation lock were kept.`
    );
    this.name = "IdentityReplaceUncertain";
  }
}

/** The POSIX-semantics helper was killed but did not exit in time; it may still act. */
export class PosixReplaceStillRunning extends Error {
  constructor() {
    super("The replacement helper did not exit after it was stopped.");
    this.name = "PosixReplaceStillRunning";
  }
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

/** Fixed script: paths arrive only through CA_POSIX_SOURCE and CA_POSIX_TARGET. */
const POSIX_REPLACE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class CaPosixRename {",
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  "static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);",
  '[DllImport("kernel32.dll", SetLastError = true)]',
  "static extern bool SetFileInformationByHandle(IntPtr handle, int infoClass, IntPtr info, uint size);",
  '[DllImport("kernel32.dll", SetLastError = true)]',
  "static extern bool CloseHandle(IntPtr handle);",
  "public static int Run(string source, string target) {",
  "IntPtr handle = CreateFileW(source, 0x00010000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);",
  "if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();",
  "IntPtr info = IntPtr.Zero;",
  "try {",
  "int ptr = IntPtr.Size;",
  "int nameBytes = target.Length * 2;",
  "int nameOffset = 2 * ptr + 4;",
  "int size = nameOffset + nameBytes + 2;",
  "info = Marshal.AllocHGlobal(size);",
  "for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);",
  "Marshal.WriteInt32(info, 0, 3);",
  "Marshal.WriteInt32(info, 2 * ptr, nameBytes);",
  "Marshal.Copy(target.ToCharArray(), 0, IntPtr.Add(info, nameOffset), target.Length);",
  "if (!SetFileInformationByHandle(handle, 22, info, (uint)size)) return Marshal.GetLastWin32Error();",
  "return 0;",
  "} finally {",
  "if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);",
  "CloseHandle(handle);",
  "}",
  "}",
  "}",
  "'@",
  "$rc = [CaPosixRename]::Run($env:CA_POSIX_SOURCE, $env:CA_POSIX_TARGET)",
  "[Console]::Out.WriteLine('rc=' + $rc)",
  "} catch {",
  "[Console]::Out.WriteLine('rc=1')",
  "}"
].join("\n");

const POSIX_REPLACE_MAX_OUTPUT = 256;

/** @internal Process transport for windowsPosixReplace; replaced by tests. */
export interface PosixReplaceTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawn: (...args: any[]) => any;
  timeoutMs?: number;
  exitMs?: number;
}

/**
 * @internal Renames source over target with POSIX semantics (Windows only), which
 * succeeds even while another process holds target open with delete sharing. Settles
 * only after the helper process has closed. Resolves the Win32 code it printed (0 =
 * success); rejects when the process closed without a well-formed result. A helper that
 * is killed at the deadline but still has not closed exitMs later rejects with
 * PosixReplaceStillRunning, because it may yet act.
 */
export function windowsPosixReplace(
  source: string,
  target: string,
  { spawn: start = spawn, timeoutMs = 30_000, exitMs = 10_000 }: PosixReplaceTransport = {
    spawn
  }
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let done = false;
    let failed = false;
    let out = "";
    let deadline: NodeJS.Timeout | undefined;
    let exit: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(exit);
      settle();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let child: any;
    try {
      child = start(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          POSIX_REPLACE_SCRIPT
        ],
        {
          env: {
            ...process.env,
            CA_POSIX_SOURCE: resolve(source),
            CA_POSIX_TARGET: resolve(target)
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"]
        }
      );
    } catch (error) {
      reject(error);
      return;
    }
    child.on("error", (error: Error) => {
      if (child.pid === undefined) {
        finish(() => reject(error));
        return;
      }
      failed = true; // The close barrier still decides; the deadline keeps running.
    });
    child.stdout?.on("error", () => {
      failed = true;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (failed) return;
      const text = chunk.toString();
      // Checked before appending, so no more than the cap is ever kept.
      if (out.length + text.length > POSIX_REPLACE_MAX_OUTPUT) {
        failed = true;
        out = "";
        return;
      }
      out += text;
    });
    child.on("close", (code: number | null) => {
      finish(() => {
        const match = !failed && code === 0 ? /^rc=(\d+)\r?\n?$/.exec(out) : null;
        if (match) resolvePromise(Number(match[1]));
        else reject(new Error("The replacement helper closed without a valid result."));
      });
    });
    deadline = setTimeout(() => {
      // A helper stopped at the deadline has no valid result, even if it printed one and
      // then closes cleanly; the readback decides what happened.
      failed = true;
      try {
        child.kill();
      } catch {
        // The exit wait below still decides.
      }
      exit = setTimeout(() => finish(() => reject(new PosixReplaceStillRunning())), exitMs);
    }, timeoutMs);
  });
}

async function sha256OrNull(path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * One helper attempt, judged by reading both files back. Returns "replaced" or
 * "failed" (nothing changed); anything else is IdentityReplaceUncertain.
 */
async function attemptPosixReplace(
  temp: string,
  target: string,
  posixReplace: (source: string, target: string) => Promise<number>
): Promise<"replaced" | "failed"> {
  let tempBefore: string | null, targetBefore: string | null;
  try {
    tempBefore = await sha256OrNull(temp);
    targetBefore = await sha256OrNull(target);
  } catch {
    return "failed";
  }
  let acted = true;
  try {
    acted = (await posixReplace(temp, target)) === 0;
  } catch (error) {
    if ((error as Error)?.name === "PosixReplaceStillRunning")
      throw new IdentityReplaceUncertain(temp, target);
    acted = false;
  }
  let tempAfter: string | null, targetAfter: string | null;
  try {
    tempAfter = await sha256OrNull(temp);
    targetAfter = await sha256OrNull(target);
  } catch {
    throw new IdentityReplaceUncertain(temp, target);
  }
  if (tempBefore !== null && tempAfter === null && targetAfter === tempBefore) return "replaced";
  if (!acted && tempAfter === tempBefore && targetAfter === targetBefore) return "failed";
  throw new IdentityReplaceUncertain(temp, target);
}

/** @internal Test seam for replaceIdentityFile and rotateIdentity. */
export interface ReplaceOptions {
  /** Defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Defaults to a real timer. */
  wait?: (ms: number) => Promise<unknown>;
  /** Defaults to windowsPosixReplace; used only on win32 after a rename EPERM. */
  posixReplace?: (source: string, target: string) => Promise<number>;
}

/**
 * @internal Exported for tests; rotateIdentity is the caller.
 *
 * Renames temp over target. On Windows, EPERM from that rename may be transient:
 * it is what a rename onto a file another process holds open returns until the file
 * is released, although EPERM alone does not prove such a holder. On Windows the same
 * attempt then tries posixReplace (by default windowsPosixReplace), which replaces the
 * target even while another process holds it with delete sharing. The attempt is
 * judged by reading both files back, never by the helper's result alone: replaced
 * (temp gone, target holds temp's bytes) returns; unchanged after a failed helper
 * retries after each bounded wait with the same temp and target; anything else throws
 * IdentityReplaceUncertain, and rotateIdentity then keeps temp and the rotation lock.
 * A holder without delete sharing, an older Windows or a filesystem without POSIX
 * rename leaves the files unchanged, so the bounded retry applies as before. Any other
 * error, EPERM on any other platform, or the rename's EPERM after the last wait is
 * thrown unchanged. The target is never removed first, and temp is left for the caller
 * to clean up.
 */
export async function replaceIdentityFile(
  temp: string,
  target: string,
  {
    platform = process.platform,
    wait = sleep,
    posixReplace = (source, dest) => windowsPosixReplace(source, dest)
  }: ReplaceOptions = {}
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const held = platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM";
      if (!held) throw error;
      // Same attempt: a POSIX-semantics rename can succeed where the plain one cannot.
      if ((await attemptPosixReplace(temp, target, posixReplace)) === "replaced") return;
      if (attempt >= REPLACE_WAITS_MS.length) throw error;
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
  { wait, posixReplace }: Pick<ReplaceOptions, "wait" | "posixReplace"> = {}
): Promise<LocalIdentity> {
  await verifyPrivate(dir, "directory");
  const path = join(dir, FILE);
  // Rotations are serialized: two concurrent ones would read the same epoch. A lock
  // left by a crashed rotation is reported, never broken automatically.
  const lockPath = join(dir, "rotate.lock");
  let lock;
  let keepLock = false;
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
    let keepTemp = false;
    try {
      await replaceIdentityFile(temp, path, {
        ...(wait ? { wait } : {}),
        ...(posixReplace ? { posixReplace } : {})
      });
    } catch (error) {
      keepTemp = keepLock = error instanceof IdentityReplaceUncertain;
      throw error;
    } finally {
      if (!keepTemp) await rm(temp, { force: true });
    }
    await verifyPrivate(path, "file");
    return next;
  } finally {
    await lock.close();
    if (!keepLock) await rm(lockPath, { force: true });
  }
}
