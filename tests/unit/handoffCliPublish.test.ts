import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Failures partway through publishing the CLI's output, injected through a
// pass-through `node:fs` mock (no production test hook): what this attempt created
// is removed, the summary completion marker never appears, and a file another
// process created is never touched.
const fault = vi.hoisted(() => ({
  /** Write half of this file's content, then throw. */
  partialWrite: undefined as string | undefined,
  /** Throw while closing this file. */
  failClose: undefined as string | undefined,
  /** Let "another process" create this file first, so our exclusive create fails. */
  foreign: undefined as string | undefined,
  /** Replace this file with an identical copy (a new file) just before it is opened to read. */
  swap: undefined as string | undefined,
  /** Directory enumeration seen through opendirSync: entries read and handles closed. */
  dirReads: 0,
  dirsOpened: 0,
  dirsClosed: 0,
  fds: new Map<number, string>()
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const name = (fd: number) => basename(fault.fds.get(fd) ?? "");
  return {
    ...fs,
    openSync: ((path: string, flags?: string, ...rest: unknown[]) => {
      if (flags === "wx" && fault.foreign === basename(path)) fs.writeFileSync(path, "foreign");
      if (flags === "r" && fault.swap === basename(path)) {
        const bytes = fs.readFileSync(path);
        fs.unlinkSync(path);
        fs.writeFileSync(path, bytes);
      }
      const fd = (fs.openSync as (...a: unknown[]) => number)(path, flags, ...rest);
      fault.fds.set(fd, path);
      return fd;
    }) as typeof fs.openSync,
    writeFileSync: ((target: unknown, data: string, ...rest: unknown[]) => {
      if (typeof target === "number" && fault.partialWrite === name(target)) {
        fs.writeSync(target, data.slice(0, Math.floor(data.length / 2)));
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return (fs.writeFileSync as (...a: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync,
    opendirSync: ((path: string, ...rest: unknown[]) => {
      const handle = (fs.opendirSync as (...a: unknown[]) => import("node:fs").Dir)(path, ...rest);
      fault.dirsOpened++;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "readSync")
            return () => {
              const entry = target.readSync();
              if (entry) fault.dirReads++;
              return entry;
            };
          if (key === "closeSync")
            return () => {
              fault.dirsClosed++;
              target.closeSync();
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }) as typeof fs.opendirSync,
    closeSync: ((fd: number) => {
      const failing = fault.failClose !== undefined && fault.failClose === name(fd);
      fs.closeSync(fd);
      if (failing) throw Object.assign(new Error("io error"), { code: "EIO" });
    }) as typeof fs.closeSync
  };
});

const { runHandoffCompose } = await import("../../src/integrations/hekate/handoffConsumer/cli");
const { sha256Hex } = await import("../../src/integrations/hekate/handoffConsumer/exactJson");

const GOLDEN = resolve("tests/fixtures/hekate/e2e-consumer-v0");
const dirs: string[] = [];
afterEach(() => {
  fault.partialWrite = fault.failClose = fault.foreign = fault.swap = undefined;
  fault.dirReads = fault.dirsOpened = fault.dirsClosed = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function compose() {
  const dir = mkdtempSync(join(tmpdir(), "handoff-publish-"));
  dirs.push(dir);
  const out = join(dir, "out");
  let stderr = "";
  const code = runHandoffCompose(
    [
      "compose",
      "--delivery",
      join(GOLDEN, "delivery"),
      "--fresh",
      join(GOLDEN, "inputs/fresh.json"),
      "--policy",
      join(GOLDEN, "inputs/policy-allow.json"),
      "--request",
      join(GOLDEN, "inputs/request.json"),
      "--retrieval",
      join(GOLDEN, "recorded/retrieval.json"),
      "--out",
      out
    ],
    { stdout: () => {}, stderr: (t) => (stderr += t) }
  );
  return { code, stderr, out };
}

describe("a failure while publishing", () => {
  it("publishes all three files when nothing fails", () => {
    const r = compose();
    expect(r.code).toBe(0);
    expect(readdirSync(r.out).sort()).toEqual(["h1-text.txt", "summary.json", "view-part.txt"]);
  });

  it.each(["view-part.txt", "h1-text.txt", "summary.json"])(
    "removes everything it created, including a partial %s",
    (file) => {
      fault.partialWrite = file;
      const r = compose();
      expect(r).toMatchObject({ code: 1, stderr: "handoff: output_unwritable\n" });
      expect(existsSync(r.out)).toBe(false);
    }
  );

  it("removes its files when closing one fails", () => {
    fault.failClose = "summary.json";
    const r = compose();
    expect(r.stderr).toBe("handoff: output_unwritable\n");
    expect(existsSync(r.out)).toBe(false);
  });

  it("never removes a file another process created, and leaves no summary", () => {
    fault.foreign = "h1-text.txt";
    const r = compose();
    expect(r.stderr).toBe("handoff: output_unwritable\n");
    // Our view part is gone; the foreign file and therefore the directory remain.
    expect(readdirSync(r.out)).toEqual(["h1-text.txt"]);
    expect(readFileSync(join(r.out, "h1-text.txt"), "utf8")).toBe("foreign");
  });
});

/** A SYNTHETIC export from the golden bundle (no pilot ran), and a runner over it. */
function syntheticExport() {
  const dir = mkdtempSync(join(tmpdir(), "handoff-swap-"));
  dirs.push(dir);
  const exp = join(dir, "export");
  cpSync(join(GOLDEN, "delivery"), join(exp, "delivery"), { recursive: true });
  const expected = JSON.parse(readFileSync(join(GOLDEN, "expected/valid/expected.json"), "utf8"));
  const top: Record<string, Buffer> = {
    "fresh.json": readFileSync(join(GOLDEN, "inputs/fresh.json")),
    "policy.json": readFileSync(join(GOLDEN, "inputs/policy-allow.json")),
    "request.json": readFileSync(join(GOLDEN, "inputs/request.json")),
    "retrieval.json": readFileSync(join(GOLDEN, "recorded/retrieval.json")),
    "view-part.txt": readFileSync(join(GOLDEN, "expected/valid/view-part.txt")),
    "provenance.json": Buffer.from('{"exportVersion":"handoff-export.v0","synthetic":true}'),
    "expected.json": Buffer.from(
      JSON.stringify({
        version: "handoff-expectation.v0",
        h1Builder: "chatagent-h1",
        viewDigest: expected.viewDigest,
        viewPartSha256: sha256Hex(readFileSync(join(GOLDEN, "expected/valid/view-part.txt"))),
        reservationTokens: expected.reservationTokens,
        viewCost: expected.viewCost,
        h1SuppliedSha256: expected.h1SuppliedSha256,
        candidateDigest: JSON.parse(readFileSync(join(GOLDEN, "delivery/wrapper.json"), "utf8"))
          .candidateDigest
      })
    )
  };
  for (const [name, bytes] of Object.entries(top)) writeFileSync(join(exp, name), bytes);
  const all = {
    ...top,
    ...Object.fromEntries(
      readdirSync(join(exp, "delivery")).map((f) => [
        `delivery/${f}`,
        readFileSync(join(exp, "delivery", f))
      ])
    )
  };
  writeFileSync(
    join(exp, "INDEX.sha256"),
    Object.keys(all)
      .sort()
      .map((p) => `${sha256Hex(all[p as keyof typeof all])}  ${p}\n`)
      .join("")
  );
  const run = () => {
    let stderr = "";
    const code = runHandoffCompose(["compose", "--export", exp, "--out", join(dir, "out")], {
      stdout: () => {},
      stderr: (t) => (stderr += t)
    });
    return { code, stderr };
  };
  return { dir, exp, run };
}

describe("an export file replaced between listing and reading", () => {
  it("is refused even when the replacement has identical bytes", () => {
    const { dir, run } = syntheticExport();
    fault.swap = "policy.json";
    expect(run()).toEqual({ code: 1, stderr: "handoff: export_invalid\n" });
    expect(existsSync(join(dir, "out"))).toBe(false);
    // The same export, read without a replacement, composes.
    fault.swap = undefined;
    expect(run().code).toBe(0);
  });
});

describe("an export directory with unexpected entries", () => {
  it("stops enumerating at the first unknown entry and closes the handle", () => {
    const { exp, run } = syntheticExport();
    // Many unknown names that sort before every expected one.
    for (let i = 0; i < 500; i++) writeFileSync(join(exp, `000-extra-${i}`), "x");
    expect(run()).toEqual({ code: 1, stderr: "handoff: export_invalid\n" });
    // Refused at the first unknown entry, never loading the 509 listed.
    expect(fault.dirReads).toBeLessThan(10);
    expect(fault.dirsClosed).toBe(fault.dirsOpened);
    expect(fault.dirsOpened).toBe(1);
  });

  it("closes every handle it opened on a valid export", () => {
    const { run } = syntheticExport();
    expect(run().code).toBe(0);
    expect(fault.dirsOpened).toBe(2);
    expect(fault.dirsClosed).toBe(2);
    expect(fault.dirReads).toBe(15);
  });
});
