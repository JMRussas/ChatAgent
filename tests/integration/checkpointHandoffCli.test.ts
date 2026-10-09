import {
  link as realLink,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runHandoffCli,
  handoffPath,
  type HandoffDeps,
  type PublishIo
} from "../../scripts/handoffCheckpoint";
import type { AttentionItem } from "../../src/integrations/hekate/checkpointAttention";
import type { ExecutiveOverview } from "../../src/integrations/hekate/executiveOverview";
import { ROOT_A, leaf, overviewOf, rootView } from "../helpers/executiveFixtures";
import { STAMP } from "../helpers/checkpointFixtures";
import { attentionOf, item } from "../helpers/handoffFixtures";

const ID = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tmp = async () => {
  // The CLI requires the canonical directory, so the base must not be a short name or a link.
  const dir = await mkdtemp(join(await realpath(tmpdir()), "ckpt-handoff-"));
  dirs.push(dir);
  return dir;
};

const overview = (
  items: AttentionItem[],
  status: "ok" | "unavailable" = "ok"
): ExecutiveOverview => {
  const view = rootView(ROOT_A, "Delivery", [leaf(1, "in_progress")]);
  const root =
    status === "ok"
      ? view
      : { ...view, status: "unavailable" as const, reason: "TIMEOUT" as const };
  return {
    ...overviewOf(root),
    schema: "executive-overview/v3",
    attention: attentionOf(...items)
  };
};

/** Collections come from the queue in order; the count proves how many reads happened. */
function deps(reads: ExecutiveOverview[], extra: HandoffDeps = {}) {
  let count = 0;
  const handoff: HandoffDeps = {
    collect: async () => reads[Math.min(count++, reads.length - 1)],
    now: () => new Date(STAMP),
    newId: () => ID,
    ...extra
  };
  return { handoff, collections: () => count };
}
const ls = async (dir: string) => (await readdir(dir)).sort();

describe("handoffCheckpoint CLI", () => {
  it("writes one file after exactly two agreeing collections and --show parses it", async () => {
    const out = await tmp();
    const first = overview([item()]);
    const { handoff, collections } = deps([
      first,
      overview([item({ recordUpdatedAt: "2026-10-09T10:00:05.000Z" })])
    ]);
    const result = await runHandoffCli(["--out-dir", out], {}, handoff);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("handoff written locally; not sent");
    expect(collections()).toBe(2);
    expect(await ls(out)).toEqual([`${ID}.handoff.json`]);
    const saved = JSON.parse(await readFile(handoffPath(out, ID), "utf8"));
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].recordUpdatedAt).toBe(STAMP);
    expect(saved).toMatchObject({
      delivery: "not_sent",
      notification: "none",
      wake: "none",
      acknowledgment: "none"
    });
    const shown = await runHandoffCli(["--show", handoffPath(out, ID)], {});
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout.join("\n")).toContain("delivery not_sent");
  });

  it("writes nothing and exits 0 after one read when there are no items, and says what was not covered", async () => {
    const out = await tmp();
    const { handoff, collections } = deps([overview([], "unavailable")]);
    const result = await runHandoffCli(["--out-dir", out], {}, handoff);
    expect(result.exitCode).toBe(0);
    expect(collections()).toBe(1);
    expect(await ls(out)).toEqual([]);
    const text = result.stdout.join("\n");
    expect(text).toContain("not a health statement");
    expect(text).toContain("unavailable (TIMEOUT); not covered");
  });

  it("refuses without a file when the second read differs in a pinned field", async () => {
    for (const second of [
      overview([item({ fence: { attemptId: "at-1", attemptEpoch: 3, contentRevision: 3 } })]),
      overview([item({ runId: "44444444-4444-4444-8444-444444444444" })]),
      overview([item({ stop: { kind: "tripwire", code: "hard_units" } })]),
      overview([
        item(),
        item({
          kind: "refused_start",
          stop: { kind: "refused", code: "pin_mismatch" },
          action: "fix_start_precondition"
        })
      ]),
      overview([])
    ]) {
      const out = await tmp();
      const result = await runHandoffCli(
        ["--out-dir", out],
        {},
        deps([overview([item()]), second]).handoff
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.join()).toContain("PIN_CHANGED");
      expect(await ls(out)).toEqual([]);
    }
  });

  it("refuses when a root that had items is unavailable in either read", async () => {
    const out = await tmp();
    const result = await runHandoffCli(
      ["--out-dir", out],
      {},
      deps([overview([item()]), overview([item()], "unavailable")]).handoff
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join()).toContain("READ_UNAVAILABLE");
    expect(await ls(out)).toEqual([]);
  });

  it("refuses a late publication at the deadline", async () => {
    const out = await tmp();
    let t = 0;
    const result = await runHandoffCli(
      ["--out-dir", out],
      {},
      deps([overview([item()])], { monotonicMs: () => (t += 8_000) }).handoff
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join()).toContain("DEADLINE");
    expect(await ls(out)).toEqual([]);
  });

  it("refuses a relative, missing or non-directory out-dir before writing, collecting nothing for relative", async () => {
    const out = await tmp();
    const relative = deps([overview([item()])]);
    expect((await runHandoffCli(["--out-dir", "rel/dir"], {}, relative.handoff)).exitCode).toBe(1);
    expect(relative.collections()).toBe(0);
    const missing = await runHandoffCli(
      ["--out-dir", join(out, "nope")],
      {},
      deps([overview([item()])]).handoff
    );
    expect(missing.exitCode).toBe(1);
    const file = join(out, "plain.txt");
    await writeFile(file, "x");
    expect(
      (await runHandoffCli(["--out-dir", file], {}, deps([overview([item()])]).handoff)).exitCode
    ).toBe(1);
    expect(await ls(out)).toEqual(["plain.txt"]);
  });

  it("refuses a symlinked out-dir", async () => {
    const root = await tmp();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    try {
      await symlink(real, linked, "dir");
    } catch {
      return; // symlink creation is not permitted on this host
    }
    const result = await runHandoffCli(
      ["--out-dir", linked],
      {},
      deps([overview([item()])]).handoff
    );
    expect(result.exitCode).toBe(1);
    expect(await ls(real)).toEqual([]);
  });

  it("never overwrites a target created while publishing, and leaves no temp file", async () => {
    const out = await tmp();
    const existing = "pre-existing bytes";
    const racing: PublishIo = {
      lstat,
      realpath,
      open,
      unlink,
      link: async (from, to) => {
        await writeFile(to, existing);
        return realLink(from, to);
      }
    };
    const result = await runHandoffCli(
      ["--out-dir", out],
      {},
      deps([overview([item()])], { io: racing }).handoff
    );
    expect(result.exitCode).toBe(4);
    expect(await readFile(handoffPath(out, ID), "utf8")).toBe(existing);
    expect(await ls(out)).toEqual([`${ID}.handoff.json`]);
  });

  it("refuses rather than falling back when links are unsupported", async () => {
    const out = await tmp();
    const noLink: PublishIo = {
      lstat,
      realpath,
      open,
      unlink,
      link: async () => {
        throw Object.assign(new Error("nope"), { code: "EPERM" });
      }
    };
    const result = await runHandoffCli(
      ["--out-dir", out],
      {},
      deps([overview([item()])], { io: noLink }).handoff
    );
    expect(result.exitCode).toBe(4);
    expect(await ls(out)).toEqual([]);
  });

  it("returns usage errors with code 2", async () => {
    for (const argv of [
      [],
      ["--out-dir"],
      ["--show"],
      ["--out-dir", "/a", "--show", "/b"],
      ["--other", "x"]
    ])
      expect((await runHandoffCli(argv, {})).exitCode).toBe(2);
  });

  it("--show refuses a tampered file without echoing its content", async () => {
    const out = await tmp();
    await runHandoffCli(["--out-dir", out], {}, deps([overview([item()])]).handoff);
    const path = handoffPath(out, ID);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"delivery":"not_sent"', '"delivery":"sent SECRET"'));
    const result = await runHandoffCli(["--show", path], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join()).toContain("FILE_INVALID");
    expect(result.stderr.join() + result.stdout.join()).not.toContain("SECRET");
    expect((await runHandoffCli(["--show", join(out, "absent.json")], {})).exitCode).toBe(1);
  });

  it("is not configured without the server environment", async () => {
    const out = await tmp();
    const result = await runHandoffCli(["--out-dir", out], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join()).toContain("NOT_CONFIGURED");
  });
});

describe("independent late publication regression", () => {
  it("refuses a publication that expires while syncing the temporary file", async () => {
    const out = await tmp();
    let clock = 0;
    const delayed: PublishIo = {
      lstat,
      realpath,
      link: realLink,
      unlink,
      open: async (...args) => {
        const h = await open(...args);
        return new Proxy(h, {
          get(target, key) {
            if (key === "sync")
              return async () => {
                await target.sync();
                clock = 30000;
              };
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          }
        });
      }
    };
    const result = await runHandoffCli(
      ["--out-dir", out],
      {},
      deps([overview([item()])], { io: delayed, monotonicMs: () => clock }).handoff
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join()).toContain("DEADLINE");
    expect(await ls(out)).toEqual([]);
  });
});
