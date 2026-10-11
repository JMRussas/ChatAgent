import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RUN_RECORD_BYTES, WorkflowRunStore } from "../../src/workflows/runStore";
import type { WorkflowRun } from "../../src/workflows/types";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    planId: randomUUID(),
    ownerId: "local:A",
    definition: {
      version: 1,
      name: "wf",
      description: "",
      steps: [
        {
          id: "a",
          name: "a",
          inputs: {},
          action: { type: "human", instructions: "x" },
          timeoutMs: 1000
        }
      ]
    },
    revision: 1,
    attemptEpoch: 1,
    status: "running",
    steps: [{ id: "a", name: "a", status: "pending" }],
    startedAt: now,
    updatedAt: now,
    ...overrides
  };
};

describe("WorkflowRunStore", () => {
  let dir: string;
  let store: WorkflowRunStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-runs-"));
    store = new WorkflowRunStore(dir);
  });
  afterEach(async () => {
    vi.mocked(rename).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips, replaces atomically and leaves no temp files", async () => {
    const r = run();
    await store.create(r);
    await store.write({ ...r, status: "waiting_input" });
    expect((await store.read("local:A", r.id)).status).toBe("waiting_input");
    expect(await readdir(dir)).toEqual([`${r.id}.json`]);
  });

  it("admits a run exclusively and refuses non-UUID ids and other owners", async () => {
    const r = run();
    await store.create(r);
    await expect(store.create(r)).rejects.toMatchObject({ code: "run_exists" });
    await expect(store.read("local:A", "../../etc/passwd")).rejects.toMatchObject({
      code: "invalid_run_id"
    });
    await expect(store.read("local:B", r.id)).rejects.toMatchObject({
      code: "run_not_found",
      status: 404
    });
    await expect(store.read("local:A", randomUUID())).rejects.toMatchObject({
      code: "run_not_found"
    });
  });

  it("refuses corrupt, mismatched and oversized persisted artifacts", async () => {
    const corruptId = randomUUID();
    await writeFile(store.pathFor(corruptId), "{not json");
    await expect(store.read("local:A", corruptId)).rejects.toMatchObject({ code: "run_corrupt" });

    const other = run();
    const swappedId = randomUUID();
    await writeFile(store.pathFor(swappedId), JSON.stringify(other));
    await expect(store.read("local:A", swappedId)).rejects.toMatchObject({ code: "run_corrupt" });

    const invalid = randomUUID();
    await writeFile(
      store.pathFor(invalid),
      JSON.stringify({ ...run({ id: invalid }), status: "bogus" })
    );
    await expect(store.read("local:A", invalid)).rejects.toMatchObject({ code: "run_corrupt" });

    const huge = randomUUID();
    await writeFile(store.pathFor(huge), " ".repeat(MAX_RUN_RECORD_BYTES + 1));
    await expect(store.read("local:A", huge)).rejects.toMatchObject({ code: "run_corrupt" });
  });

  it("refuses to write an oversized record and keeps the previous version", async () => {
    const r = run();
    await store.create(r);
    const big = {
      ...r,
      steps: [
        {
          id: "a",
          name: "a",
          status: "completed" as const,
          output: "x".repeat(MAX_RUN_RECORD_BYTES)
        }
      ]
    };
    await expect(store.write(big)).rejects.toMatchObject({ code: "record_too_large" });
    expect((await store.read("local:A", r.id)).steps[0].status).toBe("pending");
    expect(await readdir(dir)).toEqual([`${r.id}.json`]);
  });

  it("persists after a transient sharing failure and refuses persistent IO without losing the previous artifact", async () => {
    const r = run();
    await store.create(r);
    const failure = Object.assign(new Error("Sharing violation"), {
      code: "EPERM",
      syscall: "rename"
    });
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await store.write({ ...r, status: "waiting_input" });
    expect((await store.read("local:A", r.id)).status).toBe("waiting_input");
    vi.mocked(rename).mockRejectedValue(failure);
    await expect(store.write({ ...r, status: "stopped" })).rejects.toMatchObject({
      code: "run_store_io",
      cause: { code: "EPERM" }
    });
    expect((await store.read("local:A", r.id)).status).toBe("waiting_input");
    expect(await readdir(dir)).toEqual([`${r.id}.json`]);
  });

  it("claims a run exclusively and requires explicit recovery of existing locks", async () => {
    const id = randomUUID();
    const claim = await store.claim(id);
    await expect(store.claim(id)).rejects.toMatchObject({ code: "run_busy" });
    await claim.release();
    await (await store.claim(id)).release();

    await writeFile(store.pathFor(id, ".lock"), JSON.stringify({ pid: 2 ** 30, at: 0 }));
    await expect(store.claim(id)).rejects.toMatchObject({ code: "run_busy" });
    await unlink(store.pathFor(id, ".lock"));
    await (await store.claim(id)).release();
  });

  it("does not release a replacement or unreadable claim, and release is idempotent", async () => {
    const id = randomUUID();
    const first = await store.claim(id);
    const path = store.pathFor(id, ".lock");
    await writeFile(path, JSON.stringify({ token: "replacement" }));
    await first.release();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "replacement" });
    await unlink(path);
    const second = await store.claim(id);
    await first.release();
    await expect(store.claim(id)).rejects.toMatchObject({ code: "run_busy" });
    await writeFile(path, "unreadable JSON");
    await second.release();
    expect(await readFile(path, "utf8")).toBe("unreadable JSON");
  });

  it("finds the latest owned run without returning another caller's artifact", async () => {
    const first = run({ status: "failed", startedAt: "2026-10-10T10:00:00Z" });
    const second = run({
      planId: first.planId,
      status: "stopped",
      startedAt: "2026-10-10T11:00:00Z"
    });
    const foreign = run({
      ownerId: "local:B",
      planId: first.planId,
      startedAt: "2026-10-10T12:00:00Z"
    });
    await store.create(first);
    await store.create(second);
    await store.create(foreign);
    expect(await store.latest("local:A", [first.planId])).toEqual(
      new Map([[first.planId, second.id]])
    );
  });
});
