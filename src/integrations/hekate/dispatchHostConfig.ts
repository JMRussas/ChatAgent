import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseStrictJson } from "./devCoordination";
import { DispatchHost, DispatchHostConfigError, type DispatchHostOptions } from "./dispatchHost";

/** The trusted startup variable; a request or browser can never supply it. */
export const DISPATCH_CONFIG_ENV = "HEKATE_DISPATCH_CONFIG_PATH";
export const MAX_DISPATCH_CONFIG_BYTES = 128 * 1024;
const MAX_PATH_CHARS = 500;

export type DispatchStartupCode =
  | "INVALID_CONFIG_PATH"
  | "CONFIG_UNREADABLE"
  | "CONFIG_NOT_REGULAR"
  | "CONFIG_TOO_LARGE"
  | "CONFIG_NOT_JSON"
  | "TRACE_ROOT_REQUIRED"
  | "CONFIG_INVALID";

/**
 * A startup refusal that names a fixed code (and, for schema errors, the field paths the
 * host already reports). It never carries the configured path, a value or a credential.
 */
export class DispatchStartupError extends Error {
  readonly fields: string[];
  constructor(
    readonly code: DispatchStartupCode,
    fields: string[] = []
  ) {
    const bounded = fields.slice(0, 32).map((field) => field.slice(0, 200));
    super(`DISPATCH_HOST_STARTUP: ${code}${bounded.length > 0 ? ` (${bounded.join(", ")})` : ""}`);
    this.fields = bounded;
    this.name = "DispatchStartupError";
  }
}

const norm = (p: string) =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);

/** Rejects observed links and reads one matching regular descriptor within the byte cap. */
async function readConfigFile(file: string): Promise<string> {
  let linked;
  try {
    linked = await lstat(file, { bigint: true });
    if (linked.isSymbolicLink() || !linked.isFile())
      throw new DispatchStartupError("CONFIG_NOT_REGULAR");
    // A link in a parent directory would make the file something other than the named path.
    if (norm(await realpath(file)) !== norm(file))
      throw new DispatchStartupError("CONFIG_NOT_REGULAR");
  } catch (error) {
    throw error instanceof DispatchStartupError
      ? error
      : new DispatchStartupError("CONFIG_UNREADABLE");
  }
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== linked.dev || info.ino !== linked.ino)
      throw new DispatchStartupError("CONFIG_NOT_REGULAR");
    if (info.size > BigInt(MAX_DISPATCH_CONFIG_BYTES))
      throw new DispatchStartupError("CONFIG_TOO_LARGE");
    const buffer = Buffer.alloc(MAX_DISPATCH_CONFIG_BYTES + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    // A file that grew past the cap after the size check is refused as well.
    if (read > MAX_DISPATCH_CONFIG_BYTES) throw new DispatchStartupError("CONFIG_TOO_LARGE");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, read)
    );
  } catch (error) {
    if (error instanceof DispatchStartupError) throw error;
    // A decoding failure is not valid JSON either; other failures are I/O.
    throw new DispatchStartupError(
      error instanceof TypeError ? "CONFIG_NOT_JSON" : "CONFIG_UNREADABLE"
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Builds the trusted dispatch host from `HEKATE_DISPATCH_CONFIG_PATH`. Unset keeps the
 * feature disabled. The file is consumed by the actual `DispatchHost` constructor, so the
 * closed schema, containment rules and every pin stay owned by the adapter. The
 * conversation workflow also requires the explicit operator-approved `traceRoot`, which the
 * adapter alone forwards to native children.
 */
export async function loadDispatchHost(
  env: NodeJS.ProcessEnv = process.env,
  options: DispatchHostOptions = {}
): Promise<DispatchHost | undefined> {
  const file = env[DISPATCH_CONFIG_ENV];
  if (file === undefined) return undefined;
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.length > MAX_PATH_CHARS ||
    file.includes("\0") ||
    !path.isAbsolute(file)
  )
    throw new DispatchStartupError("INVALID_CONFIG_PATH");
  const text = await readConfigFile(file);
  let config: unknown;
  try {
    config = parseStrictJson(text);
  } catch {
    throw new DispatchStartupError("CONFIG_NOT_JSON");
  }
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new DispatchStartupError("CONFIG_INVALID");
  if (typeof (config as { traceRoot?: unknown }).traceRoot !== "string")
    throw new DispatchStartupError("TRACE_ROOT_REQUIRED");
  try {
    return new DispatchHost(config, options);
  } catch (error) {
    throw new DispatchStartupError(
      "CONFIG_INVALID",
      error instanceof DispatchHostConfigError ? error.fields : []
    );
  }
}
