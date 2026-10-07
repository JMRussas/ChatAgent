import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  fds: new Map<number, string>()
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const name = (fd: number) => basename(fault.fds.get(fd) ?? "");
  return {
    ...fs,
    openSync: ((path: string, flags?: string, ...rest: unknown[]) => {
      if (flags === "wx" && fault.foreign === basename(path)) fs.writeFileSync(path, "foreign");
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
    closeSync: ((fd: number) => {
      const failing = fault.failClose !== undefined && fault.failClose === name(fd);
      fs.closeSync(fd);
      if (failing) throw Object.assign(new Error("io error"), { code: "EIO" });
    }) as typeof fs.closeSync
  };
});

const { runHandoffCompose } = await import("../../src/integrations/hekate/handoffConsumer/cli");

const GOLDEN = resolve("tests/fixtures/hekate/e2e-consumer-v0");
const dirs: string[] = [];
afterEach(() => {
  fault.partialWrite = fault.failClose = fault.foreign = undefined;
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
