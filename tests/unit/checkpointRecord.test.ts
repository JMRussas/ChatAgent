import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKPOINT_LIMITS,
  CheckpointRecordError,
  budgetRecordPath,
  deriveGateOutcome,
  parseBoundedJson,
  parseBudgetRecord,
  parseGateRecord,
  parseRunInput,
  replaceBudgetRecord,
  reserveBudgetRecord,
  serializeBudgetRecord
} from "../../src/checkpoint/checkpointRecord";
import {
  CheckpointRecordsConfigError,
  loadCheckpointRecordsConfig,
  parseCheckpointRecords
} from "../../src/config/checkpointRecordsConfig";
import { guid } from "../helpers/executiveFixtures";
import { BASE_REF, FENCE, RUN_ID, makeGate, makeRecord } from "../helpers/checkpointFixtures";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("bounded strict JSON", () => {
  const code = (text: string, options = {}) => {
    try {
      parseBoundedJson(text, options);
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return "ok";
  };

  it("refuses duplicate keys, including escaped spellings, and __proto__", () => {
    expect(code('{"a":1,"a":2}')).toBe("DUPLICATE_KEY");
    expect(code('{"a":1,"\\u0061":2}')).toBe("DUPLICATE_KEY");
    expect(code('{"x":{"a":1,"a":2}}')).toBe("DUPLICATE_KEY");
    expect(code('{"__proto__":{}}')).toBe("UNSAFE_KEY");
    expect(code('{"a":1,"b":{"a":2}}')).toBe("ok");
  });

  it("bounds nesting depth and rejects trailing or malformed text", () => {
    expect(code("[".repeat(40) + "]".repeat(40))).toBe("DEPTH");
    expect(code("[[[1]]]", { maxDepth: 2 })).toBe("DEPTH");
    expect(code("[[1]]", { maxDepth: 4 })).toBe("ok");
    for (const bad of [
      '{"a":1} x',
      "{'a':1}",
      '{"a":}',
      '{"a":1,}',
      "",
      '"unterminated',
      "01",
      " 1"
    ])
      expect(code(bad)).toBe("SYNTAX");
  });

  it("record mode admits fractions but never an integral decimal or unsafe integer", () => {
    expect(parseBoundedJson('{"cost":0.0123}')).toEqual({ cost: 0.0123 });
    expect(code('{"n":1.0}')).toBe("INVALID_NUMBER");
    expect(code('{"n":1e2}')).toBe("INVALID_NUMBER");
    expect(code('{"n":9007199254740993}')).toBe("INVALID_NUMBER");
    expect(code('{"n":-0}')).toBe("INVALID_NUMBER");
    expect(code('{"n":1e999}')).toBe("INVALID_NUMBER");
  });

  it("stream mode admits any finite number but still refuses infinity", () => {
    const stream = { numbers: "stream" as const };
    expect(code('{"n":1.0,"m":12345678901234567890,"k":1e-7}', stream)).toBe("ok");
    expect(code('{"n":1e999}', stream)).toBe("INVALID_NUMBER");
  });
});

describe("budget record schema", () => {
  it("accepts a complete record with fractional provider cost kept separate from integers", () => {
    const parsed = parseBudgetRecord(bytes(makeRecord()));
    expect(parsed.ok && parsed.value.providerReported.costUsd).toBe(0.0123);
  });

  it("refuses an identity, budget or counter that is not an exact safe integer", () => {
    const fractional = JSON.stringify(makeRecord()).replace(
      '"attemptEpoch":2',
      '"attemptEpoch":2.5'
    );
    expect(parseBudgetRecord(Buffer.from(fractional))).toEqual({ ok: false, reason: "invalid" });
    const decimalForm = JSON.stringify(makeRecord()).replace('"units":7', '"units":7.0');
    expect(parseBudgetRecord(Buffer.from(decimalForm))).toEqual({ ok: false, reason: "invalid" });
    const bad = (patch: Partial<ReturnType<typeof makeRecord>>) =>
      parseBudgetRecord(bytes(makeRecord(patch))).ok;
    expect(bad({ consumed: { ...makeRecord().consumed, units: -1 } })).toBe(false);
    expect(bad({ consumed: { ...makeRecord().consumed, units: 202 } })).toBe(false);
    expect(bad({ hard: { ...makeRecord().hard, units: 201 } })).toBe(false);
    expect(bad({ providerReported: { numTurns: 1.5, costUsd: 0.1, status: "unverified" } })).toBe(
      false
    );
    expect(bad({ providerReported: { numTurns: 1, costUsd: -1, status: "unverified" } })).toBe(
      false
    );
    expect(bad({ expected: { units: 61, basis: "provisional_heuristic" } })).toBe(false);
  });

  it("is closed: unknown keys, wrong enums, duplicate keys and inconsistent state are refused", () => {
    expect(parseBudgetRecord(bytes({ ...makeRecord(), extra: 1 })).ok).toBe(false);
    expect(parseBudgetRecord(bytes(makeRecord({ writerLiveness: "alive" as never }))).ok).toBe(
      false
    );
    expect(
      parseBudgetRecord(bytes(makeRecord({ stop: { kind: "tripwire", code: "exited" as never } })))
        .ok
    ).toBe(false);
    expect(parseBudgetRecord(bytes(makeRecord({ state: "running" }))).ok).toBe(false);
    expect(
      parseBudgetRecord(Buffer.from(`{"schema":"x",${JSON.stringify(makeRecord()).slice(1)}`)).ok
    ).toBe(false);
    const dup = JSON.stringify(makeRecord()).replace(
      '"state":"ended"',
      '"state":"ended","state":"ended"'
    );
    expect(parseBudgetRecord(Buffer.from(dup)).ok).toBe(false);
  });

  it("distinguishes an unsupported schema version and fatal UTF-8", () => {
    expect(parseBudgetRecord(bytes({ ...makeRecord(), schema: "checkpoint-budget/v2" }))).toEqual({
      ok: false,
      reason: "unsupported_schema"
    });
    expect(parseBudgetRecord(bytes({ schema: "other/v1" }))).toEqual({
      ok: false,
      reason: "invalid"
    });
    expect(parseBudgetRecord(Buffer.from([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: "invalid"
    });
  });

  it("serializes under the 16 KiB cap and refuses an invalid record", () => {
    expect(Buffer.byteLength(serializeBudgetRecord(makeRecord()))).toBeLessThan(
      CHECKPOINT_LIMITS.maxFileBytes
    );
    expect(() => serializeBudgetRecord({ ...makeRecord(), runId: "nope" })).toThrow(
      CheckpointRecordError
    );
  });
});

describe("gate evidence schema", () => {
  it("maps an unavailable verifier to verifier_unavailable, never source_failed", () => {
    expect(deriveGateOutcome([{ result: "unavailable" }, { result: "unavailable" }])).toBe(
      "verifier_unavailable"
    );
    expect(deriveGateOutcome([])).toBe("verifier_unavailable");
    expect(deriveGateOutcome([{ result: "pass" }, { result: "unavailable" }])).toBe("partial");
    expect(deriveGateOutcome([{ result: "fail" }, { result: "unavailable" }])).toBe("partial");
    expect(deriveGateOutcome([{ result: "fail" }, { result: "pass" }])).toBe("partial");
    expect(deriveGateOutcome([{ result: "fail" }, { result: "pass" }], "source")).toBe(
      "source_failed"
    );
    expect(deriveGateOutcome([{ result: "pass" }])).toBe("checks_passed");
  });

  it("refuses a contradictory outcome and an unevidenced source failure", () => {
    expect(parseGateRecord(bytes(makeGate())).ok).toBe(true);
    const outage = makeGate({
      checks: [{ name: "tests", result: "unavailable" }],
      outcome: "verifier_unavailable"
    });
    expect(parseGateRecord(bytes(outage)).ok).toBe(true);
    expect(parseGateRecord(bytes({ ...outage, outcome: "source_failed" })).ok).toBe(false);
    const failed = makeGate({
      failureAttribution: "source",
      checks: [{ name: "tests", result: "fail" }],
      outcome: "source_failed"
    });
    expect(parseGateRecord(bytes(failed)).ok).toBe(true);
    expect(parseGateRecord(bytes({ ...failed, evidenceRefs: [] })).ok).toBe(false);
    expect(parseGateRecord(bytes({ ...makeGate(), suppliedBy: "automation" })).ok).toBe(false);
    expect(parseGateRecord(bytes({ ...makeGate(), evidenceRefs: Array(9).fill("x") })).ok).toBe(
      false
    );
  });
});

describe("record files", () => {
  it("reserves exclusively and replaces atomically without leaving temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ckpt-rec-"));
    dirs.push(dir);
    const running = makeRecord({
      state: "running",
      stop: { kind: "none", code: "none" },
      endedAt: null,
      exit: null
    });
    await reserveBudgetRecord(dir, running);
    await expect(reserveBudgetRecord(dir, makeRecord())).rejects.toMatchObject({
      code: "RECORD_EXISTS"
    });
    expect(JSON.parse(await readFile(budgetRecordPath(dir, RUN_ID), "utf8")).state).toBe("running");
    await replaceBudgetRecord(dir, makeRecord());
    expect(JSON.parse(await readFile(budgetRecordPath(dir, RUN_ID), "utf8")).state).toBe("ended");
    expect(await readdir(dir)).toEqual([`${RUN_ID}.budget.json`]);
  });
});

describe("run input", () => {
  const input = () => ({
    schema: "checkpoint-run/v1",
    runId: RUN_ID,
    unit: "assistant_message_ids_distinct/v1",
    profile: "readonly_smoke",
    identity: {
      rootId: FENCE.rootId,
      nodeId: FENCE.nodeId,
      attemptId: "at-1",
      attemptEpoch: 2,
      contentRevision: 3,
      stateRevision: 4,
      executorRef: "exec-1",
      baseRef: BASE_REF
    },
    executable: { path: join(tmpdir(), "claude"), sha256: "a".repeat(64) },
    gitExecutable: { path: join(tmpdir(), "git"), sha256: "b".repeat(64) },
    worktree: join(tmpdir(), "wt"),
    promptFile: join(tmpdir(), "prompt.txt"),
    promptSha256: "c".repeat(64),
    recordDir: join(tmpdir(), "records"),
    model: "claude-sonnet-5-5",
    expected: { units: 30 },
    hard: { units: 60, wallMs: 900_000, outputBytes: 8 * 1024 * 1024 },
    planApiUrl: "http://127.0.0.1:5100"
  });

  it("accepts the strict input and refuses unknown keys, relative paths and oversize files", () => {
    expect(parseRunInput(bytes(input())).hard.units).toBe(60);
    expect(() => parseRunInput(bytes({ ...input(), args: ["--dangerous"] }))).toThrow(
      CheckpointRecordError
    );
    expect(() => parseRunInput(bytes({ ...input(), worktree: "relative/wt" }))).toThrow();
    expect(() =>
      parseRunInput(bytes({ ...input(), hard: { ...input().hard, units: 201 } }))
    ).toThrow();
    expect(() => parseRunInput(bytes({ ...input(), expected: { units: 61 } }))).toThrow();
    expect(() => parseRunInput(Buffer.alloc(CHECKPOINT_LIMITS.maxFileBytes + 1, 32))).toThrow();
    expect(() =>
      parseRunInput(Buffer.from(JSON.stringify(input()).replace("{", '{"runId":"x",')))
    ).toThrow();
  });
});

describe("checkpoint record registry config", () => {
  const entry = (n = 1, path = join(tmpdir(), `r${n}.budget.json`)) => ({
    rootId: guid(1),
    nodeId: guid(100, n),
    recordPath: path
  });

  it("is off when unset and needs the overview when set", () => {
    expect(loadCheckpointRecordsConfig({}, true)).toBeUndefined();
    const env = { HEKATE_CHECKPOINT_RECORDS_JSON: JSON.stringify([entry()]) };
    expect(loadCheckpointRecordsConfig(env, true)).toHaveLength(1);
    expect(() => loadCheckpointRecordsConfig(env, false)).toThrow(CheckpointRecordsConfigError);
  });

  it("refuses relative paths, duplicates, unknown keys, duplicate keys and more than 16", () => {
    expect(() => parseCheckpointRecords([entry(1, "relative.json")])).toThrow();
    expect(() =>
      parseCheckpointRecords([entry(1), entry(1, join(tmpdir(), "other.json"))])
    ).toThrow();
    expect(() => parseCheckpointRecords([entry(1), entry(2, entry(1).recordPath)])).toThrow();
    expect(() => parseCheckpointRecords([{ ...entry(), extra: 1 }])).toThrow();
    expect(() => parseCheckpointRecords([])).toThrow();
    expect(() =>
      parseCheckpointRecords(Array.from({ length: 17 }, (_, i) => entry(i + 1)))
    ).toThrow();
    expect(parseCheckpointRecords(Array.from({ length: 16 }, (_, i) => entry(i + 1)))).toHaveLength(
      16
    );
    const dup = `[{"rootId":"${guid(1)}","rootId":"${guid(1)}","nodeId":"${guid(100, 1)}","recordPath":"x"}]`;
    expect(() =>
      loadCheckpointRecordsConfig({ HEKATE_CHECKPOINT_RECORDS_JSON: dup }, true)
    ).toThrow(CheckpointRecordsConfigError);
  });

  describe("optional continuation record path", () => {
    const withContinuation = (n = 1, runId = RUN_ID) => ({
      ...entry(n),
      continuationRecordPath: join(tmpdir(), `${runId}.continuation.json`)
    });

    it("keeps the exact existing entry shape when absent", () => {
      const [parsed] = parseCheckpointRecords([entry()]);
      expect(Object.keys(parsed)).toEqual(["rootId", "nodeId", "recordPath"]);
      // An explicit undefined is the same as absent and never leaks a key.
      const [undef] = parseCheckpointRecords([{ ...entry(), continuationRecordPath: undefined }]);
      expect(Object.keys(undef)).toEqual(["rootId", "nodeId", "recordPath"]);
    });

    it("accepts one trusted absolute run-named path and returns a detached copy", () => {
      const input = withContinuation();
      const [parsed] = parseCheckpointRecords([input]);
      expect(parsed).toEqual(input);
      expect(parsed).not.toBe(input);
      const env = { HEKATE_CHECKPOINT_RECORDS_JSON: JSON.stringify([input]) };
      expect(loadCheckpointRecordsConfig(env, true)).toEqual([input]);
    });

    it("refuses relative, control-character, wrongly named and non-string values", () => {
      const bad = [
        `${RUN_ID}.continuation.json`,
        join(tmpdir(), "run.continuation.json"),
        join(tmpdir(), `${RUN_ID}.budget.json`),
        join(tmpdir(), `${RUN_ID}.continuation.json.bak`),
        join(tmpdir(), `${RUN_ID}\u0001.continuation.json`),
        join(tmpdir(), "AAAAAAAA-1111-4111-8111-111111111111.continuation.json"),
        join(tmpdir(), "x".repeat(1024), `${RUN_ID}.continuation.json`),
        "",
        7,
        null
      ];
      for (const continuationRecordPath of bad)
        expect(() => parseCheckpointRecords([{ ...entry(), continuationRecordPath }])).toThrow(
          CheckpointRecordsConfigError
        );
    });

    it("refuses a path reused by any entry, including as its own budget record", () => {
      const path = join(tmpdir(), `${RUN_ID}.continuation.json`);
      expect(() => parseCheckpointRecords([withContinuation(1), withContinuation(2)])).toThrow();
      expect(() =>
        parseCheckpointRecords([{ ...entry(1, path), continuationRecordPath: path }])
      ).toThrow();
      expect(() => parseCheckpointRecords([entry(1, path), withContinuation(2)])).toThrow();
      expect(
        parseCheckpointRecords([withContinuation(1), withContinuation(2, guid(7))])
      ).toHaveLength(2);
    });
  });

  it("never echoes the configured value", () => {
    const secret = "SECRET-PATH-VALUE";
    try {
      loadCheckpointRecordsConfig(
        { HEKATE_CHECKPOINT_RECORDS_JSON: `[{"recordPath":"${secret}"}]` },
        true
      );
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toBe("INVALID_CHECKPOINT_RECORDS");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("independent causality and monetary contract regressions", () => {
  it("keeps a failed check unattributed without an explicit source verdict", () => {
    expect(deriveGateOutcome([{ result: "fail" }])).toBe("partial");
    expect(
      parseGateRecord(
        bytes(makeGate({ checks: [{ name: "tests", result: "fail" }], outcome: "partial" }))
      ).ok
    ).toBe(true);
    expect(
      parseGateRecord(
        bytes(makeGate({ checks: [{ name: "tests", result: "fail" }], outcome: "source_failed" }))
      ).ok
    ).toBe(false);
  });
  it("admits integral decimal monetary metadata while preserving integer fences", () => {
    const cost = JSON.stringify(makeRecord()).replace('"costUsd":0.0123', '"costUsd":1.0');
    expect(parseBudgetRecord(Buffer.from(cost)).ok).toBe(true);
    expect(parseBoundedJson('{"providerUsdCap":5.0}')).toEqual({ providerUsdCap: 5 });
    expect(() => parseBoundedJson('{"consumed":{"units":5.0}}')).toThrow();
  });
});
