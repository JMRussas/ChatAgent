import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as roles from "../../src/app/roleCatalog";
import { RoleCatalog } from "../../src/app/roleCatalog";

// CA-ISSUE-012 acceptance oracle: role-file reload without a restart. Startup and
// reload read the configured file through one bounded descriptor (1 MiB) as strict
// UTF-8; a reload is synchronous from read to replace and leaves the previous
// catalog untouched on any failure.
const LIMIT = 1 << 20;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = (bytes: Buffer | string) => {
  const dir = mkdtempSync(join(tmpdir(), "role-reload-"));
  dirs.push(dir);
  const path = join(dir, "roles.json");
  writeFileSync(path, bytes);
  return path;
};
const catalog = (...ids: string[]) => ({
  version: "role-catalog-v1",
  roles: ids.map((id) => ({
    id,
    version: "1",
    bindingId: "fixed",
    instructions: `Role ${id}`,
    toolIds: []
  }))
});
/** Valid JSON padded with trailing whitespace to exactly `size` bytes. */
const padded = (value: unknown, size: number) => {
  const text = JSON.stringify(value);
  return Buffer.from(text + " ".repeat(size - Buffer.byteLength(text)));
};
/** A catalog whose instructions hold one byte that is not valid UTF-8. */
const invalidUtf8 = () => {
  const text = Buffer.from(JSON.stringify(catalog("a")).replace("Role a", "Role \u0001"));
  text[text.indexOf(1)] = 0xff;
  return text;
};
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const codeOf = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "no error";
};
const ids = (c: RoleCatalog) => c.list().map((r) => r.id);

describe("bounded strict startup load", () => {
  it("loads a valid catalog of exactly 1 MiB", async () => {
    const loaded = await roles.loadRoleCatalog(file(padded(catalog("a"), LIMIT)));
    expect(loaded && ids(loaded)).toEqual(["a"]);
  });

  it("refuses a catalog file larger than 1 MiB as ROLE_CATALOG_INVALID", async () => {
    const path = file(padded(catalog("a"), LIMIT + 1));
    expect(await codeOf(() => roles.loadRoleCatalog(path))).toBe("ROLE_CATALOG_INVALID");
  });

  it("refuses a catalog file that is not valid UTF-8 as ROLE_CATALOG_INVALID", async () => {
    const path = file(invalidUtf8());
    expect(await codeOf(() => roles.loadRoleCatalog(path))).toBe("ROLE_CATALOG_INVALID");
  });
});

describe("reloadRoleCatalog", () => {
  it("is exported", () => {
    expect(typeof (roles as Record<string, unknown>).reloadRoleCatalog).toBe("function");
  });

  type Reload = (
    catalog: RoleCatalog,
    path: string
  ) => { version: string; roleIds: string[]; sha256: string };
  const reload = (catalog: RoleCatalog, path: string) => {
    const fn = (roles as Record<string, unknown>).reloadRoleCatalog;
    // A named assertion, so a missing export fails here rather than as a TypeError.
    expect(typeof fn).toBe("function");
    return (fn as Reload)(catalog, path);
  };

  it("replaces the catalog synchronously and reports version, role ids and file hash", () => {
    const current = new RoleCatalog(catalog("a"));
    const bytes = Buffer.from(JSON.stringify(catalog("b", "c")));
    const result = reload(current, file(bytes));
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({
      version: "role-catalog-v1",
      roleIds: ["b", "c"],
      sha256: sha256(bytes)
    });
    expect(ids(current)).toEqual(["b", "c"]);
  });

  it.each<[string, () => string]>([
    ["a missing file", () => join(tmpdir(), "role-reload-missing", "roles.json")],
    ["malformed JSON", () => file("{")],
    ["a schema violation", () => file(JSON.stringify({ version: "role-catalog-v2", roles: [] }))],
    ["a file over 1 MiB", () => file(padded(catalog("b"), LIMIT + 1))],
    ["invalid UTF-8", () => file(invalidUtf8())]
  ])("refuses %s as ROLE_CATALOG_RELOAD_FAILED and keeps the previous catalog", (_l, path) => {
    expect(typeof (roles as Record<string, unknown>).reloadRoleCatalog).toBe("function");
    const current = new RoleCatalog(catalog("a"));
    const before = current.list();
    let code: string | undefined = "no error";
    try {
      reload(current, path());
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("ROLE_CATALOG_RELOAD_FAILED");
    expect(current.list()).toEqual(before);
  });
});
