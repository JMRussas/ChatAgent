import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTINUATION_RECORD_SCHEMA,
  buildGate,
  checkArguments,
  claimKeyOf,
  entryState,
  finishRequestBody,
  parseContinuationManifest,
  parseContinuationRecord,
  parseRawDiffZ,
  parseStatusZ,
  serializeContinuationRecord,
  validRelativePath,
  type ContinuationRecord
} from "../../src/checkpoint/checkpointContinuation";
import { gateRecordSchema } from "../../src/checkpoint/checkpointRecord";
import { BASE_REF, FENCE, RUN_ID, SOURCE_REF, STAMP } from "../helpers/checkpointFixtures";

const h = (c: string) => c.repeat(64);
const run = {
  schema: "checkpoint-run/v1",
  runId: RUN_ID,
  unit: "assistant_message_ids_distinct/v1",
  profile: "coding",
  identity: { ...FENCE, stateRevision: 4, executorRef: "exec-1", baseRef: BASE_REF },
  executable: { path: "/opt/claude", sha256: h("a") },
  gitExecutable: { path: "/usr/bin/git", sha256: h("b") },
  worktree: "/work/wt",
  promptFile: "/work/prompt.txt",
  promptSha256: h("c"),
  recordDir: "/work/rec",
  model: "m-1",
  expected: { units: 5 },
  hard: { units: 10, wallMs: 60_000, outputBytes: 1_000_000 },
  providerUsdCap: 2.5,
  planApiUrl: "http://127.0.0.1:1"
};
const manifest = () => ({
  schema: "checkpoint-continuation-run/v1",
  run,
  files: ["src/a.ts", "docs/x.md"],
  focusedTests: ["tests/a.test.ts"],
  nodeExecutable: { path: "/usr/bin/node", sha256: h("d") },
  toolingSha256: { prettier: h("1"), typescript: h("2"), vitest: h("3") },
  limits: { wallMs: 200_000, verifierWallMs: 60_000, verifierOutputBytes: 1_000_000 }
});
const parse = (value: unknown) => parseContinuationManifest(Buffer.from(JSON.stringify(value)));
const refuses = (value: unknown) => expect(() => parse(value)).toThrow("INPUT_INVALID");

describe("continuation manifest", () => {
  it("accepts the closed manifest, including a decimal provider cap", () => {
    expect(parse(manifest()).run.providerUsdCap).toBe(2.5);
  });

  it("refuses unknown fields, arbitrary command fields and a non-coding profile", () => {
    for (const extra of ["command", "script", "argv", "action", "scriptPath", "env"])
      refuses({ ...manifest(), [extra]: "x" });
    refuses({ ...manifest(), toolingSha256: { ...manifest().toolingSha256, argv: h("4") } });
    refuses({ ...manifest(), run: { ...run, profile: "readonly_smoke" } });
    refuses({ ...manifest(), limits: { ...manifest().limits, extraArgs: 1 } });
  });

  it("refuses unsupported versions, duplicate or unsafe keys, decimals and oversize input", () => {
    refuses({ ...manifest(), schema: "checkpoint-continuation-run/v2" });
    const text = JSON.stringify(manifest());
    const duplicate = text.replace('"files"', '"files":[],"files"');
    expect(() => parseContinuationManifest(Buffer.from(duplicate))).toThrow("INPUT_INVALID");
    const unsafe = text.replace('"files"', '"__proto__":1,"files"');
    expect(() => parseContinuationManifest(Buffer.from(unsafe))).toThrow("INPUT_INVALID");
    const decimal = text.replace('"wallMs":200000', '"wallMs":200000.0');
    expect(() => parseContinuationManifest(Buffer.from(decimal))).toThrow("INPUT_INVALID");
    const identity = text.replace('"attemptEpoch":2', '"attemptEpoch":2.0');
    expect(() => parseContinuationManifest(Buffer.from(identity))).toThrow("INPUT_INVALID");
    expect(() => parseContinuationManifest(Buffer.alloc(32 * 1024 + 1, 32))).toThrow(
      "INPUT_INVALID"
    );
  });

  it("enforces path scope, uniqueness and the aggregate wall bound", () => {
    for (const bad of [
      "package.json",
      "src",
      "../src/a.ts",
      "src/../a.ts",
      "src//a.ts",
      "src/./a.ts",
      "src\\a.ts",
      "/src/a.ts",
      "-src/a.ts",
      ".git/config",
      "src/.git/x",
      "src/.gitattributes",
      "src/node_modules/x.ts",
      "src/a b.ts",
      "src/a\u0001.ts",
      "src/é.ts",
      "C:/x/a.ts",
      "lib/a.ts",
      `src/${"a".repeat(240)}`,
      "src/a.ts."
    ]) {
      expect(validRelativePath(bad), bad).toBe(false);
      refuses({ ...manifest(), files: [bad] });
    }
    expect(validRelativePath("scripts/a.ts")).toBe(true);
    refuses({ ...manifest(), files: [] });
    refuses({ ...manifest(), files: ["src/a.ts", "SRC/A.ts"] });
    refuses({ ...manifest(), files: Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`) });
    refuses({ ...manifest(), focusedTests: [] });
    refuses({ ...manifest(), focusedTests: ["src/a.test.ts"] });
    refuses({ ...manifest(), focusedTests: ["tests/a.ts"] });
    refuses({ ...manifest(), focusedTests: ["tests/a.test.ts", "tests/a.test.ts"] });
    refuses({ ...manifest(), limits: { ...manifest().limits, wallMs: 90_000 } });
    refuses({ ...manifest(), limits: { ...manifest().limits, wallMs: 1_800_001 } });
    refuses({ ...manifest(), limits: { ...manifest().limits, verifierWallMs: 600_001 } });
    refuses({ ...manifest(), limits: { ...manifest().limits, verifierOutputBytes: 4_194_305 } });
    refuses({ ...manifest(), nodeExecutable: { path: "node", sha256: h("d") } });
  });
});

const record = (over: Partial<ContinuationRecord> = {}): ContinuationRecord => ({
  schema: CONTINUATION_RECORD_SCHEMA,
  runId: RUN_ID,
  identity: { ...FENCE, observedStateRevision: 4, executorRef: "exec-1" },
  baseRef: BASE_REF,
  phase: "verifying",
  reason: "in_progress",
  startedAt: STAMP,
  updatedAt: STAMP,
  endedAt: null,
  sourceRef: SOURCE_REF,
  worker: {
    stop: { kind: "exited", code: "exited" },
    exit: { code: 0, signal: null },
    consumed: { units: 3, wallMs: 10, outputBytes: 99, counterState: "lower_bound" },
    providerReported: { numTurns: 3, costUsd: 1, status: "unverified" }
  },
  finish: "confirmed",
  checkRole: "mimir_external_checks",
  checks: [],
  gate: "not_written",
  failureAttribution: "unattributed",
  leadAcceptance: "pending",
  semanticReview: "not_performed",
  delivery: "not_sent",
  wake: "none",
  acknowledgment: "none",
  recordTrust: "supplied_not_authenticated",
  writerLiveness: "unknown",
  ...over
});
const passing = ["prettier", "typescript", "vitest"].map((name) => ({
  name: name as "prettier",
  result: "pass" as const,
  ran: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimited: false,
  outputBytes: 5,
  outputSha256: h("e"),
  startedAt: STAMP,
  endedAt: STAMP
}));

describe("continuation record", () => {
  it("round-trips, preserves unverified counters and an integral provider cost", () => {
    const text = serializeContinuationRecord(record());
    expect(text.endsWith("\n")).toBe(true);
    const parsed = parseContinuationRecord(Buffer.from(text));
    expect(parsed.ok && parsed.value.worker?.consumed.counterState).toBe("lower_bound");
    expect(parsed.ok && parsed.value.worker?.providerReported.costUsd).toBe(1);
    expect(parsed.ok && parsed.value.recordTrust).toBe("supplied_not_authenticated");
  });

  it("is closed: unknown fields, other versions and pinned literals are refused", () => {
    const text = serializeContinuationRecord(record());
    const bad = (mutate: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(text) as Record<string, unknown>;
      mutate(value);
      return parseContinuationRecord(Buffer.from(JSON.stringify(value)));
    };
    expect(bad((v) => (v.command = "x")).ok).toBe(false);
    expect(bad((v) => (v.schema = "checkpoint-continuation/v2"))).toEqual({
      ok: false,
      reason: "unsupported_schema"
    });
    expect(bad((v) => (v.leadAcceptance = "accepted")).ok).toBe(false);
    expect(bad((v) => (v.semanticReview = "performed")).ok).toBe(false);
    expect(bad((v) => (v.wake = "scheduled")).ok).toBe(false);
    expect(bad((v) => (v.failureAttribution = "source")).ok).toBe(false);
    expect(bad((v) => (v.phase = "accepted")).ok).toBe(false);
  });

  it("pairs phase, reason, end time and checks", () => {
    expect(() => serializeContinuationRecord(record({ phase: "review_pending" }))).toThrow();
    expect(() =>
      serializeContinuationRecord(
        record({ phase: "needs_operator", reason: "in_progress", endedAt: STAMP })
      )
    ).toThrow();
    expect(() => serializeContinuationRecord(record({ endedAt: STAMP }))).toThrow();
    expect(() =>
      serializeContinuationRecord(
        record({
          phase: "review_pending",
          reason: "checks_passed",
          gate: "written",
          endedAt: STAMP,
          checks: passing.map((c, i) => (i === 1 ? { ...c, result: "fail" as const } : c))
        })
      )
    ).toThrow();
    expect(
      serializeContinuationRecord(
        record({
          phase: "review_pending",
          reason: "checks_passed",
          gate: "written",
          endedAt: STAMP,
          checks: passing
        })
      )
    ).toContain('"phase":"review_pending"');
  });
});

describe("Git output parsing and fixed profiles", () => {
  it("parses NUL-separated status and raw diff output without renames", () => {
    expect(parseStatusZ(Buffer.from(" M src/a.ts\0?? src/new.ts\0 D docs/x.md\0"))).toEqual([
      { x: " ", y: "M", path: "src/a.ts" },
      { x: "?", y: "?", path: "src/new.ts" },
      { x: " ", y: "D", path: "docs/x.md" }
    ]);
    expect(parseStatusZ(Buffer.alloc(0))).toEqual([]);
    expect(() => parseStatusZ(Buffer.from(" M src/a.ts"))).toThrow();
    expect(() => parseStatusZ(Buffer.from([0x20, 0x4d, 0x20, 0xff, 0x0]))).toThrow();
    expect(() => parseStatusZ(Buffer.alloc(300 * 1024, 65))).toThrow();
    const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0src/a.ts\0`;
    expect(parseRawDiffZ(Buffer.from(raw))[0]).toMatchObject({
      newMode: "100644",
      path: "src/a.ts"
    });
    expect(() => parseRawDiffZ(Buffer.from(raw.replace(" M", " R")))).toThrow();
    expect(() => parseRawDiffZ(Buffer.from(raw.slice(0, -1)))).toThrow();
  });

  it("builds only the fixed Prettier, TypeScript and Vitest arguments", () => {
    expect(checkArguments("prettier", ["src/a.ts", "src/new.ts"], ["tests/a.test.ts"])).toEqual([
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      "--ignore-unknown",
      "src/a.ts",
      "src/new.ts"
    ]);
    expect(checkArguments("typescript", ["src/a.ts"], [])).toEqual([
      "node_modules/typescript/lib/_tsc.js",
      "--project",
      "tsconfig.json",
      "--noEmit"
    ]);
    expect(checkArguments("vitest", ["src/a.ts"], ["tests/a.test.ts"])).toEqual([
      "node_modules/vitest/vitest.mjs",
      "run",
      "--maxWorkers=1",
      "tests/a.test.ts"
    ]);
  });

  it("binds the finish body to the run, fence and candidate deterministically", () => {
    const input = parse(manifest()).run;
    const body = JSON.parse(finishRequestBody(input, SOURCE_REF, 4));
    expect(body).toEqual({
      to: "done",
      rootId: FENCE.rootId,
      attemptId: "at-1",
      attemptEpoch: 2,
      artifactRef: SOURCE_REF,
      expectedStateRevision: 4,
      actor: "checkpoint-continuation",
      operationKey: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(finishRequestBody(input, SOURCE_REF, 4)).toBe(finishRequestBody(input, SOURCE_REF, 4));
    expect(finishRequestBody(input, "e".repeat(40), 4)).not.toBe(
      finishRequestBody(input, SOURCE_REF, 4)
    );
    expect(claimKeyOf(input.identity)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gate", () => {
  const result = (
    name: "prettier" | "typescript" | "vitest",
    r: "pass" | "fail" | "unavailable"
  ) => ({
    ...passing[0],
    name,
    result: r
  });
  const gateOf = (results: ("pass" | "fail" | "unavailable")[]) =>
    buildGate(
      record({
        checks: [
          result("prettier", results[0]),
          result("typescript", results[1]),
          result("vitest", results[2])
        ]
      }),
      claimKeyOf(parse(manifest()).run.identity),
      STAMP
    );

  it("is a valid existing gate whose failures are never attributed to source", () => {
    for (const results of [
      ["pass", "pass", "pass"],
      ["fail", "pass", "pass"],
      ["fail", "fail", "fail"],
      ["pass", "unavailable", "unavailable"],
      ["unavailable", "unavailable", "unavailable"]
    ] as const) {
      const gate = gateOf([...results]);
      expect(gateRecordSchema.safeParse(gate).success).toBe(true);
      expect(gate.failureAttribution).toBe("unattributed");
      expect(gate.outcome).not.toBe("source_failed");
    }
    expect(gateOf(["pass", "pass", "pass"]).outcome).toBe("checks_passed");
    expect(gateOf(["fail", "pass", "pass"]).outcome).toBe("partial");
    expect(gateOf(["fail", "pass", "pass"]).evidenceRefs).toContain("continuation:check_failed");
    expect(gateOf(["pass", "unavailable", "pass"]).evidenceRefs).toContain(
      "continuation:check_unavailable"
    );
    expect(gateOf(["pass", "pass", "pass"]).evidenceRefs).toContain(
      "semantic-review:not-performed"
    );
  });
});

describe("source entry safety", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("classifies regular, absent and symlinked entries", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ckpt-entry-")));
    dirs.push(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "x");
    await writeFile(join(dir, "plain"), "x");
    expect(await entryState(dir, "src/a.ts")).toBe("file");
    expect(await entryState(dir, "src/missing.ts")).toBe("absent");
    expect(await entryState(dir, "docs/none.md")).toBe("absent");
    expect(await entryState(dir, "plain/child.ts")).toBe("unsafe");
    expect(await entryState(dir, "src")).toBe("unsafe");
    try {
      await symlink(join(dir, "src", "a.ts"), join(dir, "src", "link.ts"), "file");
      await symlink(join(dir, "src"), join(dir, "linked"), "junction");
    } catch {
      return; // creating links needs a privilege on some hosts; the other cases still ran
    }
    expect(await entryState(dir, "src/link.ts")).toBe("unsafe");
    expect(await entryState(dir, "linked/a.ts")).toBe("unsafe");
  });
});
